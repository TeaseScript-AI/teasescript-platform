// Writes the export equivalence fixture (L5h.3b, §21.4 family 5) with the base's assembler: run in a built checkout of
// the base commit, with this folder's `scenarios.mjs`, as `node generate.mjs <base checkout> <base commit> <out file>`.
// The fixture is never re-blessed: a later change of the export's output is a new row with its reason, in the test.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILD, PACKAGE, SCENARIOS, SHOWN, exportFiles } from "./scenarios.mjs";

const [root, base, out] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(root, "dist", path)).href);
// The compiler's source Start (`compile-project.js`) after the adapter's plan Start of the same name.
const api = {
  ...(await load("player/runtime-adapter.js")),
  ...(await load("player/runtime-view.js")),
  ...(await load("player/debug-recorder.js")),
  ...(await load("player/debug-export-assembly.js")),
  ...(await load("player/debug-export.js")),
  ...(await load("player/compile-project.js")),
};
// The base's recorder names its limit in bytes.
api.smallRecorder = (limit) => new api.DebugRecorder({ argumentBytes: limit });

/** The base's candidate: the shown session with its plan, read in the main realm. */
const candidateOf = (made) => ({
  build: BUILD,
  package: PACKAGE,
  session:
    made.session === null
      ? null
      : {
          plan: made.session.plan,
          snapshot: made.snapshot,
          failure: made.session.state.failure,
          events: [...made.session.events],
          transcriptEntries: [...made.session.transcriptEntries],
        },
  recording: made.recording,
  hostError: made.hostError,
  editedWhileDebugging: null,
  rewoundWhileDebugging: made.rewound,
  ...SHOWN,
});

const scenarios = [];
for (const scenario of SCENARIOS)
  scenarios.push({
    name: scenario.name,
    choices: scenario.choices,
    files: await exportFiles(api, scenario, candidateOf),
  });
// Formatted as the repository formats its JSON, by the checkout's own Prettier and configuration.
const prettier = await import(pathToFileURL(join(root, "node_modules/prettier/index.mjs")).href);
const options = (await prettier.resolveConfig(join(root, "package.json"))) ?? {};
writeFileSync(
  out,
  await prettier.format(JSON.stringify({ base, scenarios }), { ...options, parser: "json" }),
);
