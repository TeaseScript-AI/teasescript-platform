// The cost report's one deciding function over its cells (`cells.mjs`) and the report's refusals (`report.mjs`).
import assert from "node:assert/strict";
import test from "node:test";
import { AXES, allCells, cellName, classify } from "./cells.mjs";
import { buildReport } from "./report.mjs";

test("every cell is decided in both phases, and every axis value is required somewhere", () => {
  for (const phase of ["r0", "r1"]) {
    const required = allCells().filter((cell) => classify(cell, phase).required);
    for (const [axis, values] of Object.entries(AXES))
      for (const value of values)
        assert.ok(
          required.some((cell) => cell[axis] === value),
          `${phase}: no required cell has ${axis} '${value}'`,
        );
  }
});

test("the exclusions name their reasons, and the Worker Player waits for r1", () => {
  const decide = (cell, phase = "r1") =>
    classify(
      { script: "DisciplineClinic", route: "source", backend: "main", engine: "chromium", ...cell },
      phase,
    );
  assert.equal(decide({ scenario: "taps", engine: "firefox" }).reason, "no CDP touch input");
  assert.equal(
    decide({ scenario: "session", route: "plan" }).reason,
    "the full Player prepares source only",
  );
  assert.equal(decide({ scenario: "bridge", route: "plan" }).required, true);
  assert.equal(decide({ scenario: "session", backend: "worker" }, "r0").rule, "worker Player");
  assert.equal(decide({ scenario: "session", backend: "worker" }, "r1").required, true);
  assert.equal(decide({ scenario: "bridge", backend: "worker" }, "r0").required, true);
  assert.equal(
    decide({ scenario: "keepDurable", script: "CelebWorship", engine: "pixel" }).required,
    true,
  );
  assert.equal(decide({ scenario: "keepDurable", script: "CelebWorship" }).rule, "phone only");
});

test("a value outside the axes is refused, never skipped", () => {
  assert.throws(
    () =>
      classify(
        {
          scenario: "session",
          script: "CelebWorship",
          route: "source",
          backend: "main",
          engine: "safari",
        },
        "r0",
      ),
    /no value of the axis 'engine'/u,
  );
  assert.throws(
    () =>
      classify(
        {
          scenario: "session",
          script: "CelebWorship",
          route: "source",
          backend: "main",
          engine: "pixel",
        },
        "r2",
      ),
    /no phase/u,
  );
});

test("the report fails on a row for an excluded cell and lists required cells without data as incomplete", () => {
  const row = (cell, ok) => ({
    route: "source",
    backend: "main",
    script: "CelebWorship",
    version: "1",
    build: "dist/player-app",
    commit: null,
    ok,
    result: {},
    ...cell,
  });
  assert.throws(
    () =>
      buildReport(
        [row({ scenario: "taps", engine: "webkit", script: "DisciplineClinic" }, true)],
        "r0",
      ),
    /excluded cell/u,
  );
  const report = buildReport(
    [
      row({ scenario: "session", engine: "chromium" }, true),
      row({ scenario: "session", engine: "firefox" }, false),
    ],
    "r0",
  );
  assert.equal(report.complete, false);
  const chromium = cellName({
    scenario: "session",
    script: "CelebWorship",
    route: "source",
    backend: "main",
    engine: "chromium",
  });
  const firefox = cellName({
    scenario: "session",
    script: "CelebWorship",
    route: "source",
    backend: "main",
    engine: "firefox",
  });
  assert.ok(chromium in report.summary);
  assert.ok(report.incomplete.some((line) => line.includes(firefox) && line.includes("0 ok")));
});
