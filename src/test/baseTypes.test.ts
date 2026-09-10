import * as assert from "assert";
import { baseTypeIdentifierOffsets } from "../baseTypes";

/** The identifier tokens the parser points at, resolved back to strings. */
function baseTypeNames(header: string): string[] {
  return baseTypeIdentifierOffsets(header).map((offset) => {
    const match = /^[A-Za-z0-9_]+/.exec(header.slice(offset));
    return match ? match[0] : "";
  });
}

/**
 * Pure unit suite for {@link baseTypeIdentifierOffsets}. Each input is a type
 * header — the text *after* the type name — as the extension slices it from
 * the class's document symbol.
 */
suite("baseTypeIdentifierOffsets", () => {
  test("a single generic interface", () => {
    assert.deepStrictEqual(baseTypeNames(" : IResourceImporter<string>\n{"), ["IResourceImporter"]);
  });

  test("multiple base types are all returned (the caller filters non-interfaces)", () => {
    assert.deepStrictEqual(baseTypeNames(" : BaseClass, IFoo, IBar\n{"), ["BaseClass", "IFoo", "IBar"]);
  });

  test("generic type params and a where-clause are excluded", () => {
    assert.deepStrictEqual(
      baseTypeNames("<TResourceId> : IResourceImporter<TResourceId> where TResourceId : notnull\n{"),
      ["IResourceImporter"]
    );
  });

  test("a primary constructor's parameters are skipped", () => {
    assert.deepStrictEqual(baseTypeNames("(IService s, int n) : IBar\n{"), ["IBar"]);
  });

  test("a record ending in a semicolon", () => {
    assert.deepStrictEqual(baseTypeNames("(int X) : IBar;"), ["IBar"]);
  });

  test("nested generic arguments are not treated as base types", () => {
    assert.deepStrictEqual(baseTypeNames(" : IFoo<IBar<string>>\n{"), ["IFoo"]);
  });

  test("a qualified name yields each dotted segment (definition provider disambiguates)", () => {
    assert.deepStrictEqual(baseTypeNames(" : Some.Ns.IFoo\n{"), ["Some", "Ns", "IFoo"]);
  });

  test("no base list: only a where-clause", () => {
    assert.deepStrictEqual(baseTypeNames("<T> where T : IConstraint\n{"), []);
  });

  test("no base list: empty header before the body", () => {
    assert.deepStrictEqual(baseTypeNames("\n{"), []);
  });
});
