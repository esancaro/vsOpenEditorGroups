import * as path from 'path';
import * as vscode from 'vscode';

export const STORAGE_FILE = 'editor-groups.json';
export const OTHER_STORE_KEY = 'oeg:other';
export const MIME_TYPE = 'application/vnd.code.tree.manualeditorgroups';
export const URI_LIST_MIME = 'text/uri-list';
export const VSCODE_URI_LIST_MIME = 'application/vnd.code.uri-list';

export type SortMode = 'manual' | 'name' | 'nameDesc';
export type GroupFlag = 'red' | 'yellow' | 'green';

export const GROUP_FLAGS: GroupFlag[] = ['red', 'yellow', 'green'];

export function sanitizeGroupFlag(raw: unknown): GroupFlag | undefined {
  if (raw === 'red' || raw === 'yellow' || raw === 'green') {
    return raw;
  }
  return undefined;
}

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Off',
  name: 'A-Z',
  nameDesc: 'Z-A'
};

export const SORT_CYCLE: SortMode[] = ['name', 'nameDesc', 'manual'];

export interface Group {
  id: string;
  name: string;
  children: (Group | string)[];
  pattern?: string;
  /** When true, the group starts expanded. Omitted means collapsed. */
  expanded?: boolean;
  /** Optional status flag shown as an inline color on the group. */
  flag?: GroupFlag;
  /** When true, the group is hidden and inactive until shown again. */
  hidden?: boolean;
  /** In-memory only; never written to JSON. */
  storeKey?: string;
}

export interface PersistedData {
  version: number;
  groups: Group[];
  /** @deprecated Migrated onto Group.pattern on load. */
  patterns?: { pattern: string; groupId?: string; group?: string }[];
  sortMode?: SortMode;
}

export interface FileNode {
  kind: 'file';
  uri: string;
  parentId: string | null;
  storeKey: string;
}

export interface SeparatorNode {
  kind: 'separator';
  storeKey: string;
}

export interface WorkspaceFolderNode {
  kind: 'workspace';
  storeKey: string;
  folder: vscode.WorkspaceFolder;
}

export interface OtherFilesNode {
  kind: 'other';
}

export type TreeElement = WorkspaceFolderNode | OtherFilesNode | Group | FileNode | SeparatorNode;

export function generateId(): string {
  return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export function isFileNode(node: unknown): node is FileNode {
  return !!node && typeof node === 'object' && (node as FileNode).kind === 'file';
}

export function isSeparator(node: unknown): node is SeparatorNode {
  return !!node && typeof node === 'object' && (node as SeparatorNode).kind === 'separator';
}

export function isWorkspaceFolder(node: unknown): node is WorkspaceFolderNode {
  return !!node && typeof node === 'object' && (node as WorkspaceFolderNode).kind === 'workspace';
}

export function isOtherFiles(node: unknown): node is OtherFilesNode {
  return !!node && typeof node === 'object' && (node as OtherFilesNode).kind === 'other';
}

export function isGroup(node: unknown): node is Group {
  return !!node
    && typeof node === 'object'
    && !isFileNode(node)
    && !isSeparator(node)
    && !isWorkspaceFolder(node)
    && !isOtherFiles(node)
    && typeof (node as Group).id === 'string'
    && Array.isArray((node as Group).children);
}

export function makeFileNode(uri: string, parentId: string | null, storeKey: string): FileNode {
  return { kind: 'file', uri, parentId, storeKey };
}

export function makeSeparator(storeKey: string): SeparatorNode {
  return { kind: 'separator', storeKey };
}

export function makeWorkspaceNode(folder: vscode.WorkspaceFolder): WorkspaceFolderNode {
  return { kind: 'workspace', storeKey: folder.uri.toString(), folder };
}

export const OTHER_FILES_NODE: OtherFilesNode = { kind: 'other' };

/**
 * Compile a user regex against the whole workspace-relative path.
 * Patterns that do not already use ^ or $ are wrapped as ^(?:pattern)$ so
 * `.*.js` matches `src/foo.js` but not `package.json` (substring `.js`).
 */
export function compileUserPattern(pattern: string): RegExp {
  const source = pattern.trim();
  if (!source) {
    throw new Error('Empty pattern');
  }
  const alreadyAnchored = source.startsWith('^') || source.endsWith('$');
  return new RegExp(alreadyAnchored ? source : `^(?:${source})$`);
}

export function isUriString(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function tabResourceUri(tab: vscode.Tab): vscode.Uri | undefined {
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

export function parseUriList(raw: string): string[] {
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

export function sanitizeSortMode(raw: unknown): SortMode {
  if (raw === 'manual' || raw === 'name' || raw === 'nameDesc') {
    return raw;
  }
  return 'name';
}

export function stampStoreKey(groups: Group[], storeKey: string): void {
  for (const g of groups) {
    g.storeKey = storeKey;
    stampStoreKey(g.children.filter(isGroup), storeKey);
  }
}

/** Longest matching workspace folder for a file URI, if any. */
export function folderForUri(uriStr: string, folders?: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
  const list = folders ?? vscode.workspace.workspaceFolders ?? [];
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(uriStr);
  } catch {
    return undefined;
  }
  if (uri.scheme === 'untitled') {
    return undefined;
  }
  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  const filePath = normalizeFs(uri.fsPath);
  for (const folder of list) {
    const base = normalizeFs(folder.uri.fsPath);
    if (filePath === base || filePath.startsWith(base + '/')) {
      if (base.length > bestLen) {
        best = folder;
        bestLen = base.length;
      }
    }
  }
  return best;
}

export function folderContainsUri(folder: vscode.WorkspaceFolder, uriStr: string): boolean {
  return folderForUri(uriStr, [folder]) === folder;
}

function normalizeFs(fsPath: string): string {
  const replaced = fsPath.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    return replaced.toLowerCase();
  }
  return replaced;
}

export function toFolderRelativePath(uriStr: string, folder: vscode.WorkspaceFolder): string {
  try {
    const uri = vscode.Uri.parse(uriStr);
    if (uri.scheme === 'untitled') {
      return uriStr;
    }
    const rel = path.relative(folder.uri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return uriStr;
    }
    return rel.replace(/\\/g, '/');
  } catch {
    return uriStr;
  }
}

export function fromFolderRelativePath(stored: string, folder: vscode.WorkspaceFolder): string {
  try {
    if (isUriString(stored)) {
      return vscode.Uri.parse(stored).toString();
    }
    return vscode.Uri.joinPath(folder.uri, stored).toString();
  } catch {
    return stored;
  }
}

export function toMatchPath(uriStr: string, folder: vscode.WorkspaceFolder): string {
  const stored = toFolderRelativePath(uriStr, folder);
  if (!isUriString(stored)) {
    return stored;
  }
  try {
    return vscode.Uri.parse(uriStr).fsPath.replace(/\\/g, '/');
  } catch {
    return uriStr;
  }
}

export function isMissingFileError(err: unknown): boolean {
  if (err instanceof vscode.FileSystemError) {
    const code = (err as vscode.FileSystemError).code;
    if (code === 'FileNotFound' || code === 'EntryNotFound') {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|FileNotFound|EntryNotFound|does not exist/i.test(msg);
}
