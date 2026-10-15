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

/**
 * What a speaker whose own properties `own` gives reads as its property `name`: its own value; else for `title` its
 * `shortTitle` and for `shortTitle` its `title`; else for a term the default of its gender (see {@link GENDER_TERMS});
 * else `undefined`.
 */
export function speakerPropertyValue<T>(
  own: (name: string) => T | undefined,
  name: string,
): T | string | undefined {
  const value = own(name);
  if (value !== undefined) return value;
  if (name === "title") return own("shortTitle");
  if (name === "shortTitle") return own("title");
  const term = GENDER_TERMS.get(name);
  if (term === undefined) return undefined;
  const gender = own("gender");
  return gender === "male" ? term[0] : gender === "female" ? term[1] : undefined;
}
