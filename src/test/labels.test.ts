import * as assert from "assert";
import { SearchLabelBuilder } from "../labels";

/**
 * Pure unit suite for {@link SearchLabelBuilder} — no VS Code APIs involved
 * (the class itself has zero `vscode` imports), but it still runs inside
 * this project's single Mocha/`vscode-test` harness alongside the e2e
 * suites.
 */
suite("SearchLabelBuilder", () => {
  const builder = new SearchLabelBuilder();

  test("plain word with no enclosing symbol and no `new` usage returns the word unchanged", () => {
    const label = builder.build({
      word: "Greeter",
      lineTextBeforeWord: "class ",
    });

    assert.strictEqual(label, "Greeter");
  });

  test("accessor word with an enclosing symbol composes Enclosing.word", () => {
    const label = builder.build({
      word: "get",
      lineTextBeforeWord: "  ",
      enclosing: { name: "greeting", kind: "property" },
    });

    assert.strictEqual(label, "greeting.get");
  });

  test("accessor word strips a `(get) `-style prefix from the enclosing symbol's name", () => {
    const label = builder.build({
      word: "get",
      lineTextBeforeWord: "  ",
      enclosing: { name: "(get) greeting", kind: "property" },
    });

    assert.strictEqual(label, "greeting.get");
  });

  test("`set` accessor mirrors the `get` behavior, including `(set) ` prefix stripping", () => {
    const plain = builder.build({
      word: "set",
      lineTextBeforeWord: "  ",
      enclosing: { name: "greeting", kind: "property" },
    });
    const prefixed = builder.build({
      word: "set",
      lineTextBeforeWord: "  ",
      enclosing: { name: "(set) greeting", kind: "property" },
    });

    assert.strictEqual(plain, "greeting.set");
    assert.strictEqual(prefixed, "greeting.set");
  });

  test("accessor word with no enclosing symbol falls back to the plain word", () => {
    const label = builder.build({
      word: "get",
      lineTextBeforeWord: "  ",
      enclosing: undefined,
    });

    assert.strictEqual(label, "get");
  });

  test("`new Foo(` usage labels the tab as a constructor call", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "new ",
    });

    assert.strictEqual(label, "new Foo()");
  });

  test("`new Some.Ns.Foo(` qualified usage still recognizes the `new` keyword", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "new Some.Ns.",
    });

    assert.strictEqual(label, "new Foo()");
  });

  test("`renew Foo` is NOT a constructor usage (word-boundary check on `new`)", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "renew ",
    });

    assert.strictEqual(label, "Foo");
  });

  test("constructor declaration (enclosing.kind === \"constructor\") labels as a constructor", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "  ",
      enclosing: { name: "Foo", kind: "constructor" },
    });

    assert.strictEqual(label, "new Foo()");
  });

  test("enclosing name equal to the word but kind \"other\" (e.g. a record) stays the plain word", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "  ",
      enclosing: { name: "Foo", kind: "other" },
    });

    assert.strictEqual(label, "Foo");
  });

  test("constructor declaration detected by type-name + '(' even when the provider reports a plain method", () => {
    // Some C# providers label the constructor SymbolKind.Method; the token
    // equals the enclosing class name and is followed by '(' → constructor.
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "    public ",
      enclosing: { name: "Foo", kind: "other" },
      enclosingTypeName: "Foo",
      wordFollowedByOpenParen: true,
    });

    assert.strictEqual(label, "new Foo()");
  });

  test("the class declaration (name === type, but NOT followed by '(') stays the plain word", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "public class ",
      enclosing: { name: "Foo", kind: "other" },
      enclosingTypeName: "Foo",
      wordFollowedByOpenParen: false,
    });

    assert.strictEqual(label, "Foo");
  });

  test("empty lineTextBeforeWord does not crash and falls back to the plain word", () => {
    const label = builder.build({
      word: "Foo",
      lineTextBeforeWord: "",
    });

    assert.strictEqual(label, "Foo");
  });
});
