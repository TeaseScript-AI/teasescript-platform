import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

/** A field of the composer: its text, or the "Repeat password" field under a lock's password. */
export type ComposerField = "input" | "repeat";

/**
 * How the composer brings a field in line with a text written from outside (`Composer.vue`): it ends an input-method
 * composition under way in that field, and makes a text field and the Textarea's own copy show the text.
 */
type FieldWriter = (field: ComposerField, text: string) => void;

/** The composer's writable text and repeat, which only `Composer.vue` takes (`useComposerModel`). */
interface ComposerModel {
  readonly draft: Ref<string>;
  /** The "Repeat password" of a lock's password field, which, like its password, is never kept. */
  readonly repeated: Ref<string>;
  /** Attaches the mounted composer's field writer; the returned function detaches it. */
  attach(writer: FieldWriter): () => void;
}

const composerModel: InjectionKey<ComposerModel> = Symbol("composerModel");

/**
 * The owner of the composer's text and repeat, for the component that renders the composer. It gets them only to read,
 * through `text`, and writes them only through `writeField`: the composer ends a composition under way in that field
 * and shows the text, and the text is published at once, also an unchanged one. The composer takes the writable model
 * itself (`useComposerModel`), which the component providing it cannot inject.
 */
export function useComposerFields(): {
  text(field: ComposerField): string;
  writeField(field: ComposerField, text: string): void;
} {
  const draft = ref("");
  const repeated = ref("");
  let writer: FieldWriter | null = null;
  const model = (field: ComposerField) => (field === "repeat" ? repeated : draft);
  provide(composerModel, {
    draft,
    repeated,
    attach(next) {
      writer = next;
      return () => {
        if (writer === next) writer = null;
      };
    },
  });
  return {
    text: (field) => model(field).value,
    writeField(field, text) {
      writer?.(field, text);
      model(field).value = text;
    },
  };
}

/** The composer's writable model, for `Composer.vue` only, under a component that called `useComposerFields`. */
export function useComposerModel(): ComposerModel {
  const model = inject(composerModel, null);
  if (model === null)
    throw new Error("The composer needs useComposerFields in a component that renders it.");
  return model;
}
