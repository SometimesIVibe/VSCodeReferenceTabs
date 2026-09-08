import * as assert from "assert";
import { CallGroup, CallNode } from "../model";
import {
  allRootsTest,
  dedupeCallNodesByLocation,
  findCallNode,
  orderCallGroups,
  recomputeAndSort,
} from "../callTree";

/**
 * Pure unit suite for the call-tree roll-up + ordering ({@link recomputeAndSort})
 * and lookup ({@link findCallNode}). No VS Code APIs involved.
 */

let counter = 0;
function node(name: string, isTest: boolean, overrides: Partial<CallNode> = {}): CallNode {
  return {
    id: `n${counter++}`,
    name,
    detail: "",
    symbolKind: 11,
    uri: `file:///${name}.cs`,
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
    selectionRange: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
    isTest,
    branchTest: isTest,
    loaded: false,
    expanded: false,
    children: [],
    ...overrides,
  };
}

suite("callTree", () => {
  suite("recomputeAndSort — branchTest roll-up", () => {
    test("an unexpanded node's branchTest falls back to its own isTest", () => {
      const nodes = [node("A", false), node("B", true)];
      recomputeAndSort(nodes);
      assert.strictEqual(nodes.find((n) => n.name === "A")!.branchTest, false);
      assert.strictEqual(nodes.find((n) => n.name === "B")!.branchTest, true);
    });

    test("a non-test node whose loaded callers are all test is an 'only used by tests' branch", () => {
      const prod = node("Prod", false, {
        loaded: true,
        expanded: true,
        children: [node("Test1", true, { loaded: true }), node("Test2", true, { loaded: true })],
      });
      recomputeAndSort([prod]);
      // The view distinguishes the two flavors of the dimmed marking from
      // these two flags: branchTest && !isTest => "only used by tests" (a
      // production node reached only from tests), vs isTest => "test".
      assert.strictEqual(prod.branchTest, true, "all callers test => dimmed test branch");
      assert.strictEqual(prod.isTest, false, "the node itself is production => 'only used by tests'");
    });

    test("a node with even one non-test caller is not a test branch", () => {
      const root = node("Root", true, {
        loaded: true,
        expanded: true,
        children: [node("TestCaller", true, { loaded: true }), node("ProdCaller", false, { loaded: true })],
      });
      recomputeAndSort([root]);
      assert.strictEqual(root.branchTest, false);
    });

    test("roll-up is recursive through multiple levels", () => {
      const leaf = node("Leaf", true, { loaded: true });
      const mid = node("Mid", false, { loaded: true, expanded: true, children: [leaf] });
      const top = node("Top", false, { loaded: true, expanded: true, children: [mid] });
      recomputeAndSort([top]);
      assert.strictEqual(mid.branchTest, true);
      assert.strictEqual(top.branchTest, true);
    });

    test("an expanded node with zero callers uses its own isTest (entry point)", () => {
      const prodEntry = node("ProdEntry", false, { loaded: true, expanded: true, children: [] });
      const testEntry = node("TestEntry", true, { loaded: true, expanded: true, children: [] });
      recomputeAndSort([prodEntry, testEntry]);
      assert.strictEqual(prodEntry.branchTest, false);
      assert.strictEqual(testEntry.branchTest, true);
    });
  });

  suite("recomputeAndSort — ordering", () => {
    test("non-test before test at the top level, name-alpha within each", () => {
      const nodes = [node("Zebra", false), node("Apple", true), node("Mango", false), node("Beta", true)];
      recomputeAndSort(nodes);
      assert.deepStrictEqual(
        nodes.map((n) => n.name),
        ["Mango", "Zebra", "Apple", "Beta"]
      );
    });

    test("children are ordered the same way as the top level", () => {
      const parent = node("P", false, {
        loaded: true,
        expanded: true,
        children: [node("tImpl", true, { loaded: true }), node("aProd", false, { loaded: true })],
      });
      recomputeAndSort([parent]);
      assert.deepStrictEqual(
        parent.children.map((n) => n.name),
        ["aProd", "tImpl"]
      );
    });
  });

  suite("orderCallGroups", () => {
    function group(title: string, kind: CallGroup["kind"], isTest: boolean): CallGroup {
      return { id: `g-${title}`, title, kind, roots: [], isTest, collapsed: isTest };
    }

    test("interface group is first; implementations follow with test groups last", () => {
      const groups = [
        group("BetaHandler", "implementation", false),
        group("ZebraTestHandler", "implementation", true),
        group("AlphaHandler", "implementation", false),
        group("IHandler", "interface", false),
      ];
      orderCallGroups(groups);
      assert.deepStrictEqual(
        groups.map((g) => g.title),
        ["IHandler", "AlphaHandler", "BetaHandler", "ZebraTestHandler"]
      );
    });

    test("a test-only interface group still sorts before implementations", () => {
      const groups = [
        group("ProdHandler", "implementation", false),
        group("IHandler", "interface", true),
      ];
      orderCallGroups(groups);
      assert.deepStrictEqual(
        groups.map((g) => g.title),
        ["IHandler", "ProdHandler"]
      );
    });
  });

  suite("allRootsTest", () => {
    test("true only when there is at least one root and all are test branches", () => {
      assert.strictEqual(allRootsTest([]), false);
      assert.strictEqual(allRootsTest([node("A", true, { branchTest: true })]), true);
      assert.strictEqual(
        allRootsTest([node("A", true, { branchTest: true }), node("B", false, { branchTest: false })]),
        false
      );
    });
  });

  suite("dedupeCallNodesByLocation", () => {
    function at(uri: string, line: number, character = 0): CallNode {
      return node("n", false, {
        uri,
        selectionRange: { startLine: line, startCharacter: character, endLine: line, endCharacter: character + 1 },
      });
    }

    test("drops callers that resolve to the same file + selection-range start, keeping the first", () => {
      const a = at("file:///A.cs", 10);
      const dupOfA = at("file:///A.cs", 10);
      const b = at("file:///B.cs", 10);
      const result = dedupeCallNodesByLocation([a, dupOfA, b]);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0], a);
      assert.strictEqual(result[1], b);
    });

    test("keeps same-file callers on different lines/columns", () => {
      const result = dedupeCallNodesByLocation([
        at("file:///A.cs", 10, 4),
        at("file:///A.cs", 20, 4),
        at("file:///A.cs", 10, 8),
      ]);
      assert.strictEqual(result.length, 3);
    });
  });

  suite("findCallNode", () => {
    test("finds a deeply nested node by id", () => {
      const leaf = node("Leaf", false);
      const mid = node("Mid", false, { loaded: true, children: [leaf] });
      const top = node("Top", false, { loaded: true, children: [mid] });
      assert.strictEqual(findCallNode([top], leaf.id), leaf);
    });

    test("returns undefined for an unknown id", () => {
      assert.strictEqual(findCallNode([node("A", false)], "nope"), undefined);
    });
  });
});
