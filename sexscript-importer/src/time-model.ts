/**
 * The TeaseScript time model the output targets (#512, ADR 0026). Model 2 is main's: an exact `day` and `week`, and
 * `calendar` for calendar steps (#763), with `absoluteDateTime` (#759), which the converter always writes. Model 1,
 * `TIME_MODEL=1` or the converters' `--time-model 1`, writes the earlier day, month, and year steps, to compare with an
 * older build.
 */
export type TimeModel = 1 | 2;

export function timeModel(): TimeModel {
  return process.env.TIME_MODEL === "1" ? 1 : 2;
}

/** Selects the time model for this process and the conversions it starts, from a `--time-model` argument. */
export function selectTimeModel(value: string | undefined): void {
  if (value !== "1" && value !== "2") throw new Error(`--time-model takes 1 or 2, not ${value}`);
  process.env.TIME_MODEL = value;
}
