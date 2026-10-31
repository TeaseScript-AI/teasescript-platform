// Groovy-oracle fixtures: small Groovy programs whose converted packages must say what Groovy 2.5.21 printed for them
// (tools/groovy-oracle.ts records `<name>.out`). Each one is a case where the conversion compiles and runs, so a
// regression would change what the player reads without any diagnostic: closure captures, shared lists, list growth and
// positions, comparisons, defaults, and formatting. Real Groovy parsing, importer lowering, and the repository build's
// compiler and runtime, with seed 1. `WAIT n` lines count only where the fixture's own preamble prints them. A fixture
// that asks gets its `<name>.answers` in turn on both sides, and must use them all; an image request takes one stored
// image for its answer, as a chosen file. A camera capture takes a `PHOTO` answer as a photo of that image; without one
// there is no camera, so takePhoto() gives null, as a fixture's preamble has getImage give.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emitTease } from "../src/emit-tease.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { repositoryBuildUrl } from "../src/repository-build.ts";
import { parseGroovySource } from "../src/source-parser.ts";
import { ORACLE_FIXTURES, oracleAnswers, oracleFixtureNames } from "../tools/groovy-oracle.ts";

interface OracleEvent {
  kind?: string;
  text?: string;
}
interface OracleSnapshot {
  status: string;
  foregroundAction?: {
    kind?: string;
    actionId?: number;
    interactionKind?: string;
    ui?: { kind?: string };
    createdAtMs?: number;
    deadlineMs?: number;
  } | null;
}
interface OracleStep {
  snapshot: OracleSnapshot;
  events: OracleEvent[];
}
interface OracleRuntime {
  compileSource(source: string): { plan?: unknown };
  createFreshRuntimeSnapshot(plan: unknown, options: { seed: number }): OracleSnapshot;
  run(plan: unknown, snapshot: OracleSnapshot): OracleStep;
  observeTime(plan: unknown, snapshot: OracleSnapshot, now: number): OracleStep;
  completeAction(
    plan: unknown,
    snapshot: OracleSnapshot,
    request: unknown,
    options?: { capturedMedia?: { holds: (reference: string) => boolean } },
  ): OracleStep & { outcome: { kind?: string } };
}

/** The stored image an image request is answered with. */
const ORACLE_IMAGE = "oracle-image";

const unavailable = ((): string | false => {
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0)
    return "Java is not available for the Groovy 2.5.21 parser helper.";
  const jar =
    process.env.SEXSCRIPT_GROOVY_JAR ??
    path.join(homedir(), ".m2/repository/org/codehaus/groovy/groovy/2.5.21/groovy-2.5.21.jar");
  if (!existsSync(jar)) return `Groovy 2.5.21 JAR not found: ${jar}`;
  return existsSync(repositoryBuildUrl("src/index.js"))
    ? false
    : "The TeaseScript build is missing; run npm run build:typescript in the repository root.";
})();

/** What a converted fixture says, with `WAIT n` for each wait where `waits` asks for them, until it halts. */
async function converted(name: string, waits: boolean): Promise<string[]> {
  const runtime: unknown = await import(repositoryBuildUrl("src/index.js").href);
  assert.ok(typeof runtime === "object" && runtime !== null);
  // EVIDENCE: the repository build's index exports these runtime functions (src/index.ts).
  const { compileSource, createFreshRuntimeSnapshot, run, observeTime, completeAction } =
    runtime as OracleRuntime;
  const answers = [...(oracleAnswers(name) ?? [])];
  const parsed = await parseGroovySource(path.join(ORACLE_FIXTURES, `${name}.groovy`));
  const [program] = lowerSelfContainedPackage([parsed], {});
  assert.ok(program !== undefined);
  const { plan } = compileSource(emitTease(program));
  assert.ok(plan !== undefined, `${name} does not compile`);
  const lines: string[] = [];
  const note = (events: readonly OracleEvent[]): void => {
    for (const event of events) if (event.kind === "say") lines.push(event.text ?? "");
  };
  let step = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1 }));
  note(step.events);
  for (let turn = 0; turn < 500 && step.snapshot.status === "waiting"; turn += 1) {
    const action = step.snapshot.foregroundAction;
    if (action?.kind === "capture") {
      // A `PHOTO` answer is a photo the camera takes; otherwise there is no camera.
      const photo = answers[0] === "PHOTO";
      if (photo) answers.shift();
      const completed = completeAction(
        plan,
        step.snapshot,
        {
          actionId: action.actionId,
          actionKind: "capture",
          payload: photo
            ? { kind: "captured", media: { kind: "image", reference: ORACLE_IMAGE } }
            : { kind: "unavailable", reason: "unconfigured" },
        },
        { capturedMedia: { holds: (reference) => reference === ORACLE_IMAGE } },
      );
      assert.equal(completed.outcome.kind, "completed", `${name} refuses the camera's answer`);
      note(completed.events);
      step = run(plan, completed.snapshot);
      note(step.events);
      continue;
    }
    if (action?.kind === "interaction") {
      const answer = answers.shift();
      assert.ok(answer !== undefined, `${name} asks more often than its answers`);
      const payload =
        action.ui?.kind === "image"
          ? { kind: "image", reference: ORACLE_IMAGE }
          : action.interactionKind === "choice"
            ? { kind: "selectedOption", optionIndex: Number(answer) }
            : { kind: "submittedText", submittedText: answer };
      const { actionId, interactionKind } = action;
      const completed = completeAction(
        plan,
        step.snapshot,
        { actionId, actionKind: "interaction", interactionKind, payload },
        { capturedMedia: { holds: (reference) => reference === ORACLE_IMAGE } },
      );
      assert.equal(completed.outcome.kind, "completed", `${name} refuses the answer ${answer}`);
      note(completed.events);
      step = run(plan, completed.snapshot);
      note(step.events);
      continue;
    }
    const deadline = action?.deadlineMs;
    if (deadline === undefined) break;
    if (waits && action?.kind === "delay")
      lines.push(`WAIT ${(deadline - (action.createdAtMs ?? deadline)) / 1000}`);
    const observed = observeTime(plan, step.snapshot, deadline);
    note(observed.events);
    step = run(plan, observed.snapshot);
    note(step.events);
  }
  assert.equal(step.snapshot.status, "halted", `${name} does not halt`);
  assert.deepEqual(answers, [], `${name} leaves answers unused`);
  return lines;
}

for (const name of unavailable ? [] : oracleFixtureNames()) {
  test(`${name} says what Groovy printed`, async () => {
    const expected = readFileSync(path.join(ORACLE_FIXTURES, `${name}.out`), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const waits = expected.some((line) => line.startsWith("WAIT "));
    assert.deepEqual(await converted(name, waits), expected);
  });
}

test("Groovy-oracle fixtures are available", { skip: unavailable }, () => {
  assert.ok(oracleFixtureNames().length > 0);
});
