import { editDistance } from "./form-fields.js";
import { PLAYER } from "./speaker-terms.js";

/**
 * The message for a read of a property that an object does not have, naming the properties it has: at runtime
 * (TSR017) those of the object read, at compile time all that its objects can have (#845). `label` is how the source
 * spells the object, or `null`.
 */
export function missingPropertyMessage(
  label: string | null,
  name: string,
  properties: readonly string[],
): string {
  const subject = label === null ? "This object" : `'${label}'`;
  if (properties.length === 0) return `${subject} has no properties, so it has no '${name}'.`;
  const listed =
    properties.length === 1
      ? `Its only property is ${nameList(properties)}`
      : `Its properties are ${nameList(properties)}`;
  return `${subject} has no property '${name}'. ${listed}.`;
}

/**
 * The message for a read of a custom property that no declaration or assignment gives a speaker (V30 §37): of the
 * speaker `speaker`, or of any declared speaker for `null`. `properties` are the custom properties it can have, and
 * `names` every property a misspelled name may be meant as; `example` is a speaker to declare the property in.
 */
export function missingSpeakerPropertyMessage(
  speaker: string | null,
  name: string,
  properties: readonly string[],
  names: readonly string[],
  example: string,
): string {
  const one = properties.length === 1;
  let found: string;
  if (speaker === null)
    found =
      properties.length === 0
        ? `Speakers have no custom properties, so none has '${name}'.`
        : `No speaker has a property '${name}'. The custom ${one ? "property of speakers is" : "properties of speakers are"} ${nameList(properties)}.`;
  else
    found =
      properties.length === 0
        ? `Speaker '${speaker}' has no custom properties, so it has no '${name}'.`
        : `Speaker '${speaker}' has no property '${name}'. Its ${one ? "only custom property is" : "custom properties are"} ${nameList(properties)}.`;
  return (
    found +
    (misspelledPropertyHint(name, names) ||
      (speaker === PLAYER
        ? ` Assign it before reading it, as in 'player.${name} = ...'.`
        : ` Give the property a start value, as in 'speaker ${example} { ${name}: ... }', or assign it before reading it.`))
  );
}

/**
 * The message for a read of a built-in field, term, or name list that no declaration or assignment gives a speaker
 * (V30 §37): of the speaker `speaker`, or of any declared speaker for `null`. `sources` are the fields of which the
 * speaker needs one, the field first; `example` is a speaker to declare it in.
 */
export function missingSpeakerFieldMessage(
  speaker: string | null,
  name: string,
  sources: readonly string[],
  example: string,
): string {
  const subject =
    speaker === null ? `No speaker has '${name}'` : `Speaker '${speaker}' has no '${name}'`;
  const whom = speaker === null ? "a speaker" : "it";
  const needed = sources.length === 1 ? "one" : alternatives(sources);
  // The player has no declaration: an assignment or a copy of the account gives it a field.
  if (speaker === PLAYER)
    return `${subject}: no assignment or copy of the account gives ${whom} ${needed}. Copy the account with 'player.copyFrom(account)', or assign ${sources.includes("gender") ? `'player.gender' or 'player.${name}'` : `'player.${name}'`} before reading it.`;
  const fix = sources.includes("gender")
    ? `Give ${whom} a gender, as in 'speaker ${example} { gender: "female" }', or assign '${speaker === null ? "" : `${speaker}.`}${name}' before reading it.`
    : `Give ${whom} a start value, as in 'speaker ${example} { ${name}: ... }', or assign it before reading it.`;
  return `${subject}: no declaration or assignment gives ${whom} ${needed}. ${fix}`;
}

/** Names in quotes as alternatives, as in `'a' or 'b'` and `'a', 'b', or 'c'`. */
function alternatives(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length <= 2
    ? quoted.join(" or ")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

/** Up to ten names in quotes, joined as in `'a', 'b', and 'c'`, with how many more there are. */
function nameList(names: readonly string[]): string {
  const quoted = names.slice(0, 10).map((name) => `'${name}'`);
  const more = names.length - quoted.length;
  if (more > 0) return `${quoted.join(", ")}, and ${more} more`;
  return quoted.length <= 2
    ? quoted.join(" and ")
    : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

/** The property or method of several that `name` likely misspells, as `name` for `nmae`, as a hint after the message. */
export function misspelledPropertyHint(name: string, properties: readonly string[]): string {
  if (properties.length < 2) return "";
  let nearest: string | undefined;
  let best = Math.min(3, name.length);
  for (const property of properties) {
    const distance = editDistance(name, property);
    if (distance < best) {
      nearest = property;
      best = distance;
    }
  }
  return nearest === undefined ? "" : ` Did you mean '${nearest}'?`;
}
