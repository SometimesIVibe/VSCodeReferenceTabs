/**
 * Decides whether a reference's file belongs to a .NET **test project** by
 * locating the nearest enclosing `.csproj` and inspecting its contents — no
 * path-name guessing. A file with no `.csproj` up its directory tree (a
 * non-.NET file, or a loose script) is treated as non-test.
 *
 * The pure XML predicate {@link isTestProjectContent} has no `vscode`
 * dependency and is unit-tested directly; {@link TestProjectClassifier}
 * wraps it with the directory walk, file reads, and caching that need the
 * VS Code file-system API.
 */
import * as vscode from "vscode";

/**
 * True when a `.csproj`'s XML marks it as a test project. Recognized signals,
 * in priority order:
 *
 * 1. An explicit `<IsTestProject>false</IsTestProject>` opts out, even if a
 *    test package is also referenced (wins over everything below).
 * 2. `<IsTestProject>true</IsTestProject>`.
 * 3. An SDK-style project targeting `MSTest.Sdk` (`<Project Sdk="MSTest.Sdk">`,
 *    possibly one of several `;`-separated SDKs).
 * 4. A `PackageReference` to the test SDK or a known test framework —
 *    `Microsoft.NET.Test.Sdk`, or any `xunit*` / `nunit*` / `mstest*` package
 *    (covers the frameworks plus their test adapters/runners).
 *
 * A lightweight regex scan is used rather than a full XML parser: the
 * extension bundles no XML dependency, and these markers are unambiguous in
 * the flat, attribute-driven shape of an SDK-style `.csproj`.
 */
export function isTestProjectContent(csprojXml: string): boolean {
  if (/<IsTestProject>\s*false\s*<\/IsTestProject>/i.test(csprojXml)) {
    return false;
  }
  if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(csprojXml)) {
    return true;
  }

  const sdkMatch = csprojXml.match(/<Project\b[^>]*\bSdk\s*=\s*"([^"]*)"/i);
  if (sdkMatch && /(^|;)\s*MSTest\.Sdk\b/i.test(sdkMatch[1])) {
    return true;
  }

  const packageRef = /<PackageReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = packageRef.exec(csprojXml)) !== null) {
    if (isTestPackage(match[1])) {
      return true;
    }
  }

  return false;
}

/** True for the test SDK and the common test-framework package families (and their adapters/runners). */
function isTestPackage(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n === "microsoft.net.test.sdk" ||
    n.startsWith("xunit") ||
    n.startsWith("nunit") ||
    n.startsWith("mstest")
  );
}

/**
 * Classifies file URIs as belonging to a test project by walking up to the
 * nearest `.csproj` and parsing it. Two caches keep a single search cheap:
 * one maps each visited directory to the `.csproj` that governs it (so files
 * sharing a project resolve without re-walking), the other maps each
 * `.csproj` to its parsed test/non-test verdict (so each project file is
 * read and scanned at most once). Create one per search.
 */
export class TestProjectClassifier {
  /** Directory URI string -> governing `.csproj` URI string, or `null` when none exists up-tree. */
  private readonly csprojByDir = new Map<string, string | null>();
  /** `.csproj` URI string -> whether it is a test project. */
  private readonly isTestByCsproj = new Map<string, boolean>();

  public async isTestReference(fileUri: vscode.Uri): Promise<boolean> {
    const csproj = await this.findNearestCsproj(fileUri);
    if (!csproj) {
      return false;
    }
    return this.isTestProject(csproj);
  }

  /**
   * Walks from the file's directory up to the workspace-folder root (or the
   * filesystem root when the file is outside any folder), returning the first
   * `.csproj` found. Every directory visited on the way is memoized with the
   * result so sibling files short-circuit.
   */
  private async findNearestCsproj(fileUri: vscode.Uri): Promise<vscode.Uri | null> {
    const stopAt = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.toString();
    const visited: string[] = [];
    let dir = parentUri(fileUri);

    for (;;) {
      const key = dir.toString();

      const cached = this.csprojByDir.get(key);
      if (cached !== undefined) {
        this.rememberDirs(visited, cached);
        return cached === null ? null : vscode.Uri.parse(cached);
      }
      visited.push(key);

      const found = await this.readCsprojIn(dir);
      if (found) {
        this.rememberDirs(visited, found.toString());
        return found;
      }

      const parent = parentUri(dir);
      if (key === stopAt || parent.toString() === key) {
        this.rememberDirs(visited, null);
        return null;
      }
      dir = parent;
    }
  }

  private rememberDirs(dirs: string[], csproj: string | null): void {
    for (const dir of dirs) {
      this.csprojByDir.set(dir, csproj);
    }
  }

  private async readCsprojIn(dir: vscode.Uri): Promise<vscode.Uri | null> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return null;
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.toLowerCase().endsWith(".csproj")) {
        return vscode.Uri.joinPath(dir, name);
      }
    }
    return null;
  }

  private async isTestProject(csproj: vscode.Uri): Promise<boolean> {
    const key = csproj.toString();
    const cached = this.isTestByCsproj.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let isTest = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(csproj);
      isTest = isTestProjectContent(Buffer.from(bytes).toString("utf8"));
    } catch {
      isTest = false;
    }
    this.isTestByCsproj.set(key, isTest);
    return isTest;
  }
}

/** Parent directory of a URI, via `joinPath(uri, "..")`; at a root it returns the root unchanged (loop terminator). */
function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, "..");
}
