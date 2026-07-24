#!/usr/bin/env bash
set -euo pipefail

EXPECTED_MAIN_SHA="ed098995238172065c6dcd1ea2b8e9e0d4238675"
SUMMARY_FILE="${RUNNER_TEMP:-/tmp}/postmerge-pr22-pr23-summary.txt"
NVM_DIR="${RUNNER_TEMP:-/tmp}/nvm"
export NVM_DIR

printf 'Expected current main: %s\n' "$EXPECTED_MAIN_SHA"
git fetch origin main --depth=1
ACTUAL_MAIN_SHA="$(git rev-parse origin/main)"
printf 'Observed current main: %s\n' "$ACTUAL_MAIN_SHA"
test "$ACTUAL_MAIN_SHA" = "$EXPECTED_MAIN_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_MAIN_SHA"
test -z "$(git status --short)"

rm -rf "$NVM_DIR"
git clone --depth 1 --branch v0.40.3 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
. "$NVM_DIR/nvm.sh"

echo '$ nvm install'
nvm install
echo '$ nvm use'
nvm use
NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
printf 'Node: %s\nNPM: %s\n' "$NODE_VERSION" "$NPM_VERSION"

echo '$ npm ci'
npm ci

echo '$ npm run build  # prerequisite for direct dist test files'
npm run build

echo '$ node --test dist/tests/interpreter.test.js dist/tests/interpreter-semantic-boundary.test.js dist/tests/instruction-lowering-boundary.test.js dist/tests/runtime-semantics.test.js dist/tests/runtime-checkpoint.test.js'
node --test \
  dist/tests/interpreter.test.js \
  dist/tests/interpreter-semantic-boundary.test.js \
  dist/tests/instruction-lowering-boundary.test.js \
  dist/tests/runtime-semantics.test.js \
  dist/tests/runtime-checkpoint.test.js

echo '$ node --input-type=module  # explicit PR22/PR23 functional probes'
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { parse } from "./dist/src/parser.js";
import { compileSource } from "./dist/src/compiler.js";
import { compileProgram, InstructionCompilationError } from "./dist/src/instructions.js";
import { execute, InterpreterCompilationError } from "./dist/src/runtime/interpreter.js";
import { SerializableValueError, fromHostRuntimeValue } from "./dist/src/runtime/serializable-values.js";
import { createRuntimeObject, createRuntimeSpeaker } from "./dist/src/runtime/values.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "./dist/src/runtime/state.js";
import { run as runEngine } from "./dist/src/runtime/engine.js";
import { CheckpointError, createCheckpoint, restoreCheckpoint } from "./dist/src/runtime/checkpoint.js";

const random = { next: () => 0 };
const parseProgram = (source) => {
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.program;
};

const hostSpeaker = createRuntimeSpeaker("hostSpeaker");
hostSpeaker.properties.set("displayName", "Host Speaker");
const assertHostSpeakerRejected = (action) => {
  assert.throws(action, (error) => {
    assert.ok(error instanceof SerializableValueError);
    assert.equal(error.code, "invalid");
    assert.equal(error.message, "Host speaker values are not supported at the runtime boundary.");
    return true;
  });
};
assertHostSpeakerRejected(() => fromHostRuntimeValue(hostSpeaker));
assertHostSpeakerRejected(() => execute(parseProgram("say hostSpeaker"), { random, globals: { hostSpeaker } }));
console.log("PASS PR22 host RuntimeSpeaker in globals is explicitly rejected");

const builtinSpeakerResult = execute(parseProgram("let value = provideSpeaker()"), {
  random,
  builtins: { provideSpeaker: () => hostSpeaker },
});
assert.deepEqual(
  builtinSpeakerResult.errors.map((error) => [error.code, error.message]),
  [["TSR013", "Host speaker values are not supported at the runtime boundary."]],
);
assert.equal(JSON.stringify(builtinSpeakerResult).includes('"speakerId":0'), false);
console.log("PASS PR22 host speaker builtin result produces structured TSR013");

const declaredSource = [
  "speaker vera {",
  '  displayName: "Vera"',
  "}",
  "speaker vera",
  'say "Hello"',
  "exit",
].join("\n");
const declaredLegacy = execute(parseProgram(declaredSource), { random });
assert.deepEqual(declaredLegacy.errors, []);
const declaredSay = declaredLegacy.events.find((event) => event.kind === "say");
assert.equal(declaredSay?.speaker?.identifier, "vera");
assert.equal(declaredSay?.speaker?.displayName, "Vera");
const declaredCompilation = compileSource(declaredSource);
assert.deepEqual(declaredCompilation.diagnostics, []);
assert.notEqual(declaredCompilation.plan, null);
const declaredPlan = declaredCompilation.plan;
const declaredExecution = runEngine(declaredPlan, createFreshRuntimeSnapshot(declaredPlan));
assert.equal(declaredExecution.snapshot.status, "halted");
assert.equal(validateRuntimeSnapshot(declaredExecution.snapshot, declaredPlan).valid, true);
const checkpoint = createCheckpoint(declaredPlan, declaredExecution.snapshot);
const restored = restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
assert.equal(JSON.stringify(restored).includes('"speakerId":0'), false);
const malformedCheckpoint = JSON.parse(JSON.stringify(checkpoint));
malformedCheckpoint.snapshot.frames = [];
assert.throws(
  () => restoreCheckpoint(malformedCheckpoint),
  (error) => error instanceof CheckpointError && error.info.code === "TSK002",
);
console.log("PASS PR22 declared speakers and snapshot/checkpoint validation remain intact");

const invalidCalls = [
  [["function identity(value) { return value }", "identity(1, 2)"].join("\n"), "TSV020"],
  [["function identity(value) { return value }", "identity(other: 1)"].join("\n"), "TSV022"],
  [["function identity(value) { return value }", "identity(value: 1, value: 2)"].join("\n"), "TSV023"],
  [["function pair(left, right = 2) { return left + right }", "pair(right: 2)"].join("\n"), "TSV024"],
];
const assertInterpreterDiagnostic = (program, code) => {
  assert.throws(() => execute(program, { random }), (error) => {
    assert.ok(error instanceof InterpreterCompilationError);
    assert.equal(error instanceof TypeError, false);
    assert.ok(error.diagnostics.some((diagnostic) => diagnostic.code === code));
    return true;
  });
};
for (const [source, code] of invalidCalls) assertInterpreterDiagnostic(parseProgram(source), code);
const namedProgram = parseProgram([
  "function pair(left, right) { return left + right }",
  "pair(left: 1, right: 2)",
].join("\n"));
const positionalProgram = parseProgram([
  "function pair(left, right) { return left + right }",
  "pair(1, 2)",
].join("\n"));
const mixedProgram = JSON.parse(JSON.stringify(namedProgram));
mixedProgram.statements[1].expression.arguments.unshift(
  positionalProgram.statements[1].expression.arguments[0],
);
assertInterpreterDiagnostic(mixedProgram, "TSV021");
console.log("PASS PR23 execute(Program, options) reports TSV020 through TSV024");

const player = createRuntimeObject(new Map([["alias", "puppy"]]));
const captured = [];
const configuredResult = execute(parseProgram("capture(player.alias)"), {
  random,
  globals: { player },
  builtins: {
    capture: (call) => {
      captured.push(call.positional[0] ?? null);
      return null;
    },
  },
});
assert.deepEqual(configuredResult.errors, []);
assert.deepEqual(captured, ["puppy"]);
console.log("PASS PR23 configured globals and builtins are accepted by validation");

const excessiveSource = [
  "function identity(value) { return value }",
  "identity(1, 2)",
].join("\n");
assert.throws(
  () => compileProgram(parseProgram(excessiveSource)),
  (error) => {
    assert.ok(error instanceof InstructionCompilationError);
    assert.equal(error instanceof TypeError, false);
    assert.equal(error.code, "TSC003");
    return true;
  },
);
console.log("PASS PR23 direct invalid compileProgram input reports TSC003");

const validCompile = compileSource([
  "function identity(value) { return value }",
  "let result = identity(1)",
  "exit",
].join("\n"));
assert.deepEqual(validCompile.diagnostics, []);
assert.notEqual(validCompile.plan, null);
const invalidCompile = compileSource(excessiveSource);
assert.equal(invalidCompile.plan, null);
assert.ok(invalidCompile.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV020"));
console.log("PASS PR23 normal compileSource behavior remains unchanged");
NODE

if grep -R --line-number --fixed-string 'speakerId: 0' src; then
  echo 'FAIL: a speakerId: 0 construction remains in src' >&2
  exit 1
fi
echo 'PASS PR22 no speakerId: 0 construction exists in src'

echo '$ npm run check'
npm run check

echo '$ npm run build'
npm run build

echo '$ git diff --check'
git diff --check
test -z "$(git status --short)"

cat > "$SUMMARY_FILE" <<EOF
RESULT=PASS
BASE_SHA=$EXPECTED_MAIN_SHA
NODE=$NODE_VERSION
NPM=$NPM_VERSION
TARGETED_TESTS=PASS
FUNCTIONAL_PROBES=PASS
NPM_CHECK=PASS
NPM_BUILD=PASS
GIT_DIFF_CHECK=PASS
WORKTREE_CLEAN=PASS
EOF
cat "$SUMMARY_FILE"
