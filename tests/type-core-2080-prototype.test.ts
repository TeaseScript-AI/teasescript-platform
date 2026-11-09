import assert from "node:assert/strict";
import test from "node:test";
import { compileSourceWithBackend } from "../src/compiler.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { CapReached, WorkLedger, withTestAllowance } from "../src/type-inference/core/budget.js";
import { withoutRecords } from "../src/type-inference/core/consumers.js";
import type { CertificateLedger } from "../src/type-inference/core/consumers/certificates.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { runGlobals } from "./helpers/type-core-route.js";

const programs = [
  ["U0", "let count = 1\ncount = 2\nexit\n", ["nocheck", "nocheck"]],
  ["U1", "let count = 1\ncount = hostValue\nexit\n", ["nocheck", "required"]],
  [
    "U2",
    "let typed: integer = hostValue\nlet out = typed\nout = typed\nexit\n",
    ["nocheck", "nocheck"],
  ],
  [
    "U3",
    "let typed: integer = hostValue\nlet out = typed\nout = hostOther\nexit\n",
    ["nocheck", "required"],
  ],
  ["string control", 'let count = 1\ncount = "bad"\nexit\n', ["nocheck", "rejected"]],
] as const;

function configured<T>(
  mode: string | undefined,
  k: string | undefined,
  share: string | undefined,
  run: () => T,
): T {
  const names = ["TS2080_MODE", "TS2080_K", "TS2080_SHARE"];
  const previous = names.map((key) => process.env[key]);
  for (const [i, value] of [mode, k, share].entries()) {
    if (value === undefined) delete process.env[names[i]!];
    else process.env[names[i]!] = value;
  }
  try {
    return run();
  } finally {
    for (const [i, value] of previous.entries()) {
      if (value === undefined) delete process.env[names[i]!];
      else process.env[names[i]!] = value;
    }
  }
}
function analysed(source: string) {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request);
  return withTestAllowance(1, () => analyseCore(request));
}
function ledger(source: string): CertificateLedger {
  const answers = analysed(source);
  assert.equal(answers.budget.settled, false);
  assert.deepEqual(answers.budget.finished, [], "certificates finish no solver demands");
  const result = answers.budget.certificates;
  assert.ok(result);
  assert.equal(
    result.stores.reduce((sum, store) => sum + store.units, 0),
    answers.budget.apart.get("stopCertificates"),
  );
  assert.ok(
    result.cap === null || result.stores.reduce((sum, store) => sum + store.units, 0) <= result.cap,
  );
  return result;
}
function compile(source: string) {
  return withTestAllowance(1, () =>
    compileSourceWithBackend(source, { globals: ["hostValue", "hostOther"] }, CORE_BACKEND),
  );
}
for (const [name, source, outcomes] of programs) {
  test(`scratch #2080 ${name}: C1 certificate, publication and runtime`, () =>
    configured("reference", "none", "none", () => {
      const first = ledger(source);
      assert.deepEqual(
        first.stores.map((store) => store.outcome),
        outcomes,
      );
      for (const certificate of analysed(source).stopCertificates())
        if (certificate.outcome === "required")
          assert.deepEqual(certificate.required?.ref, { kind: "integer" });
      assert.equal(JSON.stringify(first), JSON.stringify(ledger(source)));
      if (name === "string control") {
        assert.throws(
          () => compile(source),
          (error: unknown) =>
            error instanceof CandidateOutsideSlice &&
            error.what.includes("rejected") &&
            error.what.includes("store"),
        );
        return;
      }
      const result = compile(source);
      assert.ok(result.plan);
      assert.equal(runGlobals(result.plan, { hostValue: 1, hostOther: 2 }).status, "halted");
      if (name === "U1" || name === "U3") {
        const invalid =
          name === "U1" ? { hostValue: 1.5, hostOther: 1 } : { hostValue: 1, hostOther: 1.5 };
        const run = runGlobals(result.plan, invalid);
        assert.equal(run.status, "failed");
        assert.match(run.failure ?? "", /^TSR058@/);
        assert.equal(runGlobals(result.plan, { hostValue: 1.5, hostOther: 1 }).status, "failed");
      }
    }));
}
test("scratch #2080 aggregate cap stops at the first crossing and never derives later stores", () =>
  configured("capped", "10", "none", () => {
    const source = "let count = 1\ncount = hostValue\ncount = 3\nexit\n";
    const result = ledger(source);
    assert.deepEqual(
      result.stores.map((store) => store.outcome),
      ["unresolved-total", "unresolved-total", "unresolved-total"],
    );
    assert.ok(result.stores[0]!.units > 0);
    assert.deepEqual(
      result.stores.slice(1).map((store) => store.units),
      [0, 0],
    );
    assert.throws(() => compile(source), CandidateOutsideSlice);
  }));
test("scratch #2080 certificate guard leaves program stop, total and spender intact", () => {
  for (const stopped of [false, true]) {
    const work = new WorkLedger(100);
    work.charge("checks", 2);
    work.spender = 3;
    if (stopped) work.stop("work");
    assert.throws(
      () =>
        work.apart(() =>
          work.certificateWork(3, () => {
            work.charge("checks", 2);
            work.spender = 7;
            work.charge("literalUnits", 2);
          }),
        ),
      CapReached,
    );
    assert.equal(work.total, 2);
    assert.equal(work.stopped, stopped ? "work" : null);
    assert.equal(work.spender, 3);
    assert.equal(work.certificateUnits, 2);
  }
});
test("scratch #2080 unsupported inferred copy declines; unset mode retains the base route", () => {
  const source = "let first = 1\nlet second = first\nsecond = hostValue\nexit\n";
  configured("reference", "none", "none", () => {
    assert.ok(ledger(source).stores.some((store) => store.outcome === "unresolved-semantic"));
    assert.throws(() => compile(source), CandidateOutsideSlice);
  });
  configured(undefined, undefined, undefined, () => {
    assert.equal(analysed(source).budget.certificates, undefined);
    assert.ok(compile(source).plan);
  });
});

test("scratch #2080 the aggregate shares work across stores without a per-store cap", () => {
  const source = "let count = 1\ncount = 2\ncount = 3\ncount = 4\nexit\n";
  const reference = configured("reference", "none", "none", () => ledger(source));
  const k = Math.ceil(
    reference.stores.reduce((sum, store) => sum + store.units, 0) / reference.marked,
  );
  assert.ok(reference.stores[0]!.units > k, "shared construction is charged to the first store");
  configured("capped", String(k), "none", () => {
    const capped = ledger(source);
    assert.deepEqual(capped.stores, reference.stores);
    assert.ok(compile(source).plan);
  });
});
test("scratch #2080 a cut Required derivation publishes none of its partial contract or warnings", () => {
  const source = programs[1][1];
  const reference = configured("reference", "none", "none", () => ledger(source));
  const cap = reference.stores.reduce((sum, store) => sum + store.units, 0) - 1;
  assert.ok(reference.cap);
  configured("capped", "none", String(cap / reference.cap), () => {
    const answers = analysed(source);
    assert.deepEqual(
      answers.budget.certificates?.stores.map((store) => store.outcome),
      ["nocheck", "unresolved-total"],
    );
    assert.deepEqual(answers.completedWarnings(), []);
    assert.deepEqual(answers.receiving, []);
    assert.throws(() => compile(source), CandidateOutsideSlice);
  });
});

test("scratch #2080 a later direct written copy decides before a conflicting literal", () =>
  configured("reference", "none", "none", () => {
    const source =
      'let typed: integer = hostValue\nlet out = null\nout = typed\nout = "bad"\nexit\n';
    assert.equal(ledger(source).stores.at(-1)?.outcome, "rejected");
    assert.throws(() => compile(source), CandidateOutsideSlice);
  }));

test("scratch #2080 the publication gate declines a Required check omitted from completion", () =>
  configured("reference", "none", "none", () => {
    assert.throws(
      () =>
        withoutRecords({ diagnostic: () => false, check: () => false, completion: true }, () =>
          compile(programs[1][1]),
        ),
      (error: unknown) => error instanceof CandidateOutsideSlice && error.what.includes("required"),
    );
  }));
