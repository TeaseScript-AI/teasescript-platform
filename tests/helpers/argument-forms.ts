/*
 * The malformed arguments of a host op, generated from its declared argument forms (#1963 L3): each form's fields with
 * their value classes, required or optional. Every malformed argument has an id naming its form, field and value, so a
 * family can check that each one it generated also ran.
 */

import { product } from "./family-coverage.js";

/** The classes of argument values, each with values of other classes, which no op accepts for it. */
const WRONG_VALUES = {
  string: [1, null, true, {}, [], new Uint8Array([1])],
  bytes: ["text", null, 1, [1, 2], {}],
  nullableString: [1, true, {}, [], new Uint8Array([1])],
  integer: ["1", null, true, 1.5, {}, []],
  nullableInteger: ["1", true, 1.5, {}, []],
  boolean: ["true", null, 1, {}, []],
  // A recording selector: `current`, or a ticket.
  selector: ["other", null, 1, {}, { ticket: 1 }, { ticket: "r1", kind: "recording" }],
} as const satisfies Record<string, readonly unknown[]>;
export type ValueClass = keyof typeof WRONG_VALUES;
/** The values of each class a valid argument may hold; the first is the one a generated argument holds. */
export const VALID_VALUES: Readonly<Record<ValueClass, readonly [unknown, ...unknown[]]>> = {
  string: ["t1"],
  bytes: [new Uint8Array([1])],
  nullableString: ["t1", null],
  integer: [1],
  nullableInteger: [1, null],
  boolean: [true, false],
  selector: ["current", "none", { ticket: "r1" }],
};

/** One form of an op's arguments: its required fields, and any optional ones, with their value classes. */
export interface ArgumentForm {
  readonly required: Readonly<Record<string, ValueClass>>;
  readonly optional?: Readonly<Record<string, ValueClass>>;
}

/** A malformed argument, under the id that names what is wrong with it. */
export interface MalformedArgument {
  readonly id: string;
  readonly args: unknown;
}

/**
 * Every malformed argument `forms` give: no record; each form with a required field missing, an extra field, or a field
 * (required or optional) of another class; two forms' fields together. Each must be refused before the op runs.
 */
export function malformedArguments(forms: readonly ArgumentForm[]): MalformedArgument[] {
  const valid = (fields: Readonly<Record<string, ValueClass>>) =>
    Object.fromEntries(
      Object.entries(fields).map(([field, kind]) => [field, VALID_VALUES[kind][0]]),
    );
  const found: MalformedArgument[] = [
    { id: "null", args: null },
    { id: "a string", args: "t1" },
    { id: "a list", args: [] },
  ];
  forms.forEach((form, index) => {
    const name = `form ${index + 1}`;
    const whole = valid(form.required);
    found.push({ id: `${name} with an extra field`, args: { ...whole, extra: 1 } });
    for (const field of Object.keys(form.required)) {
      const { [field]: _left, ...without } = whole;
      found.push({ id: `${name} without ${field}`, args: without });
    }
    for (const [field, kind] of [
      ...Object.entries(form.required),
      ...Object.entries(form.optional ?? {}),
    ])
      WRONG_VALUES[kind].forEach((wrong, at) =>
        found.push({
          id: `${name} with ${field} as wrong ${kind} ${at + 1}`,
          args: { ...whole, [field]: wrong },
        }),
      );
    forms
      .slice(index + 1)
      .forEach((other, offset) =>
        found.push({
          id: `forms ${index + 1} and ${index + offset + 2} together`,
          args: { ...whole, ...valid(other.required) },
        }),
      );
  });
  return found;
}

/**
 * The ids every malformed argument of `forms` must have, derived from the forms' domains alone (`product`), not from
 * `malformedArguments`: a family checks the rows it ran against these, so an argument the generator leaves out fails.
 */
export function formObligations(forms: readonly ArgumentForm[]): string[] {
  const ids = ["null", "a string", "a list"];
  forms.forEach((form, index) => {
    const name = `form ${index + 1}`;
    ids.push(`${name} with an extra field`);
    for (const { field } of product({ field: Object.keys(form.required) }))
      ids.push(`${name} without ${field}`);
    const classes: Readonly<Record<string, ValueClass>> = { ...form.required, ...form.optional };
    for (const [field, kind] of Object.entries(classes))
      for (const { at } of product({
        at: WRONG_VALUES[kind].map((_value, position) => String(position + 1)),
      }))
        ids.push(`${name} with ${field} as wrong ${kind} ${at}`);
    for (let other = index + 1; other < forms.length; other += 1)
      ids.push(`forms ${index + 1} and ${other + 1} together`);
  });
  return ids;
}
