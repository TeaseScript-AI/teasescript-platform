/**
 * The terms whose defaults a speaker's `gender` gives (V30 §37, "Gender defaults and overrides", "Anatomical and arousal
 * terms", and "Dynamic action terms"): for each, its `"male"` and its `"female"` default. Another gender gives none.
 */
export const GENDER_TERMS: ReadonlyMap<string, readonly [male: string, female: string]> = new Map([
  ["maleFemale", ["male", "female"]],
  ["manWoman", ["man", "woman"]],
  ["boyGirl", ["boy", "girl"]],
  ["heShe", ["he", "she"]],
  ["himHer", ["him", "her"]],
  ["hisHer", ["his", "her"]],
  ["himselfHerself", ["himself", "herself"]],
  ["penisVagina", ["penis", "vagina"]],
  ["cockPussy", ["cock", "pussy"]],
  ["penisClitoris", ["penis", "clitoris"]],
  ["cockClit", ["cock", "clit"]],
  ["glansClitoris", ["glans", "clitoris"]],
  ["ballsLabia", ["balls", "labia"]],
  ["scrotumVulva", ["scrotum", "vulva"]],
  ["foreskinClitoralHood", ["foreskin", "clitoral hood"]],
  ["chestBreasts", ["chest", "breasts"]],
  ["nippleBreast", ["nipple", "breast"]],
  ["hardWet", ["hard", "wet"]],
  ["strokeRub", ["stroke", "rub"]],
  ["strokingRubbing", ["stroking", "rubbing"]],
  ["wankRub", ["wank", "rub"]],
  ["wankingRubbing", ["wanking", "rubbing"]],
  ["strokedRubbed", ["stroked", "rubbed"]],
  ["wankedRubbed", ["wanked", "rubbed"]],
  ["strokerMasturbator", ["stroker", "masturbator"]],
]);

/** The random name lists of a speaker (V30 §37, "Name lists"). */
export const SPEAKER_NAME_LISTS: ReadonlySet<string> = new Set([
  "petNames",
  "degradingNames",
  "lovingNames",
]);

/** The name of the built-in speaker for the person playing the tease (V30 §37). */
export const PLAYER = "player";

/**
 * The person fields of a speaker and of the player profile: the name fields, `alias`, `gender`, the terms of
 * {@link GENDER_TERMS}, and the name lists. `player.copyFrom(playerProfile)` copies them; the profile has no others.
 */
export const PERSON_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "shortTitle",
  "firstName",
  "lastName",
  "displayName",
  "alias",
  "gender",
  ...GENDER_TERMS.keys(),
  ...SPEAKER_NAME_LISTS,
]);

/**
 * What a speaker whose own properties `own` gives reads as its property `name`: its own value; else for `title` its
 * `shortTitle` and for `shortTitle` its `title`; else for `displayName` the name that `displayName` gives (see
 * {@link displayNameParts}); else for a term the default of its gender (see {@link GENDER_TERMS}); else `undefined`.
 */
export function speakerPropertyValue<T>(
  own: (name: string) => T | undefined,
  name: string,
  displayName: () => string | undefined,
): T | string | undefined {
  const value = own(name);
  if (value !== undefined) return value;
  if (name === "title") return own("shortTitle");
  if (name === "shortTitle") return own("title");
  if (name === "displayName") return displayName();
  const term = GENDER_TERMS.get(name);
  if (term === undefined) return undefined;
  const gender = own("gender");
  return gender === "male" ? term[0] : gender === "female" ? term[1] : undefined;
}

/** The fields that give a speaker without a `displayName` of its own the one it reads (V30 §37). */
const DISPLAY_NAME_FIELDS: readonly string[] = ["title", "shortTitle", "firstName", "lastName"];

/**
 * The parts of the `displayName` that a speaker without one of its own reads and shows (V30 §37), when `has` tells which
 * properties it has of its own: the non-empty texts of its `title`, else its `shortTitle`, its `firstName`, and its
 * `lastName`, in that order, each as `text` shows the field it names, or `null` for one it lacks or that shows nothing.
 * Joined by spaces they are the name. `undefined` when it has none of these fields.
 */
export function displayNameParts(
  has: (name: string) => boolean,
  text: (name: string) => string | null,
): string[] | undefined {
  if (!DISPLAY_NAME_FIELDS.some(has)) return undefined;
  return [text("title") ?? text("shortTitle"), text("firstName"), text("lastName")].filter(
    (part): part is string => part !== null && part.length > 0,
  );
}

/**
 * The properties that a speaker reads its property `name` from, when `has` tells which properties it has of its own:
 * `name` itself, or the ones {@link speakerPropertyValue} falls back to.
 */
export function speakerPropertySources(has: (name: string) => boolean, name: string): string[] {
  if (has(name)) return [name];
  if (name === "title" && has("shortTitle")) return ["shortTitle"];
  if (name === "shortTitle" && has("title")) return ["title"];
  if (name === "displayName" && DISPLAY_NAME_FIELDS.some(has))
    return [...speakerPropertySources(has, "title"), "firstName", "lastName"].filter(has);
  return [GENDER_TERMS.has(name) ? "gender" : name];
}

/**
 * The properties other than `name` that a speaker reads through `name` (see {@link speakerPropertySources}), whose
 * values a store into `name` may therefore change too: the terms it lacks for `gender`, the other title, and a
 * `displayName` it lacks for a field that gives one.
 */
export function propertiesReadThrough(has: (name: string) => boolean, name: string): string[] {
  if (name === "gender") return [...GENDER_TERMS.keys()].filter((term) => !has(term));
  const through: string[] = [];
  if (name === "title" && !has("shortTitle")) through.push("shortTitle");
  if (name === "shortTitle" && !has("title")) through.push("title");
  if (DISPLAY_NAME_FIELDS.includes(name) && !has("displayName")) through.push("displayName");
  return through;
}
