import * as vscode from 'vscode';
import { OTHER_STORE_KEY } from '../model';
import { ensureGroupPath, FolderStore, PendingMove } from './store';

export class WorkspaceHub {
  private readonly entries = new Map<string, { folder: vscode.WorkspaceFolder; store: FolderStore; subs: vscode.Disposable[] }>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private discovering = false;

  static key(folder: vscode.WorkspaceFolder): string {
    return folder.uri.toString();
  }

  get isMultiRoot(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  }

  get folders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  store(key: string | undefined | null): FolderStore | undefined {
    if (!key || key === OTHER_STORE_KEY) {
      return undefined;
    }
    return this.entries.get(key)?.store;
  }

  stores(): FolderStore[] {
    return [...this.entries.values()].map((e) => e.store);
  }

  async discover(): Promise<void> {
    if (this.discovering) {
      return;
    }
    this.discovering = true;
    try {
      const seen = new Set<string>();
      const pending: PendingMove[] = [];
      for (const folder of this.folders) {
        const key = WorkspaceHub.key(folder);
        seen.add(key);
        let entry = this.entries.get(key);
        if (!entry) {
          const store = new FolderStore(folder);
          const subs = [
            store.onDidChange(() => {
              void this.reloadStore(key);
            })
          ];
          entry = { folder, store, subs };
          this.entries.set(key, entry);
        }
        const moves = await entry.store.discover(this.folders);
        pending.push(...moves);
      }
      for (const key of [...this.entries.keys()]) {
        if (!seen.has(key)) {
          this.disposeEntry(key);
        }
      }
      const changed = this.applyMoves(pending);
      for (const store of changed) {
        store.stampKeys();
        await store.save();
      }
      this.onDidChangeEmitter.fire();
    } finally {
      this.discovering = false;
    }
  }

  async reloadStore(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const moves = await entry.store.discover(this.folders);
    const changed = this.applyMoves(moves);
    for (const store of changed) {
      store.stampKeys();
      await store.save();
    }
    this.onDidChangeEmitter.fire();
  }

  async ensure(folder: vscode.WorkspaceFolder): Promise<FolderStore> {
    let entry = this.entries.get(WorkspaceHub.key(folder));
    if (!entry) {
      await this.discover();
      entry = this.entries.get(WorkspaceHub.key(folder));
    }
    if (!entry) {
      throw new Error('Open a folder to use Open Editor Groups.');
    }
    return entry.store;
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) {
      this.disposeEntry(key);
    }
    this.onDidChangeEmitter.dispose();
  }

  private applyMoves(pending: PendingMove[]): FolderStore[] {
    if (pending.length === 0) {
      return [];
    }
    const touched = new Set<FolderStore>();
    for (const move of pending) {
      const dest = this.store(move.targetKey);
      if (!dest) {
        continue;
      }
      dest.markCreated();
      const group = ensureGroupPath(dest, move.groupPath);
      if (group && !group.pattern && !group.children.includes(move.uri)) {
        group.children.push(move.uri);
      }
      dest.stampKeys();
      touched.add(dest);
      const source = this.store(move.sourceKey);
      if (source) {
        touched.add(source);
      }
    }
    return [...touched];
  }

  private disposeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    for (const sub of entry.subs) {
      sub.dispose();
    }
    entry.store.dispose();
    this.entries.delete(key);
  }
}
