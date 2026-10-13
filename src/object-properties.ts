import { editDistance } from "./form-fields.js";

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
  const names = properties.slice(0, 10).map((property) => `'${property}'`);
  const more = properties.length - names.length;
  if (names.length === 0) return `${subject} has no properties, so it has no '${name}'.`;
  const listed =
    names.length === 1
      ? `Its only property is ${names[0]}`
      : `Its properties are ${more > 0 ? `${names.join(", ")}, and ${more} more` : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`}`;
  return `${subject} has no property '${name}'. ${listed}.`;
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
