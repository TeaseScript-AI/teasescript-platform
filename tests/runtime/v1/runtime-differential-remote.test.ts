import assert from "node:assert/strict";
import test from "node:test";

import { decodeReply, type RunnerOp } from "../../helpers/runtime-differential-remote.js";

// The cross-process reply decoder (docs/TESTING.md "Differential harness"): the one path from a runner's reply bytes to
// what the driver sees. Over a generated family of every valid reply shape, each mutated at every position the harness
// owns, it must refuse every mutation and accept one inside an engine payload unchanged, and never throw.

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Path = readonly (string | number)[];

const DIGEST = "a".repeat(64);
const RECORD = {
  state: {
    operation: "step",
    host: null,
    result: { events: [{ kind: "say" }] },
    decisions: [{ draw: 1 }],
    snapshot: { frames: [1] },
  },
  traces: { observer: [{ before: 1 }], instructionTrace: null, debug: { records: [] } },
};
const failure = (stage: string) => ({
  side: "right",
  outcome: { kind: "harness-failure", stage, member: "fresh.run", error: "boom" },
});

/** One valid reply per answer shape: the operation, its answer tag and answer, and the side that asked. */
const SAMPLES: readonly {
  readonly op: RunnerOp;
  readonly tag: string;
  readonly answer: Json;
  readonly side: "right" | null;
}[] = [
  { op: "begin", tag: "value", answer: null, side: "right" },
  { op: "start", tag: "value", answer: null, side: "right" },
  { op: "capture", tag: "value", answer: null, side: "right" },
  {
    op: "compile",
    tag: "value",
    answer: { kind: "plan", diagnostics: [{ code: "TS1" }] },
    side: "right",
  },
  { op: "compile", tag: "value", answer: { kind: "rejected", diagnostics: [] }, side: "right" },
  {
    op: "compile",
    tag: "value",
    answer: { kind: "unsupported", reason: "outside the slice" },
    side: "right",
  },
  { op: "planDigest", tag: "value", answer: DIGEST, side: "right" },
  {
    op: "probe",
    tag: "value",
    answer: { steps: 3, waits: [1], emitting: [2], faulted: false },
    side: "right",
  },
  { op: "next", tag: "value", answer: { kind: "go" }, side: "right" },
  {
    op: "next",
    tag: "value",
    answer: { kind: "end", outcome: { kind: "completed" } },
    side: "right",
  },
  {
    op: "next",
    tag: "value",
    answer: {
      kind: "end",
      outcome: { kind: "structured-fault", code: "TSR058", path: "v", span: { so: 1 }, pc: 4 },
    },
    side: "right",
  },
  {
    op: "next",
    tag: "value",
    answer: { kind: "end", outcome: { kind: "censored", reason: "steps" } },
    side: "right",
  },
  { op: "restore", tag: "value", answer: { run: 1, live: true }, side: "right" },
  { op: "pending", tag: "value", answer: null, side: "right" },
  { op: "pending", tag: "value", answer: failure("restore"), side: "right" },
  { op: "opening", tag: "value", answer: "record", side: "right" },
  { op: "apply", tag: "value", answer: "record", side: "right" },
  { op: "admit", tag: "value", answer: { accepted: true, digest: DIGEST }, side: null },
  {
    op: "admit",
    tag: "value",
    answer: {
      accepted: false,
      error: { name: "CheckpointError", code: null, path: "x", info: { at: 1 }, message: "no" },
    },
    side: null,
  },
  { op: "apply", tag: "failure", answer: failure("step"), side: "right" },
  {
    op: "next",
    tag: "failure",
    answer: {
      side: "right",
      outcome: { kind: "serializer-failure", stage: "step", member: "write", error: "deep" },
    },
    side: "right",
  },
  {
    op: "start",
    tag: "stop",
    answer: {
      verdict: { kind: "not-compared", side: "right", because: "admission-rejected" },
      outcome: { side: "right", outcome: { kind: "admission-rejected", error: "refused" } },
    },
    side: "right",
  },
];

/** Whether `path` (below the answer, or below a record's part) is inside an engine payload, which the harness leaves opaque. */
function opaque(op: RunnerOp, path: Path): boolean {
  const [first, second] = path;
  if (op === "compile") return first === "diagnostics";
  if (op === "next") return first === "outcome" && second === "span";
  if (op === "admit")
    return first === "error" && (second === "code" || second === "path" || second === "info");
  return false;
}
const RECORD_OPAQUE = (path: Path) =>
  (path[0] === "state" && ["host", "result", "snapshot"].includes(String(path[1]))) ||
  (path[0] === "state" && path[1] === "decisions" && path.length > 2) ||
  (path[0] === "traces" && ["instructionTrace", "debug"].includes(String(path[1]))) ||
  (path[0] === "traces" && path[1] === "observer" && path.length > 2);
/** Strings any text may replace: names, messages and reasons, never a tag, a side, a stage or a digest. */
const FREE = new Set(["reason", "member", "error", "code", "path", "operation", "message", "name"]);
const COUNT = new Set(["steps", "pc", "run"]);

const typeOf = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const REPLACEMENTS: readonly Json[] = [null, true, 7, "x", [], {}, { toString: null }, -1, 1.5];

/** The replacements of a harness-owned position's `value` that its schema must refuse. */
function refusedReplacements(
  value: Json,
  key: string | number | undefined,
  parent: string | number | undefined,
): Json[] {
  const isCount =
    typeof key === "string" ? COUNT.has(key) : parent === "waits" || parent === "emitting";
  // A primitive wrapped in an array coerces back to itself (`String(["step"])` is `"step"`): only a schema without
  // coercion refuses it.
  const wrapped: Json[] = value === null || typeof value !== "object" ? [[value]] : [];
  return [...wrapped, ...REPLACEMENTS].filter((replacement) => {
    const sameType = typeOf(replacement) === typeOf(value);
    if (!sameType) return true;
    if (typeof value === "number") return isCount && (replacement === -1 || replacement === 1.5);
    if (typeof value === "string") return !(typeof key === "string" && FREE.has(key));
    if (typeof value === "boolean") return false;
    if (Array.isArray(value)) return false;
    // An object replaced by `{}` or `{ toString: null }` misses keys or has one too many.
    return value !== null && Object.keys(value).length > 0;
  });
}

/** Every position of `value`, with its path. */
function positions(value: Json, path: Path = []): { path: Path; value: Json }[] {
  const out = [{ path, value }];
  if (Array.isArray(value))
    value.forEach((item, index) => out.push(...positions(item, [...path, index])));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) out.push(...positions(item, [...path, key]));
  return out;
}

type JsonObject = { readonly [key: string]: Json };
const isJsonObject = (value: Json): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `value` with the position at `path` replaced, deleted, or (an object) given an extra key. */
function edit(
  value: Json,
  path: Path,
  replace: { readonly with?: Json; readonly delete?: true; readonly extra?: true },
): Json {
  if (path.length === 0) {
    if (replace.extra && isJsonObject(value)) return { ...value, extra: 1 };
    return replace.with ?? null;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value))
    return value.map((item: Json, index: number) =>
      index === head ? edit(item, rest, replace) : item,
    );
  if (!isJsonObject(value) || typeof head !== "string") return value;
  if (rest.length === 0 && replace.delete)
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== head));
  return { ...value, [head]: edit(value[head] ?? null, rest, replace) };
}

/** A record's texts, as a runner writes them, from its two parts. */
function texts(record: Json): Json {
  if (!isJsonObject(record)) throw new Error("A record is an object.");
  return { state: JSON.stringify(record["state"]), traces: JSON.stringify(record["traces"]) };
}
/** The valid answers the samples give for `sample`'s operation and tag, as JSON. */
const validAnswers = (sample: (typeof SAMPLES)[number]) =>
  new Set(
    SAMPLES.filter((item) => item.op === sample.op && item.tag === sample.tag).map((item) =>
      JSON.stringify(item.answer),
    ),
  );
const line = (envelope: Json) => Buffer.from(JSON.stringify(envelope), "utf8");
const SEQ = 5;

test("the reply decoder refuses every mutation of a harness-owned position and accepts an engine payload's, without throwing", () => {
  const coverage = new Map<string, { refused: number; accepted: number }>();
  const count = (sample: (typeof SAMPLES)[number], kind: string, accepted: boolean) => {
    const key = `${sample.op}/${sample.tag}/${kind}`;
    const entry = coverage.get(key) ?? { refused: 0, accepted: 0 };
    if (accepted) entry.accepted += 1;
    else entry.refused += 1;
    coverage.set(key, entry);
  };
  const decode = (sample: (typeof SAMPLES)[number], bytes: Uint8Array) => {
    let decoded: ReturnType<typeof decodeReply> | undefined;
    assert.doesNotThrow(() => {
      decoded = decodeReply(bytes, SEQ, sample.op, sample.side);
    }, `${sample.op}: the decoder threw`);
    return decoded!;
  };
  const refuses = (
    sample: (typeof SAMPLES)[number],
    kind: string,
    bytes: Uint8Array,
    what: string,
  ) => {
    const decoded = decode(sample, bytes);
    assert.equal(
      typeof decoded,
      "string",
      `${sample.op}/${sample.tag} ${kind} ${what} was accepted`,
    );
    count(sample, kind, false);
  };

  for (const sample of SAMPLES) {
    const isRecord = sample.answer === "record";
    const answer: Json = isRecord ? texts(RECORD) : sample.answer;
    const envelope = { seq: SEQ, [sample.tag]: answer };
    // The sample itself is accepted as it is.
    const accepted = decode(sample, line(envelope));
    assert.notEqual(typeof accepted, "string", `${sample.op}/${sample.tag}: ${String(accepted)}`);
    if (isRecord && typeof accepted !== "string" && "value" in accepted)
      assert.deepEqual(accepted.record, RECORD);

    // The envelope: another sequence, another or a second answer tag, no object at all.
    const wrongs: Json[] = [
      { ...envelope, seq: SEQ + 1 },
      { ...envelope, stop: { verdict: { kind: "equivalent" }, outcome: null } },
      { ...envelope, value: null, failure: null },
      { seq: SEQ, answer },
      null,
      [envelope],
      "reply",
    ];
    for (const wrong of wrongs)
      refuses(sample, "envelope", line(wrong), JSON.stringify(wrong).slice(0, 60));

    // Bytes: invalid UTF-8 inside the line (also inside a string), a lone lead byte, a truncated line.
    const bytes = line(envelope);
    const quote = bytes.indexOf(0x22, 2);
    for (const at of [0, quote + 1, Math.floor(bytes.length / 2), bytes.length])
      refuses(
        sample,
        "bytes",
        Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at)]),
        `0xff at ${at}`,
      );
    refuses(sample, "bytes", Buffer.concat([bytes, Buffer.from([0xc3])]), "a lone lead byte");
    refuses(sample, "bytes", bytes.subarray(0, Math.floor(bytes.length / 2)), "a truncated line");

    // Every harness-owned position of the answer, and for a record of its parts' shells.
    const variants: {
      readonly kind: string;
      readonly answer: Json;
      readonly owned: boolean;
      readonly what: string;
    }[] = [];
    const mutate = (
      root: Json,
      isOpaque: (path: Path) => boolean,
      wrap: (mutated: Json) => Json,
      prefix: string,
    ) => {
      for (const { path, value } of positions(root)) {
        // A record's texts are made from its two parts, so its root itself is the answer's, mutated above.
        if (prefix !== "" && path.length === 0) continue;
        const owned = !isOpaque(path);
        const key = path.at(-1);
        const parent = path.at(-2);
        // At the root, a replacement that is another valid answer of the operation (`pending`'s `null`) is not a mutation.
        const replacements = (
          owned ? refusedReplacements(value, key, parent) : REPLACEMENTS
        ).filter(
          (replacement) =>
            path.length > 0 ||
            prefix !== "" ||
            !validAnswers(sample).has(JSON.stringify(replacement)),
        );
        for (const replacement of replacements)
          variants.push({
            kind: owned ? "replace" : "opaque",
            answer: wrap(edit(root, path, { with: replacement })),
            owned,
            what: `${prefix}${path.join(".")}=${JSON.stringify(replacement)}`,
          });
        if (!owned || isOpaque(path.slice(0, -1))) continue;
        if (path.length > 0 && typeof key === "string")
          variants.push({
            kind: "delete",
            answer: wrap(edit(root, path, { delete: true })),
            owned,
            what: `${prefix}${path.join(".")} deleted`,
          });
        if (value !== null && typeof value === "object" && !Array.isArray(value))
          variants.push({
            kind: "extra",
            answer: wrap(edit(root, path, { extra: true })),
            owned,
            what: `${prefix}${path.join(".")} extra key`,
          });
      }
    };
    if (isRecord) {
      mutate(
        answer,
        (path) => path.length > 1,
        (mutated) => mutated,
        "",
      );
      mutate(RECORD, RECORD_OPAQUE, (mutated) => texts(mutated), "record ");
    } else
      mutate(
        answer,
        (path) => opaque(sample.op, path),
        (mutated) => mutated,
        "",
      );

    for (const variant of variants) {
      const decoded = decode(sample, line({ seq: SEQ, [sample.tag]: variant.answer }));
      if (variant.owned) {
        assert.equal(
          typeof decoded,
          "string",
          `${sample.op}/${sample.tag} ${variant.what} was accepted`,
        );
        count(sample, variant.kind, false);
      } else {
        assert.notEqual(
          typeof decoded,
          "string",
          `${sample.op}/${sample.tag} ${variant.what}: ${String(decoded)}`,
        );
        count(sample, variant.kind, true);
      }
    }
  }

  // Coverage: every sample's envelope, bytes and owned replacements were refused, and every engine payload's
  // replacements were accepted; deletions and extra keys wherever the answer has an object the harness owns.
  for (const sample of SAMPLES) {
    for (const kind of ["envelope", "bytes", "replace"])
      assert.ok(
        (coverage.get(`${sample.op}/${sample.tag}/${kind}`)?.refused ?? 0) > 0,
        `${sample.op}/${sample.tag} ${kind}`,
      );
    if (typeof sample.answer === "object" && sample.answer !== null)
      for (const kind of ["delete", "extra"])
        assert.ok(
          (coverage.get(`${sample.op}/${sample.tag}/${kind}`)?.refused ?? 0) > 0,
          `${sample.op}/${sample.tag} ${kind}`,
        );
  }
  for (const key of [
    "compile/value/opaque",
    "next/value/opaque",
    "admit/value/opaque",
    "opening/value/opaque",
    "apply/value/opaque",
  ])
    assert.ok((coverage.get(key)?.accepted ?? 0) > 0, key);
  // The family's size, for the pull request's record: operations by mutation kind, refused and accepted.
  console.log(JSON.stringify({ replyDecoderCoverage: Object.fromEntries(coverage) }));
});
