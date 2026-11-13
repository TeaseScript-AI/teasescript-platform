// #2493: the identity view's work (`identitySteps`): none without an identity function, and with one each loop's units
// as a count of the syntax's own gives them (R38, R51).
import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { WorkLedger } from "../../../src/type-inference/core/budget.js";
import { coreCheckResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { checkedOnSource, identityView } from "../../../src/type-inference/core/identity-view.js";
import type { CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { type WorkFamily } from "../../helpers/type-core/families/builders.js";
import { analysed, many, sized, steepCounters } from "../../helpers/type-core/type-core-work.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";

const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];
const PASS = "global function pass(given) {\n  return given\n}\n";

test("the view takes no work without an identity function (#2493)", () => {
  const plain = coreRequest(main('let box = {n: 1}\nbox.n = 2\nsay "${box.n}"\nexit'))!;
  const none = identityView(plain);
  assert.equal(none.request, plain);
  assert.equal(none.steps, 0);
  assert.equal(analyseCore(plain).budget.counts.has("identitySteps"), false);
});

/**
 * k of each: a function whose body reads a call, a call read beside one kept in a store's receiver, one kept in the
 * receiver of a method whose callee is in parentheses, and a written variable's start value (translated into the view).
 */
const IDENTITY_CALLS: WorkFamily = {
  name: "identity-calls",
  measures:
    "#2493: every loop of the view, its units per value, name, parentheses, ancestor and member",
  program: (k) =>
    main(
      PASS +
        many(k, (i) => `global function use${i}(q) {\n  let r = pass(q)\n  return r\n}`) +
        "\n" +
        many(
          k,
          (i) =>
            `let b${i} = {n: pass(${i})}\npass(b${i}).n = pass(1)\nlet xs${i} = [pass(${i})]\n(pass(xs${i}).add)(1)\nlet w${i} = pass(${i})\nw${i} = 2`,
        ) +
        "\nexit",
    ),
};

/** A value of the syntax tree as this count reads it: a node or a list, by its members. */
type Tree = { readonly [member: string]: unknown };
const isTree = (value: unknown): value is Tree => value !== null && typeof value === "object";
/** A container's members but `span` (what the view walks), as [key, value] pairs. */
const members = (value: Tree): [string, unknown][] =>
  Object.entries(value).filter(([key]) => key !== "span");
const text = (value: unknown, member: string): string => {
  const found = isTree(value) ? value[member] : undefined;
  return typeof found === "string" ? found : "";
};
const kindOf = (value: unknown): string => text(value, "kind");

/**
 * The view's units for a request with an identity function `pass`, counted from its syntax (the walks the view's
 * docblock lists, each counted here by its own reading of the tree, not by the view): values met, a function's body
 * values and names, a callee's parentheses, the ancestors of each call read, and the rebuild's containers and members.
 */
function expectedUnits(request: CoreAnalysisRequest): number {
  let units = 0;
  let functions = 0;
  for (const file of request.files) {
    // identityNames: a unit per top-level statement, and per function name (each declared once here)
    for (const statement of file.program.statements) {
      units += 1;
      if (statement.kind === "functionDeclaration") functions += 1;
    }
    // a unit for the file
    units += 1;
    const holders = new Map<Tree, { readonly holder: Tree; readonly key: string }>();
    const containers: Tree[] = [];
    const stack: [unknown, Tree | null, string][] = [[file.program, null, ""]];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      units += 1;
      const [value, holder, key] = at;
      if (!isTree(value)) continue;
      containers.push(value);
      if (holder !== null) holders.set(value, { holder, key });
      if (kindOf(value) === "functionDeclaration") {
        // ownNames: its body's values; the names copied (`given`; `q` and `r`)
        let body = 0;
        const own: unknown[] = [value["body"]];
        for (let next = own.pop(); next !== undefined; next = own.pop()) {
          body += 1;
          if (isTree(next)) for (const [, child] of members(next)) own.push(child);
        }
        units += body + (text(value["name"], "name") === "pass" ? 1 : 2);
      }
      if (kindOf(value) === "callExpression")
        for (let callee = value["callee"]; kindOf(callee) === "parenthesizedExpression";) {
          units += 1;
          callee = isTree(callee) ? callee["expression"] : undefined;
        }
      for (const [member, child] of members(value)) stack.push([child, value, member]);
    }
    // the calls read: each call of `pass` but a store's or a changing method's receiver
    const kept = (call: Tree): boolean => {
      const up = holders.get(call);
      if (
        up === undefined ||
        kindOf(up.holder) !== "propertyAccessExpression" ||
        up.key !== "object"
      )
        return false;
      let above = holders.get(up.holder);
      while (above !== undefined && kindOf(above.holder) === "parenthesizedExpression")
        above = holders.get(above.holder);
      return (
        above !== undefined &&
        ((kindOf(above.holder) === "assignmentStatement" && above.key === "target") ||
          (kindOf(above.holder) === "callExpression" && above.key === "callee"))
      );
    };
    const reads = containers.filter(
      (value) =>
        kindOf(value) === "callExpression" &&
        kindOf(value["callee"]) === "identifier" &&
        text(value["callee"], "name") === "pass" &&
        !kept(value),
    );
    if (reads.length === 0) continue;
    const marked = new Set<Tree>();
    for (const call of reads)
      for (
        let at: Tree | undefined = call;
        at !== undefined && !marked.has(at);
        at = holders.get(at)?.holder
      ) {
        units += 1;
        marked.add(at);
      }
    // the rebuild: each container, and each member of a marked one that is no call read (a list's elements, a node's
    // members with its span)
    units += containers.length;
    for (const value of marked) if (!reads.includes(value)) units += Object.keys(value).length;
    // the nodes translated into the view
    units += file.picks.size;
  }
  const options = request.options;
  units += functions;
  units +=
    (options.sharedWrites?.size ?? 0) +
    (options.written?.lets.size ?? 0) +
    (options.speakers?.size ?? 0);
  return units;
}

test("the view's work is each loop's units, as the syntax counts them, at three sizes (#2493, R51)", () => {
  for (const k of [64, 128, 256]) {
    const request = sized(IDENTITY_CALLS, k).request;
    assert.equal(
      analyseCore(request).budget.counts.get("identitySteps"),
      expectedUnits(request),
      `k = ${k}`,
    );
  }
});

test("the view's work grows with the program, at three sizes (#2493)", () => {
  assert.deepEqual(
    [
      ...steepCounters([IDENTITY_CALLS]),
      ...steepCounters([IDENTITY_CALLS], false, undefined, [128, 256]),
    ],
    [],
  );
  for (const k of [64, 128, 256])
    assert.ok((analysed(sized(IDENTITY_CALLS, k)).budget.counts.get("identitySteps") ?? 0) > 0);
});

test("the result read back onto the source charges a unit per node it translates (#2493, R51)", () => {
  const request = coreRequest(
    main(
      `${PASS}let xs: (integer | string)[] = [1, "s"]\nlet w: integer = pass(xs[1])\nrepeat pass(xs[1]) {}\nexit`,
    ),
  )!;
  const view = identityView(request);
  const answers = analyseCore(view.request);
  const checked = coreCheckResult(
    answers,
    new SliceIndex(view.request.files.map((file) => file.program)),
    view.request,
  );
  const core = checked.coreChecks;
  const nodes =
    checked.runtimeChecks.size +
    checked.formShapes.size +
    checked.ways.paths.size +
    checked.unreachable.size +
    (core === undefined
      ? 0
      : core.requireExisting.size +
        core.indexChecks.size +
        core.fallbackChecks.size +
        core.expected.size +
        core.repairs.size +
        core.partChecks.size);
  assert.ok(nodes > 0);
  const work = new WorkLedger(1_000_000);
  checkedOnSource(view, checked, work);
  assert.equal(work.counts().get("identitySteps"), nodes);
});
