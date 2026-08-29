import * as vscode from 'vscode';
import {
  compileUserPattern,
  fromFolderRelativePath,
  generateId,
  Group,
  isGroup,
  isMissingFileError,
  isUriString,
  PersistedData,
  sanitizeSortMode,
  SortMode,
  stampStoreKey,
  STORAGE_FILE,
  toFolderRelativePath,
  toMatchPath,
} from '../model';

export interface PendingMove {
  sourceKey: string;
  targetKey: string;
  groupPath: string[];
  uri: string;
}

export class FolderStore {
  rootGroups: Group[] = [];
  sortMode: SortMode = 'name';
  private _ready = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private suppressWatch = 0;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(public readonly folder: vscode.WorkspaceFolder) {}

  get storeKey(): string {
    return this.folder.uri.toString();
  }

  get ready(): boolean {
    return this._ready;
  }

  get storageUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, '.vscode', STORAGE_FILE);
  }

  markCreated(): void {
    this._ready = true;
  }

  stampKeys(): void {
    stampStoreKey(this.rootGroups, this.storeKey);
  }

  toStoragePath(uriStr: string): string {
    return toFolderRelativePath(uriStr, this.folder);
  }

  fromStoragePath(stored: string): string {
    return fromFolderRelativePath(stored, this.folder);
  }

  toMatchPath(uriStr: string): string {
    return toMatchPath(uriStr, this.folder);
  }

  async discover(allFolders: readonly vscode.WorkspaceFolder[]): Promise<PendingMove[]> {
    this.ensureWatcher();
    try {
      await vscode.workspace.fs.stat(this.storageUri);
    } catch (err) {
      this.resetEmpty();
      if (!isMissingFileError(err)) {
        this.resetEmpty();
      }
      return [];
    }

    this._ready = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.storageUri);
      const text = Buffer.from(bytes).toString('utf8');
      const data = JSON.parse(text) as PersistedData;
      const pending: PendingMove[] = [];
      if (data && Array.isArray(data.groups)) {
        this.rootGroups = this.sanitizeGroups(data.groups, allFolders, pending, []);
      } else {
        this.rootGroups = [];
      }
      const migrated = this.migrateLegacyPatterns(data?.patterns);
      this.sortMode = sanitizeSortMode(data?.sortMode);
      this.stampKeys();
      if (migrated) {
        await this.save();
      }
      return pending;
    } catch {
      this.rootGroups = [];
      this.sortMode = 'name';
      this.stampKeys();
      return [];
    }
  }

  resetEmpty(): void {
    this.rootGroups = [];
    this.sortMode = 'name';
    this._ready = false;
    this.stampKeys();
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this._ready && this.rootGroups.length === 0) {
      return;
    }
    if (this.rootGroups.length > 0) {
      this._ready = true;
    }
    if (!this._ready) {
      return;
    }

    const vscodeDir = vscode.Uri.joinPath(this.folder.uri, '.vscode');
    this.suppressWatch += 1;
    try {
      try {
        await vscode.workspace.fs.createDirectory(vscodeDir);
      } catch {
        // exists
      }
      const data: PersistedData = {
        version: 2,
        groups: this.toPersistedGroups(this.rootGroups),
        sortMode: this.sortMode
      };
      const text = JSON.stringify(data, null, 2);
      await vscode.workspace.fs.writeFile(this.storageUri, Buffer.from(text, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save editor groups: ${err}`);
    } finally {
      setTimeout(() => {
        this.suppressWatch = Math.max(0, this.suppressWatch - 1);
      }, 150);
    }
  }

  scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 300);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.onDidChangeEmitter.dispose();
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    const pattern = new vscode.RelativePattern(this.folder, `.vscode/${STORAGE_FILE}`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onDisk = () => {
      if (this.suppressWatch > 0) {
        return;
      }
      this.onDidChangeEmitter.fire();
    };
    this.watcher.onDidChange(onDisk);
    this.watcher.onDidCreate(onDisk);
    this.watcher.onDidDelete(onDisk);
  }

  private sanitizeGroups(
    groups: any[],
    allFolders: readonly vscode.WorkspaceFolder[],
    pending: PendingMove[],
    groupPath: string[]
  ): Group[] {
    const result: Group[] = [];
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' ? raw.id : generateId();
      const name = typeof raw.name === 'string' ? raw.name : 'Group';
      const pathNames = [...groupPath, name];
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
            if (pattern) {
              continue;
            }
            const moved = this.extractCrossRoot(c, allFolders, pending, pathNames);
            if (moved) {
              continue;
            }
            children.push(this.fromStoragePath(c));
          } else if (c && typeof c === 'object') {
            const sub = this.sanitizeGroups([c], allFolders, pending, pathNames);
            if (sub.length > 0) children.push(sub[0]);
          }
        }
      }
      const expanded = raw.expanded === true ? true : undefined;
      result.push({ id, name, children, pattern, expanded, storeKey: this.storeKey });
    }
    return result;
  }

  /**
   * Old multi-root files stored `OtherRoot/src/foo.ts` in the first folder's JSON,
   * or a `file://` URI that actually lives in another folder.
   */
  private extractCrossRoot(
    stored: string,
    allFolders: readonly vscode.WorkspaceFolder[],
    pending: PendingMove[],
    groupPath: string[]
  ): boolean {
    if (allFolders.length < 2) {
      return false;
    }
    if (isUriString(stored)) {
      try {
        const uri = vscode.Uri.parse(stored).toString();
        const owner = folderOwner(uri, allFolders);
        if (owner && owner.uri.toString() !== this.storeKey) {
          pending.push({ sourceKey: this.storeKey, targetKey: owner.uri.toString(), groupPath, uri });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
    const slash = stored.indexOf('/');
    if (slash <= 0) {
      return false;
    }
    const folderName = stored.slice(0, slash);
    const rest = stored.slice(slash + 1);
    const other = allFolders.find((f) => f.name === folderName && f.uri.toString() !== this.storeKey);
    if (!other) {
      return false;
    }
    pending.push({
      sourceKey: this.storeKey,
      targetKey: other.uri.toString(),
      groupPath,
      uri: vscode.Uri.joinPath(other.uri, rest).toString()
    });
    return true;
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
        group = findGroupById(this.rootGroups, item.groupId);
      }
      if (!group && typeof item.group === 'string') {
        group = findGroupByPath(this.rootGroups, item.group);
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
}

function folderOwner(uriStr: string, folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(uriStr);
  } catch {
    return undefined;
  }
  if (uri.scheme === 'untitled') {
    return undefined;
  }
  const filePath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  for (const folder of folders) {
    const base = folder.uri.fsPath.replace(/\\/g, '/').toLowerCase();
    if (filePath === base || filePath.startsWith(base + '/')) {
      if (base.length > bestLen) {
        best = folder;
        bestLen = base.length;
      }
    }
  }
  return best;
}

export function findGroupById(groups: Group[], id: string): Group | undefined {
  for (const g of groups) {
    if (g.id === id) {
      return g;
    }
    const found = findGroupById(g.children.filter(isGroup), id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findGroupByPath(groups: Group[], pathLabel: string): Group | undefined {
  const walk = (list: Group[], prefix: string): Group | undefined => {
    for (const g of list) {
      const next = prefix ? `${prefix} / ${g.name}` : g.name;
      if (next === pathLabel) {
        return g;
      }
      const found = walk(g.children.filter(isGroup), next);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return walk(groups, '');
}

export function ensureGroupPath(store: FolderStore, names: string[]): Group | undefined {
  if (names.length === 0) {
    return undefined;
  }
  let list = store.rootGroups;
  let current: Group | undefined;
  for (const name of names) {
    current = list.find((g) => isGroup(g) && g.name === name);
    if (!current) {
      current = {
        id: generateId(),
        name,
        children: [],
        storeKey: store.storeKey
      };
      list.push(current);
    }
    list = current.children.filter(isGroup);
  }
  return current;
}
