import * as vscode from 'vscode';
import * as path from 'path';

// Types for persisted + in-memory model
export interface Group {
  id: string;
  name: string;
  children: (Group | string)[];
  pattern?: string;
  /** When true, the group starts expanded. Omitted means collapsed. */
  expanded?: boolean;
}

type SortMode = 'manual' | 'name' | 'nameDesc';

interface PersistedData {
  version: number;
  groups: Group[];
  /** @deprecated Migrated onto Group.pattern on load. */
  patterns?: { pattern: string; groupId?: string; group?: string }[];
  sortMode?: SortMode;
}

const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Off',
  name: 'A-Z',
  nameDesc: 'Z-A'
};

const SORT_CYCLE: SortMode[] = ['name', 'nameDesc', 'manual'];

/** A file row in the tree. The same URI may appear under several groups. */
export interface FileNode {
  kind: 'file';
  uri: string;
  parentId: string | null;
}

export interface SeparatorNode {
  kind: 'separator';
}

type TreeElement = Group | FileNode | SeparatorNode;

const UNGROUPED_SEPARATOR: SeparatorNode = { kind: 'separator' };

function isFileNode(node: unknown): node is FileNode {
  return !!node && typeof node === 'object' && (node as FileNode).kind === 'file';
}

function isSeparator(node: unknown): node is SeparatorNode {
  return !!node && typeof node === 'object' && (node as SeparatorNode).kind === 'separator';
}

const MIME_TYPE = 'application/vnd.code.tree.manualeditorgroups';
const URI_LIST_MIME = 'text/uri-list';
const VSCODE_URI_LIST_MIME = 'application/vnd.code.uri-list';
const STORAGE_FILE = 'editor-groups.json';

function generateId(): string {
  return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function isGroup(node: unknown): node is Group {
  return !!node
    && typeof node === 'object'
    && !isFileNode(node)
    && !isSeparator(node)
    && typeof (node as Group).id === 'string'
    && Array.isArray((node as Group).children);
}

/**
 * Compile a user regex against the whole workspace-relative path.
 * Patterns that do not already use ^ or $ are wrapped as ^(?:pattern)$ so
 * `.*.js` matches `src/foo.js` but not `package.json` (substring `.js`).
 */
function compileUserPattern(pattern: string): RegExp {
  const source = pattern.trim();
  if (!source) {
    throw new Error('Empty pattern');
  }
  const alreadyAnchored = source.startsWith('^') || source.endsWith('$');
  return new RegExp(alreadyAnchored ? source : `^(?:${source})$`);
}

function makeFileNode(uri: string, parentId: string | null): FileNode {
  return { kind: 'file', uri, parentId };
}

function tabResourceUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  return undefined;
}

function parseUriList(raw: string): string[] {
  const uris: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    try {
      uris.push(vscode.Uri.parse(trimmed).toString());
    } catch {
      // ignore malformed entries
    }
  }
  return uris;
}

export class EditorGroupsProvider implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined | null | void> = this._onDidChangeTreeData.event;

  public rootGroups: Group[] = [];
  public sortMode: SortMode = 'name';
  private openUris = new Set<string>();
  private dirtyUris = new Set<string>();
  private fileNodeCache = new Map<string, FileNode>();
  private revealingActive = false;
  private revealQueued = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private storageUri: vscode.Uri | undefined;
  /** Last active editor URI; used to decorate tree rows without relying on selection. */
  private activeUri: string | undefined;
  private lastOpenKey = '';

  constructor() {
    this.initializeStorage();
  }

  private async initializeStorage() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const root = folders[0].uri;
      const vscodeDir = vscode.Uri.joinPath(root, '.vscode');
      try {
        await vscode.workspace.fs.createDirectory(vscodeDir);
      } catch {
        // ignore
      }
      this.storageUri = vscode.Uri.joinPath(vscodeDir, STORAGE_FILE);
    } else {
      this.storageUri = undefined;
    }
    await this.load();
    this.refreshOpenUris();
    this.lastOpenKey = [...this.openUris].sort().join('\0');
    this.activeUri = this.activeFileUri();
    this.refresh();
  }

  public registerListeners(): vscode.Disposable[] {
    return [
      vscode.window.tabGroups.onDidChangeTabs(() => {
        void this.onOpenEditorsChanged();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        void this.onOpenEditorsChanged();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.onActiveEditorChanged();
      }),
      vscode.window.onDidChangeActiveNotebookEditor(() => {
        this.onActiveEditorChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await this.initializeStorage();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const uriStr = e.document.uri.toString();
        if (!this.openUris.has(uriStr)) {
          return;
        }
        const wasDirty = this.dirtyUris.has(uriStr);
        const isDirty = e.document.isDirty;
        if (wasDirty === isDirty) {
          return;
        }
        if (isDirty) {
          this.dirtyUris.add(uriStr);
        } else {
          this.dirtyUris.delete(uriStr);
        }
        this._onDidChangeTreeData.fire();
        void this.revealActiveEditor();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const uriStr = doc.uri.toString();
        if (this.dirtyUris.delete(uriStr)) {
          this._onDidChangeTreeData.fire();
          void this.revealActiveEditor();
        }
      }),
      vscode.workspace.onDidRenameFiles(async (e) => {
        let changed = false;
        for (const { oldUri, newUri } of e.files) {
          if (this.renameUriInTree(oldUri.toString(), newUri.toString())) {
            changed = true;
          }
        }
        if (changed) {
          await this.save();
          this.refresh();
        }
      })
    ];
  }

  private async onOpenEditorsChanged(): Promise<void> {
    this.refreshOpenUris();
    const key = [...this.openUris].sort().join('\0');
    const openedChanged = key !== this.lastOpenKey;
    this.lastOpenKey = key;
    if (openedChanged) {
      this.activeUri = this.activeFileUri();
      this._onDidChangeTreeData.fire();
      setTimeout(() => {
        void this.revealActiveEditor();
      }, 40);
      return;
    }
    this.onActiveEditorChanged();
  }

  private onActiveEditorChanged(): void {
    const next = this.activeFileUri();
    if (next === this.activeUri) {
      void this.revealActiveEditor();
      return;
    }
    const prev = this.activeUri;
    this.activeUri = next;
    this.emitActiveIndicatorChange(prev, next);
    void this.revealActiveEditor();
  }

  private refreshOpenUris() {
    this.openUris.clear();
    this.dirtyUris.clear();
    for (const tg of vscode.window.tabGroups.all) {
      for (const tab of tg.tabs) {
        const uri = tabResourceUri(tab);
        if (!uri) {
          continue;
        }
        const uriStr = uri.toString();
        this.openUris.add(uriStr);
        if (tab.isDirty) {
          this.dirtyUris.add(uriStr);
        }
      }
    }
  }

  private collectAllAssignedUris(): Set<string> {
    const set = new Set<string>();
    const walk = (g: Group) => {
      if (g.pattern) {
        for (const uri of this.openFilesMatching(g.pattern)) {
          set.add(uri);
        }
      }
      for (const child of g.children) {
        if (typeof child === 'string') {
          if (!g.pattern) {
            set.add(child);
          }
        } else if (isGroup(child)) {
          walk(child);
        }
      }
    };
    for (const g of this.rootGroups) {
      walk(g);
    }
    return set;
  }

  private openFilesMatching(pattern: string): string[] {
    let re: RegExp;
    try {
      re = compileUserPattern(pattern);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const uriStr of this.openUris) {
      if (re.test(this.toMatchPath(uriStr))) {
        out.push(uriStr);
      }
    }
    return out;
  }

  private matchesPattern(pattern: string, uriStr: string): boolean {
    try {
      return compileUserPattern(pattern).test(this.toMatchPath(uriStr));
    } catch {
      return false;
    }
  }

  private countOpenFilesInSubtree(group: Group): number {
    let count = 0;
    const walk = (g: Group) => {
      if (g.pattern) {
        count += this.openFilesMatching(g.pattern).length;
      }
      for (const child of g.children) {
        if (typeof child === 'string') {
          if (!g.pattern && this.openUris.has(child)) count++;
        } else if (isGroup(child)) {
          walk(child);
        }
      }
    };
    walk(group);
    return count;
  }

  private countAllFilesInSubtree(group: Group): number {
    let count = 0;
    const walk = (g: Group) => {
      if (g.pattern) {
        count += this.openFilesMatching(g.pattern).length;
      }
      for (const child of g.children ?? []) {
        if (typeof child === 'string') {
          if (!g.pattern) count++;
        } else if (isGroup(child)) {
          walk(child);
        }
      }
    };
    walk(group);
    return count;
  }

  private collectFileUrisInSubtree(group: Group): string[] {
    const uris: string[] = [];
    const walk = (g: Group) => {
      if (g.pattern) {
        uris.push(...this.openFilesMatching(g.pattern));
      }
      for (const child of g.children ?? []) {
        if (typeof child === 'string') {
          if (!g.pattern) uris.push(child);
        } else if (isGroup(child)) {
          walk(child);
        }
      }
    };
    walk(group);
    return uris;
  }

  private collectOpenUrisInSubtree(group: Group): string[] {
    return this.collectFileUrisInSubtree(group).filter((uri) => this.openUris.has(uri));
  }

  // --- Persistence ---

  private async load() {
    this.rootGroups = [];
    if (!this.storageUri) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.storageUri);
      const text = Buffer.from(bytes).toString('utf8');
      const data = JSON.parse(text) as PersistedData;
      if (data && Array.isArray(data.groups)) {
        this.rootGroups = this.sanitizeGroups(data.groups);
      }
      const migrated = this.migrateLegacyPatterns(data?.patterns);
      this.sortMode = this.sanitizeSortMode(data?.sortMode);
      if (migrated) {
        await this.save();
      }
    } catch {
      this.rootGroups = [];
      this.sortMode = 'name';
    }
  }

  private sanitizeSortMode(raw: unknown): SortMode {
    if (raw === 'manual' || raw === 'name' || raw === 'nameDesc') {
      return raw;
    }
    return 'name';
  }

  private sanitizeGroups(groups: any[]): Group[] {
    const result: Group[] = [];
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' ? raw.id : generateId();
      const name = typeof raw.name === 'string' ? raw.name : 'Group';
      let pattern: string | undefined;
      if (typeof raw.pattern === 'string' && raw.pattern.trim()) {
        try {
          compileUserPattern(raw.pattern);
          pattern = raw.pattern.trim();
        } catch {
          pattern = undefined;
        }
      }
      const children: (Group | string)[] = [];
      if (Array.isArray(raw.children)) {
        for (const c of raw.children) {
          if (typeof c === 'string' && c.length > 0) {
            if (!pattern) {
              children.push(this.fromStoragePath(c));
            }
          } else if (c && typeof c === 'object') {
            const sub = this.sanitizeGroups([c]);
            if (sub.length > 0) children.push(sub[0]);
          }
        }
      }
      const expanded = raw.expanded === true ? true : undefined;
      result.push({ id, name, children, pattern, expanded });
    }
    return result;
  }

  private migrateLegacyPatterns(raw: PersistedData['patterns']): boolean {
    if (!Array.isArray(raw) || raw.length === 0) {
      return false;
    }
    let migrated = false;
    for (const item of raw) {
      if (!item || typeof item.pattern !== 'string' || !item.pattern.trim()) continue;
      try {
        compileUserPattern(item.pattern);
      } catch {
        continue;
      }
      let group: Group | undefined;
      if (typeof item.groupId === 'string') {
        group = this.findGroupById(item.groupId);
      }
      if (!group && typeof item.group === 'string') {
        group = this.collectGroupsWithPaths().find((e) => e.path === item.group)?.group;
      }
      if (group && !group.pattern) {
        group.pattern = item.pattern.trim();
        migrated = true;
      }
    }
    return migrated;
  }

  private toPersistedGroups(groups: Group[]): Group[] {
    return groups.map((g) => {
      const persisted: Group = {
        id: g.id,
        name: g.name,
        children: []
      };
      if (g.pattern) {
        persisted.pattern = g.pattern;
      }
      if (g.expanded) {
        persisted.expanded = true;
      }
      for (const c of g.children) {
        if (typeof c === 'string') {
          if (!g.pattern) {
            persisted.children.push(this.toStoragePath(c));
          }
        } else {
          persisted.children.push(this.toPersistedGroups([c])[0]);
        }
      }
      return persisted;
    });
  }

  /**
   * Workspace-relative path with `/` separators so moving the project folder
   * does not break saved groupings. Files outside the workspace (and untitled
   * buffers) stay as full URIs.
   */
  private toStoragePath(uriStr: string): string {
    try {
      const uri = vscode.Uri.parse(uriStr);
      if (uri.scheme === 'untitled') {
        return uriStr;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        return uriStr;
      }
      const rel = vscode.workspace.asRelativePath(uri, folders.length > 1);
      if (!rel || rel === uri.fsPath || path.isAbsolute(rel)) {
        return uriStr;
      }
      return rel.replace(/\\/g, '/');
    } catch {
      return uriStr;
    }
  }

  private fromStoragePath(stored: string): string {
    try {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(stored)) {
        return vscode.Uri.parse(stored).toString();
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        return vscode.Uri.file(stored).toString();
      }
      if (folders.length > 1) {
        const slash = stored.indexOf('/');
        if (slash > 0) {
          const folderName = stored.slice(0, slash);
          const rest = stored.slice(slash + 1);
          const folder = folders.find((f) => f.name === folderName);
          if (folder) {
            return vscode.Uri.joinPath(folder.uri, rest).toString();
          }
        }
      }
      return vscode.Uri.joinPath(folders[0].uri, stored).toString();
    } catch {
      return stored;
    }
  }

  private toMatchPath(uriStr: string): string {
    const stored = this.toStoragePath(uriStr);
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(stored)) {
      return stored;
    }
    try {
      return vscode.Uri.parse(uriStr).fsPath.replace(/\\/g, '/');
    } catch {
      return uriStr;
    }
  }

  public async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.storageUri) {
      return;
    }
    try {
      const data: PersistedData = {
        version: 2,
        groups: this.toPersistedGroups(this.rootGroups),
        sortMode: this.sortMode
      };
      const text = JSON.stringify(data, null, 2);
      await vscode.workspace.fs.writeFile(this.storageUri, Buffer.from(text, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save editor groups: ${err}`);
    }
  }

  // --- TreeDataProvider ---

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (isSeparator(element)) {
      const item = new vscode.TreeItem('Ungrouped', vscode.TreeItemCollapsibleState.None);
      item.id = 'separator:ungrouped';
      item.contextValue = 'separator';
      item.iconPath = new vscode.ThemeIcon('dash');
      item.tooltip = 'Open editors that are not in a group';
      return item;
    }

    if (isFileNode(element)) {
      const uri = vscode.Uri.parse(element.uri);
      const basename = path.basename(uri.fsPath || uri.path);
      const isActive = this.isActiveFile(element.uri);
      const item = new vscode.TreeItem(
        isActive ? { label: basename, highlights: [[0, basename.length]] } : basename
      );
      const dirty = this.dirtyUris.has(element.uri);
      const isOpen = this.openUris.has(element.uri);

      item.id = `f:${element.parentId ?? 'root'}:${element.uri}`;
      item.resourceUri = uri;
      const parent = element.parentId ? this.findGroupById(element.parentId) : undefined;
      item.contextValue = parent?.pattern ? 'file-pattern' : 'file';
      item.iconPath = vscode.ThemeIcon.File;
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [uri, { preview: false }]
      };

      try {
        const rel = vscode.workspace.asRelativePath(uri, false);
        const dir = path.dirname(rel);
        const dirLabel = dir && dir !== '.' && dir !== '' ? dir : undefined;
        const bits: string[] = [];
        if (isActive || dirty) {
          bits.push('●');
        }
        if (dirty && isActive) {
          bits.push('unsaved');
        }
        if (!isOpen) {
          bits.push('closed');
        }
        if (dirLabel) {
          bits.push(dirLabel);
        }
        item.description = bits.length > 0 ? bits.join(' ') : undefined;
        const tooltipExtra = isActive ? ' — active editor' : !isOpen ? ' — closed' : dirty ? ' — unsaved' : '';
        item.tooltip = `${rel}${tooltipExtra}`;
      } catch {
        item.description = isActive ? '●' : !isOpen ? 'closed' : dirty ? '●' : undefined;
        item.tooltip = element.uri;
      }
      return item;
    }

    const group = element;
    const openCount = this.countOpenFilesInSubtree(group);
    const totalCount = this.countAllFilesInSubtree(group);
    const activeHidden = this.collapsedGroupHoldsActive(group);
    const item = new vscode.TreeItem(
      activeHidden
        ? { label: group.name, highlights: [[0, group.name.length]] }
        : group.name,
      group.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `g:${group.id}`;
    const pattern = group.pattern;
    item.contextValue = pattern ? 'group-pattern' : 'group';
    item.iconPath = activeHidden
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('list.highlightForeground'))
      : pattern
        ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('folder');
    const countLabel = openCount > 0
      ? `(${openCount} open)`
      : totalCount > 0
        ? `(${totalCount})`
        : undefined;
    const activeName = activeHidden && this.activeUri ? this.fileBasename(this.activeUri) : undefined;
    const descParts: string[] = [];
    if (pattern) {
      descParts.push(countLabel ? `.* ${countLabel}` : '.*');
    } else if (countLabel) {
      descParts.push(countLabel);
    }
    if (activeName) {
      descParts.push(`● ${activeName}`);
    }
    item.description = descParts.length > 0 ? descParts.join(' ') : undefined;
    const tooltipBits = [group.name];
    if (totalCount > 0) {
      tooltipBits.push(`${openCount} open / ${totalCount} files`);
    }
    if (pattern) {
      tooltipBits.push(`pattern /${pattern}/`);
    }
    if (activeName) {
      tooltipBits.push(`contains active editor ${activeName}`);
    }
    item.tooltip = tooltipBits.join(' — ');
    return item;
  }

  getChildren(element?: TreeElement): Thenable<TreeElement[]> {
    if (element && isGroup(element) && !element.expanded) {
      // VS Code only asks for children of open nodes — keep our flag in sync.
      element.expanded = true;
      this.scheduleSave();
    }
    if (!element) {
      const assigned = this.collectAllAssignedUris();
      const ungrouped: string[] = [];
      for (const uriStr of this.openUris) {
        if (!assigned.has(uriStr)) {
          ungrouped.push(uriStr);
        }
      }
      const ungroupedNodes = this.orderFiles(ungrouped, false).map((uri) => this.cachedFileNode(uri, null));
      if (this.rootGroups.length > 0 && ungroupedNodes.length > 0) {
        return Promise.resolve([...this.rootGroups, UNGROUPED_SEPARATOR, ...ungroupedNodes]);
      }
      return Promise.resolve([...this.rootGroups, ...ungroupedNodes]);
    }

    if (isFileNode(element) || isSeparator(element)) {
      return Promise.resolve([]);
    }

    return Promise.resolve(this.visibleGroupChildren(element));
  }

  private visibleGroupChildren(group: Group): TreeElement[] {
    const groups: Group[] = [];
    const files: string[] = [];
    const mixed: TreeElement[] = [];
    const patternFiles = group.pattern ? this.openFilesMatching(group.pattern) : undefined;
    for (const child of group.children ?? []) {
      if (typeof child === 'string') {
        if (patternFiles) {
          continue;
        }
        if (!this.openUris.has(child)) {
          continue;
        }
        if (this.sortMode === 'manual') {
          mixed.push(this.cachedFileNode(child, group.id));
        } else {
          files.push(child);
        }
      } else if (isGroup(child)) {
        if (this.sortMode === 'manual') {
          mixed.push(child);
        } else {
          groups.push(child);
        }
      }
    }
    if (patternFiles) {
      if (this.sortMode === 'manual') {
        return [
          ...mixed,
          ...this.orderFiles(patternFiles, false).map((uri) => this.cachedFileNode(uri, group.id))
        ];
      }
      return [...groups, ...this.orderFiles(patternFiles, false).map((uri) => this.cachedFileNode(uri, group.id))];
    }
    if (this.sortMode === 'manual') {
      return mixed;
    }
    return [...groups, ...this.orderFiles(files, false).map((uri) => this.cachedFileNode(uri, group.id))];
  }

  private orderFiles(files: string[], preserveStoredOrder: boolean): string[] {
    if (preserveStoredOrder && this.sortMode === 'manual') {
      return files;
    }
    return [...files].sort((a, b) => this.compareFiles(a, b));
  }

  private compareFiles(a: string, b: string): number {
    const ba = path.basename(vscode.Uri.parse(a).fsPath || a);
    const bb = path.basename(vscode.Uri.parse(b).fsPath || b);
    const cmp = ba.localeCompare(bb, undefined, { numeric: true, sensitivity: 'base' });
    return this.sortMode === 'nameDesc' ? -cmp : cmp;
  }

  getParent(element: TreeElement): TreeElement | undefined {
    if (isFileNode(element)) {
      return element.parentId ? this.findGroupById(element.parentId) : undefined;
    }
    if (isSeparator(element)) {
      return undefined;
    }
    return this.findParentGroupForGroup(element);
  }

  // --- Drag and Drop ---

  readonly dragMimeTypes = [MIME_TYPE, URI_LIST_MIME];
  readonly dropMimeTypes = [MIME_TYPE, URI_LIST_MIME, VSCODE_URI_LIST_MIME];

  async handleDrag(
    source: TreeElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const payload: { groups: string[]; files: { uri: string; parentId: string | null }[] } = { groups: [], files: [] };

    for (const el of source) {
      if (isFileNode(el)) {
        payload.files.push({ uri: el.uri, parentId: el.parentId });
      } else if (isGroup(el)) {
        payload.groups.push(el.id);
      }
    }

    dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(payload)));
    if (payload.files.length > 0) {
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(payload.files.map((f) => f.uri).join('\n')));
    }
  }

  async handleDrop(
    target: TreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const internal = dataTransfer.get(MIME_TYPE);
    if (internal) {
      let payload: { groups: string[]; files: { uri: string; parentId: string | null }[] };
      try {
        payload = JSON.parse(await internal.asString());
      } catch {
        return;
      }
      await this.applyInternalDrop(target, payload);
      return;
    }

    const uriListItem = dataTransfer.get(URI_LIST_MIME) ?? dataTransfer.get(VSCODE_URI_LIST_MIME);
    if (!uriListItem) {
      return;
    }

    const uris = parseUriList(await uriListItem.asString());
    await this.applyExternalUriDrop(target, uris);
  }

  private dropAnchor(target: TreeElement | undefined): { destGroup: Group | null; before?: Group | string } {
    if (!target) {
      return { destGroup: null };
    }
    if (isGroup(target)) {
      return { destGroup: target };
    }
    if (isFileNode(target)) {
      return {
        destGroup: target.parentId ? this.findGroupById(target.parentId) ?? null : null,
        before: target.uri
      };
    }
    return { destGroup: null };
  }

  private insertIntoList<T>(list: T[], items: T[], before?: T): void {
    if (items.length === 0) {
      return;
    }
    const idx = before !== undefined ? list.indexOf(before) : -1;
    if (idx < 0) {
      list.push(...items);
    } else {
      list.splice(idx, 0, ...items);
    }
  }

  /** Dragging a file onto a sibling (same group or both ungrouped) means reorder — turn sorting off. */
  private shouldEnableManualReorder(
    files: { uri: string; parentId: string | null }[],
    destGroup: Group | null,
    movingGroups: boolean
  ): boolean {
    if (this.sortMode === 'manual' || movingGroups || files.length === 0 || !destGroup) {
      return false;
    }
    const destId = destGroup?.id ?? null;
    return files.every((f) => f.parentId === destId);
  }

  private async applyInternalDrop(
    target: TreeElement | undefined,
    payload: { groups: string[]; files: { uri: string; parentId: string | null }[] }
  ): Promise<void> {
    if (
      payload.files.length === 1
      && payload.groups.length === 0
      && isFileNode(target)
      && payload.files[0].uri === target.uri
      && payload.files[0].parentId === target.parentId
    ) {
      return;
    }

    const { destGroup, before } = this.dropAnchor(target);
    if (this.shouldEnableManualReorder(payload.files, destGroup, payload.groups.length > 0)) {
      this.captureCurrentVisualOrder();
      this.sortMode = 'manual';
    }
    const groupsToMove: Group[] = [];
    for (const gid of payload.groups) {
      const groupNode = this.findGroupById(gid);
      if (!groupNode) continue;
      if (destGroup && this.groupContains(groupNode, destGroup)) continue;
      groupsToMove.push(groupNode);
    }

    for (const g of groupsToMove) {
      this.removeGroupFromTree(g);
    }
    for (const f of payload.files) {
      if (destGroup?.pattern && !this.matchesPattern(destGroup.pattern, f.uri)) {
        continue;
      }
      this.removeFileFromGroup(f.uri, f.parentId);
    }

    const fileUris = payload.files.map((f) => f.uri);
    const changed = groupsToMove.length > 0 || fileUris.length > 0;
    if (!changed) {
      return;
    }

    if (destGroup) {
      const uniqueFiles = destGroup.pattern
        ? []
        : fileUris.filter((uri) => !this.containsDirectUri(destGroup, uri));
      const items: (Group | string)[] = [...groupsToMove, ...uniqueFiles];
      this.insertIntoList(destGroup.children, items, before);
    } else {
      if (before && isGroup(before)) {
        this.insertIntoList(this.rootGroups, groupsToMove, before);
      } else {
        this.rootGroups.push(...groupsToMove);
      }
    }

    await this.save();
    this.refresh();
  }

  private async applyExternalUriDrop(target: TreeElement | undefined, uriStrs: string[]): Promise<void> {
    if (uriStrs.length === 0) {
      return;
    }

    const { destGroup, before } = this.dropAnchor(target);
    const files: string[] = [];
    const toOpen: vscode.Uri[] = [];

    for (const uriStr of uriStrs) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(uriStr);
      } catch {
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          continue;
        }
      } catch {
        // Might be an unsaved / virtual document; still try to assign + open
      }

      const normalized = uri.toString();
      files.push(normalized);
      toOpen.push(uri);
    }

    if (destGroup && !destGroup.pattern) {
      const uniqueFiles = files.filter((uri) => !this.containsDirectUri(destGroup, uri));
      this.insertIntoList(destGroup.children, uniqueFiles, before);
    }

    for (const uri of toOpen) {
      try {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false, preserveFocus: true });
      } catch {
        // ignore files we cannot open
      }
    }

    if (files.length > 0) {
      await this.save();
    }
    this.refresh();
  }

  // --- Public helpers used by commands ---

  public async createGroupAtRoot(): Promise<Group | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter name for new group',
      value: 'New Group'
    });
    if (!name || !name.trim()) return undefined;

    const newGroup: Group = {
      id: generateId(),
      name: name.trim(),
      children: []
    };
    this.rootGroups.push(newGroup);
    await this.save();
    this.refresh();
    return newGroup;
  }

  public async createSubgroup(parent: Group): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `Create subgroup inside "${parent.name}"`,
      value: 'New Subgroup'
    });
    if (!name || !name.trim()) return;

    const newGroup: Group = {
      id: generateId(),
      name: name.trim(),
      children: []
    };
    parent.children.push(newGroup);
    await this.save();
    this.refresh(parent);
  }

  public async renameGroup(group: Group): Promise<void> {
    const newName = await vscode.window.showInputBox({
      prompt: 'Rename group',
      value: group.name
    });
    if (!newName || !newName.trim() || newName.trim() === group.name) return;

    group.name = newName.trim();
    await this.save();
    this.refresh(group);
  }

  public async deleteGroup(group: Group): Promise<void> {
    const removed = this.removeGroupFromTree(group);
    if (!removed) {
      return;
    }
    await this.save();
    this.refresh();
  }

  public async ungroupFiles(nodes: FileNode[]): Promise<void> {
    let changed = false;
    for (const node of nodes) {
      if (this.removeFileFromGroup(node.uri, node.parentId)) {
        changed = true;
      }
    }
    if (changed) {
      await this.save();
      this.refresh();
    }
  }

  private async pickDestinationGroup(title: string, exclude: Group[] = []): Promise<Group | undefined> {
    const destinations = this.collectGroupsWithPaths().filter(
      (entry) => !exclude.some((sel) => this.groupContains(sel, entry.group))
    );

    if (destinations.length === 0) {
      if (this.rootGroups.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          'No groups yet. Create a group first?',
          'Create Group'
        );
        if (choice === 'Create Group') {
          return this.createGroupAtRoot();
        }
      } else {
        vscode.window.showInformationMessage('No valid destination groups.');
      }
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      destinations.map((entry) => {
        const openCount = this.countOpenFilesInSubtree(entry.group);
        return {
          label: entry.path,
          description: openCount > 0 ? `${openCount} open` : undefined,
          iconPath: new vscode.ThemeIcon('folder'),
          group: entry.group
        };
      }),
      {
        title,
        placeHolder: 'Select a group',
        matchOnDescription: true
      }
    );
    return picked?.group;
  }

  /**
   * Adds files to a group without removing other memberships.
   * Nested groups are listed with a path label, e.g. "Parent / Child".
   */
  public async addToGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    if (unique.length === 0) return;

    const selectedGroups = unique.filter(isGroup);
    const files = this.uniqueFileUris(unique);
    const dest = await this.pickDestinationGroup('Add to Group', selectedGroups);
    if (!dest) return;

    let changed = false;

    for (const g of selectedGroups) {
      if (this.groupContains(g, dest)) continue;
      if (!this.removeGroupFromTree(g)) continue;
      dest.children.push(g);
      changed = true;
    }

    for (const uri of files) {
      if (dest.pattern) {
        continue;
      }
      if (this.containsDirectUri(dest, uri)) {
        continue;
      }
      dest.children.push(uri);
      changed = true;
    }

    if (changed) {
      await this.save();
      this.refresh();
    }
  }

  /**
   * Moves this file entry out of its current group into another group.
   * Other copies of the same file in different groups are left alone.
   */
  public async moveToGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    const files = unique.filter(isFileNode);
    const selectedGroups = unique.filter(isGroup);
    if (files.length === 0 && selectedGroups.length === 0) return;

    const dest = await this.pickDestinationGroup('Move to Group', selectedGroups);
    if (!dest) return;

    let changed = false;

    for (const g of selectedGroups) {
      if (this.groupContains(g, dest)) continue;
      if (!this.removeGroupFromTree(g)) continue;
      dest.children.push(g);
      changed = true;
    }

    for (const node of files) {
      if (node.parentId === dest.id) {
        continue;
      }
      if (dest.pattern) {
        if (!this.matchesPattern(dest.pattern, node.uri)) {
          continue;
        }
        this.removeFileFromGroup(node.uri, node.parentId);
        changed = true;
        continue;
      }
      this.removeFileFromGroup(node.uri, node.parentId);
      if (!this.containsDirectUri(dest, node.uri)) {
        dest.children.push(node.uri);
      }
      changed = true;
    }

    if (changed) {
      await this.save();
      this.refresh();
    }
  }

  public async openAllFilesInGroup(group: Group): Promise<void> {
    const uris = [...new Set(this.collectFileUrisInSubtree(group))];
    for (const uriStr of uris) {
      try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uriStr), {
          preview: false,
          preserveFocus: true
        });
      } catch {
        // ignore
      }
    }
  }

  public async openFilesInGroup(group: Group): Promise<void> {
    const uris = [...new Set(this.collectFileUrisInSubtree(group))];
    if (uris.length === 0) {
      vscode.window.showInformationMessage(`"${group.name}" has no files yet.`);
      return;
    }

    const items = uris.map((uriStr) => {
      const uri = vscode.Uri.parse(uriStr);
      const rel = vscode.workspace.asRelativePath(uri, false);
      return {
        label: path.basename(uri.fsPath || uri.path),
        description: this.openUris.has(uriStr) ? 'open' : 'closed',
        detail: rel,
        uriStr
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: `Open files in ${group.name}`,
      placeHolder: 'Select one or more files to open',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked || picked.length === 0) {
      return;
    }
    for (const item of picked) {
      try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(item.uriStr), {
          preview: false,
          preserveFocus: true
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Wraps the given elements (files and/or groups) into a newly created group.
   * A single in-tree element is wrapped in place. Ungrouped files and multi-selections
   * become a new root group containing those items.
   */
  public async addToNewGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    if (unique.length === 0) return;

    const first = unique[0];
    const defaultName = isFileNode(first)
      ? path.basename(vscode.Uri.parse(first.uri).fsPath || 'File')
      : isGroup(first)
        ? first.name
        : 'New Group';

    const name = await vscode.window.showInputBox({
      prompt: unique.length === 1 ? 'Name for the new group' : `Name for the new group (${unique.length} items)`,
      value: defaultName
    });
    if (!name || !name.trim()) return;

    const wrapper: Group = {
      id: generateId(),
      name: name.trim(),
      children: []
    };

    if (unique.length === 1 && this.replaceElementWithWrapper(first, wrapper)) {
      await this.save();
      this.refresh();
      return;
    }

    for (const el of unique) {
      if (isFileNode(el)) {
        this.removeFileFromGroup(el.uri, el.parentId);
        if (!this.containsDirectUri(wrapper, el.uri)) {
          wrapper.children.push(el.uri);
        }
      } else if (isGroup(el) && !this.groupContains(el, wrapper) && this.removeGroupFromTree(el)) {
        wrapper.children.push(el);
      }
    }

    this.rootGroups.push(wrapper);
    await this.save();
    this.refresh();
  }

  /**
   * Create or edit a regex rule stored on the group. Matching open files appear
   * in the tree but are not written to JSON.
   */
  public async addGroupPattern(preselected?: Group): Promise<void> {
    const group = preselected ?? await this.pickDestinationGroup('Group by Pattern');
    if (!group) return;

    const result = await this.promptGroupPattern(group, group.pattern);
    if (result === undefined) {
      return;
    }

    if (result === null) {
      delete group.pattern;
      await this.save();
      this.refresh();
      vscode.window.showInformationMessage(`Removed pattern from "${group.name}".`);
      return;
    }

    group.pattern = result;
    await this.save();
    this.refresh();
    const n = this.openFilesMatching(result).length;
    vscode.window.showInformationMessage(
      n > 0
        ? `Pattern saved. ${n} open file${n === 1 ? '' : 's'} currently match "${group.name}".`
        : `Pattern saved. Open files matching /${result}/ will appear under "${group.name}".`
    );
  }

  /** `string` = save, `null` = remove, `undefined` = cancel */
  private promptGroupPattern(group: Group, current?: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      box.title = `OEG: Group by Pattern — ${group.name}`;
      box.prompt = 'JavaScript regex against the whole workspace-relative path (/ as separator). Unanchored patterns are matched end-to-end. Enter or Save to apply.';
      box.placeholder = '.*\\.js$';
      box.value = current ?? '';
      box.ignoreFocusOut = true;

      const saveBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('save'),
        tooltip: 'Save'
      };
      const removeBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('trash'),
        tooltip: 'Remove pattern'
      };
      box.buttons = current ? [saveBtn, removeBtn] : [saveBtn];

      const validate = (value: string): string | undefined => {
        if (!value.trim()) {
          return current ? undefined : 'Enter a regular expression';
        }
        try {
          compileUserPattern(value);
          return undefined;
        } catch (err) {
          return String(err);
        }
      };
      box.validationMessage = validate(box.value);

      box.onDidChangeValue((value) => {
        box.validationMessage = validate(value);
      });

      let settled = false;
      const finish = (value: string | null | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        box.hide();
        resolve(value);
      };

      box.onDidTriggerButton((btn) => {
        if (btn === removeBtn) {
          finish(null);
          return;
        }
        const v = box.value.trim();
        const err = validate(v);
        if (err) {
          box.validationMessage = err;
          return;
        }
        finish(v);
      });

      box.onDidAccept(() => {
        const v = box.value.trim();
        if (!v && current) {
          finish(null);
          return;
        }
        const err = validate(v);
        if (err) {
          box.validationMessage = err;
          return;
        }
        finish(v);
      });

      box.onDidHide(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
        box.dispose();
      });

      box.show();
    });
  }

  public async manageGroupPatterns(): Promise<void> {
    const patterned = this.collectGroupsWithPaths().filter((e) => e.group.pattern);
    if (patterned.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        'No group patterns yet.',
        'Add Pattern'
      );
      if (choice === 'Add Pattern') {
        await this.addGroupPattern();
      }
      return;
    }

    type PatternItem = vscode.QuickPickItem & { action?: 'add'; group?: Group };
    const picked = await vscode.window.showQuickPick<PatternItem>(
      [
        { label: '$(add) Add pattern', action: 'add' },
        ...patterned.map((e) => ({
          label: e.group.pattern!,
          description: e.path,
          group: e.group
        }))
      ],
      {
        title: 'OEG: Manage Group Patterns',
        placeHolder: 'Add a pattern, or select one to edit or remove'
      }
    );
    if (!picked) return;

    if (picked.action === 'add') {
      await this.addGroupPattern();
      return;
    }
    if (picked.group) {
      await this.addGroupPattern(picked.group);
    }
  }

  private dedupeElements(elements: TreeElement[]): TreeElement[] {
    const seenGroups = new Set<string>();
    const seenFiles = new Set<string>();
    const result: TreeElement[] = [];
    for (const el of elements) {
      if (isFileNode(el)) {
        const key = `${el.parentId ?? ''}::${el.uri}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        result.push(el);
      } else if (isGroup(el)) {
        if (seenGroups.has(el.id)) continue;
        seenGroups.add(el.id);
        result.push(el);
      }
    }
    return result;
  }

  private uniqueFileUris(elements: TreeElement[]): string[] {
    const seen = new Set<string>();
    const uris: string[] = [];
    for (const el of elements) {
      if (!isFileNode(el) || seen.has(el.uri)) {
        continue;
      }
      seen.add(el.uri);
      uris.push(el.uri);
    }
    return uris;
  }

  private replaceElementWithWrapper(original: TreeElement, wrapper: Group): boolean {
    if (isFileNode(original)) {
      if (!original.parentId) {
        return false;
      }
      const parent = this.findGroupById(original.parentId);
      if (!parent) {
        return false;
      }
      const idx = parent.children.findIndex((c) => c === original.uri);
      if (idx < 0) {
        return false;
      }
      wrapper.children = [original.uri];
      parent.children[idx] = wrapper;
      return true;
    }

    const replaceInList = (list: (Group | string)[]): boolean => {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (isGroup(item) && isGroup(original) && item.id === original.id) {
          wrapper.children = [item];
          list[i] = wrapper;
          return true;
        }
        if (isGroup(item)) {
          if (replaceInList(item.children)) return true;
        }
      }
      return false;
    };

    return replaceInList(this.rootGroups);
  }

  public async closeEditors(uriStrs: string[]): Promise<void> {
    const unique = [...new Set(uriStrs)];
    const toClose: vscode.Tab[] = [];
    for (const tg of vscode.window.tabGroups.all) {
      for (const tab of tg.tabs) {
        const uri = tabResourceUri(tab);
        if (uri && unique.includes(uri.toString())) {
          toClose.push(tab);
        }
      }
    }
    if (toClose.length > 0) {
      await vscode.window.tabGroups.close(toClose);
    }
  }

  public async closeEditorsInGroups(groups: Group[]): Promise<void> {
    const uris: string[] = [];
    for (const g of groups) {
      uris.push(...this.collectOpenUrisInSubtree(g));
    }
    await this.closeEditors(uris);
  }

  public async setSortMode(mode: SortMode): Promise<void> {
    if (mode === this.sortMode) {
      this.refresh();
      return;
    }
    if (mode === 'manual' && this.sortMode !== 'manual') {
      this.captureCurrentVisualOrder();
    }
    this.sortMode = mode;
    await this.save();
    this.refresh();
    const hint = mode === 'manual' ? 'Sorting off — drag files to reorder' : `Sorted ${SORT_LABELS[mode]}`;
    vscode.window.setStatusBarMessage(`OEG: ${hint}`, 2500);
  }

  public async cycleSortMode(): Promise<void> {
    const idx = SORT_CYCLE.indexOf(this.sortMode);
    const next = SORT_CYCLE[(idx < 0 ? 0 : idx + 1) % SORT_CYCLE.length];
    await this.setSortMode(next);
  }

  /** Snapshot the current (sorted) display order so Manual Order keeps what the user sees. */
  private captureCurrentVisualOrder(): void {
    const rewrite = (group: Group) => {
      const groups: Group[] = [];
      const openFiles: string[] = [];
      const closedFiles: string[] = [];
      for (const child of group.children ?? []) {
        if (isGroup(child)) {
          rewrite(child);
          groups.push(child);
        } else if (this.openUris.has(child)) {
          openFiles.push(child);
        } else {
          closedFiles.push(child);
        }
      }
      group.children = [...groups, ...this.orderFiles(openFiles, false), ...closedFiles];
    };
    for (const g of this.rootGroups) {
      rewrite(g);
    }
  }

  public refresh(target?: TreeElement | null | void): void {
    this.refreshOpenUris();
    this.activeUri = this.activeFileUri();
    void vscode.commands.executeCommand('setContext', 'manualEditorGroups.sortMode', this.sortMode);
    if (treeView) {
      treeView.description = SORT_LABELS[this.sortMode];
    }
    this._onDidChangeTreeData.fire(target);
  }

  private cachedFileNode(uri: string, parentId: string | null): FileNode {
    const key = `${parentId ?? ''}::${uri}`;
    let node = this.fileNodeCache.get(key);
    if (!node) {
      node = makeFileNode(uri, parentId);
      this.fileNodeCache.set(key, node);
    }
    return node;
  }

  private activeFileUri(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const fromTab = tab ? tabResourceUri(tab) : undefined;
    if (fromTab) {
      return fromTab.toString();
    }
    return vscode.window.activeTextEditor?.document.uri.toString();
  }

  private isActiveFile(uriStr: string): boolean {
    return !!this.activeUri && this.activeUri === uriStr;
  }

  private fileBasename(uriStr: string): string {
    try {
      const uri = vscode.Uri.parse(uriStr);
      return path.basename(uri.fsPath || uri.path) || uriStr;
    } catch {
      return uriStr;
    }
  }

  private groupContainsFile(group: Group, uriStr: string): boolean {
    if (this.groupDirectlyContainsOpenFile(group, uriStr)) {
      return true;
    }
    for (const c of group.children ?? []) {
      if (isGroup(c) && this.groupContainsFile(c, uriStr)) {
        return true;
      }
    }
    return false;
  }

  /** Collapsed group row that hides the active editor (directly or in a nested group). */
  private collapsedGroupHoldsActive(group: Group): boolean {
    return !group.expanded && !!this.activeUri && this.groupContainsFile(group, this.activeUri);
  }

  private emitActiveIndicatorChange(prev?: string, next?: string): void {
    const uris = [prev, next].filter((u, i, arr): u is string => !!u && arr.indexOf(u) === i);
    if (uris.length === 0) {
      return;
    }
    const walk = (groups: Group[]): void => {
      for (const g of groups) {
        if (uris.some((u) => this.groupContainsFile(g, u))) {
          this._onDidChangeTreeData.fire(g);
        }
        walk((g.children ?? []).filter(isGroup));
      }
    };
    walk(this.rootGroups);
    const assigned = this.collectAllAssignedUris();
    for (const u of uris) {
      if (this.openUris.has(u) && !assigned.has(u)) {
        this._onDidChangeTreeData.fire(this.cachedFileNode(u, null));
      }
    }
  }

  /**
   * True when this group's children are shown: the group and every ancestor
   * are expanded. VS Code cannot highlight a file under a collapsed folder
   * without expanding it.
   */
  private isGroupOpenInTree(groupId: string): boolean {
    const chain = this.findGroupPath(groupId);
    return !!chain && chain.every((g) => g.expanded);
  }

  private findGroupPath(id: string, groups: Group[] = this.rootGroups, trail: Group[] = []): Group[] | undefined {
    for (const g of groups) {
      const next = [...trail, g];
      if (g.id === id) {
        return next;
      }
      const nested = this.findGroupPath(id, (g.children ?? []).filter(isGroup), next);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  private groupDirectlyContainsOpenFile(group: Group, uriStr: string): boolean {
    if (!this.openUris.has(uriStr)) {
      return false;
    }
    if (group.pattern) {
      return this.matchesPattern(group.pattern, uriStr);
    }
    return (group.children ?? []).some((c) => c === uriStr);
  }

  /** First visible occurrence under `groups` (already-expanded ancestors only). */
  private findVisibleOpenFileNode(uriStr: string, groups: Group[] = this.rootGroups): FileNode | undefined {
    for (const g of groups) {
      if (this.isGroupOpenInTree(g.id) && this.groupDirectlyContainsOpenFile(g, uriStr)) {
        return this.cachedFileNode(uriStr, g.id);
      }
      const nested = this.findVisibleOpenFileNode(uriStr, (g.children ?? []).filter(isGroup));
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  /**
   * Follow the active editor without expanding collapsed groups. Prefer the
   * occurrence the user is already looking at (selection), then any expanded
   * group, then ungrouped. Skip entirely if the file is only in collapsed groups.
   */
  private findRevealTarget(uriStr: string): FileNode | undefined {
    const selection = treeView?.selection ?? [];
    for (const s of selection) {
      if (isFileNode(s) && s.uri === uriStr && (s.parentId === null || this.isGroupOpenInTree(s.parentId))) {
        return s;
      }
    }
    for (const s of selection) {
      const scope = isGroup(s)
        ? s
        : isFileNode(s) && s.parentId
          ? this.findGroupById(s.parentId)
          : undefined;
      if (!scope) {
        continue;
      }
      if (this.isGroupOpenInTree(scope.id) && this.groupDirectlyContainsOpenFile(scope, uriStr)) {
        return this.cachedFileNode(uriStr, scope.id);
      }
      const nested = this.findVisibleOpenFileNode(uriStr, (scope.children ?? []).filter(isGroup));
      if (nested) {
        return nested;
      }
    }
    const grouped = this.findVisibleOpenFileNode(uriStr);
    if (grouped) {
      return grouped;
    }
    if (this.openUris.has(uriStr) && !this.collectAllAssignedUris().has(uriStr)) {
      return this.cachedFileNode(uriStr, null);
    }
    return undefined;
  }

  public setGroupExpanded(group: Group, expanded: boolean): void {
    const next = expanded ? true : undefined;
    if (group.expanded === next) {
      return;
    }
    if (next) {
      group.expanded = true;
    } else {
      delete group.expanded;
    }
    this.scheduleSave();
    // Re-style the row: collapsed groups that hide the active file get ● filename.
    this._onDidChangeTreeData.fire(group);
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 300);
  }

  public async revealActiveEditor(): Promise<void> {
    if (!treeView?.visible) {
      return;
    }
    if (this.revealingActive) {
      this.revealQueued = true;
      return;
    }
    const uriStr = this.activeUri ?? this.activeFileUri();
    if (!uriStr || !this.openUris.has(uriStr)) {
      return;
    }
    const target = this.findRevealTarget(uriStr);
    if (!target) {
      return;
    }
    this.revealingActive = true;
    try {
      await treeView.reveal(target, { select: true, focus: false, expand: false });
    } catch {
      // Element may not be materialized yet; label ● still marks the row
    } finally {
      this.revealingActive = false;
      if (this.revealQueued) {
        this.revealQueued = false;
        void this.revealActiveEditor();
      }
    }
  }

  // --- Internal tree mutation helpers ---

  private findGroupById(id: string, groups: Group[] = this.rootGroups): Group | undefined {
    for (const g of groups) {
      if (!isGroup(g)) continue;
      if (g.id === id) return g;
      const found = this.findGroupById(id, (g.children ?? []).filter(isGroup));
      if (found) return found;
    }
    return undefined;
  }

  private removeNode(predicate: (node: Group | string) => boolean): boolean {
    const removeFrom = (list: (Group | string)[]): boolean => {
      const idx = list.findIndex(predicate);
      if (idx !== -1) {
        list.splice(idx, 1);
        return true;
      }
      for (const item of list) {
        if (isGroup(item)) {
          if (removeFrom(item.children)) return true;
        }
      }
      return false;
    };
    return removeFrom(this.rootGroups);
  }

  private removeFileFromGroup(uriStr: string, parentId: string | null): boolean {
    if (!parentId) {
      return true;
    }
    const parent = this.findGroupById(parentId);
    if (!parent) {
      return false;
    }
    const idx = parent.children.findIndex((n) => typeof n === 'string' && n === uriStr);
    if (idx === -1) {
      return false;
    }
    parent.children.splice(idx, 1);
    return true;
  }

  private removeFileFromTree(uriStr: string): boolean {
    return this.removeNode((n) => typeof n === 'string' && n === uriStr);
  }

  private removeGroupFromTree(group: Group): boolean {
    return this.removeNode((n) => isGroup(n) && n.id === group.id);
  }

  private findParentGroupForUri(uriStr: string, groups: Group[] = this.rootGroups): Group | undefined {
    for (const g of groups) {
      if (!isGroup(g)) continue;
      for (const c of g.children ?? []) {
        if (typeof c === 'string' && c === uriStr) return g;
        if (isGroup(c)) {
          const deeper = this.findParentGroupForUri(uriStr, [c]);
          if (deeper) return deeper;
        }
      }
    }
    return undefined;
  }

  private findParentGroupForGroup(target: Group, groups: Group[] = this.rootGroups): Group | undefined {
    for (const g of groups) {
      for (const c of g.children) {
        if (isGroup(c) && c.id === target.id) return g;
        if (isGroup(c)) {
          const deeper = this.findParentGroupForGroup(target, [c]);
          if (deeper) return deeper;
        }
      }
    }
    return undefined;
  }

  private collectGroupsWithPaths(): { group: Group; path: string }[] {
    const result: { group: Group; path: string }[] = [];
    const walk = (groups: Group[], prefix: string) => {
      for (const g of groups) {
        if (!isGroup(g)) continue;
        const pathLabel = prefix ? `${prefix} / ${g.name}` : g.name;
        result.push({ group: g, path: pathLabel });
        walk((g.children ?? []).filter(isGroup), pathLabel);
      }
    };
    walk(this.rootGroups, '');
    return result;
  }

  private containsUri(group: Group, uriStr: string): boolean {
    for (const c of group.children) {
      if (typeof c === 'string' && c === uriStr) return true;
      if (isGroup(c) && this.containsUri(c, uriStr)) return true;
    }
    return false;
  }

  private containsDirectUri(group: Group, uriStr: string): boolean {
    if (group.pattern) {
      return this.matchesPattern(group.pattern, uriStr);
    }
    return (group.children ?? []).some((c) => typeof c === 'string' && c === uriStr);
  }

  /** True if `maybeDescendant` is `ancestor` or nested somewhere under it. */
  private groupContains(ancestor: Group, maybeDescendant: Group): boolean {
    if (ancestor.id === maybeDescendant.id) return true;
    for (const c of ancestor.children) {
      if (isGroup(c) && this.groupContains(c, maybeDescendant)) return true;
    }
    return false;
  }

  private renameUriInTree(oldUri: string, newUri: string): boolean {
    let changed = false;
    const walk = (list: (Group | string)[]) => {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (typeof item === 'string') {
          if (item === oldUri) {
            list[i] = newUri;
            changed = true;
          }
        } else {
          walk(item.children);
        }
      }
    };
    walk(this.rootGroups);
    return changed;
  }

  public coversEveryOpenFile(files: string[]): boolean {
    if (this.openUris.size < 2 || files.length !== this.openUris.size) {
      return false;
    }
    return files.every((f) => this.openUris.has(f));
  }

  public findElementForUri(uriStr: string): TreeElement | undefined {
    const search = (groups: Group[]): TreeElement | undefined => {
      for (const g of groups) {
        for (const c of g.children) {
          if (typeof c === 'string' && c === uriStr) return this.cachedFileNode(c, g.id);
          if (isGroup(c)) {
            const found = search([c]);
            if (found) return found;
          }
        }
      }
      return undefined;
    };
    return search(this.rootGroups);
  }
}

// --- Activation ---

let provider: EditorGroupsProvider | undefined;
let treeView: vscode.TreeView<TreeElement> | undefined;

function isGroupElement(value: unknown): value is Group {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Group).id === 'string'
    && typeof (value as Group).name === 'string'
    && Array.isArray((value as Group).children);
}

function isUriLike(value: unknown): value is vscode.Uri {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !isFileNode(value)
    && typeof (value as vscode.Uri).scheme === 'string'
    && typeof (value as vscode.Uri).toString === 'function'
    && !('children' in (value as object));
}

function normalizeElement(value: unknown): TreeElement | undefined {
  if (isFileNode(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    return makeFileNode(value, null);
  }
  if (isGroupElement(value)) {
    return value;
  }
  if (isUriLike(value)) {
    return makeFileNode(value.toString(), null);
  }
  return undefined;
}

function asElementList(value: unknown): TreeElement[] {
  if (value === undefined || value === null) {
    return [];
  }
  const source = Array.isArray(value) ? value : [value];
  const result: TreeElement[] = [];
  for (const item of source) {
    const el = normalizeElement(item);
    if (el !== undefined) {
      result.push(el);
    }
  }
  return result;
}

function sameElement(a: TreeElement, b: TreeElement): boolean {
  if (isFileNode(a) && isFileNode(b)) {
    return a.uri === b.uri && a.parentId === b.parentId;
  }
  if (isGroup(a) && isGroup(b)) {
    return a.id === b.id;
  }
  return false;
}

function fileUrisOf(elements: TreeElement[]): string[] {
  return elements.filter(isFileNode).map((f) => f.uri);
}

/**
 * Resolve which tree items a context-menu / palette command should act on.
 * VS Code passes (clickedItem, selectedItems[]). Do not use treeView.selection
 * as a stand-in for the clicked file — with canSelectMany it can report every
 * root item, which would add all open editors to a group.
 */
function fileUriFromCommand(element?: unknown): vscode.Uri | undefined {
  const clicked = Array.isArray(element) ? undefined : normalizeElement(element);
  if (isFileNode(clicked)) {
    return vscode.Uri.parse(clicked.uri);
  }
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const tabUri = tab ? tabResourceUri(tab) : undefined;
  return tabUri ?? vscode.window.activeTextEditor?.document.uri;
}

async function copyFileText(element: unknown | undefined, kind: 'path' | 'relative' | 'filename'): Promise<void> {
  const uri = fileUriFromCommand(element);
  if (!uri) {
    return;
  }
  let text: string;
  if (kind === 'path') {
    text = uri.fsPath;
  } else if (kind === 'relative') {
    text = vscode.workspace.asRelativePath(uri, false);
  } else {
    text = path.parse(uri.fsPath || uri.path).name;
  }
  await vscode.env.clipboard.writeText(text);
}

function resolveCommandTargets(item?: unknown, selectedItems?: unknown): TreeElement[] {
  const clicked = Array.isArray(item) ? undefined : normalizeElement(item);
  const selected = asElementList(
    Array.isArray(selectedItems) && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(item) ? item : undefined)
  );

  if (clicked && selected.length > 1 && selected.some((s) => sameElement(s, clicked))) {
    const files = fileUrisOf(selected);
    if (provider?.coversEveryOpenFile(files)) {
      return [clicked];
    }
    return selected;
  }

  if (clicked) {
    return [clicked];
  }

  if (selected.length === 1) {
    return selected;
  }
  if (selected.length > 1) {
    if (!provider?.coversEveryOpenFile(fileUrisOf(selected))) {
      return selected;
    }
  }

  const treeSelection = treeView ? [...treeView.selection] : [];
  if (treeSelection.length === 1) {
    return treeSelection;
  }
  if (treeSelection.length > 1) {
    if (!provider?.coversEveryOpenFile(fileUrisOf(treeSelection))) {
      return treeSelection;
    }
  }

  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const tabUri = tab ? tabResourceUri(tab) : undefined;
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const uri = tabUri ?? editorUri;
  return uri ? [makeFileNode(uri.toString(), null)] : [];
}

export async function activate(context: vscode.ExtensionContext) {
  provider = new EditorGroupsProvider();

  treeView = vscode.window.createTreeView('manualEditorGroups', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    canSelectMany: true
  });

  context.subscriptions.push(treeView);
  context.subscriptions.push(...provider.registerListeners());
  provider.refresh();
  void provider.revealActiveEditor();

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.createGroup', async () => {
      if (!provider) return;
      await provider.createGroupAtRoot();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.createSubgroup', async (element?: TreeElement) => {
      if (!provider) return;
      if (!element || !isGroup(element)) {
        await provider.createGroupAtRoot();
        return;
      }
      await provider.createSubgroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.renameGroup', async (element?: TreeElement) => {
      if (!provider || !element || !isGroup(element)) return;
      await provider.renameGroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.deleteGroup', async (element?: TreeElement) => {
      if (!provider || !element || !isGroup(element)) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete group "${element.name}"? Files in it will become ungrouped. Nested subgroups will also be removed.`,
        { modal: true },
        'Delete'
      );
      if (confirm === 'Delete') {
        await provider.deleteGroup(element);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.ungroupFile', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const files = resolveCommandTargets(element, selectedItems).filter(isFileNode);
      await provider.ungroupFiles(files);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.addToGroup', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const targets = resolveCommandTargets(element, selectedItems);
      if (targets.length === 0) return;
      await provider.addToGroup(targets);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.moveToGroup', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const targets = resolveCommandTargets(element, selectedItems);
      if (targets.length === 0) return;
      await provider.moveToGroup(targets);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.openAllFilesInGroup', async (element?: TreeElement) => {
      if (!provider || !element || !isGroup(element)) return;
      await provider.openAllFilesInGroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.openFilesInGroup', async (element?: TreeElement) => {
      if (!provider || !element || !isGroup(element)) return;
      await provider.openFilesInGroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.addToNewGroup', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const targets = resolveCommandTargets(element, selectedItems);
      if (targets.length === 0) return;
      await provider.addToNewGroup(targets);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.groupByPattern', async (element?: TreeElement) => {
      if (!provider) return;
      const group = element && isGroup(element) ? element : undefined;
      await provider.addGroupPattern(group);
    }),
    vscode.commands.registerCommand('manualEditorGroups.groupByPatternSet', async (element?: TreeElement) => {
      if (!provider) return;
      const group = element && isGroup(element) ? element : undefined;
      await provider.addGroupPattern(group);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.manageGroupPatterns', async () => {
      if (!provider) return;
      await provider.manageGroupPatterns();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.copyPath', async (element?: unknown) => {
      await copyFileText(element, 'path');
    }),
    vscode.commands.registerCommand('manualEditorGroups.copyRelativePath', async (element?: unknown) => {
      await copyFileText(element, 'relative');
    }),
    vscode.commands.registerCommand('manualEditorGroups.copyFilename', async (element?: unknown) => {
      await copyFileText(element, 'filename');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.closeEditor', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const files = fileUrisOf(resolveCommandTargets(element, selectedItems));
      await provider.closeEditors(files);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.closeEditorsInGroup', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const groups = resolveCommandTargets(element, selectedItems).filter(isGroup);
      await provider.closeEditorsInGroups(groups);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.refresh', () => {
      provider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.sortByName', async () => {
      await provider?.setSortMode('name');
    }),
    vscode.commands.registerCommand('manualEditorGroups.sortByNameDesc', async () => {
      await provider?.setSortMode('nameDesc');
    }),
    vscode.commands.registerCommand('manualEditorGroups.sortManual', async () => {
      await provider?.setSortMode('manual');
    }),
    vscode.commands.registerCommand('manualEditorGroups.sortIconAscending', async () => {
      await provider?.cycleSortMode();
    }),
    vscode.commands.registerCommand('manualEditorGroups.sortIconDescending', async () => {
      await provider?.cycleSortMode();
    }),
    vscode.commands.registerCommand('manualEditorGroups.sortIconOff', async () => {
      await provider?.cycleSortMode();
    })
  );

  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        provider?.refresh();
        void provider?.revealActiveEditor();
      }
    }),
    treeView.onDidExpandElement((e) => {
      if (isGroup(e.element)) {
        provider?.setGroupExpanded(e.element, true);
      }
    }),
    treeView.onDidCollapseElement((e) => {
      if (isGroup(e.element)) {
        provider?.setGroupExpanded(e.element, false);
      }
    })
  );
}

export function deactivate() {
  provider = undefined;
  treeView = undefined;
}
