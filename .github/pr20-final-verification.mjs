import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = (relativePath) => pathToFileURL(path.join(process.cwd(), relativePath)).href;

const { compileSource } = await import(moduleUrl("dist/src/compiler.js"));
const { INSTRUCTION_PLAN_VERSION } = await import(moduleUrl("dist/src/instructions.js"));
const {
  CHECKPOINT_VERSION,
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
} = await import(moduleUrl("dist/src/runtime/checkpoint.js"));
const { run } = await import(moduleUrl("dist/src/runtime/engine.js"));
const {
  XORSHIFT32_ALGORITHM,
  createXorShift32State,
  nextXorShift32,
} = await import(moduleUrl("dist/src/runtime/random.js"));
const {
  RUNTIME_SNAPSHOT_VERSION,
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
} = await import(moduleUrl("dist/src/runtime/state.js"));

const compile = (source) => {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan;
};

assert.throws(
  () => createXorShift32State(0),
  (error) => error instanceof RangeError &&
    error.message === "The xorshift32 seed must be a non-zero unsigned 32-bit integer.",
);
console.log("PASS createXorShift32State(0) rejects zero");

const exitPlan = compile("exit");
assert.throws(
  () => createFreshRuntimeSnapshot(exitPlan, { seed: 0 }),
  (error) => error instanceof RangeError &&
    error.message === "The xorshift32 seed must be a non-zero unsigned 32-bit integer.",
);
console.log("PASS fresh runtime state rejects seed 0");

assert.throws(
  () => nextXorShift32({ algorithm: XORSHIFT32_ALGORITHM, state: 0 }),
  (error) => error instanceof TypeError && error.message === "Malformed xorshift32 state.",
);
console.log("PASS direct RNG advancement rejects state 0");

const invalidSnapshot = createFreshRuntimeSnapshot(exitPlan);
invalidSnapshot.rng.state = 0;
const validation = validateRuntimeSnapshot(invalidSnapshot, exitPlan);
assert.equal(validation.valid, false);
assert.ok(validation.errors.includes("Runtime RNG state is malformed or unsupported."));
console.log("PASS snapshot validation rejects RNG state 0");

const malformedCheckpoint = JSON.parse(JSON.stringify(
  createCheckpoint(exitPlan, createFreshRuntimeSnapshot(exitPlan)),
));
malformedCheckpoint.snapshot.rng.state = 0;
assert.throws(
  () => restoreCheckpoint(malformedCheckpoint),
  (error) => error instanceof CheckpointError &&
    error.info.code === "TSK002" &&
    error.info.message === "Runtime RNG state is malformed or unsupported.",
);
console.log("PASS checkpoint restoration reports TSK002 for RNG state 0");

const rng = createXorShift32State(0x1234_5678);
const states = [];
const values = [];
for (let index = 0; index < 5; index += 1) {
  values.push(nextXorShift32(rng));
  states.push(rng.state);
}
assert.deepEqual(states, [2274908837, 358294691, 1210119364, 2176035992, 1882851208]);
assert.deepEqual(values, [
  0.529668488772586,
  0.08342198352329433,
  0.28175287041813135,
  0.5066478606313467,
  0.43838545866310596,
]);
console.log("PASS valid non-zero seed preserves the established deterministic sequence");

const deterministicSource = [
  'let values = ["a", "b", "c", "d"]',
  "say values.random",
  "say random()",
  "say chance(50)",
  "say randomInteger(1..=6)",
  "say randomInteger(0..3)",
  "exit",
].join("\n");
const deterministicPlan = compile(deterministicSource);
const first = run(
  deterministicPlan,
  createFreshRuntimeSnapshot(deterministicPlan, { seed: 0x1234_5678 }),
);
const second = run(
  deterministicPlan,
  createFreshRuntimeSnapshot(deterministicPlan, { seed: 0x1234_5678 }),
);
assert.deepEqual(first.events, second.events);
assert.deepEqual(first.snapshot.rng, second.snapshot.rng);
assert.equal(first.snapshot.failure, null);
assert.equal(first.snapshot.status, "halted");
console.log("PASS .random, random(), chance(), and randomInteger() remain deterministic");

assert.equal(INSTRUCTION_PLAN_VERSION, 3);
assert.equal(RUNTIME_SNAPSHOT_VERSION, 3);
assert.equal(CHECKPOINT_VERSION, 3);
console.log("PASS instruction-plan, snapshot, and checkpoint versions remain 3");
