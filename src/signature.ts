// Pure, dependency-free extraction of a callable's parameter-type list from
// the source text at its definition. Used to disambiguate overloads in the
// search-tab label (and therefore the dedup key): two overloads that share a
// name get distinct labels — `ImportProductAsync(int, CancellationToken)` vs
// `ImportProductAsync(string)` — so a reference search on each opens its own
// tab instead of the two collapsing into one.
//
// Has zero `vscode` imports so it can be unit-tested in plain node
// (see `src/test/signature.test.ts`); `src/search.ts` feeds it the definition
// document's source text.

const IDENT = /[A-Za-z0-9_]/;

/**
 * Given `defText` — document text starting at (or shortly before) a callable's
 * name — and the `name` itself, returns the formatted parameter-type suffix
 * that follows the name: `"(int, CancellationToken)"`, `"()"` for a
 * parameterless callable, or `undefined` when no parameter list follows the
 * name (a field, property, plain type reference, …), leaving the label
 * unchanged.
 *
 * Each parameter is reduced to its type for "type name"–ordered languages
 * (C#, Java, C++) — dropping the parameter name and any default value — while
 * a modifier such as `ref`/`out`/`in`/`params` is kept, since it is part of an
 * overload's identity. For name-first languages (a top-level `:` before any
 * default, as in TypeScript's `id: number` or Python) the parameters are kept
 * verbatim, because the type-vs-name reduction does not apply there.
 */
export function parameterSuffixFromDefinition(defText: string, name: string): string | undefined {
  const inner = extractParameterListInner(defText, name);
  if (inner === undefined) {
    return undefined;
  }
  const params = splitTopLevel(inner)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (params.length === 0) {
    return "()";
  }
  const nameFirst = params.some(hasNameFirstColon);
  const rendered = nameFirst ? params : params.map(reduceToType);
  return `(${rendered.join(", ")})`;
}

/**
 * The inner text of the `(…)` parameter list that follows `name` in `text`,
 * skipping an optional generic parameter list `<…>` between the two, or
 * `undefined` if no `(…)` follows. Scanning starts at the first whole-word
 * occurrence of `name` (the definition location points at the name, so this is
 * normally offset 0; searching tolerates a broader definition range that also
 * covers the return type / modifiers).
 */
function extractParameterListInner(text: string, name: string): string | undefined {
  const nameStart = findWholeWord(text, name);
  if (nameStart === -1) {
    return undefined;
  }
  let i = skipTrivia(text, nameStart + name.length);
  if (text[i] === "<") {
    const end = matchBalanced(text, i, "<", ">");
    if (end === -1) {
      return undefined;
    }
    i = skipTrivia(text, end);
  }
  if (text[i] !== "(") {
    return undefined;
  }
  const close = matchBalanced(text, i, "(", ")");
  if (close === -1) {
    return undefined;
  }
  return text.slice(i + 1, close - 1);
}

/** Index of the first occurrence of `word` in `text` on identifier boundaries, or -1. */
function findWholeWord(text: string, word: string): number {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(word, from);
    if (idx === -1) {
      return -1;
    }
    const before = idx > 0 ? text[idx - 1] : "";
    const after = idx + word.length < text.length ? text[idx + word.length] : "";
    if (!IDENT.test(before) && !IDENT.test(after)) {
      return idx;
    }
    from = idx + 1;
  }
}

/**
 * Reduces one "type name"–ordered parameter to its type: strips leading
 * attribute groups (`[…]`), cuts any default value (`= …`), then drops the
 * trailing parameter name. Leading modifiers (`ref`/`out`/`in`/`params`/…)
 * stay with the type. Falls back to the trimmed parameter unchanged if the
 * reduction would leave nothing (e.g. a bare type with no name).
 */
function reduceToType(param: string): string {
  let s = param.trim();
  // Leading attribute groups: `[FromServices] IFoo x` → `IFoo x`.
  while (s.startsWith("[")) {
    const end = matchBalanced(s, 0, "[", "]");
    if (end === -1) {
      break;
    }
    s = s.slice(end).trimStart();
  }
  s = cutAtDefault(s).trim();
  // Drop the trailing parameter name (`CancellationToken ct` → `CancellationToken`),
  // but only when non-empty type text precedes it.
  const nameMatch = /\s([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(s);
  if (nameMatch && nameMatch.index > 0) {
    const type = s.slice(0, nameMatch.index).trim();
    if (type.length > 0) {
      return type;
    }
  }
  return s.length > 0 ? s : param.trim();
}

/** The portion of `param` before its default value — the first top-level `=` that is not part of `==`/`=>`/`<=`/`>=`/`!=`. */
function cutAtDefault(param: string): string {
  const stops = topLevelScan(param, (text, i, depth) => {
    if (depth !== 0 || text[i] !== "=") {
      return false;
    }
    const prev = i > 0 ? text[i - 1] : "";
    const next = i + 1 < text.length ? text[i + 1] : "";
    return next !== "=" && next !== ">" && prev !== "=" && prev !== "<" && prev !== ">" && prev !== "!";
  });
  return stops === -1 ? param : param.slice(0, stops);
}

/** True when `param` has a top-level `:` before any default value and it is not part of a `::` qualifier — the shape of a name-first (`id: number`) parameter. */
function hasNameFirstColon(param: string): boolean {
  const hit = topLevelScan(param, (text, i, depth) => {
    if (depth !== 0) {
      return false;
    }
    if (text[i] === "=") {
      // Reached the default value without a name-first colon; stop scanning.
      return true;
    }
    if (text[i] === ":") {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      return prev !== ":" && next !== ":";
    }
    return false;
  });
  return hit !== -1 && param[hit] === ":";
}

/** Splits `inner` at top-level commas, respecting brackets, strings and comments. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  while (i < inner.length) {
    const skipped = skipLiteral(inner, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth = Math.max(0, depth - 1);
    } else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(inner.slice(start));
  return parts;
}

/**
 * Scans `text` tracking bracket depth (across `()[]{}<>`) and skipping string /
 * char literals and comments, calling `predicate(text, i, depth)` at each
 * ordinary character. Returns the index where the predicate first returns
 * true, or -1.
 */
function topLevelScan(
  text: string,
  predicate: (text: string, i: number, depth: number) => boolean
): number {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth = Math.max(0, depth - 1);
    } else if (predicate(text, i, depth)) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Index just past the bracket that matches the `open` at `openIdx` (which must
 * be `open`), counting only `open`/`close` and skipping string / char literals
 * and comments so a bracket inside them is ignored. Returns -1 if unbalanced.
 */
function matchBalanced(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }
  return -1;
}

/** Skips whitespace and comments starting at `i`, returning the next significant index. */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
    const skipped = skipComment(text, i);
    if (skipped === i) {
      return i;
    }
    i = skipped;
  }
}

/** If a string literal, char literal or comment starts at `i`, the index just past it; otherwise `i` unchanged. */
function skipLiteral(text: string, i: number): number {
  const c = text[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === c) {
        return j + 1;
      }
      j++;
    }
    return text.length;
  }
  return skipComment(text, i);
}

/** If a line or block comment starts at `i`, the index just past it; otherwise `i` unchanged. */
function skipComment(text: string, i: number): number {
  if (text[i] === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i + 2);
    return nl === -1 ? text.length : nl;
  }
  if (text[i] === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}
