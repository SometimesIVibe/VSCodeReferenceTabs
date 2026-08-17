import * as assert from "assert";
import * as vscode from "vscode";
import { Search } from "../model";
import { SearchPersistence } from "../persistence";
import { SearchStore } from "../store";

/**
 * In-memory test double for {@link SearchPersistence}. Extends the real
 * class (rather than a plain object literal) so it satisfies the class's
 * private fields structurally, and overrides every public method to avoid
 * touching disk. The constructor's `vscode.Uri` argument is never used by
 * any overridden method, so any URI value is fine.
 */
class FakePersistence extends SearchPersistence {
  public readonly saved: Search[] = [];
  public readonly deletedIds: string[] = [];
  public scheduleSaveCalls = 0;

  constructor() {
    super(vscode.Uri.file("/fake-persistence-unused"));
  }

  public override async saveSearch(search: Search): Promise<void> {
    this.saved.push({ ...search });
  }

  public override scheduleSave(search: Search): void {
    this.scheduleSaveCalls++;
    this.saved.push({ ...search });
  }

  public override async deleteSearch(id: string): Promise<void> {
    this.deletedIds.push(id);
  }

  public override async loadAll(): Promise<Search[]> {
    return [];
  }

  public override dispose(): void {
    // No timers were ever scheduled against real disk state; nothing to do.
  }
}

/** In-memory {@link vscode.Memento} test double. */
class FakeMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.map.keys()];
  }

  public get<T>(key: string, defaultValue?: T): T {
    return (this.map.has(key) ? this.map.get(key) : defaultValue) as T;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
}

let createdAtCounter = 0;

function makeSearch(id: string, overrides: Partial<Search> = {}): Search {
  return {
    id,
    kind: "references",
    symbol: id,
    word: id,
    originUri: "file:///fixture.ts",
    originLine: 0,
    createdAt: ++createdAtCounter,
    groups: [],
    totalCount: 0,
    pinned: false,
    // Unique per default (derived from `id`) so existing tests, which never
    // intend to dedup, stay unaffected; dedup tests below override it.
    key: `key-${id}`,
    ...overrides,
  };
}

suite("SearchStore", () => {
  let persistence: FakePersistence;
  let memento: FakeMemento;
  let store: SearchStore;

  setup(() => {
    createdAtCounter = 0;
    persistence = new FakePersistence();
    memento = new FakeMemento();
    store = new SearchStore(persistence, memento);
  });

  teardown(() => {
    store.dispose();
  });

  suite("add / setActive / close", () => {
    test("add appends and activates the new search", () => {
      const a = makeSearch("a");
      const b = makeSearch("b");
      store.add(a);
      store.add(b);

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "b"]);
      assert.strictEqual(store.activeId, "b");
      assert.deepStrictEqual(persistence.saved.map((s) => s.id), ["a", "b"]);
    });

    test("setActive switches the active tab and persists tab state", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));

      store.setActive("a");

      assert.strictEqual(store.activeId, "a");
      assert.deepStrictEqual(memento.get<string[]>("referenceTabs.tabOrder"), ["a", "b"]);
      assert.strictEqual(memento.get<string>("referenceTabs.activeId"), "a");
    });

    test("setActive is a no-op for an unknown id", () => {
      store.add(makeSearch("a"));
      store.setActive("does-not-exist");
      assert.strictEqual(store.activeId, "a");
    });

    test("close removes the tab and deletes its persisted file", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.setActive("a");

      store.close("b");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "c"]);
      assert.strictEqual(store.activeId, "a", "closing a non-active tab must not change activeId");
      assert.deepStrictEqual(persistence.deletedIds, ["b"]);
    });

    test("closing the active (last) tab activates its new neighbor", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.setActive("c");

      store.close("c");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "b"]);
      assert.strictEqual(store.activeId, "b", "the tab that slid into the closed tab's slot should activate");
    });

    test("closing the last remaining tab clears activeId", () => {
      store.add(makeSearch("a"));
      store.close("a");

      assert.strictEqual(store.all.length, 0);
      assert.strictEqual(store.activeId, undefined);
    });

    test("close is a no-op for an unknown id", () => {
      store.add(makeSearch("a"));
      store.close("does-not-exist");
      assert.strictEqual(store.all.length, 1);
    });
  });

  suite("add dedup by key", () => {
    test("duplicate key updates the existing tab in place: count unchanged, id/pinned/position kept, fresh fields win, tab activated", () => {
      store.add(makeSearch("a", { key: "shared" }));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.togglePin("a");
      // order: a (pinned), b, c
      store.setActive("c");

      const rerun = makeSearch("fresh-guid", {
        key: "shared",
        symbol: "renamed",
        totalCount: 9,
        createdAt: 999,
        pinned: false, // must be ignored — pinned is carried over from the existing entry
      });
      store.add(rerun);

      assert.strictEqual(store.all.length, 3, "count must be unchanged on dedup");
      assert.deepStrictEqual(
        store.all.map((s) => s.id),
        ["a", "b", "c"],
        "tab position must be unchanged"
      );

      const updated = store.all[0];
      assert.strictEqual(updated.id, "a", "the OLD id must be kept, not the incoming GUID");
      assert.strictEqual(updated.pinned, true, "pinned must be preserved from the existing entry");
      assert.strictEqual(updated.symbol, "renamed", "fresh fields from the incoming search must win");
      assert.strictEqual(updated.totalCount, 9);
      assert.strictEqual(updated.createdAt, 999);
      assert.strictEqual(store.activeId, "a", "the deduped tab must become active");

      // Saved under the kept id — no new file, nothing deleted.
      assert.ok(persistence.saved.some((s) => s.id === "a" && s.symbol === "renamed"));
      assert.deepStrictEqual(persistence.deletedIds, []);
    });

    test("distinct keys never dedup: each add produces its own tab", () => {
      store.add(makeSearch("a", { key: "key-a" }));
      store.add(makeSearch("b", { key: "key-b" }));

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "b"]);
      assert.strictEqual(store.all.length, 2);
    });
  });

  suite("togglePin ordering", () => {
    test("pinning moves a tab to the end of the pinned block", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.add(makeSearch("d"));
      // order: a, b, c, d (all unpinned)

      store.togglePin("b");
      // pinned block: [b]; unpinned follow in their old relative order
      assert.deepStrictEqual(store.all.map((s) => s.id), ["b", "a", "c", "d"]);
      assert.strictEqual(store.all.find((s) => s.id === "b")?.pinned, true);

      store.togglePin("d");
      // pinned block grows to [b, d] (d appended after the existing pinned tab)
      assert.deepStrictEqual(store.all.map((s) => s.id), ["b", "d", "a", "c"]);
    });

    test("unpinning moves a tab to the front of the unpinned block", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.add(makeSearch("d"));

      store.togglePin("b");
      store.togglePin("d");
      // order is now: b, d, a, c (pinned: b, d)

      store.togglePin("b");
      // b becomes unpinned and moves to the front of the unpinned block,
      // i.e. right after the remaining pinned block [d].
      assert.deepStrictEqual(store.all.map((s) => s.id), ["d", "b", "a", "c"]);
      assert.strictEqual(store.all.find((s) => s.id === "b")?.pinned, false);
    });

    test("pinned tabs stay leftmost regardless of insertion order", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));

      store.togglePin("c");
      store.togglePin("a");

      const ids = store.all.map((s) => s.id);
      const pinnedIds = store.all.filter((s) => s.pinned).map((s) => s.id);
      // Both pinned ids must precede the sole unpinned id ("b").
      assert.ok(ids.indexOf("b") > Math.max(...pinnedIds.map((id) => ids.indexOf(id))));
    });

    test("togglePin is a no-op for an unknown id", () => {
      store.add(makeSearch("a"));
      store.togglePin("does-not-exist");
      assert.deepStrictEqual(store.all.map((s) => s.id), ["a"]);
    });
  });

  suite("eviction", () => {
    test("evicts only unpinned searches, oldest first, once the unpinned count exceeds the cap", () => {
      store.setMaxSearches(2);
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));

      assert.deepStrictEqual(store.all.map((s) => s.id), ["b", "c"]);
      assert.deepStrictEqual(persistence.deletedIds, ["a"]);
      assert.strictEqual(store.activeId, "c");
    });

    test("the cap can be exceeded when every search is pinned", () => {
      store.setMaxSearches(1);
      store.add(makeSearch("a", { pinned: true }));
      store.add(makeSearch("b", { pinned: true }));
      store.add(makeSearch("c", { pinned: true }));

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "b", "c"]);
      assert.deepStrictEqual(persistence.deletedIds, []);
    });

    test("eviction never blocks add: a pinned tab plus repeated unpinned adds always succeed", () => {
      store.setMaxSearches(1);
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));
      store.add(makeSearch("u3"));

      // Only the single most recent unpinned search should survive alongside
      // the pinned one; every add() call itself must have succeeded (no
      // throw, no rejected search).
      assert.deepStrictEqual(store.all.map((s) => s.id), ["p", "u3"]);
      assert.deepStrictEqual(persistence.deletedIds, ["u1", "u2"]);
    });
  });

  suite("closeUnpinned", () => {
    test("closes exactly the unpinned tabs and leaves pinned tabs untouched", () => {
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));
      store.setActive("u1");

      store.closeUnpinned();

      assert.deepStrictEqual(store.all.map((s) => s.id), ["p"]);
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["u1", "u2"]);
      assert.strictEqual(store.activeId, "p", "closing the active unpinned tab must re-activate a remaining (pinned) tab");
    });

    test("leaves the active tab alone when it is already pinned", () => {
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("u1"));
      store.setActive("p");

      store.closeUnpinned();

      assert.strictEqual(store.activeId, "p");
      assert.deepStrictEqual(store.all.map((s) => s.id), ["p"]);
    });

    test("is a no-op when there are no unpinned tabs", () => {
      store.add(makeSearch("p", { pinned: true }));
      persistence.deletedIds.length = 0;

      store.closeUnpinned();

      assert.deepStrictEqual(store.all.map((s) => s.id), ["p"]);
      assert.deepStrictEqual(persistence.deletedIds, []);
    });
  });

  suite("closeOthers", () => {
    test("spares pinned tabs and the target, closes every other unpinned tab, deletes the right files, activates the target", () => {
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("target"));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));
      store.setActive("u1");

      store.closeOthers("target");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["p", "target"]);
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["u1", "u2"]);
      assert.strictEqual(store.activeId, "target");
    });

    test("leaves a pinned target's own pinned state untouched and still activates it", () => {
      store.add(makeSearch("target", { pinned: true }));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));
      store.setActive("u1");

      store.closeOthers("target");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["target"]);
      assert.strictEqual(store.all[0].pinned, true);
      assert.strictEqual(store.activeId, "target");
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["u1", "u2"]);
    });

    test("is a no-op on a single-tab store", () => {
      store.add(makeSearch("a"));
      persistence.deletedIds.length = 0;

      store.closeOthers("a");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a"]);
      assert.strictEqual(store.activeId, "a");
      assert.deepStrictEqual(persistence.deletedIds, []);
    });

    test("is a no-op when the only other tabs are already pinned", () => {
      store.add(makeSearch("p1", { pinned: true }));
      store.add(makeSearch("p2", { pinned: true }));
      store.add(makeSearch("target"));
      store.setActive("p1");

      store.closeOthers("target");

      // Nothing was closeable (both others are pinned), so activeId is left
      // alone rather than force-switching to the target.
      assert.deepStrictEqual(store.all.map((s) => s.id), ["p1", "p2", "target"]);
      assert.strictEqual(store.activeId, "p1");
      assert.deepStrictEqual(persistence.deletedIds, []);
    });

    test("is a no-op for an unknown id", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));

      store.closeOthers("does-not-exist");

      assert.deepStrictEqual(store.all.map((s) => s.id), ["a", "b"]);
      assert.deepStrictEqual(persistence.deletedIds, []);
    });
  });

  suite("clearAll", () => {
    test("empties the store, including pinned tabs, and deletes every persisted file", () => {
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));

      store.clearAll();

      assert.strictEqual(store.all.length, 0);
      assert.strictEqual(store.activeId, undefined);
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["p", "u1", "u2"]);
    });

    test("is a no-op on an already-empty store", () => {
      store.clearAll();
      assert.strictEqual(store.all.length, 0);
      assert.deepStrictEqual(persistence.deletedIds, []);
    });
  });

  suite("replace", () => {
    test("preserves the pinned flag and the tab's position", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));
      store.togglePin("b");
      // order is now: b, a, c (b pinned)

      const refreshed = makeSearch("b", {
        symbol: "renamed",
        totalCount: 5,
        pinned: false, // must be ignored — pinned is carried over from the existing entry
      });
      store.replace(refreshed);

      assert.deepStrictEqual(store.all.map((s) => s.id), ["b", "a", "c"], "tab position must be unchanged");
      const replaced = store.all[0];
      assert.strictEqual(replaced.pinned, true, "pinned must be preserved, not overwritten by the incoming value");
      assert.strictEqual(replaced.symbol, "renamed");
      assert.strictEqual(replaced.totalCount, 5);
    });

    test("is a no-op for an unknown id", () => {
      store.add(makeSearch("a"));
      store.replace(makeSearch("does-not-exist"));
      assert.deepStrictEqual(store.all.map((s) => s.id), ["a"]);
    });
  });

  suite("setMaxSearches", () => {
    test("shrinking the cap evicts unpinned searches immediately", () => {
      store.add(makeSearch("a"));
      store.add(makeSearch("b"));
      store.add(makeSearch("c"));

      store.setMaxSearches(1);

      assert.deepStrictEqual(store.all.map((s) => s.id), ["c"]);
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["a", "b"]);
    });

    test("shrinking the cap never evicts pinned searches", () => {
      store.add(makeSearch("p", { pinned: true }));
      store.add(makeSearch("u1"));
      store.add(makeSearch("u2"));
      store.add(makeSearch("u3"));

      store.setMaxSearches(1);

      assert.deepStrictEqual(store.all.map((s) => s.id), ["p", "u3"]);
      assert.deepStrictEqual(persistence.deletedIds.sort(), ["u1", "u2"]);
    });
  });
});
