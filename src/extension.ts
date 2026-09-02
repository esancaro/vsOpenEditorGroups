import * as vscode from 'vscode';
import * as path from 'path';
import {
  compileUserPattern,
  FileNode,
  folderContainsUri,
  GROUP_FLAGS,
  GroupFlag,
  folderForUri,
  generateId,
  Group,
  isFileNode,
  isGroup,
  isOtherFiles,
  isSeparator,
  isWorkspaceFolder,
  makeFileNode,
  makeSeparator,
  makeWorkspaceNode,
  MIME_TYPE,
  OTHER_FILES_NODE,
  OTHER_STORE_KEY,
  parseUriList,
  SeparatorNode,
  SORT_CYCLE,
  SORT_LABELS,
  SortMode,
  stampStoreKey,
  tabResourceUri,
  TreeElement,
  URI_LIST_MIME,
  VSCODE_URI_LIST_MIME,
  WorkspaceFolderNode
} from './model';
import { WorkspaceHub } from './storage/hub';
import { findGroupById as findGroupInList, FolderStore } from './storage/store';
import { createZip, readZip, safeZipPath, ZipEntry } from './zip';

export type { Group, FileNode, TreeElement, SortMode };

function groupContextValue(group: Group): string {
  const bits = ['group'];
  if (group.pattern) {
    bits.push('pattern');
  }
  if (group.flag) {
    bits.push(`flag-${group.flag}`);
  }
  return bits.join('-');
}

function flagMark(flag: GroupFlag): string {
  if (flag === 'red') {
    return '🔴';
  }
  if (flag === 'yellow') {
    return '🟡';
  }
  return '🟢';
}

function backupStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeFilePart(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'group';
}

export class EditorGroupsProvider implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined | null | void> = this._onDidChangeTreeData.event;

  private openUris = new Set<string>();
  private dirtyUris = new Set<string>();
  private fileNodeCache = new Map<string, FileNode>();
  private revealingActive = false;
  private revealQueued = false;
  private activeUri: string | undefined;
  private lastOpenKey = '';
  private readonly folderExpanded = new Map<string, boolean>();

  constructor(public readonly hub: WorkspaceHub) {
    this.refreshOpenUris();
    this.lastOpenKey = [...this.openUris].sort().join('\0');
    this.activeUri = this.activeFileUri();
  }

  public registerListeners(): vscode.Disposable[] {
    return [
      this.hub.onDidChange(() => {
        this.refresh();
      }),
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
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.hub.discover();
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
        const touched = new Set<FolderStore>();
        for (const { oldUri, newUri } of e.files) {
          for (const store of this.hub.stores()) {
            if (this.renameUriInStore(store, oldUri.toString(), newUri.toString())) {
              touched.add(store);
            }
          }
        }
        await this.persist([...touched]);
        this.refresh();
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

  storeFor(element: TreeElement | undefined): FolderStore | undefined {
    if (!element) {
      return undefined;
    }
    if (isWorkspaceFolder(element)) {
      return this.hub.store(element.storeKey);
    }
    if (isFileNode(element) || isSeparator(element)) {
      return this.hub.store(element.storeKey);
    }
    if (isGroup(element)) {
      return this.storeForGroup(element);
    }
    return undefined;
  }

  private storeForGroup(group: Group): FolderStore | undefined {
    if (group.storeKey) {
      return this.hub.store(group.storeKey);
    }
    for (const store of this.hub.stores()) {
      if (findGroupInList(store.rootGroups, group.id)) {
        return store;
      }
    }
    return undefined;
  }

  private collectAssignedUris(store: FolderStore): Set<string> {
    const set = new Set<string>();
    const walk = (g: Group) => {
      if (g.hidden) {
        return;
      }
      if (g.pattern) {
        for (const uri of this.openFilesMatching(g.pattern, store)) {
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
    for (const g of store.rootGroups) {
      walk(g);
    }
    return set;
  }

  private openFilesMatching(pattern: string, store: FolderStore): string[] {
    let re: RegExp;
    try {
      re = compileUserPattern(pattern);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const uriStr of this.openUris) {
      if (re.test(store.toMatchPath(uriStr))) {
        out.push(uriStr);
      }
    }
    return out;
  }

  private matchesPattern(pattern: string, uriStr: string, store?: FolderStore): boolean {
    const s = store ?? this.hub.stores()[0];
    if (!s) {
      return false;
    }
    try {
      return compileUserPattern(pattern).test(s.toMatchPath(uriStr));
    } catch {
      return false;
    }
  }

  private countOpenFilesInSubtree(group: Group): number {
    const store = this.storeForGroup(group);
    let count = 0;
    const walk = (g: Group) => {
      if (g.pattern && store) {
        count += this.openFilesMatching(g.pattern, store).length;
      }
      for (const child of g.children) {
        if (typeof child === 'string') {
          if (!g.pattern && this.openUris.has(child)) count++;
        } else if (isGroup(child)) {
          if (!child.hidden) walk(child);
        }
      }
    };
    walk(group);
    return count;
  }

  private countAllFilesInSubtree(group: Group): number {
    const store = this.storeForGroup(group);
    let count = 0;
    const walk = (g: Group) => {
      if (g.pattern && store) {
        count += this.openFilesMatching(g.pattern, store).length;
      }
      for (const child of g.children ?? []) {
        if (typeof child === 'string') {
          if (!g.pattern) count++;
        } else if (isGroup(child)) {
          if (!child.hidden) walk(child);
        }
      }
    };
    walk(group);
    return count;
  }

  private collectFileUrisInSubtree(group: Group): string[] {
    const store = this.storeForGroup(group);
    const uris: string[] = [];
    const walk = (g: Group) => {
      if (g.pattern && store) {
        uris.push(...this.openFilesMatching(g.pattern, store));
      }
      for (const child of g.children ?? []) {
        if (typeof child === 'string') {
          if (!g.pattern) uris.push(child);
        } else if (isGroup(child)) {
          if (!child.hidden) walk(child);
        }
      }
    };
    walk(group);
    return uris;
  }

  private collectOpenUrisInSubtree(group: Group): string[] {
    return this.collectFileUrisInSubtree(group).filter((uri) => this.openUris.has(uri));
  }

  private openUrisForFolder(folder: vscode.WorkspaceFolder): string[] {
    const out: string[] = [];
    for (const uri of this.openUris) {
      if (folderContainsUri(folder, uri)) {
        out.push(uri);
      }
    }
    return out;
  }

  private outsideWorkspaceOpenUris(): string[] {
    const folders = this.hub.folders;
    const out: string[] = [];
    for (const uri of this.openUris) {
      if (!folderForUri(uri, folders)) {
        out.push(uri);
      }
    }
    return out;
  }

  private folderHasContent(store: FolderStore): boolean {
    if (store.ready) {
      return true;
    }
    return this.openUrisForFolder(store.folder).length > 0;
  }

  private async persist(stores: FolderStore | FolderStore[] | undefined): Promise<void> {
    const list = !stores ? [] : Array.isArray(stores) ? stores : [stores];
    const unique = [...new Set(list.filter((s): s is FolderStore => !!s))];
    await Promise.all(unique.map((s) => s.save()));
  }

  // --- TreeDataProvider ---

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (isWorkspaceFolder(element)) {
      const expanded = this.folderExpanded.get(element.storeKey) !== false;
      const item = new vscode.TreeItem(
        element.folder.name,
        expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `workspace:${element.storeKey}`;
      item.contextValue = 'workspace';
      item.iconPath = new vscode.ThemeIcon('root-folder');
      item.tooltip = element.folder.uri.fsPath;
      const store = this.hub.store(element.storeKey);
      const holdsActive = !expanded && this.folderHoldsActive(store, element.folder);
      if (holdsActive && this.activeUri) {
        item.label = { label: element.folder.name, highlights: [[0, element.folder.name.length]] };
        item.description = `● ${this.fileBasename(this.activeUri)}`;
      }
      return item;
    }

    if (isOtherFiles(element)) {
      const expanded = this.folderExpanded.get(OTHER_STORE_KEY) !== false;
      const item = new vscode.TreeItem(
        'Other files',
        expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `workspace:${OTHER_STORE_KEY}`;
      item.contextValue = 'other';
      item.iconPath = new vscode.ThemeIcon('files');
      item.tooltip = 'Open editors that are not inside a workspace folder';
      return item;
    }

    if (isSeparator(element)) {
      const item = new vscode.TreeItem('Ungrouped', vscode.TreeItemCollapsibleState.None);
      item.id = `separator:${element.storeKey}`;
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

      item.id = `f:${element.storeKey}:${element.parentId ?? 'root'}:${element.uri}`;
      item.resourceUri = uri;
      const parent = element.parentId ? this.findGroupById(element.parentId, element.storeKey) : undefined;
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
    item.id = `g:${group.storeKey ?? ''}:${group.id}`;
    const pattern = group.pattern;
    item.contextValue = groupContextValue(group);
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
    if (group.flag) {
      descParts.push(flagMark(group.flag));
    }
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
    if (group.flag) {
      tooltipBits.push(`${group.flag} flag`);
    }
    if (activeName) {
      tooltipBits.push(`contains active editor ${activeName}`);
    }
    item.tooltip = tooltipBits.join(' — ');
    return item;
  }

  getChildren(element?: TreeElement): Thenable<TreeElement[]> {
    if (element && isGroup(element) && !element.expanded) {
      element.expanded = true;
      this.storeForGroup(element)?.scheduleSave();
    }
    if (!element) {
      return Promise.resolve(this.topLevel());
    }
    if (isWorkspaceFolder(element)) {
      const store = this.hub.store(element.storeKey);
      return Promise.resolve(store ? this.folderRootChildren(store) : []);
    }
    if (isOtherFiles(element)) {
      return Promise.resolve(this.otherFilesChildren());
    }
    if (isFileNode(element) || isSeparator(element)) {
      return Promise.resolve([]);
    }
    return Promise.resolve(this.visibleGroupChildren(element));
  }

  private topLevel(): TreeElement[] {
    if (!this.hub.isMultiRoot) {
      const store = this.hub.stores()[0];
      if (!store) {
        return this.legacyUngroupedOnly();
      }
      return this.folderRootChildren(store);
    }
    const sections: TreeElement[] = [];
    for (const folder of this.hub.folders) {
      const store = this.hub.store(WorkspaceHub.key(folder));
      if (!store || !this.folderHasContent(store)) {
        continue;
      }
      sections.push(makeWorkspaceNode(folder));
    }
    if (this.outsideWorkspaceOpenUris().length > 0) {
      sections.push(OTHER_FILES_NODE);
    }
    return sections;
  }

  private legacyUngroupedOnly(): TreeElement[] {
    const nodes = this.orderFiles('name', [...this.openUris], false).map((uri) =>
      this.cachedFileNode(uri, null, OTHER_STORE_KEY)
    );
    return nodes;
  }

  private folderRootChildren(store: FolderStore): TreeElement[] {
    const assigned = this.collectAssignedUris(store);
    const ungrouped: string[] = [];
    const candidates = this.hub.isMultiRoot
      ? this.openUrisForFolder(store.folder)
      : [...this.openUris];
    for (const uriStr of candidates) {
      if (!assigned.has(uriStr)) {
        ungrouped.push(uriStr);
      }
    }
    const ungroupedNodes = this.orderFiles(store.sortMode, ungrouped, false).map((uri) =>
      this.cachedFileNode(uri, null, store.storeKey)
    );
    const visibleRoots = store.rootGroups.filter((g) => !g.hidden);
    if (visibleRoots.length > 0 && ungroupedNodes.length > 0) {
      return [...visibleRoots, makeSeparator(store.storeKey), ...ungroupedNodes];
    }
    return [...visibleRoots, ...ungroupedNodes];
  }

  private otherFilesChildren(): TreeElement[] {
    const assigned = new Set<string>();
    for (const store of this.hub.stores()) {
      for (const uri of this.collectAssignedUris(store)) {
        assigned.add(uri);
      }
    }
    const files = this.outsideWorkspaceOpenUris().filter((uri) => !assigned.has(uri));
    return this.orderFiles('name', files, false).map((uri) => this.cachedFileNode(uri, null, OTHER_STORE_KEY));
  }

  private visibleGroupChildren(group: Group): TreeElement[] {
    const store = this.storeForGroup(group);
    const sortMode = store?.sortMode ?? 'name';
    const storeKey = group.storeKey ?? store?.storeKey ?? OTHER_STORE_KEY;
    const groups: Group[] = [];
    const files: string[] = [];
    const mixed: TreeElement[] = [];
    const patternFiles = group.pattern && store ? this.openFilesMatching(group.pattern, store) : undefined;
    for (const child of group.children ?? []) {
      if (typeof child === 'string') {
        if (patternFiles) {
          continue;
        }
        if (!this.openUris.has(child)) {
          continue;
        }
        if (sortMode === 'manual') {
          mixed.push(this.cachedFileNode(child, group.id, storeKey));
        } else {
          files.push(child);
        }
      } else if (isGroup(child)) {
        if (child.hidden) {
          continue;
        }
        child.storeKey = storeKey;
        if (sortMode === 'manual') {
          mixed.push(child);
        } else {
          groups.push(child);
        }
      }
    }
    if (patternFiles) {
      if (sortMode === 'manual') {
        return [
          ...mixed,
          ...this.orderFiles(sortMode, patternFiles, false).map((uri) => this.cachedFileNode(uri, group.id, storeKey))
        ];
      }
      return [...groups, ...this.orderFiles(sortMode, patternFiles, false).map((uri) => this.cachedFileNode(uri, group.id, storeKey))];
    }
    if (sortMode === 'manual') {
      return mixed;
    }
    return [...groups, ...this.orderFiles(sortMode, files, false).map((uri) => this.cachedFileNode(uri, group.id, storeKey))];
  }

  private orderFiles(sortMode: SortMode, files: string[], preserveStoredOrder: boolean): string[] {
    if (preserveStoredOrder && sortMode === 'manual') {
      return files;
    }
    if (sortMode === 'manual') {
      return [...files];
    }
    return [...files].sort((a, b) => this.compareFiles(sortMode, a, b));
  }

  private compareFiles(sortMode: SortMode, a: string, b: string): number {
    const ba = path.basename(vscode.Uri.parse(a).fsPath || a);
    const bb = path.basename(vscode.Uri.parse(b).fsPath || b);
    const cmp = ba.localeCompare(bb, undefined, { numeric: true, sensitivity: 'base' });
    return sortMode === 'nameDesc' ? -cmp : cmp;
  }

  getParent(element: TreeElement): TreeElement | undefined {
    if (isWorkspaceFolder(element) || isOtherFiles(element)) {
      return undefined;
    }
    if (isSeparator(element)) {
      return this.wrapFolder(element.storeKey);
    }
    if (isFileNode(element)) {
      if (element.parentId) {
        return this.findGroupById(element.parentId, element.storeKey);
      }
      return this.wrapFolder(element.storeKey);
    }
    const parent = this.findParentGroupForGroup(element);
    if (parent) {
      return parent;
    }
    return this.wrapFolder(element.storeKey);
  }

  private wrapFolder(storeKey: string | undefined): TreeElement | undefined {
    if (!this.hub.isMultiRoot || !storeKey) {
      return undefined;
    }
    if (storeKey === OTHER_STORE_KEY) {
      return OTHER_FILES_NODE;
    }
    const store = this.hub.store(storeKey);
    return store ? makeWorkspaceNode(store.folder) : undefined;
  }

  // --- Drag and Drop ---

  readonly dragMimeTypes = [MIME_TYPE, URI_LIST_MIME];
  readonly dropMimeTypes = [MIME_TYPE, URI_LIST_MIME, VSCODE_URI_LIST_MIME];

  async handleDrag(
    source: TreeElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const payload: { groups: { id: string; storeKey: string }[]; files: { uri: string; parentId: string | null; storeKey: string }[] } = {
      groups: [],
      files: []
    };

    for (const el of source) {
      if (isFileNode(el)) {
        payload.files.push({ uri: el.uri, parentId: el.parentId, storeKey: el.storeKey });
      } else if (isGroup(el)) {
        payload.groups.push({ id: el.id, storeKey: el.storeKey ?? this.storeForGroup(el)?.storeKey ?? '' });
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
      let payload: { groups: { id: string; storeKey: string }[]; files: { uri: string; parentId: string | null; storeKey: string }[] };
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

  private dropAnchor(target: TreeElement | undefined): {
    destStore: FolderStore | undefined;
    destGroup: Group | null;
    before?: Group | string;
    other?: boolean;
  } {
    if (!target) {
      if (!this.hub.isMultiRoot) {
        return { destStore: this.hub.stores()[0], destGroup: null };
      }
      return { destStore: undefined, destGroup: null };
    }
    if (isOtherFiles(target)) {
      return { destStore: undefined, destGroup: null, other: true };
    }
    if (isWorkspaceFolder(target)) {
      return { destStore: this.hub.store(target.storeKey), destGroup: null };
    }
    if (isSeparator(target)) {
      return { destStore: this.hub.store(target.storeKey), destGroup: null };
    }
    if (isGroup(target)) {
      return { destStore: this.storeForGroup(target), destGroup: target };
    }
    if (isFileNode(target)) {
      return {
        destStore: this.hub.store(target.storeKey),
        destGroup: target.parentId ? this.findGroupById(target.parentId, target.storeKey) ?? null : null,
        before: target.uri
      };
    }
    return { destStore: undefined, destGroup: null };
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

  private areSiblingGroups(groups: Group[], target: Group): boolean {
    if (groups.length === 0) {
      return false;
    }
    const targetStore = this.storeForGroup(target);
    const targetParentId = this.findParentGroupForGroup(target)?.id ?? null;
    return groups.every((g) => {
      if (this.storeForGroup(g) !== targetStore) {
        return false;
      }
      return (this.findParentGroupForGroup(g)?.id ?? null) === targetParentId;
    });
  }

  private insertGroupsBefore(target: Group, groups: Group[]): void {
    if (groups.length === 0) {
      return;
    }
    const parent = this.findParentGroupForGroup(target);
    if (parent) {
      this.insertIntoList(parent.children, groups, target);
    } else {
      const store = this.storeForGroup(target);
      if (store) {
        this.insertIntoList(store.rootGroups, groups, target);
      }
    }
  }

  private shouldEnableManualReorder(
    files: { uri: string; parentId: string | null; storeKey: string }[],
    destStore: FolderStore | undefined,
    destGroup: Group | null,
    movingGroups: boolean
  ): boolean {
    if (!destStore || destStore.sortMode === 'manual' || movingGroups || files.length === 0 || !destGroup) {
      return false;
    }
    const destId = destGroup.id;
    const destKey = destStore.storeKey;
    return files.every((f) => f.parentId === destId && f.storeKey === destKey);
  }

  private async applyInternalDrop(
    target: TreeElement | undefined,
    payload: { groups: { id: string; storeKey: string }[]; files: { uri: string; parentId: string | null; storeKey: string }[] }
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

    const { destStore, destGroup, before, other } = this.dropAnchor(target);
    if (this.shouldEnableManualReorder(payload.files, destStore, destGroup, payload.groups.length > 0)) {
      this.captureCurrentVisualOrder(destStore!);
      destStore!.sortMode = 'manual';
    }

    const groupsToMove: Group[] = [];
    const sourceStores = new Set<FolderStore>();
    for (const item of payload.groups) {
      const store = this.hub.store(item.storeKey);
      const groupNode = store ? findGroupInList(store.rootGroups, item.id) : this.findGroupById(item.id);
      if (!groupNode) continue;
      if (isGroup(target) && groupNode.id === target.id) continue;
      if (destGroup && this.groupContains(groupNode, destGroup)) continue;
      groupsToMove.push(groupNode);
      const src = this.storeForGroup(groupNode);
      if (src) sourceStores.add(src);
    }

    const reorderBeforeSibling = isGroup(target) && this.areSiblingGroups(groupsToMove, target);

    for (const g of groupsToMove) {
      const src = this.storeForGroup(g);
      this.removeGroupFromTree(g);
      if (src) sourceStores.add(src);
    }

    const fileUris: string[] = [];
    for (const f of payload.files) {
      const src = this.hub.store(f.storeKey);
      if (destGroup?.pattern) {
        const dest = destStore ?? this.storeForGroup(destGroup);
        if (!this.matchesPattern(destGroup.pattern, f.uri, dest)) {
          continue;
        }
      }
      this.removeFileFromGroup(f.uri, f.parentId, f.storeKey);
      if (src) sourceStores.add(src);
      fileUris.push(f.uri);
    }

    const changed = groupsToMove.length > 0 || fileUris.length > 0;
    if (!changed) {
      return;
    }

    if (other) {
      await this.persist([...sourceStores]);
      this.refresh();
      return;
    }

    if (reorderBeforeSibling && isGroup(target)) {
      this.insertGroupsBefore(target, groupsToMove);
      if (fileUris.length > 0 && destGroup && destStore && !destGroup.pattern) {
        const uniqueFiles = fileUris.filter((uri) => !this.containsDirectUri(destGroup, uri, destStore));
        this.insertIntoList(destGroup.children, uniqueFiles, before);
      }
      const dest = this.storeForGroup(target);
      if (dest) {
        dest.stampKeys();
        dest.markCreated();
      }
      await this.persist([...sourceStores, dest].filter((s): s is FolderStore => !!s));
      this.refresh();
      return;
    }

    if (destGroup && destStore) {
      const uniqueFiles = destGroup.pattern
        ? []
        : fileUris.filter((uri) => !this.containsDirectUri(destGroup, uri, destStore));
      const items: (Group | string)[] = [...groupsToMove, ...uniqueFiles];
      this.insertIntoList(destGroup.children, items, before);
      destStore.stampKeys();
      destStore.markCreated();
      await this.persist([...sourceStores, destStore]);
      this.refresh();
      return;
    }

    if (destStore) {
      destStore.rootGroups.push(...groupsToMove);
      destStore.stampKeys();
      if (groupsToMove.length > 0) {
        destStore.markCreated();
      }
      await this.persist([...sourceStores, destStore]);
      this.refresh();
      return;
    }

    // Multi-root drop on empty space: send groups to the end of their own store.
    for (const g of groupsToMove) {
      const src = this.hub.store(g.storeKey) ?? [...sourceStores][0];
      if (src) {
        src.rootGroups.push(g);
        src.stampKeys();
        sourceStores.add(src);
      }
    }
    await this.persist([...sourceStores]);
    this.refresh();
  }

  private async applyExternalUriDrop(target: TreeElement | undefined, uriStrs: string[]): Promise<void> {
    if (uriStrs.length === 0) {
      return;
    }

    const { destStore, destGroup, before } = this.dropAnchor(target);
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

    if (destGroup && destStore && !destGroup.pattern) {
      const uniqueFiles = files.filter((uri) => !this.containsDirectUri(destGroup, uri, destStore));
      this.insertIntoList(destGroup.children, uniqueFiles, before);
      destStore.markCreated();
      await destStore.save();
    }

    for (const uri of toOpen) {
      try {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false, preserveFocus: true });
      } catch {
        // ignore files we cannot open
      }
    }

    this.refresh();
  }

  // --- Public helpers used by commands ---

  async pickAdminStore(): Promise<FolderStore | undefined> {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      return undefined;
    }
    return this.hub.ensure(folder);
  }

  public async createGroupAtRoot(store?: FolderStore): Promise<Group | undefined> {
    const dest = store ?? await this.pickAdminStore();
    if (!dest) return undefined;

    const name = await vscode.window.showInputBox({
      prompt: `Enter name for new group`,
      placeHolder: `Create group in ${dest.folder.name}`,
      value: 'New Group'
    });
    if (!name || !name.trim()) return undefined;

    const newGroup: Group = {
      id: generateId(),
      name: name.trim(),
      children: [],
      storeKey: dest.storeKey
    };
    dest.rootGroups.push(newGroup);
    dest.markCreated();
    await dest.save();
    this.refresh();
    return newGroup;
  }

  public async createSubgroup(parent: Group): Promise<void> {
    const store = this.storeForGroup(parent);
    if (!store) return;
    const name = await vscode.window.showInputBox({
      prompt: `Create subgroup inside "${parent.name}"`,
      placeHolder: `Create group in ${store.folder.name}`,
      value: 'New Subgroup'
    });
    if (!name || !name.trim()) return;

    const newGroup: Group = {
      id: generateId(),
      name: name.trim(),
      children: [],
      storeKey: store.storeKey
    };
    parent.children.push(newGroup);
    store.markCreated();
    await store.save();
    this.refresh(parent);
  }

  public async renameGroup(group: Group): Promise<void> {
    const store = this.storeForGroup(group);
    if (!store) return;
    const newName = await vscode.window.showInputBox({
      prompt: 'Rename group',
      value: group.name
    });
    if (!newName || !newName.trim() || newName.trim() === group.name) return;

    group.name = newName.trim();
    await store.save();
    this.refresh(group);
  }

  public async deleteGroup(group: Group): Promise<void> {
    const store = this.storeForGroup(group);
    const removed = this.removeGroupFromTree(group);
    if (!removed) {
      return;
    }
    await this.persist(store);
    this.refresh();
  }

  public async hideGroup(group: Group): Promise<void> {
    const store = this.storeForGroup(group);
    if (!store) {
      return;
    }
    group.hidden = true;
    await store.save();
    this.refresh();
  }

  public async showHiddenGroups(): Promise<void> {
    const hidden = this.collectHiddenGroups();
    if (hidden.length === 0) {
      vscode.window.showInformationMessage('No hidden groups.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      hidden.map((entry) => ({
        label: entry.path,
        description: entry.group.pattern ? '.*' : undefined,
        iconPath: new vscode.ThemeIcon('eye-closed'),
        group: entry.group,
        path: entry.path
      })),
      {
        title: 'Show Hidden Groups',
        placeHolder: 'Select one or more groups to show',
        canPickMany: true,
        matchOnDescription: true
      }
    );
    if (!picked || picked.length === 0) {
      return;
    }

    const selected = new Set(picked.map((p) => p.group));
    const extraParents: { group: Group; path: string }[] = [];
    const extraSeen = new Set<string>();
    for (const item of picked) {
      const chain = this.findGroupPath(item.group.id, item.group.storeKey) ?? [];
      for (const ancestor of chain.slice(0, -1)) {
        if (!ancestor.hidden || selected.has(ancestor) || extraSeen.has(ancestor.id)) {
          continue;
        }
        extraSeen.add(ancestor.id);
        extraParents.push({ group: ancestor, path: this.groupPathLabel(ancestor) });
      }
    }

    if (extraParents.length > 0) {
      const childLabel = picked.length === 1 ? `"${picked[0].path}"` : 'the selected subgroup(s)';
      const parentLabel = extraParents.length === 1
        ? `"${extraParents[0].path}"`
        : extraParents.map((p) => `"${p.path}"`).join(', ');
      const confirm = await vscode.window.showWarningMessage(
        `Unhiding ${childLabel} will also show parent group${extraParents.length === 1 ? '' : 's'} ${parentLabel}. Continue?`,
        { modal: true },
        'Show'
      );
      if (confirm !== 'Show') {
        return;
      }
    }

    const touched = new Set<FolderStore>();
    for (const item of [...picked, ...extraParents]) {
      delete item.group.hidden;
      const store = this.storeForGroup(item.group);
      if (store) {
        touched.add(store);
      }
    }
    await this.persist([...touched]);
    this.refresh();
  }

  public async ungroupFiles(nodes: FileNode[]): Promise<void> {
    const touched = new Set<FolderStore>();
    let changed = false;
    for (const node of nodes) {
      if (this.removeFileFromGroup(node.uri, node.parentId, node.storeKey)) {
        changed = true;
        const store = this.hub.store(node.storeKey);
        if (store) touched.add(store);
      }
    }
    if (changed) {
      await this.persist([...touched]);
      this.refresh();
    }
  }

  public async pickGroupForBackup(title: string): Promise<Group | undefined> {
    return this.pickDestinationGroup(title);
  }

  private async pickDestinationGroup(title: string, exclude: Group[] = []): Promise<Group | undefined> {
    const destinations = this.collectGroupsWithPaths().filter(
      (entry) =>
        !this.isHiddenInTree(entry.group)
        && !exclude.some((sel) => this.groupContains(sel, entry.group))
    );

    if (destinations.length === 0) {
      const anyGroups = this.hub.stores().some((s) => s.rootGroups.length > 0);
      if (!anyGroups) {
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

  public async addToGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    if (unique.length === 0) return;

    const selectedGroups = unique.filter(isGroup);
    const files = this.uniqueFileUris(unique);
    const dest = await this.pickDestinationGroup('Add to Group', selectedGroups);
    if (!dest) return;
    const destStore = this.storeForGroup(dest);
    if (!destStore) return;

    const touched = new Set<FolderStore>([destStore]);
    let changed = false;

    for (const g of selectedGroups) {
      if (this.groupContains(g, dest)) continue;
      const src = this.storeForGroup(g);
      if (!this.removeGroupFromTree(g)) continue;
      if (src) touched.add(src);
      dest.children.push(g);
      changed = true;
    }

    for (const uri of files) {
      if (dest.pattern) {
        continue;
      }
      if (this.containsDirectUri(dest, uri, destStore)) {
        continue;
      }
      dest.children.push(uri);
      changed = true;
    }

    if (changed) {
      destStore.stampKeys();
      destStore.markCreated();
      await this.persist([...touched]);
      this.refresh();
    }
  }

  public async moveToGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    const files = unique.filter(isFileNode);
    const selectedGroups = unique.filter(isGroup);
    if (files.length === 0 && selectedGroups.length === 0) return;

    const dest = await this.pickDestinationGroup('Move to Group', selectedGroups);
    if (!dest) return;
    const destStore = this.storeForGroup(dest);
    if (!destStore) return;

    const touched = new Set<FolderStore>([destStore]);
    let changed = false;

    for (const g of selectedGroups) {
      if (this.groupContains(g, dest)) continue;
      const src = this.storeForGroup(g);
      if (!this.removeGroupFromTree(g)) continue;
      if (src) touched.add(src);
      dest.children.push(g);
      changed = true;
    }

    for (const node of files) {
      if (node.parentId === dest.id && node.storeKey === destStore.storeKey) {
        continue;
      }
      const src = this.hub.store(node.storeKey);
      if (src) touched.add(src);
      if (dest.pattern) {
        if (!this.matchesPattern(dest.pattern, node.uri, destStore)) {
          continue;
        }
        this.removeFileFromGroup(node.uri, node.parentId, node.storeKey);
        changed = true;
        continue;
      }
      this.removeFileFromGroup(node.uri, node.parentId, node.storeKey);
      if (!this.containsDirectUri(dest, node.uri, destStore)) {
        dest.children.push(node.uri);
      }
      changed = true;
    }

    if (changed) {
      destStore.stampKeys();
      destStore.markCreated();
      await this.persist([...touched]);
      this.refresh();
    }
  }

  public async backupGroup(group: Group, kind: 'open' | 'all'): Promise<void> {
    const uris = [...new Set(
      kind === 'open' ? this.collectOpenUrisInSubtree(group) : this.collectFileUrisInSubtree(group)
    )];
    if (uris.length === 0) {
      vscode.window.showInformationMessage(
        kind === 'open'
          ? `"${group.name}" has no open files to back up.`
          : `"${group.name}" has no files to back up.`
      );
      return;
    }

    const entries: ZipEntry[] = [];
    const skipped: string[] = [];
    for (const uriStr of uris) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(uriStr);
      } catch {
        skipped.push(uriStr);
        continue;
      }
      if (uri.scheme === 'untitled') {
        skipped.push(uriStr);
        continue;
      }
      const name = this.zipEntryName(uri);
      if (!name) {
        skipped.push(uri.fsPath || uriStr);
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        entries.push({ name, data: Buffer.from(bytes) });
      } catch {
        skipped.push(name);
      }
    }

    if (entries.length === 0) {
      vscode.window.showWarningMessage(`Could not read any files in "${group.name}" to back up.`);
      return;
    }

    const stamp = backupStamp();
    const kindLabel = kind === 'open' ? 'open' : 'all';
    const defaultName = `${safeFilePart(group.name)}-${kindLabel}-${stamp}.zip`;
    const store = this.storeForGroup(group);
    const defaultUri = store
      ? vscode.Uri.joinPath(store.folder.uri, defaultName)
      : vscode.Uri.file(defaultName);

    const dest = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'Zip archive': ['zip'] },
      saveLabel: 'Backup',
      title: `Backup ${kind === 'open' ? 'open' : 'all'} files in ${group.name}`
    });
    if (!dest) {
      return;
    }

    try {
      const zip = createZip(entries);
      await vscode.workspace.fs.writeFile(dest, zip);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to write backup: ${err}`);
      return;
    }

    const extra = skipped.length > 0 ? ` Skipped ${skipped.length} (untitled, outside workspace, or unreadable).` : '';
    vscode.window.showInformationMessage(
      `Backed up ${entries.length} file${entries.length === 1 ? '' : 's'} from "${group.name}".${extra}`
    );
  }

  public async restoreBackup(_group?: Group): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Zip archive': ['zip'] },
      openLabel: 'Restore',
      title: 'Restore files from a group backup'
    });
    if (!picked || picked.length === 0) {
      return;
    }

    let entries: ZipEntry[];
    let comment = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      const parsed = readZip(Buffer.from(bytes));
      entries = parsed.entries;
      comment = parsed.comment;
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read zip: ${err}`);
      return;
    }

    const stripRoot = this.shouldStripLegacyRootPrefix(entries, comment);
    const planned: { uri: vscode.Uri; name: string; data: Buffer }[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      const safe = safeZipPath(entry.name);
      if (!safe) {
        skipped.push(entry.name);
        continue;
      }
      const uri = this.uriFromZipEntry(safe, stripRoot);
      if (!uri) {
        skipped.push(safe);
        continue;
      }
      planned.push({ uri, name: safe, data: entry.data });
    }

    if (planned.length === 0) {
      vscode.window.showWarningMessage('No files in that zip could be restored into this workspace.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Restore will overwrite ${planned.length} file${planned.length === 1 ? '' : 's'} on disk. Continue?`,
      { modal: true },
      'Overwrite'
    );
    if (confirm !== 'Overwrite') {
      return;
    }

    let written = 0;
    const failed: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Restoring backup' },
      async () => {
        for (const item of planned) {
          try {
            await vscode.workspace.fs.writeFile(item.uri, item.data);
            written++;
          } catch {
            failed.push(item.name);
          }
        }
      }
    );

    const bits = [`Restored ${written} file${written === 1 ? '' : 's'}.`];
    if (failed.length > 0) {
      bits.push(`Failed ${failed.length}.`);
    }
    if (skipped.length > 0) {
      bits.push(`Skipped ${skipped.length} (unsafe or outside workspace).`);
    }
    vscode.window.showInformationMessage(bits.join(' '));
  }

  private zipEntryName(uri: vscode.Uri): string | undefined {
    // Single-folder: path relative to the folder root (`file1.txt`), not `tmp/file1.txt`.
    // Multi-root: prefix with the workspace folder name so restore can pick the right root.
    const rel = vscode.workspace.asRelativePath(uri, this.hub.isMultiRoot);
    if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
      return undefined;
    }
    return safeZipPath(rel.replace(/\\/g, '/'));
  }

  /**
   * Older backups always prefixed the workspace folder name, even in a single-folder
   * window. Those zips have no OEG comment and every entry starts with `FolderName/`.
   */
  private shouldStripLegacyRootPrefix(entries: ZipEntry[], comment: string): boolean {
    if (comment.startsWith('OEG-backup') || this.hub.isMultiRoot) {
      return false;
    }
    const folder = this.hub.folders[0];
    if (!folder) {
      return false;
    }
    const prefix = `${folder.name}/`;
    const files = entries.filter((e) => !e.name.endsWith('/'));
    return files.length > 0 && files.every((e) => safeZipPath(e.name)?.startsWith(prefix));
  }

  private uriFromZipEntry(relative: string, stripLegacyRoot: boolean): vscode.Uri | undefined {
    const folders = this.hub.folders;
    if (folders.length === 0) {
      return undefined;
    }
    if (folders.length > 1) {
      const slash = relative.indexOf('/');
      if (slash > 0) {
        const folderName = relative.slice(0, slash);
        const rest = relative.slice(slash + 1);
        const folder = folders.find((f) => f.name === folderName);
        if (folder && rest) {
          return vscode.Uri.joinPath(folder.uri, rest);
        }
      }
    }
    let rest = relative;
    if (stripLegacyRoot) {
      const name = folders[0].name;
      if (rest === name) {
        return undefined;
      }
      if (rest.startsWith(name + '/')) {
        rest = rest.slice(name.length + 1);
      }
    }
    if (!rest) {
      return undefined;
    }
    return vscode.Uri.joinPath(folders[0].uri, rest);
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

  public async addToNewGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    if (unique.length === 0) return;

    const first = unique[0];
    const defaultName = isFileNode(first)
      ? path.basename(vscode.Uri.parse(first.uri).fsPath || 'File')
      : isGroup(first)
        ? first.name
        : 'New Group';

    let dest = this.storeFor(first);
    if (!dest) {
      dest = await this.pickAdminStore();
    }
    if (!dest) return;

    const name = await vscode.window.showInputBox({
      prompt: unique.length === 1 ? 'Name for the new group' : `Name for the new group (${unique.length} items)`,
      placeHolder: `Create group in ${dest.folder.name}`,
      value: defaultName
    });
    if (!name || !name.trim()) return;

    const wrapper: Group = {
      id: generateId(),
      name: name.trim(),
      children: [],
      storeKey: dest.storeKey
    };

    const touched = new Set<FolderStore>([dest]);
    if (unique.length === 1 && this.replaceElementWithWrapper(first, wrapper)) {
      dest.stampKeys();
      dest.markCreated();
      await dest.save();
      this.refresh();
      return;
    }

    for (const el of unique) {
      if (isFileNode(el)) {
        const src = this.hub.store(el.storeKey);
        this.removeFileFromGroup(el.uri, el.parentId, el.storeKey);
        if (src) touched.add(src);
        if (!this.containsDirectUri(wrapper, el.uri, dest)) {
          wrapper.children.push(el.uri);
        }
      } else if (isGroup(el) && !this.groupContains(el, wrapper) && this.removeGroupFromTree(el)) {
        const src = this.storeForGroup(el);
        if (src) touched.add(src);
        wrapper.children.push(el);
      }
    }

    dest.rootGroups.push(wrapper);
    dest.stampKeys();
    dest.markCreated();
    await this.persist([...touched]);
    this.refresh();
  }

  public async addGroupPattern(preselected?: Group): Promise<void> {
    const group = preselected ?? await this.pickDestinationGroup('Group by Pattern');
    if (!group) return;
    const store = this.storeForGroup(group);
    if (!store) return;

    const result = await this.promptGroupPattern(group, group.pattern);
    if (result === undefined) {
      return;
    }

    if (result === null) {
      delete group.pattern;
      await store.save();
      this.refresh();
      vscode.window.showInformationMessage(`Removed pattern from "${group.name}".`);
      return;
    }

    group.pattern = result;
    store.markCreated();
    await store.save();
    this.refresh();
    const n = this.openFilesMatching(result, store).length;
    vscode.window.showInformationMessage(
      n > 0
        ? `Pattern saved. ${n} open file${n === 1 ? '' : 's'} currently match "${group.name}".`
        : `Pattern saved. Open files matching /${result}/ will appear under "${group.name}".`
    );
  }

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
    const patterned = this.collectGroupsWithPaths().filter((e) => e.group.pattern && !this.isHiddenInTree(e.group));
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
        const key = `${el.storeKey}::${el.parentId ?? ''}::${el.uri}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        result.push(el);
      } else if (isGroup(el)) {
        const key = `${el.storeKey ?? ''}::${el.id}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
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
      const parent = this.findGroupById(original.parentId, original.storeKey);
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

    const store = isGroup(original) ? this.storeForGroup(original) : undefined;
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

    if (store) {
      return replaceInList(store.rootGroups);
    }
    for (const s of this.hub.stores()) {
      if (replaceInList(s.rootGroups)) return true;
    }
    return false;
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

  public async setSortMode(mode: SortMode, store?: FolderStore): Promise<void> {
    const dest = store ?? await this.pickAdminStore();
    if (!dest) return;
    if (mode === dest.sortMode) {
      this.refresh();
      return;
    }
    if (mode === 'manual' && dest.sortMode !== 'manual') {
      this.captureCurrentVisualOrder(dest);
    }
    dest.sortMode = mode;
    if (dest.ready || dest.rootGroups.length > 0) {
      dest.markCreated();
      await dest.save();
    }
    this.refresh();
    const hint = mode === 'manual' ? 'Sorting off — drag files to reorder' : `Sorted ${SORT_LABELS[mode]}`;
    vscode.window.setStatusBarMessage(`OEG: ${hint}`, 2500);
  }

  public async cycleSortMode(store?: FolderStore): Promise<void> {
    const dest = store ?? await this.pickAdminStore();
    if (!dest) return;
    const idx = SORT_CYCLE.indexOf(dest.sortMode);
    const next = SORT_CYCLE[(idx < 0 ? 0 : idx + 1) % SORT_CYCLE.length];
    await this.setSortMode(next, dest);
  }

  private captureCurrentVisualOrder(store: FolderStore): void {
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
      group.children = [...groups, ...this.orderFiles(store.sortMode, openFiles, false), ...closedFiles];
    };
    for (const g of store.rootGroups) {
      rewrite(g);
    }
  }

  public refresh(target?: TreeElement | null | void): void {
    this.refreshOpenUris();
    this.activeUri = this.activeFileUri();
    const sortStore = this.hub.stores().find((s) => this.folderHasContent(s)) ?? this.hub.stores()[0];
    const sortMode = sortStore?.sortMode ?? 'name';
    void vscode.commands.executeCommand('setContext', 'manualEditorGroups.sortMode', sortMode);
    if (treeView) {
      treeView.description = SORT_LABELS[sortMode];
    }
    this._onDidChangeTreeData.fire(target);
  }

  private cachedFileNode(uri: string, parentId: string | null, storeKey: string): FileNode {
    const key = `${storeKey}::${parentId ?? ''}::${uri}`;
    let node = this.fileNodeCache.get(key);
    if (!node) {
      node = makeFileNode(uri, parentId, storeKey);
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
    if (group.hidden) {
      return false;
    }
    if (this.groupDirectlyContainsOpenFile(group, uriStr)) {
      return true;
    }
    for (const c of group.children ?? []) {
      if (isGroup(c) && !c.hidden && this.groupContainsFile(c, uriStr)) {
        return true;
      }
    }
    return false;
  }

  private collapsedGroupHoldsActive(group: Group): boolean {
    return !group.expanded && !!this.activeUri && this.groupContainsFile(group, this.activeUri);
  }

  private folderHoldsActive(store: FolderStore | undefined, folder: vscode.WorkspaceFolder): boolean {
    if (!this.activeUri) {
      return false;
    }
    if (folderContainsUri(folder, this.activeUri)) {
      return true;
    }
    if (!store) {
      return false;
    }
    for (const g of store.rootGroups) {
      if (this.groupContainsFile(g, this.activeUri)) {
        return true;
      }
    }
    return false;
  }

  private emitActiveIndicatorChange(prev?: string, next?: string): void {
    const uris = [prev, next].filter((u, i, arr): u is string => !!u && arr.indexOf(u) === i);
    if (uris.length === 0) {
      return;
    }
    for (const store of this.hub.stores()) {
      const walk = (groups: Group[]): void => {
        for (const g of groups) {
          if (uris.some((u) => this.groupContainsFile(g, u))) {
            this._onDidChangeTreeData.fire(g);
          }
          walk((g.children ?? []).filter(isGroup));
        }
      };
      walk(store.rootGroups);
      if (this.hub.isMultiRoot) {
        this._onDidChangeTreeData.fire(makeWorkspaceNode(store.folder));
      }
    }
    for (const u of uris) {
      const folder = folderForUri(u, this.hub.folders);
      if (!folder) {
        this._onDidChangeTreeData.fire(this.cachedFileNode(u, null, OTHER_STORE_KEY));
      } else {
        const store = this.hub.store(folder.uri.toString());
        if (store && !this.collectAssignedUris(store).has(u)) {
          this._onDidChangeTreeData.fire(this.cachedFileNode(u, null, store.storeKey));
        }
      }
    }
  }

  private isGroupOpenInTree(groupId: string, storeKey?: string): boolean {
    const chain = this.findGroupPath(groupId, storeKey);
    if (!chain || chain.some((g) => g.hidden) || !chain.every((g) => g.expanded)) {
      return false;
    }
    if (this.hub.isMultiRoot && storeKey) {
      return this.folderExpanded.get(storeKey) !== false;
    }
    return true;
  }

  private findGroupPath(id: string, storeKey?: string): Group[] | undefined {
    const search = (groups: Group[], trail: Group[]): Group[] | undefined => {
      for (const g of groups) {
        const next = [...trail, g];
        if (g.id === id) {
          return next;
        }
        const nested = search((g.children ?? []).filter(isGroup), next);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    if (storeKey) {
      const store = this.hub.store(storeKey);
      return store ? search(store.rootGroups, []) : undefined;
    }
    for (const store of this.hub.stores()) {
      const found = search(store.rootGroups, []);
      if (found) return found;
    }
    return undefined;
  }

  private groupDirectlyContainsOpenFile(group: Group, uriStr: string): boolean {
    if (!this.openUris.has(uriStr)) {
      return false;
    }
    if (group.pattern) {
      return this.matchesPattern(group.pattern, uriStr, this.storeForGroup(group));
    }
    return (group.children ?? []).some((c) => c === uriStr);
  }

  private findVisibleOpenFileNode(uriStr: string, groups?: Group[], storeKey?: string): FileNode | undefined {
    const walk = (list: Group[], key: string): FileNode | undefined => {
      for (const g of list) {
        if (g.hidden) {
          continue;
        }
        if (this.isGroupOpenInTree(g.id, g.storeKey ?? key) && this.groupDirectlyContainsOpenFile(g, uriStr)) {
          return this.cachedFileNode(uriStr, g.id, g.storeKey ?? key);
        }
        const nested = walk((g.children ?? []).filter(isGroup), g.storeKey ?? key);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    if (groups && storeKey) {
      return walk(groups, storeKey);
    }
    for (const store of this.hub.stores()) {
      const found = walk(store.rootGroups, store.storeKey);
      if (found) return found;
    }
    return undefined;
  }

  private findRevealTarget(uriStr: string): FileNode | undefined {
    const selection = treeView?.selection ?? [];
    for (const s of selection) {
      if (isFileNode(s) && s.uri === uriStr && (s.parentId === null || this.isGroupOpenInTree(s.parentId, s.storeKey))) {
        return s;
      }
    }
    for (const s of selection) {
      const scope = isGroup(s)
        ? s
        : isFileNode(s) && s.parentId
          ? this.findGroupById(s.parentId, s.storeKey)
          : undefined;
      if (!scope) {
        continue;
      }
      const key = scope.storeKey ?? this.storeForGroup(scope)?.storeKey;
      if (this.isGroupOpenInTree(scope.id, key) && this.groupDirectlyContainsOpenFile(scope, uriStr)) {
        return this.cachedFileNode(uriStr, scope.id, key ?? OTHER_STORE_KEY);
      }
      const nested = this.findVisibleOpenFileNode(uriStr, (scope.children ?? []).filter(isGroup), key);
      if (nested) {
        return nested;
      }
    }
    const grouped = this.findVisibleOpenFileNode(uriStr);
    if (grouped) {
      return grouped;
    }
    const folder = folderForUri(uriStr, this.hub.folders);
    if (folder) {
      const store = this.hub.store(folder.uri.toString());
      if (store && !this.collectAssignedUris(store).has(uriStr)) {
        if (!this.hub.isMultiRoot || this.folderExpanded.get(store.storeKey) !== false) {
          return this.cachedFileNode(uriStr, null, store.storeKey);
        }
      }
    } else if (this.openUris.has(uriStr)) {
      if (!this.hub.isMultiRoot || this.folderExpanded.get(OTHER_STORE_KEY) !== false) {
        return this.cachedFileNode(uriStr, null, OTHER_STORE_KEY);
      }
    }
    return undefined;
  }

  public setFolderExpanded(key: string, expanded: boolean): void {
    this.folderExpanded.set(key, expanded);
  }

  public cycleGroupFlag(group: Group): void {
    const order: Array<GroupFlag | undefined> = [undefined, ...GROUP_FLAGS];
    const idx = order.indexOf(group.flag);
    const next = order[(idx < 0 ? 0 : idx + 1) % order.length];
    if (next) {
      group.flag = next;
    } else {
      delete group.flag;
    }
    this.storeForGroup(group)?.scheduleSave();
    this._onDidChangeTreeData.fire(group);
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
    this.storeForGroup(group)?.scheduleSave();
    this._onDidChangeTreeData.fire(group);
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

  private findGroupById(id: string, storeKey?: string, groups?: Group[]): Group | undefined {
    if (groups) {
      return findGroupInList(groups, id);
    }
    if (storeKey) {
      const store = this.hub.store(storeKey);
      return store ? findGroupInList(store.rootGroups, id) : undefined;
    }
    for (const store of this.hub.stores()) {
      const found = findGroupInList(store.rootGroups, id);
      if (found) return found;
    }
    return undefined;
  }

  private removeNodeFrom(list: (Group | string)[], predicate: (node: Group | string) => boolean): boolean {
    const idx = list.findIndex(predicate);
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
    for (const item of list) {
      if (isGroup(item)) {
        if (this.removeNodeFrom(item.children, predicate)) return true;
      }
    }
    return false;
  }

  private removeFileFromGroup(uriStr: string, parentId: string | null, storeKey?: string): boolean {
    if (!parentId) {
      return true;
    }
    const parent = this.findGroupById(parentId, storeKey);
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

  private removeGroupFromTree(group: Group): boolean {
    const store = this.storeForGroup(group);
    if (store) {
      return this.removeNodeFrom(store.rootGroups, (n) => isGroup(n) && n.id === group.id);
    }
    for (const s of this.hub.stores()) {
      if (this.removeNodeFrom(s.rootGroups, (n) => isGroup(n) && n.id === group.id)) {
        return true;
      }
    }
    return false;
  }

  private findParentGroupForGroup(target: Group, groups?: Group[]): Group | undefined {
    const search = (list: Group[]): Group | undefined => {
      for (const g of list) {
        for (const c of g.children) {
          if (isGroup(c) && c.id === target.id) return g;
          if (isGroup(c)) {
            const deeper = search([c]);
            if (deeper) return deeper;
          }
        }
      }
      return undefined;
    };
    if (groups) {
      return search(groups);
    }
    const store = this.storeForGroup(target);
    if (store) {
      return search(store.rootGroups);
    }
    for (const s of this.hub.stores()) {
      const found = search(s.rootGroups);
      if (found) return found;
    }
    return undefined;
  }

  private isHiddenInTree(group: Group): boolean {
    const chain = this.findGroupPath(group.id, group.storeKey);
    return !!chain?.some((g) => g.hidden);
  }

  private groupPathLabel(group: Group): string {
    const store = this.storeForGroup(group);
    const chain = this.findGroupPath(group.id, group.storeKey);
    const names = (chain ?? [group]).map((g) => g.name);
    if (this.hub.isMultiRoot && store) {
      return [store.folder.name, ...names].join(' / ');
    }
    return names.join(' / ');
  }

  private collectHiddenGroups(): { group: Group; path: string }[] {
    const result: { group: Group; path: string }[] = [];
    for (const store of this.hub.stores()) {
      const walk = (groups: Group[]) => {
        for (const g of groups) {
          if (!isGroup(g)) continue;
          if (g.hidden) {
            result.push({ group: g, path: this.groupPathLabel(g) });
          }
          walk((g.children ?? []).filter(isGroup));
        }
      };
      walk(store.rootGroups);
    }
    return result;
  }

  private collectGroupsWithPaths(): { group: Group; path: string }[] {
    const result: { group: Group; path: string }[] = [];
    const multi = this.hub.isMultiRoot;
    for (const store of this.hub.stores()) {
      const walk = (groups: Group[], prefix: string) => {
        for (const g of groups) {
          if (!isGroup(g)) continue;
          const pathLabel = prefix ? `${prefix} / ${g.name}` : g.name;
          result.push({ group: g, path: pathLabel });
          walk((g.children ?? []).filter(isGroup), pathLabel);
        }
      };
      const prefix = multi ? store.folder.name : '';
      walk(store.rootGroups, prefix);
    }
    return result;
  }

  private containsDirectUri(group: Group, uriStr: string, store?: FolderStore): boolean {
    if (group.pattern) {
      return this.matchesPattern(group.pattern, uriStr, store ?? this.storeForGroup(group));
    }
    return (group.children ?? []).some((c) => typeof c === 'string' && c === uriStr);
  }

  private groupContains(ancestor: Group, maybeDescendant: Group): boolean {
    if (ancestor.id === maybeDescendant.id) return true;
    for (const c of ancestor.children) {
      if (isGroup(c) && this.groupContains(c, maybeDescendant)) return true;
    }
    return false;
  }

  private renameUriInStore(store: FolderStore, oldUri: string, newUri: string): boolean {
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
    walk(store.rootGroups);
    return changed;
  }

  public coversEveryOpenFile(files: string[]): boolean {
    if (this.openUris.size < 2 || files.length !== this.openUris.size) {
      return false;
    }
    return files.every((f) => this.openUris.has(f));
  }
}

// --- Activation ---

let provider: EditorGroupsProvider | undefined;
let treeView: vscode.TreeView<TreeElement> | undefined;

function isGroupElement(value: unknown): value is Group {
  return isGroup(value);
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

function inferStoreKey(uriStr: string): string {
  const folder = folderForUri(uriStr);
  return folder ? folder.uri.toString() : OTHER_STORE_KEY;
}

function normalizeElement(value: unknown): TreeElement | undefined {
  if (isFileNode(value)) {
    return value;
  }
  if (isWorkspaceFolder(value) || isOtherFiles(value) || isSeparator(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    return makeFileNode(value, null, inferStoreKey(value));
  }
  if (isGroupElement(value)) {
    return value;
  }
  if (isUriLike(value)) {
    const uri = value.toString();
    return makeFileNode(uri, null, inferStoreKey(uri));
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
    return a.uri === b.uri && a.parentId === b.parentId && a.storeKey === b.storeKey;
  }
  if (isGroup(a) && isGroup(b)) {
    return a.id === b.id && (a.storeKey ?? '') === (b.storeKey ?? '');
  }
  if (isWorkspaceFolder(a) && isWorkspaceFolder(b)) {
    return a.storeKey === b.storeKey;
  }
  return false;
}

function fileUrisOf(elements: TreeElement[]): string[] {
  return elements.filter(isFileNode).map((f) => f.uri);
}

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
  return uri ? [makeFileNode(uri.toString(), null, inferStoreKey(uri.toString()))] : [];
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage('Open a folder to use Open Editor Groups.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: `$(root-folder) ${folder.name}`,
      description: folder.uri.fsPath,
      folder
    })),
    { placeHolder: 'Which project folder should store this group?' }
  );
  return pick?.folder;
}

export async function activate(context: vscode.ExtensionContext) {
  const hub = new WorkspaceHub();
  await hub.discover();
  provider = new EditorGroupsProvider(hub);

  treeView = vscode.window.createTreeView('manualEditorGroups', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    canSelectMany: true
  });

  context.subscriptions.push(treeView, hub);
  context.subscriptions.push(...provider.registerListeners());
  provider.refresh();
  void provider.revealActiveEditor();

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.createGroup', async (element?: TreeElement) => {
      if (!provider) return;
      if (isWorkspaceFolder(element)) {
        const store = provider.storeFor(element);
        await provider.createGroupAtRoot(store);
        return;
      }
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
    vscode.commands.registerCommand('manualEditorGroups.hideGroup', async (element?: TreeElement) => {
      if (!provider || !element || !isGroup(element)) return;
      await provider.hideGroup(element);
    }),
    vscode.commands.registerCommand('manualEditorGroups.showHiddenGroups', async () => {
      if (!provider) return;
      await provider.showHiddenGroups();
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
    vscode.commands.registerCommand('manualEditorGroups.backupOpen', async (element?: TreeElement) => {
      if (!provider) return;
      const group = element && isGroup(element) ? element : await provider.pickGroupForBackup('Backup Open Files');
      if (!group) return;
      await provider.backupGroup(group, 'open');
    }),
    vscode.commands.registerCommand('manualEditorGroups.backupAll', async (element?: TreeElement) => {
      if (!provider) return;
      const group = element && isGroup(element) ? element : await provider.pickGroupForBackup('Backup All Files');
      if (!group) return;
      await provider.backupGroup(group, 'all');
    }),
    vscode.commands.registerCommand('manualEditorGroups.restoreBackup', async (element?: TreeElement) => {
      if (!provider) return;
      const group = element && isGroup(element) ? element : undefined;
      await provider.restoreBackup(group);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.flagNone', async (element?: TreeElement) => {
      if (provider && element && isGroup(element)) provider.cycleGroupFlag(element);
    }),
    vscode.commands.registerCommand('manualEditorGroups.flagRedOn', async (element?: TreeElement) => {
      if (provider && element && isGroup(element)) provider.cycleGroupFlag(element);
    }),
    vscode.commands.registerCommand('manualEditorGroups.flagYellowOn', async (element?: TreeElement) => {
      if (provider && element && isGroup(element)) provider.cycleGroupFlag(element);
    }),
    vscode.commands.registerCommand('manualEditorGroups.flagGreenOn', async (element?: TreeElement) => {
      if (provider && element && isGroup(element)) provider.cycleGroupFlag(element);
    }),
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
      } else if (isWorkspaceFolder(e.element)) {
        provider?.setFolderExpanded(e.element.storeKey, true);
      } else if (isOtherFiles(e.element)) {
        provider?.setFolderExpanded(OTHER_STORE_KEY, true);
      }
    }),
    treeView.onDidCollapseElement((e) => {
      if (isGroup(e.element)) {
        provider?.setGroupExpanded(e.element, false);
      } else if (isWorkspaceFolder(e.element)) {
        provider?.setFolderExpanded(e.element.storeKey, false);
      } else if (isOtherFiles(e.element)) {
        provider?.setFolderExpanded(OTHER_STORE_KEY, false);
      }
    })
  );
}

export function deactivate() {
  provider = undefined;
  treeView = undefined;
}
