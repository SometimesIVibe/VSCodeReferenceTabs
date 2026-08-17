/**
 * Pure, dependency-free composition of the display label shown on a search
 * tab. Deliberately has zero `vscode` imports so it can be unit-tested in
 * plain node (see `src/test/labels.test.ts`) — callers (`src/search.ts`)
 * adapt live editor/document-symbol data into the plain {@link LabelInput}
 * shape below.
 */

/**
 * Coarse classification of the innermost document symbol enclosing the
 * cursor, collapsed from `vscode.SymbolKind` by the caller so this module
 * never has to know about vscode's numeric enum.
 */
export type EnclosingKind = "constructor" | "property" | "other";

/** Raw cursor tokens that get an enclosing-symbol prefix in the display label (C# property/indexer/event accessors). */
const ACCESSOR_WORDS = new Set(["get", "set", "init", "add", "remove"]);

export interface LabelInput {
  /** Raw token under the cursor. */
  word: string;
  /** Text on the origin line up to (not including) the word's start column. */
  lineTextBeforeWord: string;
  /**
   * Innermost `DocumentSymbol` containing the cursor, already
   * accessor-guarded by the caller (see `findInnermostSymbol` in
   * `search.ts`). `undefined` when no symbol provider result was usable.
   */
  enclosing?: { name: string; kind: EnclosingKind } | undefined;
}

/**
 * Composes the search-tab label from cursor/editor data already adapted to
 * plain {@link LabelInput}. Rules are applied in priority order; only the
 * first matching rule fires:
 *
 * 1. Accessor word (`get`/`set`/`init`/`add`/`remove`) with an enclosing
 *    symbol → `Enclosing.word`, stripping any `"(get) "`-style accessor
 *    prefix TypeScript's symbol provider puts on the enclosing name (the
 *    `.word` suffix already carries that information).
 * 2. Constructor *usage* — `lineTextBeforeWord` ends with the `new` keyword
 *    (allowing a qualified `new Some.Ns.` prefix before `word`) → `word()`.
 * 3. Constructor *declaration* — the enclosing symbol's kind is
 *    `"constructor"` (or, C#-record-style, its name equals `word` while its
 *    kind is `"constructor"`) → `word()`.
 * 4. Otherwise → `word` unchanged.
 */
export class SearchLabelBuilder {
  public build(input: LabelInput): string {
    const { word, lineTextBeforeWord, enclosing } = input;

    if (ACCESSOR_WORDS.has(word) && enclosing) {
      const name = enclosing.name.replace(/^\((?:get|set|init|add|remove)\)\s+/, "");
      return `${name}.${word}`;
    }

    if (this.isNewKeywordUsage(lineTextBeforeWord)) {
      return `${word}()`;
    }

    if (enclosing?.kind === "constructor") {
      return `${word}()`;
    }

    return word;
  }

  /**
   * True when `lineTextBeforeWord` ends with a bare `new` keyword, tolerating
   * a qualified namespace/type prefix already typed between `new` and the
   * word under the cursor (e.g. `new Some.Ns.` before `Foo`). Strips trailing
   * `Identifier.` segments first, then requires `new` followed by whitespace
   * at the end of the remaining text, with a non-identifier character (or
   * start of string) before it — this is what keeps `renew Foo` from
   * matching: `new` there is a suffix of `renew`, not a standalone word.
   */
  private isNewKeywordUsage(lineTextBeforeWord: string): boolean {
    return /(^|[^\w$])new\s+$/.test(stripTrailingQualifiedSegments(lineTextBeforeWord));
  }
}

/** Removes trailing `Identifier.` segments (e.g. `"new Some.Ns."` → `"new "`) so a qualified constructor prefix doesn't defeat the `new`-keyword test. */
function stripTrailingQualifiedSegments(text: string): string {
  return text.replace(/(?:[\w$]+\.)+$/, "");
}
