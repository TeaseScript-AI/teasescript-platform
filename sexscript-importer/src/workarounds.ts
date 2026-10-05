/**
 * Accepted TeaseScript that `main` does not implement yet. The importer replaces each with a workaround in implemented
 * TeaseScript, marked with a NOTE at every site, so that converted packages play natively (owner decision 2026-10-05).
 * Selecting one emits its accepted form instead, for when `main` implements it.
 */
export const ACCEPTED_FORMS = ["askBooleans", "showPopup", "openUrl", "chooseFile"] as const;

export type AcceptedForm = (typeof ACCEPTED_FORMS)[number];

/** Parses a comma-separated list of accepted forms; an empty value selects every one. */
export function parseAcceptedForms(value: string): Set<AcceptedForm> {
  if (value === "") return new Set(ACCEPTED_FORMS);
  const selected = new Set<AcceptedForm>();
  for (const name of value.split(",")) {
    const form = ACCEPTED_FORMS.find((candidate) => candidate === name.trim());
    if (form === undefined) {
      throw new Error(
        `Unknown accepted form "${name}"; expected one of ${ACCEPTED_FORMS.join(", ")}.`,
      );
    }
    selected.add(form);
  }
  return selected;
}

/** An image of the package: its path below `images/`, and the lower-case folder names that hold it. */
export interface MediaFile {
  path: string;
  tags: string[];
}
