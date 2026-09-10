// Pure, dependency-free parsing of a C#-style type header's base-type list —
// the part after `:` and before the body `{` (or a `where` clause). Used to
// find the interfaces a class implements without a type-hierarchy provider:
// the caller resolves each identifier via the definition provider and keeps
// the ones that land on an interface.

/** Whether the substring `word` sits at `[start, end)` on identifier boundaries in `text`. */
function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

/**
 * Character offsets, within `header`, of the top-level identifier tokens in a
 * type declaration's base-type list. `header` is the text starting right after
 * the type name (so it may begin with generic params `<…>`, a primary
 * constructor `(…)`, then `:` and the base list).
 *
 * Only the base list is scanned — the region after the first depth-0 `:` up to
 * the next depth-0 `where` / `{` / `;` — and only identifiers at that region's
 * top level are returned (generic arguments and constructor parameters, which
 * sit inside `<…>`/`(…)`, are skipped). Returns `[]` when there is no base
 * list. Namespace qualifiers yield extra identifiers, which the caller filters
 * out when they don't resolve to an interface with the wanted member.
 */
export function baseTypeIdentifierOffsets(header: string): number[] {
  const baseStart = findBaseListStart(header);
  if (baseStart === -1) {
    return [];
  }

  const offsets: number[] = [];
  let depth = 0;
  let i = baseStart;
  while (i < header.length) {
    const c = header[i];
    if (c === "(" || c === "<" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === ">" || c === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === "{" || c === ";") {
        break;
      }
      if (header.startsWith("where", i) && isWholeWord(header, i, i + 5)) {
        break;
      }
      if (/[A-Za-z_]/.test(c)) {
        const start = i;
        while (i < header.length && /[A-Za-z0-9_]/.test(header[i])) {
          i++;
        }
        offsets.push(start);
        continue;
      }
    }
    i++;
  }
  return offsets;
}

/** Offset just after the depth-0 `:` that starts the base list, or -1 if there is none before the body / a `where` clause. */
function findBaseListStart(header: string): number {
  let depth = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === "(" || c === "<" || c === "[") {
      depth++;
    } else if (c === ")" || c === ">" || c === "]") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (c === ":") {
        return i + 1;
      }
      if (c === "{" || c === ";") {
        return -1;
      }
      if (header.startsWith("where", i) && isWholeWord(header, i, i + 5)) {
        return -1;
      }
    }
  }
  return -1;
}
