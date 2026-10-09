/**
 * The TeaseScript time model the output targets (#512). Model 1 is the one main implements now. Model 2 is the accepted
 * one main is building: `absoluteDateTime` instead of `timestamp`, an exact `day` and `week`, and `calendar` for calendar
 * steps. `TIME_MODEL=2`, or the converters' `--time-model 2`, selects it until main has it, when model 2 becomes the
 * default.
 */
export type TimeModel = 1 | 2;

export function timeModel(): TimeModel {
  return process.env.TIME_MODEL === "2" ? 2 : 1;
}

/** Selects the time model for this process and the conversions it starts, from a `--time-model` argument. */
export function selectTimeModel(value: string | undefined): void {
  if (value !== "1" && value !== "2") throw new Error(`--time-model takes 1 or 2, not ${value}`);
  process.env.TIME_MODEL = value;
}

// Model 2's names for the timestamp family.
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["getTimestamp", "getAbsoluteDateTime"],
  ["toTimestamp", "toAbsoluteDateTime"],
  ["timestamp", "absoluteDateTime"],
]);

/** A function, method, or type name of the timestamp family as the selected time model writes it. */
export function timeName(name: string): string {
  return timeModel() === 2 ? (RENAMED.get(name) ?? name) : name;
}
