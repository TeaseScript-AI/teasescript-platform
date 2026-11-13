import type { CapturedMediaAdmission } from "../../src/runtime/actions/capture.js";
import type { StoredFileKind } from "../../src/runtime/host-data/stored-files.js";
import { everyItem, exactly, isRecord } from "./argument-checks.js";

/*
 * How the Player's media store vouches for the references in an answer over the bridge. The engine asks
 * `CapturedMediaAdmission.holds(reference, kind)` only while it resolves an answer's payload, and only about the
 * references inside it. So the Player asks its store before it sends the answer, for every kind, and sends the kinds the
 * store holds each reference as; the host answers the engine's questions from that table.
 */

/** The kinds the store holds an answer's references as; a reference it does not hold has no entry. */
export type HeldMedia = readonly { readonly reference: string; readonly kind: StoredFileKind }[];

// Every kind is asked about: a kind missing here fails to compile.
const KIND_SET = { image: true, audio: true, video: true, file: true } satisfies Record<
  StoredFileKind,
  true
>;
// EVIDENCE: validation: the keys of a literal that `satisfies Record<StoredFileKind, true>`.
const KINDS = Object.keys(KIND_SET) as StoredFileKind[];

/** For each of `references`, every kind `store` holds it as. */
export function heldMedia(store: CapturedMediaAdmission, references: readonly string[]): HeldMedia {
  return references.flatMap((reference) =>
    KINDS.filter((kind) => store.holds(reference, kind)).map((kind) => ({ reference, kind })),
  );
}

/**
 * The admission the engine gets in the host: what is not in `held` is not held. It is indexed once, since the engine asks
 * once per reference of an answer, which may store many files.
 */
export function admissionOf(held: HeldMedia): CapturedMediaAdmission {
  const kinds = new Map<string, Set<StoredFileKind>>();
  for (const { reference, kind } of held) {
    const known = kinds.get(reference);
    if (known === undefined) kinds.set(reference, new Set([kind]));
    else known.add(kind);
  }
  return { holds: (reference, kind) => kinds.get(reference)?.has(kind) === true };
}

/** Whether `value` is a `HeldMedia` table: a plain array of `{ reference, kind }` with a known kind. */
export function isHeldMedia(value: unknown): value is HeldMedia {
  return everyItem(
    value,
    (entry) =>
      isRecord(entry) &&
      exactly(entry, ["reference", "kind"]) &&
      typeof entry.reference === "string" &&
      KINDS.some((kind) => kind === entry.kind),
  );
}
