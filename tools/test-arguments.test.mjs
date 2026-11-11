import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { BOOLEAN_OPTIONS, testPathArguments, VALUE_OPTIONS } from "./test-arguments.mjs";

test("each listed option takes a value exactly when the running Node says it does", () => {
  for (const [options, takesValue] of [
    [VALUE_OPTIONS, true],
    [BOOLEAN_OPTIONS, false],
  ])
    for (const option of options) {
      const result = spawnSync(process.execPath, [option, "-e", "0"], { encoding: "utf8" });
      if (takesValue) {
        assert.equal(result.status, 9, option);
        assert.match(result.stderr, /requires an argument/u, option);
      } else assert.equal(result.status, 0, `${option}: ${result.stderr}`);
    }
});

/** Where in the arguments an option comes: what precedes it. */
const PHASES = {
  "before the first path": [],
  "after a path": ["first.test.js"],
  "after --": ["--"],
};

test("every argument Node reads as a path is checked, whatever option comes before or after it", () => {
  const classes = {
    ...Object.fromEntries([...BOOLEAN_OPTIONS].map((option) => [`boolean ${option}`, [option]])),
    ...Object.fromEntries([...VALUE_OPTIONS].map((option) => [`value ${option}`, [option, "v"]])),
    ...Object.fromEntries(
      [...VALUE_OPTIONS]
        .filter((option) => option.startsWith("--"))
        .map((option) => [`value with = ${option}`, [`${option}=v`]]),
    ),
    "unknown bare": ["--unknown"],
    // Node reads `_` in a long option's name as `-`, and so does the filter.
    "boolean underscore spelling": ["--test_only"],
    "value underscore spelling": ["--test_skip_pattern", "v"],
    "unknown with =": ["--unknown=v"],
    terminator: ["--"],
  };
  const tokens = { "missing path": ["missing.test.js"], "valid path": ["good.test.js"], none: [] };
  const cases = [];
  for (const [kind, option] of Object.entries(classes))
    for (const [next, token] of Object.entries(tokens))
      for (const [phase, start] of Object.entries(PHASES)) {
        const args = [...start, ...option, ...token];
        cases.push({ name: `${kind} × ${next} × ${phase}`, args, kind, phase, token });
      }
  for (const { name, args, kind, phase, token } of cases) {
    if (phase !== "before the first path") {
      // From the first path or `--` on, Node reads every argument as a path, also one that looks like an option.
      assert.deepEqual(testPathArguments(args), phase === "after --" ? args.slice(1) : args, name);
      continue;
    }
    if (kind.startsWith("unknown bare")) {
      assert.throws(() => testPathArguments(args), /is not an option it knows/u, name);
      continue;
    }
    // A value option took its value `v`, so the argument after the option is the first path.
    assert.deepEqual(testPathArguments(args), token, name);
  }
  // A short option has no `=` form: Node refuses `-r=x`.
  assert.throws(() => testPathArguments(["-r=x", "a.test.js"]), /is not an option it knows/u);
});
