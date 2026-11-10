/*
 * The Player's op catalogue, each op's argument check (`checkArguments`) called directly on the composed ops: one row per
 * op, with the arguments it admits and the shape they have, from which the rejected arguments are generated (each
 * required field left out, each field of another JSON kind, an unknown key, no record), and the refinements, literals
 * and nested shapes the kinds do not say, listed per op. Each check is declared a type predicate (`args is A`), which
 * TypeScript trusts without reading its body: this family is the evidence that the bodies check the fields and kinds the
 * rows give, within the cases listed, not that a body and its declared type agree on every input.
 *
 * Payloads the host admits as any record and the engine validates (an edit's value, file store and lock answers, a
 * media load report, a Start's storage entries, temporal context and profile) are rows of their shape only: their
 * rejection is the engine's, tested at its boundary.
 *
 * Each row's admitted samples are typed by what its op's check declares it admits (`OpAdmitted`, `Samples`): a sample
 * the declaration excludes does not compile, so declaration, sample and body agree on the cases listed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { deliveryOwner } from "../../player/engine-bridge/delivery.js";
import { BRIDGE_VERSION } from "../../player/engine-bridge/protocol.js";
import { createSourcePosition, createSourceSpan } from "../../src/source.js";
import type { OpAdmitted, OpName } from "../../player/engine-bridge/op-catalogue.js";
import { playerBridgeOps, playerOpsContext } from "../../player/engine-bridge/player-ops.js";
import {
  startBridgeHost,
  type BridgeOps,
  type HostSession,
} from "../../player/engine-bridge/worker-host.js";

/** The kinds of argument values: JSON's, and the bytes of a file. */
type Kind = "string" | "number" | "boolean" | "null" | "object" | "array" | "bytes";

/** A value of each JSON kind, which a field admitting no value of that kind refuses. */
const OTHER_KIND: readonly (readonly [Kind, unknown])[] = [
  ["string", "x"],
  ["number", 7],
  ["boolean", true],
  ["null", null],
  ["object", {}],
  ["array", []],
];

/** One record form of an op's arguments: an argument it admits, and each field's kinds; required unless `optional`. */
interface Form<T extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly sample: T;
  readonly fields: Readonly<Record<string, readonly Kind[]>>;
  readonly optional?: readonly string[];
}

interface Row {
  /** The record forms the op admits; none for an op that takes no record. */
  readonly forms?: readonly Form[];
  /** The kinds besides a record the whole argument may be. */
  readonly top?: readonly Kind[];
  /** Further admitted arguments: optional fields present, and the other branches of a union or a `null`. */
  readonly also?: readonly unknown[];
  /** Arguments refused for what the kinds do not say: refinements, literals, nested shapes; by what is wrong. */
  readonly rejected?: Readonly<Record<string, unknown>>;
}

/** Type only, never set: a row's admitted samples, which `ROWS` checks against its op's admitted arguments. */
interface Samples<T> {
  readonly samples?: T;
}

const S: readonly Kind[] = ["string"];
const N: readonly Kind[] = ["number"];
const B: readonly Kind[] = ["boolean"];
const O: readonly Kind[] = ["object"];
const A: readonly Kind[] = ["array"];
const NS: readonly Kind[] = ["string", "null"];
const ANY: readonly Kind[] = ["string", "number", "boolean", "null", "object", "array"];

/** An op of one record form, with its fields' kinds; every field of `sample` is required unless `optional`. */
const record = <const T extends Readonly<Record<string, unknown>>, const U = never>(
  sample: T,
  fields: Readonly<Record<string, readonly Kind[]>>,
  rest: Omit<Row, "forms" | "also"> & {
    readonly also?: readonly U[];
    readonly optional?: readonly string[];
  } = {},
): Row & Samples<T | U> => {
  const { optional, ...row } = rest;
  return { forms: [{ sample, fields, ...(optional === undefined ? {} : { optional }) }], ...row };
};
/** A row of several forms, or of a record and other kinds, with its samples typed (`Samples`). */
const row = <const T extends Readonly<Record<string, unknown>>, const U = never>(
  value: Omit<Row, "forms" | "also"> & {
    readonly forms: readonly Form<T>[];
    readonly also?: readonly U[];
  },
): Row & Samples<T | U> => value;
const NULL_ONLY: Row & Samples<null> = { top: ["null"], also: [null] };
/** The samples a row's type carries (`Samples`). */
type SamplesOf<R> = R extends Samples<infer T> ? T : never;

/** Every answering input op's arguments: the action, its fields, and how the player answered. */
const answering = <const T extends Readonly<Record<string, unknown>>, const U = never>(
  sample: T,
  fields: Readonly<Record<string, readonly Kind[]>>,
  rest: Omit<Row, "forms" | "also"> & { readonly also?: readonly U[] } = {},
) =>
  record(
    { actionId: 1, ...sample, input: null },
    { actionId: N, ...fields, input: NS },
    {
      ...rest,
      also: [{ actionId: 1, ...sample, input: "enter" }, ...(rest.also ?? [])],
      rejected: {
        "an input of no kind": { actionId: 1, ...sample, input: "typed" },
        ...rest.rejected,
      },
    },
  );

const SPAN = createSourceSpan(createSourcePosition(0, 1, 1), createSourcePosition(0, 1, 1));
const exitEvent = (sequence: number) => ({ kind: "exit" as const, sequence, span: SPAN });
const INTENT = { owner: 1, control: null, resetAt: 0, intent: 1 };
const TRACING = { on: true, intent: 1 };
const STOP = { error: "Error", run: 1, stop: 1, retires: null };
const VIEW = { messages: null, selected: null, variables: null, image: false, trees: {} };
const SITE = { line: 1, column: 1, endLine: 1, endColumn: 2 };
const OBSERVATION = record(
  { atMs: 0, media: [] },
  { atMs: N, media: A },
  {
    also: [{ atMs: 1.5, media: [{ mediaId: 1, segment: 0, progressMs: 0 }] }],
    rejected: {
      "a negative time": { atMs: -1, media: [] },
      "an infinite time": { atMs: Number.POSITIVE_INFINITY, media: [] },
      "a report without its progress": { atMs: 0, media: [{ mediaId: 1, segment: 0 }] },
      "a report with an unknown key": {
        atMs: 0,
        media: [{ mediaId: 1, segment: 0, progressMs: 0, extra: 1 }],
      },
      "a report of a text ID": { atMs: 0, media: [{ mediaId: "1", segment: 0, progressMs: 0 }] },
      "a report no record": { atMs: 0, media: ["report"] },
    },
  },
);
const TIME = <const F extends string>(field: F) =>
  record(
    // EVIDENCE: invariant: the computed key is `field`, which TypeScript types as any string.
    { [field]: 0 } as { readonly [K in F]: number },
    { [field]: N },
    { rejected: { "a negative time": { [field]: -1 }, "no time": { [field]: Number.NaN } } },
  );
const PLAN = record({ plan: "p1" }, { plan: S });
const SESSION = record({ session: "s1" }, { session: S });
const TICKET = record({ ticket: "t1" }, { ticket: S });
/** A history serial: a whole number from 1. */
const SERIAL_REJECTED = (field: string, rest: Readonly<Record<string, unknown>>) => ({
  [`${field} 0`]: { ...rest, [field]: 0 },
  [`a fractional ${field}`]: { ...rest, [field]: 1.5 },
});
const HISTORY = record(
  { history: 1 },
  { history: N },
  { rejected: SERIAL_REJECTED("history", {}) },
);
const STEP = record(
  { history: 1, step: 1 },
  { history: N, step: N },
  {
    rejected: {
      ...SERIAL_REJECTED("history", { step: 1 }),
      ...SERIAL_REJECTED("step", { history: 1 }),
    },
  },
);
const EVENT_LOG_REJECTED = (rest: Readonly<Record<string, unknown>>) => ({
  "an event of no kind": { ...rest, events: [{ kind: "bogus", sequence: 1 }] },
  "an event without its span": { ...rest, events: [{ kind: "exit", sequence: 1 }] },
  "events whose sequence does not increase": { ...rest, events: [exitEvent(1), exitEvent(1)] },
  "an event of sequence 0": { ...rest, events: [exitEvent(0)] },
});
const ANSWER = <const T extends Readonly<Record<string, unknown>>>(answer: T) =>
  record(
    { actionId: 0, answer, held: null },
    { actionId: N, answer: O, held: ["array", "null"] },
    {
      also: [{ actionId: 1, answer, held: [{ reference: "r", kind: "image" }] }],
      rejected: {
        "a negative action": { actionId: -1, answer, held: null },
        "a fractional action": { actionId: 1.5, answer, held: null },
        "held media of no kind": {
          actionId: 0,
          answer,
          held: [{ reference: "r", kind: "picture" }],
        },
        "held media with an unknown key": {
          actionId: 0,
          answer,
          held: [{ reference: "r", kind: "image", extra: 1 }],
        },
      },
    },
  );

const ROWS = {
  prepare: record(
    { source: { kind: "plan", text: "{}" } },
    { source: O },
    {
      also: [
        { source: { kind: "source", script: "exit" } },
        { source: { kind: "source", script: { files: [{ path: "main.tease", source: "exit" }] } } },
        {
          source: {
            kind: "source",
            script: {
              files: [],
              images: [{ path: "a.png", keywords: ["k"], tagsProblem: "unreadable" }],
              unreadableFiles: [{ path: "b", reason: "denied", folder: true }],
            },
          },
        },
      ],
      rejected: {
        "a source of no kind": { source: { kind: "other", text: "{}" } },
        "plan text without its text": { source: { kind: "plan" } },
        "plan text of a number": { source: { kind: "plan", text: 1 } },
        "plan text with an unknown key": { source: { kind: "plan", text: "{}", extra: 1 } },
        "a source's text under plan's key": { source: { kind: "source", text: "exit" } },
        "a script of a number": { source: { kind: "source", script: 1 } },
        "a project without files": { source: { kind: "source", script: {} } },
        "a project with an unknown key": {
          source: { kind: "source", script: { files: [], extra: 1 } },
        },
        "a project file of a numeric path": {
          source: { kind: "source", script: { files: [{ path: 1, source: "" }] } },
        },
        "a project file with an unknown key": {
          source: { kind: "source", script: { files: [{ path: "a", source: "", extra: 1 }] } },
        },
        "an image of numeric keywords": {
          source: { kind: "source", script: { files: [], images: [{ path: "a", keywords: [1] }] } },
        },
        "an unreadable file whose folder is text": {
          source: {
            kind: "source",
            script: { files: [], unreadableFiles: [{ path: "b", reason: "r", folder: "yes" }] },
          },
        },
        // An optional field present as `undefined`, which a clone keeps, as its type excludes it.
        "a project's images of undefined": {
          source: { kind: "source", script: { files: [], images: undefined } },
        },
        "a project's unreadable files of undefined": {
          source: { kind: "source", script: { files: [], unreadableFiles: undefined } },
        },
        "an image's tags problem of undefined": {
          source: {
            kind: "source",
            script: {
              files: [],
              images: [{ path: "a.png", keywords: [], tagsProblem: undefined }],
            },
          },
        },
        "an unreadable file's folder of undefined": {
          source: {
            kind: "source",
            script: { files: [], unreadableFiles: [{ path: "b", reason: "r", folder: undefined }] },
          },
        },
      },
    },
  ),
  planMetadata: PLAN,
  teardown: NULL_ONLY,
  start: record(
    { plan: "p1", options: {}, recording: false },
    { plan: S, options: O, recording: B, random: O, run: O },
    {
      optional: ["random", "run"],
      also: [
        {
          plan: "p1",
          options: {
            scriptStorage: [{}],
            persistentScriptStorage: true,
            temporalContext: {},
            wallClockMs: 0,
            debugMode: false,
            storedFiles: ["a"],
            playerProfile: {},
          },
          recording: true,
          random: { owner: 1, intent: INTENT },
          run: { run: 1, retires: null },
        },
        { plan: "p1", options: {}, recording: false, random: { owner: 1 } },
      ],
      rejected: {
        "options of a date": { plan: "p1", options: new Date(0), recording: false },
        "an unknown option": { plan: "p1", options: { extra: 1 }, recording: false },
        "a fractional wall clock": { plan: "p1", options: { wallClockMs: 1.5 }, recording: false },
        "storage entries no records": {
          plan: "p1",
          options: { scriptStorage: ["x"] },
          recording: false,
        },
        "a temporal context of text": {
          plan: "p1",
          options: { temporalContext: "x" },
          recording: false,
        },
        // The declaration admits any `object` here (`ContinueAdmitted`); the check refuses an array.
        "a temporal context of an array": {
          plan: "p1",
          options: { temporalContext: [] },
          recording: false,
        },
        "a storage entry of an array": {
          plan: "p1",
          options: { scriptStorage: [[]] },
          recording: false,
        },
        "stored files of numbers": { plan: "p1", options: { storedFiles: [1] }, recording: false },
        "a debug mode of text": { plan: "p1", options: { debugMode: "yes" }, recording: false },
        "persistent storage of a number": {
          plan: "p1",
          options: { persistentScriptStorage: 1 },
          recording: false,
        },
        "a profile of a list": { plan: "p1", options: { playerProfile: [] }, recording: false },
        "a random owner 0": { plan: "p1", options: {}, recording: false, random: { owner: 0 } },
        "a fractional random owner": {
          plan: "p1",
          options: {},
          recording: false,
          random: { owner: 1.5 },
        },
        "a random intent of another owner": {
          plan: "p1",
          options: {},
          recording: false,
          random: { owner: 2, intent: INTENT },
        },
        "random with an unknown key": {
          plan: "p1",
          options: {},
          recording: false,
          random: { owner: 1, extra: 1 },
        },
        "a run whose retired run is text": {
          plan: "p1",
          options: {},
          recording: false,
          run: { run: 1, retires: "0" },
        },
        // An optional field present as `undefined`, which a clone keeps, as its type excludes it.
        ...Object.fromEntries(
          [
            "scriptStorage",
            "persistentScriptStorage",
            "temporalContext",
            "wallClockMs",
            "debugMode",
            "storedFiles",
            "playerProfile",
          ].map((option) => [
            `an option ${option} of undefined`,
            { plan: "p1", options: { [option]: undefined }, recording: false },
          ]),
        ),
        "a random intent of undefined": {
          plan: "p1",
          options: {},
          recording: false,
          random: { owner: 1, intent: undefined },
        },
        "random of undefined": { plan: "p1", options: {}, recording: false, random: undefined },
        "a run of undefined": { plan: "p1", options: {}, recording: false, run: undefined },
      },
    },
  ),
  continue: record(
    { capture: { wallClockMs: 0, temporalContext: {} } },
    { capture: O },
    {
      rejected: {
        "a fractional wall clock": { capture: { wallClockMs: 1.5, temporalContext: {} } },
        "a capture without its temporal context": { capture: { wallClockMs: 0 } },
        "a capture with an unknown key": {
          capture: { wallClockMs: 0, temporalContext: {}, extra: 1 },
        },
        "a temporal context of text": { capture: { wallClockMs: 0, temporalContext: "x" } },
        // The declaration admits any `object` here (`ContinueAdmitted`); the check refuses an array.
        "a temporal context of an array": { capture: { wallClockMs: 0, temporalContext: [] } },
      },
    },
  ),
  viewCalls: record({ on: true }, { on: B }, { also: [{ on: false }] }),
  beginRecording: row({
    forms: [{ sample: { run: 1, retires: null }, fields: { run: N, retires: ["number", "null"] } }],
    top: ["null"],
    also: [null, { run: 2, retires: 1 }],
    rejected: { "a fractional run": { run: 1.5, retires: null } },
  }),
  observeTime: OBSERVATION,
  observeInput: OBSERVATION,
  stepTime: TIME("targetMs"),
  skipPacing: record({ actionId: 1 }, { actionId: N }),
  beginCatchUp: TIME("targetMs"),
  stepCatchUp: TIME("budgetMs"),
  adoptCatchUp: NULL_ONLY,
  dropCatchUp: NULL_ONLY,
  drawCode: record(
    { plan: "p1", path: "main.tease", site: SITE },
    { plan: S, path: S, site: O },
    {
      // A site as plan metadata gives it, with its ID and path.
      also: [
        {
          plan: "p1",
          path: "main.tease",
          site: { id: "main.tease:1:1", path: "main.tease", ...SITE },
        },
      ],
      rejected: {
        "a site at line 0": { plan: "p1", path: "main.tease", site: { ...SITE, line: 0 } },
        "a site of a fractional end": {
          plan: "p1",
          path: "main.tease",
          site: { ...SITE, endColumn: 1.5 },
        },
        "a site without its end line": {
          plan: "p1",
          path: "main.tease",
          site: { line: 1, column: 1, endColumn: 2 },
        },
      },
    },
  ),
  codeLines: record(
    { texts: [], first: 1 },
    { texts: A, first: N },
    {
      also: [{ texts: ["a", "b"], first: 3 }],
      rejected: {
        "numeric texts": { texts: [1], first: 1 },
        "a fractional first line": { texts: [], first: 1.5 },
      },
    },
  ),
  submitComposer: answering({ text: "answer" }, { text: S }),
  selectChoice: answering({ optionId: "o1" }, { optionId: S }),
  activateButton: answering({}, {}),
  stepFormField: record(
    { actionId: 1, fieldId: "f", draft: null },
    { actionId: N, fieldId: S, draft: NS },
    { also: [{ actionId: 1, fieldId: "f", draft: "d" }] },
  ),
  dismissFormField: record({ actionId: 1 }, { actionId: N }),
  clearFormField: record({ actionId: 1 }, { actionId: N }),
  draftForm: record({ actionId: 1, fieldId: "f", text: "t" }, { actionId: N, fieldId: S, text: S }),
  submitForm: answering(
    { draft: null },
    { draft: NS },
    { also: [{ actionId: 1, draft: "d", input: null }] },
  ),
  cancelForm: answering({}, {}),
  skipImage: answering({}, {}),
  answerImage: answering(
    { reference: "r", held: [] },
    { reference: S, held: A },
    {
      also: [
        { actionId: 1, reference: "r", held: [{ reference: "r", kind: "image" }], input: null },
      ],
      rejected: {
        "held media of no kind": {
          actionId: 1,
          reference: "r",
          held: [{ reference: "r", kind: "picture" }],
          input: null,
        },
      },
    },
  ),
  openUrl: answering({}, {}),
  closePopup: answering({}, {}),
  closeExport: answering({}, {}),
  pressPermanentButton: record({ buttonId: 1 }, { buttonId: N }),
  completeStorageWrite: record(
    { actionId: 1, stored: true },
    { actionId: N, stored: B },
    { also: [{ actionId: 1, stored: false }] },
  ),
  // The engine validates the value (`invalidEdit`): the host admits any.
  applyStorageEdit: record({ key: "k", value: 1 }, { key: S, value: ANY }),
  // The engine validates the report (`invalidReport`): the host admits any record.
  reportMediaLoad: record(
    { mediaId: 0, report: { kind: "loaded", durationMs: 1 } },
    { mediaId: N, report: O },
    {
      rejected: {
        "a negative medium": { mediaId: -1, report: { kind: "loaded", durationMs: 1 } },
        "a fractional medium": { mediaId: 1.5, report: { kind: "loaded", durationMs: 1 } },
      },
    },
  ),
  answerCapture: (() => {
    const unavailable = ANSWER({ kind: "unavailable", reason: "denied" });
    const captured = {
      actionId: 0,
      answer: { kind: "captured", reference: "photo-1" },
      held: null,
    } as const;
    const answer = (value: unknown) => ({ actionId: 0, answer: value, held: null });
    const typed: Row & Samples<SamplesOf<typeof unavailable> | typeof captured> = {
      ...unavailable,
      also: [...unavailable.also!, captured],
      rejected: {
        ...unavailable.rejected,
        "an answer of no kind": answer({ kind: "bogus", reason: "failed" }),
        "a captured answer with an unknown key": answer({
          kind: "captured",
          reference: "photo-1",
          extra: 1,
        }),
        "a captured answer of a numeric reference": answer({ kind: "captured", reference: 1 }),
        "an unavailable answer of a numeric reason": answer({ kind: "unavailable", reason: 1 }),
        "an unavailable answer without its reason": answer({ kind: "unavailable" }),
      },
    };
    return typed;
  })(),
  // The engine validates file store and lock answers (`invalidPayload`): the host admits any record.
  answerFileStore: ANSWER({ kind: "failed" }),
  answerLock: ANSWER({ kind: "notOpened" }),
  preparePlanText: PLAN,
  releasePlanText: PLAN,
  planText: PLAN,
  captureKeep: record(
    { session: "s1", plan: null },
    { session: S, plan: NS },
    { also: [{ session: "s1", plan: "p1" }] },
  ),
  captureCheckpoint: SESSION,
  restoreKept: (() => {
    const kept = { plan: "p1", planJson: "{}", snapshotJson: "{}" };
    return record(
      { ...kept, events: [], marks: NO_MARKS },
      { plan: S, planJson: S, snapshotJson: S, events: A, marks: O },
      {
        also: [
          {
            ...kept,
            events: [exitEvent(1), exitEvent(3)],
            marks: {
              editedWhileDebugging: { firstEditSceneTimeMs: 0.5, editCount: 1 },
              rewoundWhileDebugging: { restoredSceneTimeMs: 0, rewindCount: 2 },
            },
          },
        ],
        rejected: {
          ...EVENT_LOG_REJECTED({ ...kept, marks: NO_MARKS }),
          "marks without a rewind": { ...kept, events: [], marks: { editedWhileDebugging: null } },
          "marks of no edit": {
            ...kept,
            events: [],
            marks: { ...NO_MARKS, editedWhileDebugging: { firstEditSceneTimeMs: 0, editCount: 0 } },
          },
          "marks with an unknown key": { ...kept, events: [], marks: { ...NO_MARKS, extra: 1 } },
        },
      },
    );
  })(),
  readTransfer: row({
    forms: [
      { sample: { bytes: new Uint8Array([1]) }, fields: { bytes: ["bytes"] } },
      { sample: { text: "t" }, fields: { text: S } },
    ],
    // A view of part of a buffer, as a clone keeps it.
    also: [{ bytes: new Uint8Array(new ArrayBuffer(4)).subarray(1, 3) }],
    rejected: {
      "bytes and a text": { bytes: new Uint8Array([1]), text: "t" },
      "bytes over a shared buffer": { bytes: new Uint8Array(new SharedArrayBuffer(1)) },
    },
  }),
  reviewTransfer: record(
    { ticket: "t1", scope: "s", plan: "p1" },
    { ticket: S, scope: S, plan: S },
  ),
  transferCommit: TICKET,
  releaseTransfer: TICKET,
  retireRun: record({ run: 1 }, { run: N }, { rejected: { "a fractional run": { run: 1.5 } } }),
  commitIncident: record(
    STOP,
    { error: S, run: N, stop: N, retires: ["number", "null"] },
    {
      also: [{ ...STOP, retires: 0 }],
      rejected: {
        "a fractional run": { ...STOP, run: 1.5 },
        "a fractional stop": { ...STOP, stop: 1.5 },
        "a fractional retired run": { ...STOP, retires: 1.5 },
      },
    },
  ),
  captureRecording: SESSION,
  releaseRecording: TICKET,
  readRecording: record({ ticket: null }, { ticket: NS }, { also: [{ ticket: "r1" }] }),
  captureExport: record(
    { session: null, recording: "current" },
    { session: NS, recording: ["string", "object"] },
    {
      also: [
        { session: "s1", recording: "none" },
        { session: "s1", recording: { ticket: "r1" } },
      ],
      rejected: {
        "a recording of no kind": { session: null, recording: "other" },
        "a ticket of a number": { session: null, recording: { ticket: 1 } },
        "a ticket with an unknown key": {
          session: null,
          recording: { ticket: "r1", kind: "recording" },
        },
      },
    },
  ),
  exportPrepare: record(
    { ticket: "r1", replay: true },
    { ticket: S, replay: B },
    { also: [{ ticket: "r1", replay: false }] },
  ),
  captureStorage: SESSION,
  historyRenew: record(
    { intent: 1, owner: 0, session: null, closes: [] },
    { intent: N, owner: N, session: NS, closes: A },
    {
      also: [
        { intent: 2, owner: 1, session: "s1", closes: [] },
        ...(["import", "clear"] as const).map((by) => ({
          intent: 2,
          owner: 1,
          session: null,
          closes: [{ history: 1, by }],
        })),
        {
          intent: 2,
          owner: 1,
          session: null,
          closes: [{ history: 1, by: "debugOff", adoptionSucceeded: true }],
        },
      ],
      rejected: {
        ...SERIAL_REJECTED("intent", { owner: 0, session: null, closes: [] }),
        "a negative owner": { intent: 1, owner: -1, session: null, closes: [] },
        "a fractional owner": { intent: 1, owner: 0.5, session: null, closes: [] },
        // A renewal carries the closes decided with it; the disposal and a replacement are never among them.
        "a close by the disposal": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 1, by: "disposal" }],
        },
        "a close by a replacement": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 1, by: "replacement" }],
        },
        "a close of history 0": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 0, by: "clear" }],
        },
        "a close with an unknown key": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 1, by: "clear", more: true }],
        },
        "a close of no record": { intent: 2, owner: 0, session: null, closes: [1] },
        // Debug off's close rides on a renewal only after its adoption succeeded: it reinstates nothing.
        "a Debug-off close with no adoption": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 1, by: "debugOff" }],
        },
        "a retirement's close with an adoption": {
          intent: 2,
          owner: 0,
          session: null,
          closes: [{ history: 1, by: "clear", adoptionSucceeded: true }],
        },
      },
    },
  ),
  historyClose: record(
    { history: 1, by: "debugOff", owner: 0 },
    { history: N, by: S, adoptionSucceeded: B, owner: N },
    {
      optional: ["adoptionSucceeded"],
      also: [
        ...(["replacement", "import", "clear", "disposal"] as const).map((by) => ({
          history: 1,
          by,
          owner: 1,
        })),
        { history: 1, by: "import", adoptionSucceeded: true, owner: 1 },
        { history: 1, by: "import", adoptionSucceeded: false, owner: 1 },
      ],
      rejected: {
        ...SERIAL_REJECTED("history", { by: "debugOff", owner: 0 }),
        // No request closes by a loss: the Player only seals the history; a lost Worker's histories go with it.
        "closed by a loss": { history: 1, by: "loss", owner: 0 },
        "closed for no reason": { history: 1, by: "other", owner: 0 },
        "a negative owner": { history: 1, by: "debugOff", owner: -1 },
      },
    },
  ),
  historyTimeline: HISTORY,
  rewindBack: record(
    { history: 1, point: 1, live: "s1", events: [] },
    { history: N, point: N, live: S, events: A },
    {
      also: [{ history: 1, point: 2, live: "s1", events: [exitEvent(1)] }],
      rejected: {
        ...SERIAL_REJECTED("history", { point: 1, live: "s1", events: [] }),
        ...SERIAL_REJECTED("point", { history: 1, live: "s1", events: [] }),
        ...EVENT_LOG_REJECTED({ history: 1, point: 1, live: "s1" }),
      },
    },
  ),
  rewindForward: record(
    { history: 1, events: [] },
    { history: N, events: A },
    {
      also: [{ history: 1, events: [exitEvent(1)] }],
      rejected: {
        ...SERIAL_REJECTED("history", { events: [] }),
        ...EVENT_LOG_REJECTED({ history: 1 }),
      },
    },
  ),
  rewindCommit: STEP,
  rewindDrop: STEP,
  rewindReturn: HISTORY,
  rewindAdopt: row({
    forms: [
      { sample: { history: 1, phase: "begin" }, fields: { history: N, phase: S } },
      {
        sample: { history: 1, phase: "end", succeeded: true },
        fields: { history: N, phase: S, succeeded: B },
      },
    ],
    also: [{ history: 1, phase: "end", succeeded: false }],
    rejected: {
      ...SERIAL_REJECTED("history", { phase: "begin" }),
      "a phase of no kind": { history: 1, phase: "middle" },
      "a begin that succeeded": { history: 1, phase: "begin", succeeded: true },
    },
  }),
  debugTracing: record(
    TRACING,
    { on: B, intent: N },
    {
      also: [{ on: false, intent: 2 }],
      rejected: {
        "intent 0": { on: true, intent: 0 },
        "a fractional intent": { on: true, intent: 1.5 },
      },
    },
  ),
  restartTrace: record(
    { tracing: TRACING },
    { tracing: O },
    {
      rejected: {
        "a tracing intent 0": { tracing: { on: true, intent: 0 } },
        "a tracing intent with an unknown key": { tracing: { ...TRACING, extra: 1 } },
        "a tracing intent without its switch": { tracing: { intent: 1 } },
      },
    },
  ),
  setDebugMode: record({ on: true }, { on: B }, { also: [{ on: false }] }),
  debugView: record(
    { session: "s1", request: VIEW },
    { session: S, request: O },
    {
      also: [
        {
          session: "s1",
          request: {
            messages: { limit: 1, openNewest: true },
            selected: { sequence: 0, epoch: 0 },
            variables: { filter: "", pages: { group: 1 } },
            image: true,
            trees: { recent: { choices: { a: true }, pages: { a: 2 } } },
          },
        },
      ],
      rejected: {
        "a message limit 0": {
          session: "s1",
          request: { ...VIEW, messages: { limit: 0, openNewest: true } },
        },
        "a fractional selected sequence": {
          session: "s1",
          request: { ...VIEW, selected: { sequence: 1.5, epoch: 0 } },
        },
        "a variable page 0": {
          session: "s1",
          request: { ...VIEW, variables: { filter: "", pages: { group: 0 } } },
        },
        "an image of text": { session: "s1", request: { ...VIEW, image: "yes" } },
        "a request without its trees": {
          session: "s1",
          request: { messages: null, selected: null, variables: null, image: false },
        },
        "a tree of a numeric choice": {
          session: "s1",
          request: { ...VIEW, trees: { recent: { choices: { a: 1 }, pages: {} } } },
        },
        "a request with an unknown key": { session: "s1", request: { ...VIEW, extra: 1 } },
      },
    },
  ),
  randomControl: record(
    { intent: INTENT },
    { intent: O },
    {
      also: [{ intent: { ...INTENT, control: { sites: [["main.tease:1:1", "untried"]] } } }],
      rejected: {
        "a reset after its intent": { intent: { ...INTENT, resetAt: 2 } },
        "an owner 0": { intent: { ...INTENT, owner: 0 } },
        "a site's next draw of no kind": {
          intent: { ...INTENT, control: { sites: [["main.tease:1:1", "other"]] } },
        },
        "a site of three parts": {
          intent: { ...INTENT, control: { sites: [["main.tease:1:1", "random", 1]] } },
        },
        "a control with an unknown key": {
          intent: { ...INTENT, control: { sites: [], extra: 1 } },
        },
      },
    },
  ),
  adoptRandom: record(
    { session: "s1", intent: INTENT },
    { session: S, intent: O },
    {
      rejected: {
        "an intent without its owner": { session: "s1", intent: { ...INTENT, owner: undefined } },
      },
    },
  ),
  releaseRandom: SESSION,
  resolveDraw: (() => {
    const draw = (outcome: unknown, record: unknown = null) => ({ drawId: 1, outcome, record });
    return record(
      { drawId: 1, outcome: "natural", record: null },
      { drawId: N, outcome: ["string", "object"], record: ["object", "null"] },
      {
        also: [
          { drawId: 1, outcome: "untried", record: { resetAt: 0 } },
          { drawId: 1, outcome: { kind: "number", value: 0.5 }, record: null },
          { drawId: 1, outcome: { kind: "boolean", value: false }, record: null },
          { drawId: 1, outcome: { kind: "index", index: 2 }, record: null },
          { drawId: 1, outcome: { kind: "order", order: [1, 0] }, record: null },
        ],
        rejected: {
          "an outcome of no kind": draw("other"),
          "an outcome kind of no kind": draw({ kind: "colour", value: 1 }),
          "a fractional index": draw({ kind: "index", index: 1.5 }),
          "a number of text": draw({ kind: "number", value: "1" }),
          "a boolean of a number": draw({ kind: "boolean", value: 1 }),
          "an order of a fraction": draw({ kind: "order", order: [0.5] }),
          "an outcome with an unknown key": draw({ kind: "index", index: 1, extra: 1 }),
          "a record of a text reset": draw("natural", { resetAt: "0" }),
          "a record with an unknown key": draw("natural", { resetAt: 0, extra: 1 }),
        },
      },
    );
  })(),
  randomTried: record({ session: "s1", site: "main.tease:1:1" }, { session: S, site: S }),
} satisfies { readonly [O in OpName]: Samples<OpAdmitted<O>> };

/** A case: an argument and whether its op admits it. */
interface Case {
  readonly name: string;
  readonly args: unknown;
  readonly admitted: boolean;
}

/** The cases of `row`, its rejected ones generated from its forms and kinds, then its own. */
function casesOf(row: Row): Case[] {
  const cases: Case[] = [];
  const admit = (name: string, args: unknown) => cases.push({ name, args, admitted: true });
  const refuse = (name: string, args: unknown) => cases.push({ name, args, admitted: false });
  const top = row.top ?? [];
  (row.forms ?? []).forEach((form, index) => {
    const name = `form ${index + 1}`;
    admit(name, form.sample);
    const optional = form.optional ?? [];
    for (const field of Object.keys(form.fields)) {
      if (!optional.includes(field)) {
        const { [field]: _left, ...without } = form.sample;
        refuse(`${name} without ${field}`, without);
      }
      for (const [kind, value] of OTHER_KIND)
        if (!form.fields[field]!.includes(kind))
          refuse(`${name} with ${field} of kind ${kind}`, { ...form.sample, [field]: value });
    }
    refuse(`${name} with an unknown key`, { ...form.sample, extra: 1 });
  });
  for (const [kind, value] of OTHER_KIND)
    if (!top.includes(kind) && (kind !== "object" || row.forms === undefined))
      refuse(`an argument of kind ${kind}`, value);
  (row.also ?? []).forEach((args, index) => admit(`admitted ${index + 1}`, args));
  for (const [name, args] of Object.entries(row.rejected ?? {})) refuse(name, args);
  return cases;
}

const ops: BridgeOps = playerBridgeOps(playerOpsContext({ historySpill: async () => null }));

test("the rows are the catalogue's ops, each named once", () => {
  const names = Object.keys(ops);
  assert.deepEqual(
    names.filter((name) => !Object.hasOwn(ROWS, name)),
    [],
    "ops without a row",
  );
  assert.deepEqual(
    Object.keys(ROWS).filter((name) => !Object.hasOwn(ops, name)),
    [],
    "rows of no op",
  );
  assert.equal(names.length, 74);
});

test("each row's forms give every field a kind, and every required field a value", () => {
  for (const [op, row] of Object.entries(ROWS)) {
    assert.ok(row.forms !== undefined || (row.also ?? []).length > 0, `${op} admits something`);
    for (const form of row.forms ?? []) {
      const optional = form.optional ?? [];
      assert.deepEqual(
        Object.keys(form.sample).filter((field) => !Object.hasOwn(form.fields, field)),
        [],
        `${op}: sample fields without a kind`,
      );
      assert.deepEqual(
        Object.keys(form.fields).filter(
          (field) => !optional.includes(field) && !Object.hasOwn(form.sample, field),
        ),
        [],
        `${op}: required fields without a value`,
      );
    }
  }
});

test("each op's argument check admits its row's arguments and refuses the rest", () => {
  const wrong: string[] = [];
  for (const [op, row] of Object.entries(ROWS)) {
    const check = ops[op]?.checkArguments;
    if (check === undefined) continue;
    for (const { name, args, admitted } of casesOf(row))
      if (check(args) !== admitted)
        wrong.push(`${op}: ${name} ${admitted ? "refused" : "admitted"}`);
  }
  assert.deepEqual(wrong, []);
});

test("the host's own release takes no arguments", () => {
  const replies: unknown[] = [];
  let listen!: (data: unknown) => void;
  const owner = deliveryOwner();
  const sessions = startBridgeHost(
    { post: (reply) => replies.push(reply), listen: (listener) => (listen = listener) },
    {},
    { commit: null, dirty: null, mode: null, appVersion: null },
    owner,
  );
  // A session the host holds is registered inside a delivery, as an op does.
  const session: HostSession = { revision: 0, accepts: () => true };
  const delivery = owner.begin();
  const id = sessions.add(session);
  owner.commit(delivery);
  const refused = OTHER_KIND.filter(([kind]) => kind !== "null");
  const release = (requestId: number, args: unknown) =>
    listen({
      v: BRIDGE_VERSION,
      kind: "request",
      id: requestId,
      session: id,
      basis: null,
      op: "release",
      args,
    });
  // The refusals first: each leaves the session held, which the last request releases.
  refused.forEach(([, args], index) => release(index + 1, args));
  release(refused.length + 1, null);
  const outcomes = replies.flatMap((reply) =>
    typeof reply !== "object" || reply === null || !("kind" in reply) || reply.kind !== "reply"
      ? []
      : "ok" in reply && reply.ok === true
        ? ["released"]
        : "error" in reply &&
            typeof reply.error === "object" &&
            reply.error !== null &&
            "code" in reply.error
          ? [reply.error.code]
          : [reply],
  );
  assert.deepEqual(outcomes, [...refused.map(() => "arguments"), "released"]);
  assert.equal(sessions.get(id), undefined);
});
