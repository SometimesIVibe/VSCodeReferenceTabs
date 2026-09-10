import * as assert from "assert";
import { parameterSuffixFromDefinition } from "../signature";

/**
 * Pure unit suite for {@link parameterSuffixFromDefinition}. Each input is
 * definition source text starting at (or shortly before) the callable's name —
 * the slice `search.ts` feeds it from the definition document.
 */
suite("parameterSuffixFromDefinition", () => {
  suite("type-name–ordered (C#/Java/C++) reduction to types", () => {
    test("a simple two-parameter method", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("ImportProductAsync(int id, CancellationToken ct)", "ImportProductAsync"),
        "(int, CancellationToken)"
      );
    });

    test("a parameterless method yields ()", () => {
      assert.strictEqual(parameterSuffixFromDefinition("Run()", "Run"), "()");
    });

    test("a generic method's own type parameters are skipped before the list", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("ProcessJobAsync<TResourceId>(TResourceId id, CancellationToken ct)", "ProcessJobAsync"),
        "(TResourceId, CancellationToken)"
      );
    });

    test("generic argument commas are not treated as parameter separators", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Handle(Dictionary<string, int> map, Func<int, int> f)", "Handle"),
        "(Dictionary<string, int>, Func<int, int>)"
      );
    });

    test("default values are dropped", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Greet(string name = \"World\", int times = 1)", "Greet"),
        "(string, int)"
      );
    });

    test("a default value containing a comma or parens stays with its own parameter", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Make(int n = 1, string s = \"a, b\")", "Make"),
        "(int, string)"
      );
    });

    test("parameter modifiers are kept as part of the type", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Try(out int result, ref string buffer, params object[] rest)", "Try"),
        "(out int, ref string, params object[])"
      );
    });

    test("attributes on a parameter are stripped", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Resolve([FromServices] IFoo foo, int id)", "Resolve"),
        "(IFoo, int)"
      );
    });

    test("nullable and array types are preserved", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Store(string? key, int[] values)", "Store"),
        "(string?, int[])"
      );
    });

    test("a fully-qualified type name is kept whole", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Cancel(System.Threading.CancellationToken ct)", "Cancel"),
        "(System.Threading.CancellationToken)"
      );
    });

    test("a multi-line signature is parsed", () => {
      const text = "ImportProductAsync(\n    int id,\n    CancellationToken ct)\n{";
      assert.strictEqual(
        parameterSuffixFromDefinition(text, "ImportProductAsync"),
        "(int, CancellationToken)"
      );
    });

    test("a broader definition range covering modifiers/return type still finds the name's list", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("public async Task<Product> ImportProductAsync(int id)", "ImportProductAsync"),
        "(int)"
      );
    });
  });

  suite("name-first (TypeScript/Python) parameters kept verbatim", () => {
    test("a TypeScript signature keeps `name: Type` untouched", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("greet(name: string, times: number)", "greet"),
        "(name: string, times: number)"
      );
    });

    test("a `::` qualifier is not mistaken for a name-first colon (C# stays reduced)", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Cancel(global::System.Threading.CancellationToken ct)", "Cancel"),
        "(global::System.Threading.CancellationToken)"
      );
    });
  });

  suite("no parameter list → undefined (label unchanged)", () => {
    test("a plain type reference (name followed by `{`)", () => {
      assert.strictEqual(parameterSuffixFromDefinition("EnglishGreeter {\n}", "EnglishGreeter"), undefined);
    });

    test("a name followed by `:` (a field/base list, not a call)", () => {
      assert.strictEqual(parameterSuffixFromDefinition("greeting: string;", "greeting"), undefined);
    });

    test("the name does not appear in the text", () => {
      assert.strictEqual(parameterSuffixFromDefinition("something else entirely", "Missing"), undefined);
    });
  });

  suite("records / primary constructors", () => {
    test("a positional record's primary-constructor parameters are read", () => {
      assert.strictEqual(
        parameterSuffixFromDefinition("Point(int X, int Y) : IShape;", "Point"),
        "(int, int)"
      );
    });
  });
});
