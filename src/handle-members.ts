/**
 * The members of each kind of handle: the properties and methods of timers (V30 §27), media and camera views (V30 §22),
 * permanent buttons (V30 §28), and messages (V30 §37). One contract per kind, shared by the compiler, the runtime, and
 * the editor; the runtime implements the members in `runtime/background/timers.ts`, `runtime/background/media.ts`, and the evaluator. A problem
 * with a member is the kind's own compile error (`code`), and the compiler and the runtime give it one message
 * (`handleMemberMessage`).
 */

import { NO_ARGUMENTS, type ArgumentShape } from "./argument-rules.js";
import type { OwnedDiagnosticCode } from "./diagnostic-codes.js";
import {
  cameraPlacementMessage,
  isCameraPlacement,
  isMediaVolume,
  isTimerDisplay,
  mediaVolumeMessage,
  timerDisplayMessage,
} from "./handle-rules.js";
import type { SerializableRuntimeValue } from "./runtime/values/serializable-values.js";
import { valueKindOf } from "./value-kinds.js";

/** The kinds of handles, as the compiler names their types. */
export const HANDLE_KINDS = Object.freeze([
  "timer",
  "media",
  "camera",
  "messageHandle",
  "permanentButton",
] as const);

export type HandleKind = (typeof HANDLE_KINDS)[number];

export function isHandleKind(kind: string): kind is HandleKind {
  return HANDLE_KINDS.some((handle) => handle === kind);
}

/** The kind of handle a runtime value is, or `null` for another value. */
export function handleKindOf(value: SerializableRuntimeValue): HandleKind | null {
  const kind = valueKindOf(value);
  return isHandleKind(kind) ? kind : null;
}

/** The type of a property's value. */
export type HandleValueType = "duration" | "string" | "number";

/**
 * The values an assignable property takes, such as a timer's display: one check and one message, which the runtime
 * applies to every value assigned, and the compiler to one it knows.
 */
export interface HandleDomain {
  /** Whether the property can hold `value`; no value of another type fits. */
  readonly accepts: (value: unknown) => boolean;
  /** Why it cannot hold a value, which the message shows as the runtime does: text in quotes as a `choice`, or not. */
  readonly message: (shown: string) => string;
  readonly shows: "choice" | "value";
  /** How the compiler knows a value: as text it can see, or as a number of the known-value fold. */
  readonly known: "text" | "number";
  /** The message for text appended with `+=`, which never gives a value of the domain, when the compiler reports it. */
  readonly appended?: string;
}

/**
 * A property of a handle. A read computes its value from the state the handle names, so it is never a place: a change
 * through it changes a copy (#941).
 */
export interface HandleProperty {
  /** What a read gives, which may also be null when `nullable`. */
  readonly type: HandleValueType;
  readonly nullable?: true;
  readonly read: "computed";
  /**
   * How a script assigns it, or absent when it is read-only: the type of the value it takes, which the compiler checks
   * as it checks any place's type, and the runtime with the message of `assignedTypeMessage`, both as `TSV041`. Where it
   * has a domain, the domain alone decides at runtime, with the code of the handle (`HandleContract.code`).
   */
  readonly assign?:
    | { readonly type: "duration" | "string"; readonly domain?: undefined }
    | { readonly type: HandleValueType; readonly domain: HandleDomain };
  /** It changes as scene time passes, and with the handle's pause(), resume(), and stop(). */
  readonly timed?: true;
  /** A write first waits for the reading time of a paced message before it. */
  readonly paced?: true;
  /** A write may end the timer's round, which draws the next round's duration from its range. */
  readonly draws?: true;
  /** Its text is message markup: the compiler checks the colours of literal text assigned with `=`, as in `say`. */
  readonly markup?: true;
}

/**
 * A method of a handle. A call never only reads: it changes the handle's `timing`, which its timed properties read, or
 * the `presence` of its message or button on screen. It gives null.
 */
export interface HandleMethod {
  readonly shape: ArgumentShape;
  readonly result: "null";
  readonly changes: "timing" | "presence";
  /** A call first waits for the reading time of a paced message before it. */
  readonly paced?: true;
  /** A call may end a round that is already due, which draws the next round's duration from its range. */
  readonly draws?: true;
  /** What the call does, for the editor's help. */
  readonly summary: string;
}

export interface HandleContract {
  /**
   * The code of a problem with a member, from the compiler and the runtime: `TSV043` for a kind without a code of its
   * own.
   */
  readonly code: OwnedDiagnosticCode<"type checker", "error"> &
    OwnedDiagnosticCode<"runtime", "error">;
  /** How a message names one, as in `a timer handle`. */
  readonly noun: string;
  /** What a script that calls a method this kind does not have may do instead, besides its methods. */
  readonly instead?: string;
  readonly properties: { readonly [name: string]: HandleProperty };
  readonly methods: { readonly [name: string]: HandleMethod };
}

/** `pause()`, `resume()`, and `stop()` of timers and media, which have the same help. */
const PAUSE_SUMMARY =
  "Pauses a running timer or media: its time stops until resume(). Pausing a paused one does nothing, and on a finished or stopped one it has no effect and reports developer warning TSW010.";
const RESUME_SUMMARY =
  "Continues a paused timer or media from where it paused. Resuming a running one does nothing, and on a finished or stopped one it has no effect and reports developer warning TSW010.";
const STOP_SUMMARY =
  "Stops a running or paused timer or media for good, so its blocks that have not started yet do not run. On a finished one it only cancels those blocks, and on a stopped one it does nothing.";

/** Each kind of handle with its members. */
export const HANDLE_MEMBERS = {
  timer: {
    code: "TSV034",
    noun: "timer handle",
    properties: {
      remaining: {
        type: "duration",
        read: "computed",
        assign: { type: "duration" },
        timed: true,
        draws: true,
      },
      elapsed: { type: "duration", read: "computed", timed: true },
      display: {
        type: "string",
        read: "computed",
        assign: {
          type: "string",
          domain: {
            accepts: isTimerDisplay,
            message: timerDisplayMessage,
            shows: "choice",
            known: "text",
          },
        },
      },
      label: { type: "string", nullable: true, read: "computed" },
      state: { type: "string", read: "computed", timed: true },
      repeatDuration: {
        type: "duration",
        nullable: true,
        read: "computed",
        assign: { type: "duration" },
      },
    },
    methods: {
      pause: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "timing",
        draws: true,
        summary: PAUSE_SUMMARY,
      },
      resume: { shape: NO_ARGUMENTS, result: "null", changes: "timing", summary: RESUME_SUMMARY },
      stop: { shape: NO_ARGUMENTS, result: "null", changes: "timing", summary: STOP_SUMMARY },
    },
  },
  media: {
    code: "TSV037",
    noun: "media handle",
    properties: {
      position: {
        type: "duration",
        read: "computed",
        assign: { type: "duration" },
        timed: true,
        paced: true,
      },
      elapsed: { type: "duration", read: "computed", timed: true },
      remaining: {
        type: "duration",
        nullable: true,
        read: "computed",
        assign: { type: "duration" },
        timed: true,
        paced: true,
      },
      duration: { type: "duration", nullable: true, read: "computed" },
      volume: {
        type: "number",
        read: "computed",
        assign: {
          type: "number",
          domain: {
            accepts: isMediaVolume,
            message: mediaVolumeMessage,
            shows: "value",
            known: "number",
          },
        },
        paced: true,
      },
      state: { type: "string", read: "computed", timed: true },
    },
    methods: {
      pause: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "timing",
        paced: true,
        summary: PAUSE_SUMMARY,
      },
      resume: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "timing",
        paced: true,
        summary: RESUME_SUMMARY,
      },
      stop: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "timing",
        paced: true,
        summary: STOP_SUMMARY,
      },
    },
  },
  camera: {
    code: "TSV059",
    noun: "camera view",
    instead: "hide them with hideCamera",
    properties: {
      placement: {
        type: "string",
        read: "computed",
        assign: {
          type: "string",
          domain: {
            accepts: isCameraPlacement,
            message: cameraPlacementMessage,
            shows: "choice",
            known: "text",
            appended: cameraPlacementMessage(null),
          },
        },
        paced: true,
      },
    },
    methods: {},
  },
  messageHandle: {
    code: "TSV043",
    noun: "message handle",
    instead: "change the message with its text property",
    properties: {
      text: { type: "string", read: "computed", assign: { type: "string" }, markup: true },
    },
    methods: {
      remove: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "presence",
        summary:
          "Takes the message out of the conversation. Its text property still reads the text it had, and removing it again does nothing.",
      },
    },
  },
  permanentButton: {
    code: "TSV043",
    noun: "permanent button",
    properties: {},
    methods: {
      remove: {
        shape: NO_ARGUMENTS,
        result: "null",
        changes: "presence",
        summary: "Removes the button. Removing a button that is already gone does nothing.",
      },
    },
  },
} as const satisfies { readonly [Kind in HandleKind]: HandleContract };

type Members = typeof HANDLE_MEMBERS;

export type HandlePropertyName<Kind extends HandleKind> = keyof Members[Kind]["properties"] &
  string;

export type HandleMethodName<Kind extends HandleKind> = keyof Members[Kind]["methods"] & string;

/** The name of a method of any kind of handle. */
export type AnyHandleMethodName = { [Kind in HandleKind]: HandleMethodName<Kind> }[HandleKind];

/** The properties of `Kind` that a script can assign. */
export type AssignableHandleProperty<Kind extends HandleKind> = {
  [Name in HandlePropertyName<Kind>]: Members[Kind]["properties"][Name] extends {
    readonly assign: object;
  }
    ? Name
    : never;
}[HandlePropertyName<Kind>];

/** The property `name` of a kind of handle, or `undefined` when it has none. */
export function handleProperty(kind: HandleKind, name: string): HandleProperty | undefined {
  const properties: HandleContract["properties"] = HANDLE_MEMBERS[kind].properties;
  return Object.hasOwn(properties, name) ? properties[name] : undefined;
}

/** The method `name` of a kind of handle, or `undefined` when it has none. */
export function handleMethod(kind: HandleKind, name: string): HandleMethod | undefined {
  const methods: HandleContract["methods"] = HANDLE_MEMBERS[kind].methods;
  return Object.hasOwn(methods, name) ? methods[name] : undefined;
}

export function isHandleProperty<Kind extends HandleKind>(
  kind: Kind,
  name: string,
): name is HandlePropertyName<Kind> {
  return handleProperty(kind, name) !== undefined;
}

export function isAssignableHandleProperty<Kind extends HandleKind>(
  kind: Kind,
  name: string,
): name is AssignableHandleProperty<Kind> {
  return handleProperty(kind, name)?.assign !== undefined;
}

export function isHandleMethod<Kind extends HandleKind>(
  kind: Kind,
  name: string,
): name is HandleMethodName<Kind> {
  return handleMethod(kind, name) !== undefined;
}

/** Whether a kind of handle has a property a script can assign. */
export function hasAssignableProperties(kind: HandleKind): boolean {
  return Object.values<HandleProperty>(HANDLE_MEMBERS[kind].properties).some(
    (property) => property.assign !== undefined,
  );
}

/** The kinds of handles with a property `name` that passes `test`, such as one whose write waits for pacing. */
export function kindsWithProperty(
  name: string,
  test: (property: HandleProperty) => boolean = () => true,
): readonly HandleKind[] {
  return HANDLE_KINDS.filter((kind) => {
    const property = handleProperty(kind, name);
    return property !== undefined && test(property);
  });
}

/** The kinds of handles with a method `name` that passes `test`, such as one whose call waits for pacing. */
export function kindsWithMethod(
  name: string,
  test: (method: HandleMethod) => boolean = () => true,
): readonly HandleKind[] {
  return HANDLE_KINDS.filter((kind) => {
    const method = handleMethod(kind, name);
    return method !== undefined && test(method);
  });
}

/** The name of every method of a handle. */
export function handleMethodNames(): readonly string[] {
  return [...new Set(HANDLE_KINDS.flatMap((kind) => Object.keys(HANDLE_MEMBERS[kind].methods)))];
}

/** Whether a handle of some kind has a method `name`. Every handle method changes its handle (see `HandleMethod`). */
export function isAnyHandleMethod(name: string): boolean {
  return kindsWithMethod(name).length > 0;
}

/**
 * The help of a method that every handle with a method `name` shares, as timers and media share `pause()`, or
 * `undefined`. A message's and a permanent button's `remove()` differ.
 */
export function sharedHandleMethodSummary(name: string): string | undefined {
  const summaries = new Set(kindsWithMethod(name).map((kind) => handleMethod(kind, name)!.summary));
  return summaries.size === 1 ? [...summaries][0] : undefined;
}

/** A call of a handle method as the editor's help writes it, such as `handle.pause()`: none takes arguments. */
export function handleMethodSyntax(name: AnyHandleMethodName): string {
  return `handle.${name}()`;
}

/**
 * The message for a member that a kind of handle does not have (`read` or `call`), or a property it cannot assign
 * (`assign`), which names what it has instead.
 */
export function handleMemberMessage(
  kind: HandleKind,
  name: string,
  use: "read" | "assign" | "call",
): string {
  const contract: HandleContract = HANDLE_MEMBERS[kind];
  const noun = capitalized(contract.noun);
  const properties = Object.keys(contract.properties);
  if (use === "call") {
    const methods = Object.keys(contract.methods).map((method) => `${method}()`);
    const instead = [
      ...(methods.length === 0 ? [] : [`use ${orList(methods)}`]),
      ...(contract.instead === undefined ? [] : [contract.instead]),
    ].join(", or ");
    return `${noun}s have no method '${name}'.${instead === "" ? "" : ` ${capitalized(instead)}.`}`;
  }
  if (properties.length === 0) return `A ${contract.noun} has no property '${name}'.`;
  if (use === "read")
    return `${noun}s have no property '${name}'.${properties.length === 1 ? ` Use the ${properties[0]} property.` : ""}`;
  const assignable = properties.filter((property) => contract.properties[property]!.assign);
  return `${noun} property '${name}' cannot be assigned. You can assign ${orList(assignable)}.`;
}

/** The fix for a value of another type than a handle property without a domain takes, a duration or text. */
export function assignedTypeFix(type: "duration" | "string"): string {
  return type === "duration"
    ? " Use a duration, such as '10 s'."
    : " Convert it with toString(...) first.";
}

/**
 * That a value, described as `given`, is not of the type that the property `name` of a kind of handle takes without a
 * domain, a duration or text, assigned through `receiver` as written, such as `t`, or `null`. The compiler says it of
 * the place as of any other (`TSV041`), with this fix where it knows no better one.
 */
export function assignedTypeMessage(
  kind: HandleKind,
  name: string,
  given: string,
  receiver: string | null,
): string {
  const type = handleProperty(kind, name)?.assign?.type === "duration" ? "duration" : "string";
  return `'${receiver ?? "this object"}.${name}' holds ${type === "duration" ? "a duration" : "text (string)"}, so it cannot be set to ${given}.${assignedTypeFix(type)}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `a`, `a or b`, or `a, b, or c`. */
function orList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}
