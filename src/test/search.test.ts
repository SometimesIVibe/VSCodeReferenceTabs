import * as assert from "assert";
import * as vscode from "vscode";
import { runSearch } from "../search";

/**
 * Polls `vscode.executeDocumentSymbolProvider` on `document` until it
 * returns a non-empty result (or `maxMs` elapses), so the suite below
 * doesn't race the built-in TypeScript server's warm-up on a freshly opened
 * fixture document.
 */
async function waitForLanguageServer(document: vscode.TextDocument, maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    );
    if (Array.isArray(symbols) && symbols.length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("TypeScript language server did not report document symbols within the timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Position of the first occurrence of `token` in `document`'s text. */
function positionOfFirst(document: vscode.TextDocument, token: string): vscode.Position {
  const index = document.getText().indexOf(token);
  assert.notStrictEqual(index, -1, `expected to find "${token}" in the fixture`);
  return document.positionAt(index);
}

/**
 * Position of the first occurrence of `token` at or after the first
 * occurrence of `containing`. Used to disambiguate a token (e.g.
 * `EnglishGreeter`) that appears multiple times in the fixture by anchoring
 * to distinctive surrounding text, so the test stays robust to unrelated
 * fixture edits (rather than depending on a raw occurrence index).
 */
function positionOfTokenNear(
  document: vscode.TextDocument,
  containing: string,
  token: string
): vscode.Position {
  const text = document.getText();
  const anchorIndex = text.indexOf(containing);
  assert.notStrictEqual(anchorIndex, -1, `expected to find "${containing}" in the fixture`);
  const tokenIndex = text.indexOf(token, anchorIndex);
  assert.notStrictEqual(tokenIndex, -1, `expected to find "${token}" at or after "${containing}"`);
  return document.positionAt(tokenIndex);
}

/** Splits a `Search.key` (`${kind}|${defUri}|${line}:${char}|${label}`) into its definition-location component and its label component. */
function splitKeyLabel(key: string): { locationKey: string; label: string } {
  const parts = key.split("|");
  const label = parts.pop() ?? "";
  return { locationKey: parts.join("|"), label };
}

suite("search (end-to-end against the fixture workspace)", () => {
  let document: vscode.TextDocument;
  let editor: vscode.TextEditor;

  suiteSetup(async function () {
    this.timeout(20000);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected the fixture folder to be open as the test workspace");

    const uri = vscode.Uri.joinPath(folder!.uri, "sample.ts");
    document = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(document);

    // Warm up the TS server before any test relies on its results.
    await waitForLanguageServer(document);
  });

  test("references search on a free function finds its declaration and call sites", async function () {
    this.timeout(15000);

    const position = positionOfFirst(document, "shout");
    editor.selection = new vscode.Selection(position, position);

    const search = await runSearch("references", editor);

    assert.ok(search, "expected a search result");
    assert.strictEqual(search!.groups.length, 1, "every usage of `shout` lives in the single fixture file");
    // The 2 call sites plus (depending on TS server version) the declaration itself.
    assert.ok(
      search!.totalCount >= 2,
      `expected at least the 2 call sites to shout(), got ${search!.totalCount}`
    );
    const relativePaths = search!.groups.map((g) => g.relativePath);
    assert.ok(relativePaths.every((p) => p.endsWith("sample.ts")));
  });

  test("implementations search on the interface finds the implementing class", async function () {
    this.timeout(15000);

    const position = positionOfFirst(document, "Greeter");
    editor.selection = new vscode.Selection(position, position);

    const search = await runSearch("implementations", editor);

    assert.ok(search, "expected a search result");
    const previewText = search!.groups
      .flatMap((group) => group.items.map((item) => item.lineText))
      .join("\n");
    assert.match(previewText, /EnglishGreeter/, "the implementing class should be among the results");
  });

  test("accessor search: cursor on the `get` keyword labels the tab Property.get", async function () {
    this.timeout(15000);

    const getIndex = document.getText().indexOf("get greeting");
    assert.notStrictEqual(getIndex, -1, "expected to find the `get greeting` accessor in the fixture");
    const position = document.positionAt(getIndex);
    editor.selection = new vscode.Selection(position, position);

    const search = await runSearch("references", editor);

    assert.ok(search, "expected a search result");
    assert.strictEqual(search!.word, "get");
    // The built-in TypeScript document-symbol provider names a getter
    // "(get) greeting"; composeLabel strips that accessor prefix since the
    // `.get` suffix already carries it.
    assert.strictEqual(search!.symbol, "greeting.get");
    assert.ok(search!.symbol.endsWith(".get"), "label must still be composed from the enclosing symbol");
  });

  test("dedup key: the same symbol searched from two different usage sites produces an equal key", async function () {
    this.timeout(15000);

    const site1 = positionOfTokenNear(document, 'shout(greeter.greet("World"', "shout");
    editor.selection = new vscode.Selection(site1, site1);
    const search1 = await runSearch("references", editor);
    assert.ok(search1, "expected a search result for the first call site");

    const site2 = positionOfTokenNear(document, 'shout(greeter.greet("VS Code"', "shout");
    editor.selection = new vscode.Selection(site2, site2);
    const search2 = await runSearch("references", editor);
    assert.ok(search2, "expected a search result for the second call site");

    assert.strictEqual(
      search1!.key,
      search2!.key,
      "the same symbol from two different usage sites must produce the same dedup key"
    );
  });

  test("dedup key: `new EnglishGreeter()` and a plain `EnglishGreeter` type reference resolve to the same definition but produce different keys (label disambiguates)", async function () {
    this.timeout(15000);

    const typeRefPos = positionOfTokenNear(document, "describeGreeter(g:", "EnglishGreeter");
    editor.selection = new vscode.Selection(typeRefPos, typeRefPos);
    const typeRefSearch = await runSearch("references", editor);
    assert.ok(typeRefSearch, "expected a search result for the type-reference site");

    // Anchored on "= new EnglishGreeter" (not just "new EnglishGreeter") so
    // this doesn't accidentally match the literal "new EnglishGreeter()"
    // that appears inside this file's own explanatory comment above.
    const newExprPos = positionOfTokenNear(document, "= new EnglishGreeter", "EnglishGreeter");
    editor.selection = new vscode.Selection(newExprPos, newExprPos);
    const newExprSearch = await runSearch("references", editor);
    assert.ok(newExprSearch, "expected a search result for the `new` usage site");

    assert.notStrictEqual(
      typeRefSearch!.key,
      newExprSearch!.key,
      "a plain type reference and a constructor-call site must not dedup to the same tab"
    );

    // TS's "go to definition" resolves both `EnglishGreeter` usages to the
    // same class declaration (no explicit constructor to distinguish them),
    // so the definition-location component of the key is identical; only
    // the label differs ("EnglishGreeter" vs "EnglishGreeter()"), and that
    // is exactly what must keep the keys apart.
    const typeRef = splitKeyLabel(typeRefSearch!.key);
    const newExpr = splitKeyLabel(newExprSearch!.key);

    assert.strictEqual(
      typeRef.locationKey,
      newExpr.locationKey,
      "both usages must resolve to the same definition location"
    );
    assert.strictEqual(typeRef.label, "EnglishGreeter");
    assert.strictEqual(newExpr.label, "EnglishGreeter()");
  });
});
