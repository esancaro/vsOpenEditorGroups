import * as vscode from 'vscode';
import * as path from 'path';

// Types for persisted + in-memory model
export interface Group {
  id: string;
  name: string;
  children: (Group | string)[];
}

interface GroupPattern {
  pattern: string;
  groupId: string;
  group: string;
}

type SortMode = 'manual' | 'name' | 'nameDesc';

interface PersistedData {
  version: number;
  groups: Group[];
  patterns?: GroupPattern[];
  sortMode?: SortMode;
  ungroupedOrder?: string[];
}

const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Off',
  name: 'A-Z',
  nameDesc: 'Z-A'
};

const SORT_CYCLE: SortMode[] = ['name', 'nameDesc', 'manual'];

type TreeElement = Group | string; // string = file uri.toString()

const MIME_TYPE = 'application/vnd.code.tree.manualeditorgroups';
const URI_LIST_MIME = 'text/uri-list';
const VSCODE_URI_LIST_MIME = 'application/vnd.code.uri-list';
const STORAGE_FILE = 'editor-groups.json';

function generateId(): string {
  return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function isGroup(node: Group | string): node is Group {
  return typeof node !== 'string';
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
  public patterns: GroupPattern[] = [];
  public sortMode: SortMode = 'name';
  private ungroupedOrder: string[] = [];
  private openUris = new Set<string>();
  private dirtyUris = new Set<string>();
  private consideredOpenUris = new Set<string>();
  private storageUri: vscode.Uri | undefined;

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
    this.consideredOpenUris.clear();
    await this.load();
    this.refreshOpenUris();
    if (this.applyPatternsToNewOpens()) {
      await this.save();
    }
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
        this._onDidChangeTreeData.fire(uriStr);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const uriStr = doc.uri.toString();
        if (this.dirtyUris.delete(uriStr)) {
          this._onDidChangeTreeData.fire(uriStr);
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
    const changed = this.applyPatternsToNewOpens();
    if (changed) {
      await this.save();
    }
    this._onDidChangeTreeData.fire();
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
      for (const child of g.children) {
        if (typeof child === 'string') {
          set.add(child);
        } else {
          walk(child);
        }
      }
    };
    for (const g of this.rootGroups) {
      walk(g);
    }
    return set;
  }

  private countOpenFilesInSubtree(group: Group): number {
    let count = 0;
    const walk = (g: Group) => {
      for (const child of g.children) {
        if (typeof child === 'string') {
          if (this.openUris.has(child)) count++;
        } else {
          walk(child);
        }
      }
    };
    walk(group);
    return count;
  }

  private collectOpenUrisInSubtree(group: Group): string[] {
    const uris: string[] = [];
    const walk = (g: Group) => {
      for (const child of g.children) {
        if (typeof child === 'string') {
          if (this.openUris.has(child)) {
            uris.push(child);
          }
        } else {
          walk(child);
        }
      }
    };
    walk(group);
    return uris;
  }

  // --- Persistence ---

  private async load() {
    this.rootGroups = [];
    this.patterns = [];
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
      this.patterns = this.sanitizePatterns(data?.patterns);
      this.sortMode = this.sanitizeSortMode(data?.sortMode);
      this.ungroupedOrder = this.sanitizeUngroupedOrder(data?.ungroupedOrder);
      this.syncPatternLabels();
    } catch {
      this.rootGroups = [];
      this.patterns = [];
      this.sortMode = 'name';
      this.ungroupedOrder = [];
    }
  }

  private sanitizeSortMode(raw: unknown): SortMode {
    if (raw === 'manual' || raw === 'name' || raw === 'nameDesc') {
      return raw;
    }
    return 'name';
  }

  private sanitizeUngroupedOrder(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string' || !item) continue;
      const uri = this.fromStoragePath(item);
      if (seen.has(uri)) continue;
      seen.add(uri);
      result.push(uri);
    }
    return result;
  }

  private sanitizeGroups(groups: any[]): Group[] {
    const result: Group[] = [];
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' ? raw.id : generateId();
      const name = typeof raw.name === 'string' ? raw.name : 'Group';
      const children: (Group | string)[] = [];
      if (Array.isArray(raw.children)) {
        for (const c of raw.children) {
          if (typeof c === 'string' && c.length > 0) {
            children.push(this.fromStoragePath(c));
          } else if (c && typeof c === 'object') {
            const sub = this.sanitizeGroups([c]);
            if (sub.length > 0) children.push(sub[0]);
          }
        }
      }
      result.push({ id, name, children });
    }
    return result;
  }

  private sanitizePatterns(raw: any): GroupPattern[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const result: GroupPattern[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.pattern !== 'string' || !item.pattern.trim()) continue;
      try {
        new RegExp(item.pattern);
      } catch {
        continue;
      }
      const groupId = typeof item.groupId === 'string' ? item.groupId : '';
      const group = typeof item.group === 'string' ? item.group : '';
      if (!groupId && !group) continue;
      result.push({ pattern: item.pattern, groupId, group });
    }
    return result;
  }

  private toPersistedGroups(groups: Group[]): Group[] {
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      children: g.children.map((c) =>
        typeof c === 'string' ? this.toStoragePath(c) : this.toPersistedGroups([c])[0]
      )
    }));
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
    if (!this.storageUri) {
      return;
    }
    try {
      this.syncPatternLabels();
      const data: PersistedData = {
        version: 2,
        groups: this.toPersistedGroups(this.rootGroups),
        patterns: this.patterns,
        sortMode: this.sortMode,
        ungroupedOrder: this.ungroupedOrder.map((u) => this.toStoragePath(u))
      };
      const text = JSON.stringify(data, null, 2);
      await vscode.workspace.fs.writeFile(this.storageUri, Buffer.from(text, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save editor groups: ${err}`);
    }
  }

  // --- TreeDataProvider ---

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (typeof element === 'string') {
      const uri = vscode.Uri.parse(element);
      const basename = path.basename(uri.fsPath || uri.path);
      const item = new vscode.TreeItem(basename);
      const dirty = this.dirtyUris.has(element);

      item.id = `f:${element}`;
      item.resourceUri = uri;
      item.contextValue = 'file';
      item.iconPath = vscode.ThemeIcon.File;
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [uri]
      };

      try {
        const rel = vscode.workspace.asRelativePath(uri, false);
        const dir = path.dirname(rel);
        const dirLabel = dir && dir !== '.' && dir !== '' ? dir : undefined;
        if (dirty && dirLabel) {
          item.description = `● ${dirLabel}`;
        } else if (dirty) {
          item.description = '●';
        } else if (dirLabel) {
          item.description = dirLabel;
        }
        item.tooltip = dirty ? `${rel} — unsaved` : rel;
      } catch {
        item.description = dirty ? '●' : undefined;
        item.tooltip = dirty ? `${element} — unsaved` : element;
      }
      return item;
    }

    const group = element;
    const openCount = this.countOpenFilesInSubtree(group);
    const item = new vscode.TreeItem(
      group.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `g:${group.id}`;
    item.contextValue = 'group';
    item.iconPath = new vscode.ThemeIcon('folder');
    item.tooltip = openCount > 0 ? `${group.name} — ${openCount} open` : group.name;
    if (openCount > 0) {
      item.description = `(${openCount})`;
    }
    return item;
  }

  getChildren(element?: TreeElement): Thenable<TreeElement[]> {
    if (!element) {
      const assigned = this.collectAllAssignedUris();
      const ungrouped: string[] = [];
      for (const uriStr of this.openUris) {
        if (!assigned.has(uriStr)) {
          ungrouped.push(uriStr);
        }
      }
      return Promise.resolve([...this.rootGroups, ...this.orderFiles(ungrouped, true)]);
    }

    if (typeof element === 'string') {
      return Promise.resolve([]);
    }

    return Promise.resolve(this.visibleGroupChildren(element));
  }

  private visibleGroupChildren(group: Group): TreeElement[] {
    const groups: Group[] = [];
    const files: string[] = [];
    const mixed: TreeElement[] = [];
    for (const child of group.children ?? []) {
      if (typeof child === 'string') {
        if (!this.openUris.has(child)) {
          continue;
        }
        if (this.sortMode === 'manual') {
          mixed.push(child);
        } else {
          files.push(child);
        }
      } else {
        if (this.sortMode === 'manual') {
          mixed.push(child);
        } else {
          groups.push(child);
        }
      }
    }
    if (this.sortMode === 'manual') {
      return mixed;
    }
    return [...groups, ...this.orderFiles(files, false)];
  }

  private orderFiles(files: string[], ungrouped: boolean): string[] {
    if (this.sortMode === 'manual' && ungrouped) {
      const remaining = new Set(files);
      const ordered: string[] = [];
      for (const uriStr of this.ungroupedOrder) {
        if (remaining.has(uriStr)) {
          ordered.push(uriStr);
          remaining.delete(uriStr);
        }
      }
      const rest = [...remaining].sort((a, b) => this.compareFiles(a, b));
      ordered.push(...rest);
      return ordered;
    }
    if (this.sortMode === 'manual') {
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
    if (typeof element === 'string') {
      return this.findParentGroupForUri(element);
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
    const payload: { groups: string[]; files: string[] } = { groups: [], files: [] };

    for (const el of source) {
      if (typeof el === 'string') {
        payload.files.push(el);
      } else {
        payload.groups.push(el.id);
      }
    }

    dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(payload)));
    if (payload.files.length > 0) {
      dataTransfer.set(URI_LIST_MIME, new vscode.DataTransferItem(payload.files.join('\n')));
    }
  }

  async handleDrop(
    target: TreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const internal = dataTransfer.get(MIME_TYPE);
    if (internal) {
      let payload: { groups: string[]; files: string[] };
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

  private dropAnchor(target: TreeElement | undefined): { destGroup: Group | null; before?: TreeElement } {
    if (!target) {
      return { destGroup: null };
    }
    if (isGroup(target)) {
      return { destGroup: target };
    }
    return {
      destGroup: this.findParentGroupForUri(target) ?? null,
      before: target
    };
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
  private shouldEnableManualReorder(files: string[], destGroup: Group | null, movingGroups: boolean): boolean {
    if (this.sortMode === 'manual' || movingGroups || files.length === 0) {
      return false;
    }
    return files.every((f) => (this.findParentGroupForUri(f) ?? null) === destGroup);
  }

  private removeFromUngroupedOrder(uriStr: string): void {
    const idx = this.ungroupedOrder.indexOf(uriStr);
    if (idx >= 0) {
      this.ungroupedOrder.splice(idx, 1);
    }
  }

  private async applyInternalDrop(
    target: TreeElement | undefined,
    payload: { groups: string[]; files: string[] }
  ): Promise<void> {
    if (
      payload.files.length === 1
      && payload.groups.length === 0
      && typeof target === 'string'
      && payload.files[0] === target
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
      this.removeFileFromTree(f);
      this.removeFromUngroupedOrder(f);
    }

    const changed = groupsToMove.length > 0 || payload.files.length > 0;
    if (!changed) {
      return;
    }

    if (destGroup) {
      const items: (Group | string)[] = [...groupsToMove, ...payload.files];
      this.insertIntoList(destGroup.children, items, before);
    } else {
      if (before && isGroup(before)) {
        this.insertIntoList(this.rootGroups, groupsToMove, before);
      } else {
        this.rootGroups.push(...groupsToMove);
      }
      this.insertIntoList(
        this.ungroupedOrder,
        payload.files,
        typeof before === 'string' ? before : undefined
      );
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
      this.removeFileFromTree(normalized);
      this.removeFromUngroupedOrder(normalized);
      files.push(normalized);
      toOpen.push(uri);
    }

    if (destGroup) {
      this.insertIntoList(destGroup.children, files, before);
    } else {
      this.insertIntoList(
        this.ungroupedOrder,
        files,
        typeof before === 'string' ? before : undefined
      );
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
    this.syncPatternLabels();
    await this.save();
    this.refresh(group);
  }

  public async deleteGroup(group: Group): Promise<void> {
    const groupIds = this.collectGroupIds(group);
    const removed = this.removeGroupFromTree(group);
    if (!removed) {
      return;
    }
    this.patterns = (this.patterns ?? []).filter((p) => !groupIds.has(p.groupId));
    this.syncPatternLabels();
    await this.save();
    this.refresh();
  }

  public async ungroupFiles(uriStrs: string[]): Promise<void> {
    let changed = false;
    for (const uriStr of uriStrs) {
      if (this.removeFileFromTree(uriStr)) {
        this.removeFromUngroupedOrder(uriStr);
        this.ungroupedOrder.push(uriStr);
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
   * Moves files and/or groups into an existing group chosen from a Quick Pick.
   * Nested groups are listed with a path label, e.g. "Parent / Child".
   */
  public async addToGroup(elements: TreeElement[]): Promise<void> {
    const unique = this.dedupeElements(elements);
    if (unique.length === 0) return;

    const selectedGroups = unique.filter(isGroup);
    const files = unique.filter((el): el is string => typeof el === 'string');
    const dest = await this.pickDestinationGroup('Add to Group', selectedGroups);
    if (!dest) return;

    let changed = false;

    for (const g of selectedGroups) {
      if (this.groupContains(g, dest)) continue;
      if (!this.removeGroupFromTree(g)) continue;
      dest.children.push(g);
      changed = true;
    }

    for (const f of files) {
      this.removeFileFromTree(f);
      this.removeFromUngroupedOrder(f);
      dest.children.push(f);
      changed = true;
    }

    if (changed) {
      await this.save();
      this.refresh();
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
    const defaultName = typeof first === 'string'
      ? path.basename(vscode.Uri.parse(first).fsPath || 'File')
      : first.name;

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
      if (typeof el === 'string') {
        this.removeFileFromTree(el);
        this.removeFromUngroupedOrder(el);
        wrapper.children.push(el);
      } else if (!this.groupContains(el, wrapper) && this.removeGroupFromTree(el)) {
        wrapper.children.push(el);
      }
    }

    this.rootGroups.push(wrapper);
    await this.save();
    this.refresh();
  }

  /**
   * Create a regex rule that auto-adds a newly opened file to a group when
   * that file is not already assigned to any group. Nested groups are chosen
   * with a "Parent / Child" path. The regex is matched against the
   * workspace-relative path (forward slashes).
   */
  public async addGroupPattern(preselected?: Group): Promise<void> {
    const pattern = await vscode.window.showInputBox({
      title: 'OEG: Group by Pattern',
      prompt: 'Regex against the workspace-relative path (use / as separator). First matching rule wins. Files already in a group are left alone.',
      placeHolder: '.*\\.test\\.ts$',
      validateInput: (value) => {
        if (!value.trim()) {
          return 'Enter a regular expression';
        }
        try {
          new RegExp(value);
          return undefined;
        } catch (err) {
          return String(err);
        }
      }
    });
    if (!pattern) return;

    const group = preselected ?? await this.pickDestinationGroup('Add matching files to group');
    if (!group) return;

    const pathLabel = this.collectGroupsWithPaths().find((e) => e.group.id === group.id)?.path ?? group.name;
    this.patterns.push({
      pattern: pattern.trim(),
      groupId: group.id,
      group: pathLabel
    });

    this.refreshOpenUris();
    const applied = this.applyPatternsToUngroupedOpenFiles();
    await this.save();
    this.refresh();

    const n = applied;
    vscode.window.showInformationMessage(
      n > 0
        ? `Pattern saved. Added ${n} open file${n === 1 ? '' : 's'} to "${pathLabel}".`
        : `Pattern saved. Newly opened files matching /${pattern.trim()}/ will be added to "${pathLabel}".`
    );
  }

  public async manageGroupPatterns(): Promise<void> {
    if (this.patterns.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        'No group patterns yet.',
        'Add Pattern'
      );
      if (choice === 'Add Pattern') {
        await this.addGroupPattern();
      }
      return;
    }

    type PatternItem = vscode.QuickPickItem & { action?: 'add' | 'pattern'; index?: number };
    const picked = await vscode.window.showQuickPick<PatternItem>(
      [
        { label: '$(add) Add pattern', action: 'add' },
        ...this.patterns.map((p, index) => ({
          label: p.pattern,
          description: p.group,
          action: 'pattern' as const,
          index
        }))
      ],
      {
        title: 'OEG: Manage Group Patterns',
        placeHolder: 'Add a pattern, or select one to change its group or delete it'
      }
    );
    if (!picked) return;

    if (picked.action === 'add') {
      await this.addGroupPattern();
      return;
    }

    const index = picked.index;
    if (index === undefined) return;
    const current = this.patterns[index];
    if (!current) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: 'Change group', id: 'move' },
        { label: 'Delete pattern', id: 'delete' }
      ],
      { title: current.pattern, placeHolder: current.group }
    );
    if (!action) return;

    if (action.id === 'delete') {
      this.patterns.splice(index, 1);
      await this.save();
      this.refresh();
      return;
    }

    const dest = await this.pickDestinationGroup('Move this pattern to group');
    if (!dest) return;
    current.groupId = dest.id;
    current.group = this.collectGroupsWithPaths().find((e) => e.group.id === dest.id)?.path ?? dest.name;
    await this.save();
    this.refresh();
  }

  private applyPatternsToNewOpens(): boolean {
    const assigned = this.collectAllAssignedUris();
    let changed = false;
    for (const uriStr of this.openUris) {
      const isNew = !this.consideredOpenUris.has(uriStr);
      this.consideredOpenUris.add(uriStr);
      if (!isNew || assigned.has(uriStr)) {
        continue;
      }
      if (this.tryAssignByPattern(uriStr)) {
        assigned.add(uriStr);
        changed = true;
      }
    }
    for (const uriStr of [...this.consideredOpenUris]) {
      if (!this.openUris.has(uriStr)) {
        this.consideredOpenUris.delete(uriStr);
      }
    }
    return changed;
  }

  /** Apply patterns to every currently open ungrouped file. Returns how many were added. */
  private applyPatternsToUngroupedOpenFiles(): number {
    const assigned = this.collectAllAssignedUris();
    let count = 0;
    for (const uriStr of this.openUris) {
      if (assigned.has(uriStr)) {
        continue;
      }
      if (this.tryAssignByPattern(uriStr)) {
        assigned.add(uriStr);
        this.consideredOpenUris.add(uriStr);
        count++;
      }
    }
    return count;
  }

  private tryAssignByPattern(uriStr: string): boolean {
    const rel = this.toMatchPath(uriStr);
    for (const rule of this.patterns) {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern);
      } catch {
        continue;
      }
      if (!re.test(rel)) {
        continue;
      }
      const group = this.resolvePatternGroup(rule);
      if (!group) {
        continue;
      }
      if (!group.children.includes(uriStr)) {
        group.children.push(uriStr);
      }
      this.removeFromUngroupedOrder(uriStr);
      return true;
    }
    return false;
  }

  private resolvePatternGroup(rule: GroupPattern): Group | undefined {
    const byId = rule.groupId ? this.findGroupById(rule.groupId) : undefined;
    if (byId) {
      return byId;
    }
    if (rule.group) {
      return this.collectGroupsWithPaths().find((e) => e.path === rule.group)?.group;
    }
    return undefined;
  }

  private syncPatternLabels(): void {
    if (!this.patterns) {
      this.patterns = [];
    }
    const paths = this.collectGroupsWithPaths();
    const byId = new Map(paths.map((e) => [e.group.id, e.path]));
    for (const rule of this.patterns) {
      const resolved = this.resolvePatternGroup(rule);
      if (!resolved) {
        continue;
      }
      rule.groupId = resolved.id;
      rule.group = byId.get(resolved.id) ?? resolved.name;
    }
    this.patterns = (this.patterns ?? []).filter((rule) => !!this.resolvePatternGroup(rule));
  }

  private dedupeElements(elements: TreeElement[]): TreeElement[] {
    const seenGroups = new Set<string>();
    const seenFiles = new Set<string>();
    const result: TreeElement[] = [];
    for (const el of elements) {
      if (typeof el === 'string') {
        if (seenFiles.has(el)) continue;
        seenFiles.add(el);
        result.push(el);
      } else {
        if (seenGroups.has(el.id)) continue;
        seenGroups.add(el.id);
        result.push(el);
      }
    }
    return result;
  }

  private replaceElementWithWrapper(original: TreeElement, wrapper: Group): boolean {
    const replaceInList = (list: (Group | string)[]): boolean => {
      for (let i = 0; i < list.length; i++) {
        const item = list[i];

        if (typeof original === 'string') {
          if (item === original) {
            wrapper.children = [item];
            list[i] = wrapper;
            return true;
          }
        } else if (isGroup(item) && item.id === original.id) {
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
    const assigned = this.collectAllAssignedUris();
    const ungrouped: string[] = [];
    for (const uriStr of this.openUris) {
      if (!assigned.has(uriStr)) {
        ungrouped.push(uriStr);
      }
    }
    this.ungroupedOrder = this.orderFiles(ungrouped, true);

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
    void vscode.commands.executeCommand('setContext', 'manualEditorGroups.sortMode', this.sortMode);
    if (treeView) {
      treeView.description = SORT_LABELS[this.sortMode];
    }
    this._onDidChangeTreeData.fire(target);
  }

  // --- Internal tree mutation helpers ---

  private collectGroupIds(group: Group): Set<string> {
    const ids = new Set<string>();
    const walk = (g: Group) => {
      ids.add(g.id);
      for (const c of g.children ?? []) {
        if (isGroup(c)) {
          walk(c);
        }
      }
    };
    walk(group);
    return ids;
  }

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
          if (typeof c === 'string' && c === uriStr) return c;
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
    && typeof (value as vscode.Uri).scheme === 'string'
    && typeof (value as vscode.Uri).toString === 'function'
    && !('children' in (value as object));
}

function normalizeElement(value: unknown): TreeElement | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (isGroupElement(value)) {
    return value;
  }
  if (isUriLike(value)) {
    return value.toString();
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
  if (typeof a === 'string' || typeof b === 'string') {
    return a === b;
  }
  return a.id === b.id;
}

/**
 * Resolve which tree items a context-menu / palette command should act on.
 * VS Code passes (clickedItem, selectedItems[]). Do not use treeView.selection
 * as a stand-in for the clicked file — with canSelectMany it can report every
 * root item, which would add all open editors to a group.
 */
function fileUriFromCommand(element?: unknown): vscode.Uri | undefined {
  const clicked = Array.isArray(element) ? undefined : normalizeElement(element);
  if (typeof clicked === 'string') {
    return vscode.Uri.parse(clicked);
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
    const files = selected.filter((el): el is string => typeof el === 'string');
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
    const files = selected.filter((el): el is string => typeof el === 'string');
    if (!provider?.coversEveryOpenFile(files)) {
      return selected;
    }
  }

  const treeSelection = treeView ? [...treeView.selection] : [];
  if (treeSelection.length === 1) {
    return treeSelection;
  }
  if (treeSelection.length > 1) {
    const files = treeSelection.filter((el): el is string => typeof el === 'string');
    if (!provider?.coversEveryOpenFile(files)) {
      return treeSelection;
    }
  }

  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const tabUri = tab ? tabResourceUri(tab) : undefined;
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const uri = tabUri ?? editorUri;
  return uri ? [uri.toString()] : [];
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

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.createGroup', async () => {
      if (!provider) return;
      await provider.createGroupAtRoot();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.createSubgroup', async (element?: TreeElement) => {
      if (!provider) return;
      if (!element || typeof element === 'string') {
        await provider.createGroupAtRoot();
        return;
      }
      await provider.createSubgroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.renameGroup', async (element?: TreeElement) => {
      if (!provider || !element || typeof element === 'string') return;
      await provider.renameGroup(element);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.deleteGroup', async (element?: TreeElement) => {
      if (!provider || !element || typeof element === 'string') return;
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
      const files = resolveCommandTargets(element, selectedItems).filter((el): el is string => typeof el === 'string');
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
      const group = element && typeof element !== 'string' ? element : undefined;
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
      const files = resolveCommandTargets(element, selectedItems).filter((el): el is string => typeof el === 'string');
      await provider.closeEditors(files);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('manualEditorGroups.closeEditorsInGroup', async (element?: unknown, selectedItems?: unknown) => {
      if (!provider) return;
      const groups = resolveCommandTargets(element, selectedItems).filter((el): el is Group => typeof el !== 'string');
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
      }
    })
  );
}

export function deactivate() {
  provider = undefined;
  treeView = undefined;
}
