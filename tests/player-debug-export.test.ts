import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  DEBUG_EXPORT_VERSION,
  debugBuildRevisions,
  debugExportFile,
  debugExportFileName,
  debugExportJson,
  DebugExportError,
  parseDebugExport,
  replayDebugExport,
  type DebugExport,
  type DebugOperation,
  type DebugSelection,
} from "../player/debug-export.js";
import {
  applyExternalStorageEdit,
  compileProject,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  observeTime,
  run,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";

const reference = "captured-media:11111111-1111-4111-8111-111111111111:1";
const allSelected: DebugSelection = {
  savedValues: true,
  answers: true,
  replay: true,
  sessionText: true,
  photos: true,
  player: true,
};
const noneSelected: DebugSelection = {
  savedValues: false,
  answers: false,
  replay: false,
  sessionText: false,
  photos: false,
  player: false,
};

/**
 * Runs engine calls the way the Player's adapter does, a `run` after each accepted operation, and records each call as
 * an export entry; an independent stand-in for the Player recorder.
 */
class Recording {
  readonly anchor: RuntimeSnapshot;
  readonly operations: DebugOperation[] = [];
  snapshot: RuntimeSnapshot;
  constructor(readonly plan: InstructionPlan) {
    this.anchor = createFreshRuntimeSnapshot(plan);
    this.snapshot = this.anchor;
    this.run();
  }
  run() {
    const result = run(this.plan, this.snapshot);
    this.add("run", [{}], "ran", result, []);
    this.snapshot = result.snapshot;
  }
  observe(nowMs: number) {
    const result = observeTime(this.plan, this.snapshot, nowMs, []);
    this.add("observeTime", [nowMs, []], result.outcome.kind, result, []);
    this.snapshot = result.snapshot;
    if (result.outcome.kind === "observed") this.run();
  }
  answer(payload: Record<string, unknown>, stored: boolean | null = null) {
    const action = this.snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction");
    const request = {
      actionId: action.actionId,
      actionKind: action.kind,
      interactionKind: action.interactionKind,
      payload,
    };
    const queries: DebugOperation["admissionQueries"][number][] = [];
    const result = completeAction(
      this.plan,
      this.snapshot,
      request,
      stored === null
        ? {}
        : {
            capturedMedia: {
              holds: (asked, kind) => (
                queries.push({ reference: asked, kind, result: stored }),
                stored
              ),
            },
          },
    );
    this.add("completeAction", [request], result.outcome.kind, result, queries);
    this.snapshot = result.snapshot;
    if (result.outcome.kind === "completed") this.run();
  }
  editStorage(request: unknown) {
    const result = applyExternalStorageEdit(this.plan, this.snapshot, request);
    this.add("applyExternalStorageEdit", [request], result.outcome.kind, result, []);
    this.snapshot = result.snapshot;
  }
  add(
    kind: DebugOperation["kind"],
    args: unknown[],
    outcome: string,
    { events, snapshot }: { events: readonly InterpreterEvent[]; snapshot: RuntimeSnapshot },
    admissionQueries: DebugOperation["admissionQueries"],
  ) {
    this.operations.push({
      seq: this.operations.length + 1,
      kind,
      // A copy without recursion, as the recorder makes it.
      args: JSON.parse(debugExportJson(args)),
      admissionQueries,
      outcome,
      events: { first: events[0]?.sequence ?? null, count: events.length },
      status: snapshot.status,
      thrown: null,
      randomChoices: [],
      pausedAt: null,
    });
  }
  export(overrides: Partial<DebugExport> = {}): DebugExport {
    const failure = this.snapshot.failure;
    return {
      format: "teasescript-debug-export",
      version: DEBUG_EXPORT_VERSION,
      build: {
        commit: "abc123",
        dirty: false,
        mode: "production",
        appVersion: "0.0.0",
        ...debugBuildRevisions(),
      },
      package: { id: "fault", version: null, contentHash: null },
      incident: {
        kind: failure === null ? "requested" : "runtimeFailure",
        code: failure?.code ?? null,
        path: failure?.path ?? null,
        line: failure === null ? null : failure.span.start.line + 1,
        column: failure === null ? null : failure.span.start.column + 1,
        hostError: null,
      },
      editedWhileDebugging: null,
      rewoundWhileDebugging: null,
      selection: allSelected,
      omissions: [],
      checkpoint: createCheckpoint(this.plan, this.snapshot),
      checkpointRole: "current",
      replay: {
        anchorSnapshot: this.anchor,
        operations: this.operations,
        complete: true,
        reason: null,
      },
      photos: [],
      sections: {},
      ...overrides,
    };
  }
}

function faultPlan(): InstructionPlan {
  const compiled = compileProject([
    { path: "main.tease", source: 'call "fault.tease"\nexit' },
    {
      path: "fault.tease",
      source: [
        "function divide(value) { return 1 / value }",
        'let divisor = askNumber "Divisor"',
        "let draw = random()",
        "wait 1 s",
        "let result = divide(divisor)",
        "end",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.plan);
  return compiled.plan;
}

/** A session that fails dividing by the submitted zero, inside a function of another file, after a timed wait. */
function failedRecording(answer = "0"): Recording {
  const recording = new Recording(faultPlan());
  recording.observe(100);
  recording.answer({ kind: "submittedText", submittedText: answer });
  recording.observe(1_500);
  return recording;
}

/** The export written as a file and read back as a reader would: decompressed and parsed as untrusted data. */
async function roundTrip(exported: DebugExport, gzip = true): Promise<DebugExport> {
  const bytes = Buffer.from(await (await debugExportFile(exported, gzip)).arrayBuffer());
  assert.equal(bytes[0] === 0x1f && bytes[1] === 0x8b, gzip);
  return parseDebugExport((gzip ? gunzipSync(bytes) : bytes).toString("utf8"));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isJsonObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function member(value: Json, key: string | number): Json {
  const found = Array.isArray(value)
    ? typeof key === "number"
      ? value[key]
      : undefined
    : isJsonObject(value) && typeof key === "string"
      ? value[key]
      : undefined;
  assert.ok(found !== undefined, `no ${key}`);
  return found;
}

function invalid(json: string, kind: "invalid" | "unsupported", message: RegExp) {
  assert.throws(
    () => parseDebugExport(json),
    (error: unknown) =>
      error instanceof DebugExportError && error.kind === kind && message.test(error.message),
  );
}

test("an export reproduces a failure: restored from its anchor, the recorded calls reach the same failed state", async () => {
  const recording = failedRecording();
  assert.equal(recording.snapshot.status, "failed");
  const code = recording.snapshot.failure?.code;
  assert.ok(code);
  for (const gzip of [true, false]) {
    const read = await roundTrip(recording.export(), gzip);
    const result = replayDebugExport(read);
    assert.equal(result.kind, "reproduced");
    assert.ok(result.kind === "reproduced" && result.failure !== null);
    assert.equal(result.failure.code, code);
    assert.equal(result.failure.path, "fault.tease");
    assert.deepEqual([result.failure.line, result.failure.calls], [1, ["file", "divide"]]);
    assert.equal(result.operations, recording.operations.length);
  }
  // The failed checkpoint alone runs nothing more: reproduction needs the anchor and the calls.
  const failed = recording.export().checkpoint!;
  assert.equal(run(failed.plan, failed.snapshot).events.length, 0);
});

test("a replay reports the first call whose result differs, and a final state that differs", async () => {
  // Recorded with the answer 1, the session ends normally; replaying the answer 0 instead fails at the next run.
  const recording = failedRecording("1");
  assert.equal(recording.snapshot.status, "halted");
  const exported = recording.export();
  const answerCall = exported.replay!.operations.find(
    (operation) => operation.kind === "completeAction",
  )!;
  const changed: DebugExport = {
    ...exported,
    replay: {
      ...exported.replay!,
      operations: exported.replay!.operations.map((operation) =>
        operation === answerCall
          ? {
              ...operation,
              args: [
                Object.assign({}, operation.args[0], {
                  payload: { kind: "submittedText", submittedText: "0" },
                }),
              ],
            }
          : operation,
      ),
    },
  };
  const result = replayDebugExport(await roundTrip(changed));
  assert.equal(result.kind, "diverged");
  assert.ok(result.kind === "diverged");
  assert.equal(
    result.operation,
    answerCall.seq + 3,
    "the run after the next observation fails instead",
  );
  assert.match(result.reason, /call 7 \(run\) left the session failed, recorded halted/);
  assert.equal(result.location?.code, "TSR036");

  // A recorded outcome that does not happen.
  const refused = replayDebugExport(
    await roundTrip({
      ...exported,
      replay: {
        ...exported.replay!,
        operations: exported.replay!.operations.map((operation) =>
          operation === answerCall ? { ...operation, outcome: "invalidPayload" } : operation,
        ),
      },
    }),
  );
  assert.ok(
    refused.kind === "diverged" &&
      /outcome completed, recorded outcome invalidPayload/.test(refused.reason),
  );

  // Every call matches, but the exported state is not where they lead.
  const other = failedRecording();
  const finalDiffers = replayDebugExport(
    await roundTrip({ ...exported, checkpoint: other.export().checkpoint }),
  );
  assert.ok(finalDiffers.kind === "diverged" && finalDiffers.operation === null);
});

test("an image answer replays from the recorded store answer alone, without the photo", async () => {
  const compiled = compileProject([
    {
      path: "main.tease",
      source: 'let photo = askImage("Photo", allowCamera: false)\nsay photo\nexit',
    },
  ]);
  assert.ok(compiled.plan);
  const recording = new Recording(compiled.plan);
  recording.answer({ kind: "image", reference }, true);
  assert.equal(recording.snapshot.status, "halted");
  const exported = recording.export();
  assert.equal(replayDebugExport(await roundTrip(exported)).kind, "reproduced");
  // A store answer the recording does not have is a divergence, never real media access.
  const withoutAnswer: DebugExport = {
    ...exported,
    replay: {
      ...exported.replay!,
      operations: exported.replay!.operations.map((operation) => ({
        ...operation,
        admissionQueries: [],
      })),
    },
  };
  const result = replayDebugExport(await roundTrip(withoutAnswer));
  assert.ok(result.kind === "diverged" && /was not recorded/.test(result.reason));
});

test("without complete replay data an export is readable but not replayable", async () => {
  const recording = failedRecording();
  const structural = recording.export({
    selection: noneSelected,
    checkpoint: null,
    checkpointRole: null,
    replay: null,
    omissions: ["Replay data was not selected."],
  });
  const read = await roundTrip(structural);
  assert.equal(read.incident.code, "TSR036");
  assert.deepEqual(replayDebugExport(read), {
    kind: "incomplete",
    reason: "Replay data was not included in this export.",
  });
  const partial = recording.export({
    replay: { ...recording.export().replay!, complete: false, reason: "The recording overflowed." },
  });
  assert.deepEqual(replayDebugExport(await roundTrip(partial)), {
    kind: "incomplete",
    reason: "The recording overflowed.",
  });
  // When the current state could not be checkpointed, the last good checkpoint is the anchor itself.
  const lastGood = new Recording(faultPlan());
  const anchorOnly = lastGood.export({
    checkpoint: createCheckpoint(lastGood.plan, lastGood.anchor),
    checkpointRole: "lastGood",
    replay: { anchorSnapshot: null, operations: lastGood.operations, complete: true, reason: null },
  });
  assert.equal(replayDebugExport(await roundTrip(anchorOnly)).kind, "reproduced");
});

test("photos keep their original bytes and links, or say that the bytes are missing", async () => {
  const bytes = Uint8Array.from({ length: 70_001 }, (_, index) => (index * 13) % 256);
  const recording = failedRecording();
  const exported = recording.export({
    photos: [
      {
        reference,
        mimeType: "image/png",
        byteLength: bytes.length,
        width: 4,
        height: 3,
        data: bytes,
        usedBy: [{ relation: "imageAnswer", operation: 3, actionId: 2 }],
      },
      {
        reference: reference.replace(":1", ":2"),
        mimeType: "image/jpeg",
        byteLength: 10,
        width: null,
        height: null,
        data: null,
        usedBy: [{ relation: "savedValue", operation: null, actionId: null }],
      },
    ],
  });
  const read = await roundTrip(exported);
  assert.deepEqual(read.photos, exported.photos);
});

test("an export is validated as untrusted data, and another version is unsupported rather than invalid", async () => {
  const recording = failedRecording();
  const text = Buffer.from(
    await (await debugExportFile(recording.export(), false)).arrayBuffer(),
  ).toString("utf8");
  // The document with the value at `path` replaced, as a hand-edited or damaged file would have it.
  const changed = (path: readonly (string | number)[], replacement: Json): string => {
    const root: Json = JSON.parse(text);
    let parent = root;
    for (const key of path.slice(0, -1)) parent = member(parent, key);
    const last = path.at(-1)!;
    if (Array.isArray(parent) && typeof last === "number") parent[last] = replacement;
    else if (isJsonObject(parent) && typeof last === "string") parent[last] = replacement;
    else assert.fail(`cannot set ${path.join(".")}`);
    return JSON.stringify(root);
  };
  invalid("{", "invalid", /not JSON/);
  invalid(
    JSON.stringify({ format: "teasescript-checkpoint" }),
    "invalid",
    /not a TeaseScript debug export/,
  );
  invalid(changed(["version"], 1), "unsupported", /version 1/);
  invalid(changed(["checkpoint", "version"], 1), "unsupported", /checkpoint of another revision/);
  invalid(changed(["extra"], 1), "invalid", /unknown field "extra"/);
  invalid(
    changed(["editedWhileDebugging"], { firstEditSceneTimeMs: 0, editCount: 0 }),
    "invalid",
    /editCount/,
  );
  invalid(
    changed(["editedWhileDebugging"], { firstEditSceneTimeMs: -1, editCount: 1 }),
    "invalid",
    /firstEditSceneTimeMs/,
  );
  invalid(
    changed(["rewoundWhileDebugging"], { restoredSceneTimeMs: 0, rewindCount: 0 }),
    "invalid",
    /rewindCount/,
  );
  invalid(
    changed(["rewoundWhileDebugging"], { restoredSceneTimeMs: 0, rewindCount: 1, extra: 1 }),
    "invalid",
    /extra/,
  );
  invalid(
    changed(["checkpoint", "snapshot", "nextInstruction"], -5),
    "invalid",
    /\$\.checkpoint is not a valid checkpoint/,
  );
  invalid(
    changed(["replay", "anchorSnapshot", "rng"], "seed"),
    "invalid",
    /anchorSnapshot is not a valid checkpoint/,
  );
  invalid(changed(["replay", "operations", 1, "seq"], 7), "invalid", /seq must be 2/);
  invalid(changed(["replay", "operations", 1, "kind"], "eval"), "invalid", /kind must be one of/);
  invalid(
    changed(["replay", "operations", 1, "args", 2], 1),
    "invalid",
    /must hold 2 for observeTime/,
  );
  invalid(
    changed(["replay", "operations", 0, "args"], [{ capabilities: {} }]),
    "invalid",
    /unknown field "capabilities"/,
  );
  invalid(
    changed(["replay", "operations", 0, "thrown"], "TypeError"),
    "invalid",
    /either an outcome or a thrown error/,
  );
  invalid(
    changed(["selection", "answers"], false),
    "invalid",
    /requires saved values, answers, and session text/,
  );
  invalid(
    changed(["selection"], { ...noneSelected }),
    "invalid",
    /present although replay data was not selected/,
  );
  invalid(
    changed(["checkpointRole"], null),
    "invalid",
    /must be null exactly when there is no checkpoint/,
  );
  invalid(changed(["sections"], { cookies: [] }), "invalid", /unknown section "cookies"/);
  const photo = {
    reference,
    mimeType: "image/png",
    byteLength: 3,
    width: null,
    height: null,
    usedBy: [],
    data: "AAAA",
  };
  invalid(
    changed(["photos"], [{ ...photo, data: "AAA=" }]),
    "invalid",
    /not canonical unpadded base64url/,
  );
  invalid(
    changed(["photos"], [{ ...photo, byteLength: 4 }]),
    "invalid",
    /has 3 bytes instead of byteLength 4/,
  );
  invalid(
    changed(["photos"], [{ ...photo, reference: "/home/me/photo.png" }]),
    "invalid",
    /not a captured-media reference/,
  );
  invalid(changed(["photos"], [photo, photo]), "invalid", /listed twice/);
  invalid(
    changed(["photos"], [{ ...photo, usedBy: [{ relation: "llm" }] }]),
    "invalid",
    /usedBy\[0\] is missing "operation"/,
  );
  // The unchanged document is valid.
  assert.equal(parseDebugExport(text).replay?.operations.length, recording.operations.length);
});

test("the file name keeps only safe characters", () => {
  assert.equal(
    debugExportFileName("development-package:My Script", true),
    "development-package-My-Script-debug.teasedebug.json.gz",
  );
  assert.equal(debugExportFileName("", false), "script-debug.teasedebug.json");
});

test("the offline tool inspects without values, replays in a worker, and refuses invalid or oversized files", async () => {
  const tool = fileURLToPath(new URL("../../tools/debug-export.mjs", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "debug-export-"));
  try {
    const write = async (name: string, exported: DebugExport) => {
      const file = join(scratch, name);
      writeFileSync(file, Buffer.from(await (await debugExportFile(exported, true)).arrayBuffer()));
      return file;
    };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    const failed = await write("failed.teasedebug.json.gz", failedRecording("0").export());

    const inspected = cli("inspect", failed);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /incident: runtimeFailure TSR036 at fault\.tease:1:/);
    assert.match(inspected.stdout, /edited while debugging: no/);
    assert.match(inspected.stdout, /rewound while debugging: no/);
    assert.match(
      inspected.stdout,
      /replay: 7 call\(s\) \[run 4, observeTime 2, completeAction 1\]/,
    );
    assert.doesNotMatch(inspected.stdout, /submittedText/, "recorded arguments only with --values");
    assert.match(cli("inspect", failed, "--values").stdout, /"submittedText":"0"/);
    const marked = await write(
      "marked.teasedebug.json.gz",
      failedRecording("0").export({
        editedWhileDebugging: { firstEditSceneTimeMs: 123.5, editCount: 2 },
        rewoundWhileDebugging: { restoredSceneTimeMs: 40.5, rewindCount: 3 },
      }),
    );
    const markedInspected = cli("inspect", marked);
    assert.equal(markedInspected.status, 0, markedInspected.stderr);
    assert.match(
      markedInspected.stdout,
      /edited while debugging: yes, 2 saved-value edit\(s\) from scene time 123\.5 ms/,
    );
    assert.match(
      markedInspected.stdout,
      /rewound while debugging: yes, 3 rewind\(s\), the latest to scene time 40\.5 ms/,
    );

    const reproduced = cli("replay", failed);
    assert.equal(reproduced.status, 0, reproduced.stderr + reproduced.stdout);
    assert.match(
      reproduced.stdout,
      /^reproduced engine failure TSR036 at fault\.tease:1:\d+ \(in file > divide\)$/m,
    );

    const halted = failedRecording("1").export();
    const divergedFile = await write("diverged.teasedebug.json.gz", {
      ...halted,
      checkpoint: failedRecording("0").export().checkpoint,
    });
    const diverged = cli("replay", divergedFile);
    assert.equal(diverged.status, 1, diverged.stdout);
    assert.match(diverged.stdout, /^diverged: /);

    const structural = await write("structural.teasedebug.json.gz", {
      ...halted,
      selection: noneSelected,
      checkpoint: null,
      checkpointRole: null,
      replay: null,
    });
    assert.equal(cli("replay", structural).status, 2);

    const broken = join(scratch, "broken.teasedebug.json.gz");
    writeFileSync(
      broken,
      gzipSync('{"format":"teasescript-debug-export","version":1}').subarray(0, 20),
    );
    const brokenResult = cli("replay", broken);
    assert.equal(brokenResult.status, 4);
    assert.match(brokenResult.stdout, /damaged or incomplete/);

    const newer = join(scratch, "newer.teasedebug.json");
    writeFileSync(newer, JSON.stringify({ format: "teasescript-debug-export", version: 9 }));
    assert.equal(cli("inspect", newer).status, 3);

    // Decompression stops at the reader's limit instead of expanding the whole file.
    const bomb = join(scratch, "bomb.teasedebug.json.gz");
    writeFileSync(bomb, gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x20)));
    const bombResult = cli("inspect", bomb, "--max-mib", "1");
    assert.equal(bombResult.status, 4);
    assert.match(bombResult.stdout, /expands beyond 1048576 bytes/);

    // Deeply nested untrusted values are refused or printed, never a crash of the tool.
    const deepVersion = join(scratch, "deep-version.teasedebug.json");
    writeFileSync(
      deepVersion,
      `{"format":"teasescript-debug-export","version":${"[".repeat(30_000)}0${"]".repeat(30_000)}}`,
    );
    const deepVersionResult = cli("inspect", deepVersion);
    assert.equal(deepVersionResult.status, 3, deepVersionResult.stderr);
    let nested: Json = 1;
    for (let level = 0; level < 30_000; level += 1) nested = [nested];
    const deepSections = await write("deep-sections.teasedebug.json.gz", {
      ...halted,
      selection: noneSelected,
      checkpoint: null,
      checkpointRole: null,
      replay: null,
      sections: { storage: nested },
    });
    const deepSectionsResult = cli("inspect", deepSections, "--values");
    assert.equal(deepSectionsResult.status, 0, deepSectionsResult.stderr);
    assert.match(deepSectionsResult.stdout, /storage: \[\[\[/);

    // A replay that does not finish in time is stopped.
    assert.equal(cli("replay", failed, "--timeout", "0.001").status, 5);
    assert.equal(cli("replay").status, 64);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a recorded call that threw is compared like any other, and a failed anchor reproduces nothing", async () => {
  const compiled = compileProject([{ path: "main.tease", source: 'say "hello"\nexit' }]);
  assert.ok(compiled.plan);
  const plan = compiled.plan;
  // An event counter at its limit makes the next run throw without changing the state.
  const anchor = {
    ...createFreshRuntimeSnapshot(plan),
    nextEventSequence: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(() => run(plan, anchor));
  const thrown: DebugOperation = {
    seq: 1,
    kind: "run",
    args: [{}],
    admissionQueries: [],
    outcome: null,
    events: { first: null, count: 0 },
    status: "ready",
    thrown: "RuntimeDataError",
    randomChoices: [],
    pausedAt: null,
  };
  const exported = (operation: DebugOperation): DebugExport => ({
    ...failedRecording().export(),
    incident: {
      kind: "hostError",
      code: null,
      path: null,
      line: null,
      column: null,
      hostError: "RuntimeDataError",
    },
    checkpoint: createCheckpoint(plan, anchor),
    replay: { anchorSnapshot: anchor, operations: [operation], complete: true, reason: null },
  });
  assert.deepEqual(replayDebugExport(await roundTrip(exported(thrown))), {
    kind: "reproduced",
    failure: null,
    operations: 1,
  });
  for (const [change, reason] of [
    [{ status: "failed" }, /left the session ready, recorded failed/],
    [{ thrown: "TypeError" }, /threw RuntimeDataError, recorded threw TypeError/],
    [{ thrown: null, outcome: "ran" }, /threw RuntimeDataError, recorded outcome ran/],
  ] as const) {
    const result = replayDebugExport(await roundTrip(exported({ ...thrown, ...change })));
    assert.ok(result.kind === "diverged" && reason.test(result.reason), JSON.stringify(change));
  }
  // A thrown call emits nothing, so a recording that says otherwise is invalid.
  await assert.rejects(
    roundTrip(exported({ ...thrown, events: { first: 999, count: 17 } })),
    /must be empty for a call that threw/,
  );

  // A session that had already failed at the anchor: neither no calls nor calls that change nothing reproduce it.
  const failed = new Recording(
    compileProject([{ path: "main.tease", source: "let zero = 0\nlet result = 1 / zero\nexit" }])
      .plan!,
  );
  assert.equal(failed.snapshot.status, "failed");
  const afterFailure = failed.export({
    replay: { anchorSnapshot: failed.snapshot, operations: [], complete: true, reason: null },
  });
  assert.equal(replayDebugExport(await roundTrip(afterFailure)).kind, "incomplete");
  const noOp = new Recording(failed.plan);
  const observed = observeTime(noOp.plan, noOp.snapshot, 10, []);
  const afterNoOp = noOp.export({
    replay: {
      anchorSnapshot: noOp.snapshot,
      operations: [
        {
          seq: 1,
          kind: "observeTime",
          args: [10, []],
          admissionQueries: [],
          outcome: observed.outcome.kind,
          events: { first: observed.events[0]?.sequence ?? null, count: observed.events.length },
          status: observed.snapshot.status,
          thrown: null,
          randomChoices: [],
          pausedAt: null,
        },
      ],
      complete: true,
      reason: null,
    },
    checkpoint: createCheckpoint(noOp.plan, observed.snapshot),
  });
  assert.equal(replayDebugExport(await roundTrip(afterNoOp)).kind, "incomplete");
});

test("deeply nested values a script can save are written, read, and replayed without recursion", async () => {
  const depth = 5_000;
  const compiled = compileProject([
    {
      path: "main.tease",
      source: `let nested = ${"[".repeat(depth)}1${"]".repeat(depth)}\nsave nested as "deep"\nlet answer = askText "Answer"\nexit`,
    },
  ]);
  assert.deepEqual(compiled.diagnostics, []);
  const recording = new Recording(compiled.plan!);
  // An answer request carrying a nested extra field, which the engine accepts as JSON-safe data.
  let extra: Json = 0;
  for (let level = 0; level < depth; level += 1) extra = [extra];
  recording.answer({ kind: "submittedText", submittedText: "done", extra });
  const exported = recording.export({ sections: { storage: recording.snapshot.scriptStorage } });
  for (const gzip of [true, false]) {
    const read = await roundTrip(exported, gzip);
    assert.equal(replayDebugExport(read).kind, "reproduced");
  }
});

test("a Debug storage edit replays from its recorded request, refused ones included", async () => {
  const compiled = compileProject([
    {
      path: "main.tease",
      source: 'wait 1 s\nlet divisor = load("divisor", default: 1)\nlet result = 1 / divisor\nexit',
    },
  ]);
  assert.ok(compiled.plan);
  const recording = new Recording(compiled.plan);
  recording.editStorage({ key: "divisor", value: "not a number", extra: true });
  recording.editStorage({ key: "divisor", value: 0 });
  recording.observe(1_000);
  assert.equal(recording.snapshot.status, "failed");
  assert.deepEqual(
    recording.operations.map((operation) => [operation.kind, operation.outcome]),
    [
      ["run", "ran"],
      ["applyExternalStorageEdit", "invalidEdit"],
      ["applyExternalStorageEdit", "applied"],
      ["observeTime", "observed"],
      ["run", "ran"],
    ],
  );
  // The mark says the session was edited, also for edits before the anchor, which the calls cannot show.
  // Scene time may have a fraction of a millisecond, as the Player's clock observes it.
  const marked = await roundTrip(
    recording.export({ editedWhileDebugging: { firstEditSceneTimeMs: 123.5, editCount: 1 } }),
  );
  assert.deepEqual(marked.editedWhileDebugging, { firstEditSceneTimeMs: 123.5, editCount: 1 });
  const result = replayDebugExport(marked);
  assert.equal(result.kind, "reproduced");
  // Without the edit the session would not fail: the edit is part of what reproduces it.
  const unedited = new Recording(compiled.plan);
  unedited.observe(1_000);
  assert.equal(unedited.snapshot.status, "halted");
});
