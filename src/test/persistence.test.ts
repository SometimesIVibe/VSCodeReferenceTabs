import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Search } from "../model";
import { SearchPersistence } from "../persistence";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSearch(id: string, overrides: Partial<Search> = {}): Search {
  return {
    id,
    kind: "references",
    symbol: id,
    word: id,
    originUri: "file:///fixture.ts",
    originLine: 0,
    createdAt: Date.now(),
    groups: [],
    totalCount: 0,
    pinned: false,
    key: `key-${id}`,
    ...overrides,
  };
}

suite("SearchPersistence", () => {
  let tmpDir: string;
  let persistence: SearchPersistence;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reference-tabs-persistence-test-"));
    persistence = new SearchPersistence(vscode.Uri.file(tmpDir));
  });

  teardown(() => {
    persistence.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function searchesDir(): string {
    return path.join(tmpDir, "searches");
  }

  test("save/loadAll round-trip", async () => {
    const search = makeSearch("s1", { symbol: "Foo", totalCount: 2 });
    await persistence.saveSearch(search);

    const loaded = await persistence.loadAll();

    assert.strictEqual(loaded.length, 1);
    assert.deepStrictEqual(loaded[0], search);
  });

  test("a corrupt JSON file is deleted and skipped", async () => {
    fs.mkdirSync(searchesDir(), { recursive: true });
    const file = path.join(searchesDir(), "corrupt.json");
    fs.writeFileSync(file, "{ this is not valid json");

    const loaded = await persistence.loadAll();

    assert.strictEqual(loaded.length, 0);
    assert.strictEqual(fs.existsSync(file), false, "corrupt file should have been deleted");
  });

  test("a well-formed but wrong-shape JSON file is deleted", async () => {
    fs.mkdirSync(searchesDir(), { recursive: true });
    const file = path.join(searchesDir(), "wrongshape.json");
    fs.writeFileSync(file, JSON.stringify({ foo: "bar", count: 3 }));

    const loaded = await persistence.loadAll();

    assert.strictEqual(loaded.length, 0);
    assert.strictEqual(fs.existsSync(file), false, "wrong-shape file should have been deleted");
  });

  test("a file missing required fields (word/pinned/key) is treated as invalid and deleted", async () => {
    fs.mkdirSync(searchesDir(), { recursive: true });
    const oldShape = {
      id: "old1",
      kind: "references",
      symbol: "Bar",
      originUri: "file:///fixture.ts",
      originLine: 3,
      createdAt: 123,
      groups: [],
      totalCount: 0,
      // no `word`, no `pinned`, no `key` — old-format files are not
      // supported; they must be rejected and cleaned up like any other
      // wrong-shape file.
    };
    const file = path.join(searchesDir(), "old1.json");
    fs.writeFileSync(file, JSON.stringify(oldShape));

    const loaded = await persistence.loadAll();

    assert.strictEqual(loaded.length, 0);
    assert.strictEqual(fs.existsSync(file), false, "old-format file should have been deleted");
  });

  test("deleteSearch removes the file", async () => {
    const search = makeSearch("s2");
    await persistence.saveSearch(search);
    const file = path.join(searchesDir(), "s2.json");
    assert.strictEqual(fs.existsSync(file), true);

    await persistence.deleteSearch("s2");

    assert.strictEqual(fs.existsSync(file), false);
  });

  test("deleteSearch on a never-written id does not throw", async () => {
    await assert.doesNotReject(persistence.deleteSearch("never-existed"));
  });

  test("scheduleSave debounces rapid writes into a single, final write", async () => {
    const file = path.join(searchesDir(), "s3.json");

    persistence.scheduleSave(makeSearch("s3", { symbol: "v1" }));
    persistence.scheduleSave(makeSearch("s3", { symbol: "v2" }));
    persistence.scheduleSave(makeSearch("s3", { symbol: "v3" }));

    // Well inside the 300ms debounce window: nothing should have hit disk yet.
    await delay(120);
    assert.strictEqual(fs.existsSync(file), false, "should not write before the debounce window elapses");

    // Past the debounce window: exactly the last scheduled value should land.
    await delay(400);
    assert.strictEqual(fs.existsSync(file), true);
    const loaded = await persistence.loadAll();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].symbol, "v3", "only the last scheduled value should have been written");
  });
});
