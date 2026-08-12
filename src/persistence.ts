import * as vscode from "vscode";
import { Search } from "./model";

/** Rapid collapse-toggle writes are coalesced within this window before hitting disk. */
const DEBOUNCE_MS = 300;

/**
 * Persists {@link Search} objects as one JSON file per search under
 * `<storage>/searches/<id>.json`.
 *
 * `storage` is `context.storageUri` (workspace-scoped) when a workspace is
 * open, falling back to `context.globalStorageUri` otherwise — chosen by the
 * caller (see `extension.ts`), not by this class.
 */
export class SearchPersistence implements vscode.Disposable {
  private readonly searchesDir: vscode.Uri;
  private dirEnsured: Promise<void> | undefined;

  /** One pending debounce timer per search id, for `scheduleSave`. */
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(storage: vscode.Uri) {
    this.searchesDir = vscode.Uri.joinPath(storage, "searches");
  }

  /** Writes `search` to disk immediately. Used on creation, where losing data is not acceptable. */
  public async saveSearch(search: Search): Promise<void> {
    this.cancelScheduled(search.id);
    await this.writeFile(search);
  }

  /**
   * Debounced write (300 ms) for high-frequency mutations like collapse
   * toggles, so rapid clicking doesn't thrash disk. One timer per search id
   * — a later call for the same id resets that id's timer only.
   */
  public scheduleSave(search: Search): void {
    this.cancelScheduled(search.id);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(search.id);
      void this.writeFile(search);
    }, DEBOUNCE_MS);
    this.pendingTimers.set(search.id, timer);
  }

  /** Deletes the on-disk file for `id`, if any. Cancels a pending debounced write for it. */
  public async deleteSearch(id: string): Promise<void> {
    this.cancelScheduled(id);
    const uri = this.fileUri(id);
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Already gone (or never written) — nothing to do.
    }
  }

  /**
   * Reads every search file in the searches directory. Files that fail to
   * parse into a well-formed `Search` are deleted (best-effort) and skipped
   * rather than failing the whole restore.
   */
  public async loadAll(): Promise<Search[]> {
    await this.ensureDir();

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.searchesDir);
    } catch {
      return [];
    }

    const results: Search[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) {
        continue;
      }
      const uri = vscode.Uri.joinPath(this.searchesDir, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (!isSearch(parsed)) {
          throw new Error("not a Search");
        }
        results.push(parsed);
      } catch {
        try {
          await vscode.workspace.fs.delete(uri);
        } catch {
          // Best-effort cleanup; ignore.
        }
      }
    }

    return results;
  }

  public dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private cancelScheduled(id: string): void {
    const timer = this.pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(id);
    }
  }

  private async writeFile(search: Search): Promise<void> {
    await this.ensureDir();
    const uri = this.fileUri(search.id);
    const bytes = Buffer.from(JSON.stringify(search), "utf8");
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  private fileUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.searchesDir, `${id}.json`);
  }

  /** `createDirectory` is idempotent in `vscode.workspace.fs`; memoized so we only await it once per process. */
  private ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      this.dirEnsured = Promise.resolve(
        vscode.workspace.fs.createDirectory(this.searchesDir)
      );
    }
    return this.dirEnsured;
  }
}

function isSearch(value: unknown): value is Search {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Search>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "references" || candidate.kind === "implementations") &&
    typeof candidate.symbol === "string" &&
    typeof candidate.originUri === "string" &&
    typeof candidate.originLine === "number" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.groups) &&
    typeof candidate.totalCount === "number"
  );
}
