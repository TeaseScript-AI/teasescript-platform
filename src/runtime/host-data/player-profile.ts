import { PERSON_FIELDS, SPEAKER_NAME_LISTS, speakerPropertyValue } from "../../speaker-terms.js";
import type { SerializableRuntimeList } from "../values/serializable-values.js";
import { isPlainRecord } from "../values/plain-data.js";

/**
 * A person field of the player profile (V30 §37): text, or for a name list a list of at least one text. The player
 * profile holds only the fields the host gave, in the order of `PERSON_FIELDS`.
 */
export interface RuntimePlayerProfileFieldSnapshot {
  readonly name: string;
  readonly value: string | SerializableRuntimeList;
}

/**
 * The person fields that the host gives a session at its start, as `FreshRuntimeOptions.playerProfile` takes them: each
 * field by its name, as text, or for a name list as a list of texts.
 */
export type RuntimePlayerProfileInput = Readonly<Record<string, string | readonly string[]>>;

/**
 * The player profile fields of `input`, checked: `undefined` gives a player profile without fields. Throws a
 * `TypeError` that names the first field the host gave wrongly.
 */
export function playerProfileFromInput(input: unknown): RuntimePlayerProfileFieldSnapshot[] {
  if (input === undefined) return [];
  if (!isPlainRecord(input))
    throw new TypeError("playerProfile must be an object of person fields.");
  for (const name of Object.keys(input))
    if (!PERSON_FIELDS.has(name))
      throw new TypeError(`playerProfile.${name} is not a person field.`);
  const fields: RuntimePlayerProfileFieldSnapshot[] = [];
  for (const name of PERSON_FIELDS) {
    const value = input[name];
    if (value === undefined) continue;
    if (SPEAKER_NAME_LISTS.has(name)) {
      const names = Array.isArray(value) ? value.filter(isText) : [];
      if (names.length === 0 || names.length !== (Array.isArray(value) ? value.length : 0))
        throw new TypeError(`playerProfile.${name} must be a list of at least one text.`);
      fields.push({ name, value: { kind: "list", items: names } });
    } else if (typeof value === "string") fields.push({ name, value });
    else throw new TypeError(`playerProfile.${name} must be text.`);
  }
  return fields;
}

/** Why a snapshot's `playerProfile` is not one that {@link playerProfileFromInput} gives, or `null` when it is one. */
export function playerProfileProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "Runtime player profile must be a list of person fields.";
  const order = [...PERSON_FIELDS];
  let previous = -1;
  for (const field of value) {
    if (!isPlainRecord(field) || Object.keys(field).length !== 2 || typeof field.name !== "string")
      return "Runtime player profile field is malformed.";
    const position = order.indexOf(field.name);
    if (position <= previous)
      return "Runtime player profile must hold person fields, each once, in their order.";
    previous = position;
    const list = field.value;
    const valid = SPEAKER_NAME_LISTS.has(field.name)
      ? isPlainRecord(list) &&
        Object.keys(list).length === 2 &&
        list.kind === "list" &&
        Array.isArray(list.items) &&
        list.items.length > 0 &&
        list.items.every(isText)
      : isText(list);
    if (!valid)
      return `Runtime player profile field '${field.name}' has a value of the wrong kind.`;
  }
  return null;
}

export function clonePlayerProfile(
  playerProfile: readonly RuntimePlayerProfileFieldSnapshot[],
): RuntimePlayerProfileFieldSnapshot[] {
  return playerProfile.map(({ name, value }) => ({
    name,
    value: typeof value === "string" ? value : { kind: "list", items: [...value.items] },
  }));
}

/**
 * What the player profile reads as its field `name`, as a speaker reads its own (see `speakerPropertyValue`), or
 * `undefined` when it lacks the field.
 */
export function playerProfileFieldValue(
  playerProfile: readonly RuntimePlayerProfileFieldSnapshot[],
  name: string,
): string | SerializableRuntimeList | undefined {
  return speakerPropertyValue(
    (own) => playerProfile.find((field) => field.name === own)?.value,
    name,
  );
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}
