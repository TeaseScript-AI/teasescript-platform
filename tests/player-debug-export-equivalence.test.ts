import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import * as compileProject from "../player/runtime/compile-project.js";
import * as assembly from "../player/debug/debug-export-assembly.js";
import * as debugExport from "../player/debug/debug-export.js";
import * as recorder from "../player/debug/debug-recorder.js";
import { prepareExport } from "../player/engine-bridge/recording/export-replay.js";
import * as adapter from "../player/runtime/runtime-adapter.js";
import * as view from "../player/runtime/runtime-view.js";
import type { PlayerRuntimeSession } from "../player/runtime/runtime-adapter.js";
import type { RuntimeSnapshot } from "../src/index.js";

/*
 * L5h.3b's export equivalence (§21.4 family 5): the scenarios of `tests/fixtures/debug-export-equivalence/`, assembled
 * on the head's path (the host prepares the plan's hash and replay data, `exportPrepare`), give the file JSON the base's
 * assembler gave (`fixture.json`, written once by `generate.mjs` at the base, never re-blessed). Every row is compared
 * unconditionally: its file text equals the fixture's, with no exception list. 3b's changes of what an export holds
 * (the marks and incident from the capture) are decided before the assembler, in the export observation family.
 */

const FOLDER = resolve(process.cwd(), "tests/fixtures/debug-export-equivalence");

interface Made {
  readonly session: PlayerRuntimeSession | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly recording: recorder.DebugRecording | null;
  readonly hostError: string | null;
  readonly rewound: { readonly restoredSceneTimeMs: number; readonly rewindCount: number } | null;
}
interface Fixture {
  readonly base: string;
  readonly scenarios: readonly {
    readonly name: string;
    readonly choices: readonly string[];
    readonly files: readonly { readonly file: string; readonly parts: unknown }[];
  }[];
}

test("each scenario's export file is the one the base's assembler wrote", async () => {
  const scenarios = await import(pathToFileURL(resolve(FOLDER, "scenarios.mjs")).href);
  // EVIDENCE: fixture: `generate.mjs` writes this shape, checked by the comparisons below.
  const fixture = JSON.parse(readFileSync(resolve(FOLDER, "fixture.json"), "utf8")) as Fixture;
  // The compiler's source Start after the adapter's plan Start of the same name.
  const api = {
    ...adapter,
    ...view,
    ...recorder,
    ...assembly,
    ...debugExport,
    ...compileProject,
    smallRecorder: (limit: number) => new recorder.DebugRecorder({ argumentCodeUnits: limit }),
  };
  const candidateOf = (made: Made) => ({
    build: scenarios.BUILD,
    package: scenarios.PACKAGE,
    session:
      made.session === null
        ? null
        : {
            snapshot: made.snapshot,
            failure: made.session.state.failure,
            events: [...made.session.events],
            transcriptEntries: [...made.session.transcriptEntries],
          },
    recording: made.recording,
    prepare: (replay: boolean) =>
      prepareExport(
        {
          plan: made.recording?.plan ?? made.session?.plan ?? null,
          session: made.session === null ? null : { snapshot: made.snapshot },
          recording: made.recording,
        },
        replay,
      ),
    release: () => {},
    hostError: made.hostError,
    editedWhileDebugging: null,
    rewoundWhileDebugging: made.rewound,
    ...scenarios.SHOWN,
  });
  const names: string[] = [];
  // EVIDENCE: fixture: `scenarios.mjs` declares each scenario with its `name`.
  const declared = scenarios.SCENARIOS as readonly { readonly name: string }[];
  for (const scenario of declared) {
    const expected = fixture.scenarios.find((each) => each.name === scenario.name);
    assert.ok(expected !== undefined, `${scenario.name} is in the fixture`);
    assert.deepEqual(
      await scenarios.exportFiles(api, scenario, candidateOf),
      expected.files,
      scenario.name,
    );
    names.push(scenario.name);
  }
  assert.deepEqual(
    names,
    fixture.scenarios.map((each) => each.name),
    "every fixture row ran",
  );
});
