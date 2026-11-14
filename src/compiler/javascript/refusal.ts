/** The generator met a plan form outside the set it admits so far. The plan is valid; this is not a defect of it. */
export class GenerationRefused extends Error {
  public constructor(
    /** `instruction:<kind>` or `expression:<kind>`, with `:<detail>` where a kind is admitted in part. */
    readonly form: string,
    /** Index in `plan.instructions` of the instruction that holds the form. */
    readonly instruction: number,
  ) {
    super(`JavaScript generation does not admit ${form} yet (instruction ${instruction})`);
    this.name = "GenerationRefused";
  }
}
