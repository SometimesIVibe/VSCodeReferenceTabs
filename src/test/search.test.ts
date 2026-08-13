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
    // "(get) greeting" (not bare "greeting"), so composeLabel's
    // `${enclosing.name}.${word}` yields this rather than a bare "greeting.get".
    assert.strictEqual(search!.symbol, "(get) greeting.get");
    assert.ok(search!.symbol.endsWith(".get"), "label must still be composed from the enclosing symbol");
  });
});
