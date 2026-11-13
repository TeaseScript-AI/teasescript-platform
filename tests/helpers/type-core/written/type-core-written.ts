// Written type forms of V30 §13 for the written-type matrices: each form, its text, its levels and its checked type,
// the host values a run tries, and which of them fit.

import type { SerializableRuntimeValue } from "../../../../src/runtime/values/serializable-values.js";

/** A written type form of V30 §13: a type name, `T?`, `T | U`, or a list, set or dict of a form. */
export type Form =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "optional"; readonly of: Form }
  | { readonly kind: "union"; readonly members: readonly Form[] }
  | { readonly kind: "collection"; readonly collection: Collection; readonly of: Form };

export type Collection = "list" | "set" | "dict";

/** V30 §13's type names: the scalars, `null`, the unrestricted collections and `object`, the program-control names. */
export const SCALAR_NAMES = [
  "string",
  "boolean",
  "integer",
  "number",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
  "duration",
  "calendarDuration",
  "angle",
] as const;
export const UNRESTRICTED_NAMES = ["list", "set", "dict", "object"] as const;
export const CONTROL_NAMES = [
  "range",
  "speaker",
  "timer",
  "media",
  "messageHandle",
  "script",
  "regex",
] as const;

export const UNRESTRICTED: ReadonlySet<string> = new Set(UNRESTRICTED_NAMES);

export const name = (of: string): Form => ({ kind: "name", name: of });
export const optional = (of: Form): Form => ({ kind: "optional", of });
export const union = (...members: Form[]): Form => ({ kind: "union", members });
export const collection = (kind: Collection, of: Form): Form => ({
  kind: "collection",
  collection: kind,
  of,
});

/** The form as the source writes it. */
export function formText(form: Form): string {
  const grouped = (of: Form): string => (of.kind === "union" ? `(${formText(of)})` : formText(of));
  switch (form.kind) {
    case "name":
      return form.name;
    case "optional":
      return `${grouped(form.of)}?`;
    case "union":
      return form.members.map(formText).join(" | ");
    case "collection":
      return `${grouped(form.of)}${form.collection === "list" ? "[]" : ` ${form.collection}`}`;
  }
}

/** The members a level of a form holds: an optional's form and `null`, a union's members. */
export function members(form: Form): Form[] {
  if (form.kind === "optional") return [...members(form.of), name("null")];
  if (form.kind === "union") return form.members.flatMap(members);
  return [form];
}

/**
 * The kinds the form admits at each level of its element path, sorted, from its root down: a name its kind, a
 * collection its kind with its element's level below, an unrestricted collection's element `unknown` (every kind).
 */
export function levelsOf(form: Form): string[][] {
  const out: string[][] = [];
  let level: Form[] = [form];
  for (;;) {
    const kinds = new Set<string>();
    const below: Form[] = [];
    let open = false;
    for (const member of level.flatMap(members))
      if (member.kind === "name") {
        kinds.add(member.name);
        if (member.name !== "object" && UNRESTRICTED.has(member.name)) open = true;
      } else if (member.kind === "collection") {
        kinds.add(member.collection);
        below.push(member.of);
      }
    out.push([...kinds].sort());
    if (below.length === 0) {
      if (open) out.push(["unknown"]);
      return out;
    }
    level = below;
  }
}

/** The whole type the plan checks a store of the form against, as the tests print a `TypePlan`. */
export function checkedText(form: Form): string {
  switch (form.kind) {
    case "name":
      return form.name !== "object" && UNRESTRICTED.has(form.name)
        ? `${form.name}<any>`
        : form.name;
    case "optional":
      return `${checkedText(form.of)}|null`;
    case "union":
      return form.members.map(checkedText).join("|");
    case "collection":
      return `${form.collection}<${checkedText(form.of)}>`;
  }
}

/** A value of the form with `leaf` at its innermost element: a list's `[ ]`, a set's `set[ ]`, a dict's `dict{a: }`. */
export function valueOf(form: Form, leaf: string): string {
  switch (form.kind) {
    case "name":
      return leaf;
    case "optional":
      return valueOf(form.of, leaf);
    case "union":
      return valueOf(form.members[0]!, leaf);
    case "collection":
      return form.collection === "list"
        ? `[${valueOf(form.of, leaf)}]`
        : form.collection === "set"
          ? `set[${valueOf(form.of, leaf)}]`
          : `dict{a: ${valueOf(form.of, leaf)}}`;
  }
}

/** The kinds the innermost element `valueOf` places admits: a name's, an optional's with `null`, a union's. */
export function leafKinds(form: Form): string[] {
  switch (form.kind) {
    case "name":
      return [form.name];
    case "optional":
      return form.of.kind === "collection" ? leafKinds(form.of) : [...leafKinds(form.of), "null"];
    case "union":
      return form.members.flatMap(leafKinds);
    case "collection":
      return leafKinds(form.of);
  }
}

/** A literal of a form's innermost name, where V30 has one the slice reads. */
const LITERALS: Readonly<Record<string, string>> = {
  integer: "1",
  number: "1.5",
  string: '"a"',
  boolean: "true",
  null: "null",
  list: "[1]",
};

export function leafLiteral(form: Form): string | null {
  switch (form.kind) {
    case "name":
      return LITERALS[form.name] ?? null;
    case "optional":
      return leafLiteral(form.of);
    case "union":
      return leafLiteral(form.members[0]!);
    case "collection":
      return leafLiteral(form.of);
  }
}

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});

/** The host values every run tries: one of each scalar kind, and a list of whole numbers. */
export const HOST_VALUES: readonly SerializableRuntimeValue[] = [
  2,
  2.5,
  "text",
  true,
  null,
  list(1),
];

/**
 * A host value of each kind the host can give besides the scalars (a timer, media or message handle and a speaker
 * reference only the runtime makes, so no host value is one: rows of those kinds run forbidden values only).
 */
const KIND_SAMPLES: readonly SerializableRuntimeValue[] = [
  { kind: "date", year: 2026, month: 1, day: 2 },
  { kind: "time", hour: 1, minute: 2, second: 3, millisecond: 0 },
  { kind: "datetime", year: 2026, month: 1, day: 2, hour: 1, minute: 2, second: 3, millisecond: 0 },
  { kind: "absoluteDateTime", epochMilliseconds: 0 },
  { kind: "duration", milliseconds: 1_000 },
  { kind: "calendarDuration", months: 1, days: 2, milliseconds: 0 },
  { kind: "angle", degrees: 90 },
  { kind: "range", start: 0, end: 3, inclusive: false },
  { kind: "regex", source: "a", flags: "" },
  { kind: "script", path: "main.tease" },
  { kind: "set", items: [1] },
  { kind: "dict", entries: [{ key: "a", value: 1 }] },
  { kind: "object", properties: [{ name: "p", value: 1 }] },
];

/**
 * The values a run adds where none of `HOST_VALUES` fits every checked store (Astra's D2): each kind's value bare and in
 * lists nested to depth four (a `list[][][]`'s whole value), the first that fits.
 */
export const FITTING_POOL: readonly SerializableRuntimeValue[] = (() => {
  const out: SerializableRuntimeValue[] = [];
  for (const sample of [2, 2.5, "ok", true, null, ...KIND_SAMPLES]) {
    let value: SerializableRuntimeValue = sample;
    out.push(value);
    for (let depth = 1; depth <= 4; depth += 1) out.push((value = list(value)));
  }
  return out;
})();

/** The kinds a host value is: a whole number an `integer` and a `number`, a record its own kind. */
export function kindsOf(value: SerializableRuntimeValue): string[] {
  if (value === null) return ["null"];
  if (typeof value === "number")
    return Number.isInteger(value) ? ["integer", "number"] : ["number"];
  if (typeof value === "string") return ["string"];
  if (typeof value === "boolean") return ["boolean"];
  return [value.kind];
}

/** Whether a host value fits a form (V30 §13; the plan's check): each element of a list or set, each value of a dict. */
export function fits(form: Form, value: SerializableRuntimeValue): boolean {
  switch (form.kind) {
    case "name":
      return kindsOf(value).includes(form.name);
    case "optional":
      return value === null || fits(form.of, value);
    case "union":
      return form.members.some((member) => fits(member, value));
    case "collection":
      if (value === null || typeof value !== "object" || value.kind !== form.collection)
        return false;
      return value.kind === "dict"
        ? value.entries.every((entry) => fits(form.of, entry.value))
        : value.kind === "list" || value.kind === "set"
          ? value.items.every((item) => fits(form.of, item))
          : false;
  }
}

/** The form at `valueOf`'s leaf: a name's, an optional's (with its `null` where it wraps no collection), a union's. */
export function leafForm(form: Form): Form {
  switch (form.kind) {
    case "name":
      return form;
    case "optional":
      return form.of.kind === "collection" ? leafForm(form.of) : optional(leafForm(form.of));
    case "union":
      return union(...form.members.map(leafForm));
    case "collection":
      return leafForm(form.of);
  }
}

/** Whether the candidate route takes a written form: no set or dict element type and no written union (S10). */
export function inSlice(form: Form): boolean {
  switch (form.kind) {
    case "name":
      return true;
    case "optional":
      return inSlice(form.of);
    case "union":
      return false;
    case "collection":
      return form.collection === "list" && inSlice(form.of);
  }
}
/** A form's depth: its collections' nesting. */
export function depthOf(form: Form): number {
  switch (form.kind) {
    case "name":
      return 0;
    case "optional":
      return depthOf(form.of);
    case "union":
      return Math.max(...form.members.map(depthOf));
    case "collection":
      return 1 + depthOf(form.of);
  }
}
