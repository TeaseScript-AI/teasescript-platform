import { readonly, ref, type Ref } from "vue";

/** A field of the composer: its text, or the "Repeat password" field under a lock's password. */
export type ComposerField = "input" | "repeat";

/** What the composer offers for a text written into a field from outside (`Composer.vue`'s `writeField`). */
export interface ComposerFieldWriter {
  writeField(field: ComposerField, text: string): void;
}

/**
 * The composer's text and repeat, which the interaction can only read. A text from outside, such as a reset or a
 * prefill, goes through `writeField`: the composer ends an input-method composition in that field and publishes the text
 * at once, also an unchanged one, and a composer not mounted yet is written directly. `typed` takes the composer's own
 * updates, from its `v-model` and from `writeField`.
 */
export function useComposerFields(composer: Readonly<Ref<ComposerFieldWriter | null>>) {
  const draft = ref("");
  /** The "Repeat password" of a lock's password field, which, like its password, is never kept. */
  const repeated = ref("");
  const model = (field: ComposerField) => (field === "repeat" ? repeated : draft);
  return {
    draft: readonly(draft),
    repeated: readonly(repeated),
    writeField(field: ComposerField, text: string): void {
      if (composer.value) composer.value.writeField(field, text);
      else model(field).value = text;
    },
    typed(field: ComposerField, text: string): void {
      model(field).value = text;
    },
  };
}
