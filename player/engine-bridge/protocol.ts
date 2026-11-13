/**
 * The versioned bridge between the Player and the engine Worker that owns its plans and sessions. Messages are plain
 * structured-clone data, which `transport.ts` carries at any depth. Each side checks the envelope of every message it
 * receives; the Worker also checks each op's arguments. Reply payloads come from the same build (`ready.build`) and are not checked again.
 */

import { isPlainRecord } from "./argument-checks.js";

export const BRIDGE_VERSION = 1;

/** Which build a side belongs to; every field is `null` where it is unknown, such as in tests. */
export interface BuildIdentity {
  readonly commit: string | null;
  readonly dirty: boolean | null;
  readonly mode: string | null;
  readonly appVersion: string | null;
}

export interface BridgeRequest {
  readonly v: typeof BRIDGE_VERSION;
  readonly kind: "request";
  /** Increases with every request a client sends. */
  readonly id: number;
  /** The session the op works on, or `null` for an op on the Worker itself. */
  readonly session: string | null;
  /** The session revision the caller acted on; `null` where the op reads no session. */
  readonly basis: number | null;
  readonly op: string;
  readonly args: unknown;
}

export type BridgeReply =
  | {
      readonly v: typeof BRIDGE_VERSION;
      readonly kind: "reply";
      readonly id: number;
      readonly session: string | null;
      readonly ok: true;
      /** The session's revision after the op, or `null` for an op on the Worker itself. */
      readonly revision: number | null;
      /** How many of the session's events the reply's data includes, or `null` where it includes none. */
      readonly eventsThrough: number | null;
      readonly result: unknown;
      /** The session's view after the op, where the op returns one. */
      readonly view: unknown;
    }
  | {
      readonly v: typeof BRIDGE_VERSION;
      readonly kind: "reply";
      readonly id: number;
      readonly session: string | null;
      readonly ok: false;
      readonly error: BridgeError;
    };

/** The only message the Worker sends unasked: its module loaded. */
export interface BridgeReady {
  readonly v: typeof BRIDGE_VERSION;
  readonly kind: "ready";
  readonly build: BuildIdentity;
}

/** Why the bridge refused a request, before any effect. */
export type BridgeRefusal =
  "version" | "envelope" | "unknownOp" | "arguments" | "order" | "session" | "basis" | "halted";

/**
 * A failed request. `bridge` errors are refusals (`code` names which); `engine` errors are what the op threw, with the
 * class name, code and details it had, and whether its session ended (`ended`: no later op may use it).
 */
export interface BridgeError {
  readonly kind: "bridge" | "engine";
  readonly class: string;
  readonly code: string | null;
  readonly message: string;
  readonly info?: unknown;
  readonly ended: boolean;
}

const REQUEST_KEYS = ["v", "kind", "id", "session", "basis", "op", "args"] as const;
const REPLY_OK_KEYS = [
  "v",
  "kind",
  "id",
  "session",
  "ok",
  "revision",
  "eventsThrough",
  "result",
  "view",
] as const;
const REPLY_ERROR_KEYS = ["v", "kind", "id", "session", "ok", "error"] as const;
const BUILD_KEYS = ["commit", "dirty", "mode", "appVersion"] as const;

/** Whether `value` has exactly `required` own keys, plus any of `optional`. */
function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** The request in `value`, or why it is not one: a different version, or another envelope. */
export function readRequest(value: unknown): BridgeRequest | "version" | "envelope" {
  if (!isPlainRecord(value)) return "envelope";
  if (value.v !== BRIDGE_VERSION) return "version";
  const { kind, id, session, basis, op, args } = value;
  if (
    !hasKeys(value, REQUEST_KEYS) ||
    kind !== "request" ||
    !isId(id) ||
    !isNullableString(session) ||
    !(basis === null || isRevision(basis)) ||
    typeof op !== "string" ||
    op === ""
  )
    return "envelope";
  return { v: BRIDGE_VERSION, kind, id, session, basis, op, args };
}

function isBridgeError(value: unknown): value is BridgeError {
  return (
    isPlainRecord(value) &&
    hasKeys(value, ["kind", "class", "code", "message", "ended"], ["info"]) &&
    (value.kind === "bridge" || value.kind === "engine") &&
    typeof value.class === "string" &&
    isNullableString(value.code) &&
    typeof value.message === "string" &&
    typeof value.ended === "boolean"
  );
}

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  return (
    isPlainRecord(value) &&
    hasKeys(value, BUILD_KEYS) &&
    isNullableString(value.commit) &&
    (value.dirty === null || typeof value.dirty === "boolean") &&
    isNullableString(value.mode) &&
    isNullableString(value.appVersion)
  );
}

export function sameBuild(left: BuildIdentity, right: BuildIdentity): boolean {
  return BUILD_KEYS.every((key) => left[key] === right[key]);
}

/** The Worker's message in `value`, a reply or `ready`, or `null` when it is neither. */
export function readWorkerMessage(value: unknown): BridgeReply | BridgeReady | null {
  if (!isPlainRecord(value) || value.v !== BRIDGE_VERSION) return null;
  const v = BRIDGE_VERSION;
  if (value.kind === "ready") {
    const { build } = value;
    return hasKeys(value, ["v", "kind", "build"]) && isBuildIdentity(build)
      ? { v, kind: "ready", build }
      : null;
  }
  const { id, session } = value;
  if (value.kind !== "reply" || !isId(id) || !isNullableString(session)) return null;
  if (value.ok === true) {
    const { revision, eventsThrough, result, view } = value;
    return hasKeys(value, REPLY_OK_KEYS) &&
      (revision === null || isRevision(revision)) &&
      (eventsThrough === null || isRevision(eventsThrough))
      ? { v, kind: "reply", id, session, ok: true, revision, eventsThrough, result, view }
      : null;
  }
  if (value.ok === false) {
    const { error } = value;
    return hasKeys(value, REPLY_ERROR_KEYS) && isBridgeError(error)
      ? { v, kind: "reply", id, session, ok: false, error }
      : null;
  }
  return null;
}

export function refusal(code: BridgeRefusal, message: string): BridgeError {
  return { kind: "bridge", class: "BridgeRefusal", code, message, ended: false };
}
