import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, ref, type Ref, type ShallowRef } from "vue";

import type { PhotoSwatches } from "../player/theme/node-vibrant/swatches.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

type Media = { readonly src: string; readonly alt: string };
// `stagePhotos.ts`'s preparation of a photo, which the test finishes itself.
interface PreparedPhoto {
  readonly shown: Promise<string>;
  readonly swatches: Promise<PhotoSwatches | null>;
  release(): void;
}
let useStagePhoto: (
  media: Readonly<Ref<Media | undefined>>,
  prepare: (source: string) => PreparedPhoto,
) => {
  shown: ShallowRef<{ readonly media: Media; readonly url: string } | null>;
  swatches: ShallowRef<PhotoSwatches | null>;
};

// Load the real Vue composable through the existing build tool, like the Player session host tests.
before(async () => {
  const module = await loadPlayerModule("player/vue/src/useStagePhoto.ts");
  assert.equal(typeof module.useStagePhoto, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export was checked callable just above.
  useStagePhoto = module.useStagePhoto as typeof useStagePhoto;
});

// Distinct swatches per photo; only their identity matters here.
function colours(): PhotoSwatches {
  const colour = { rgb: [60, 140, 60] as const, population: 1, share: 1 };
  return {
    Vibrant: colour,
    LightVibrant: null,
    DarkVibrant: null,
    Muted: null,
    LightMuted: null,
    DarkMuted: null,
  };
}

// A photo whose preparation the test finishes: `measured` when its swatches are known, `ready` when it can show.
interface Preparation {
  measured(swatches: PhotoSwatches | null): Promise<void>;
  ready(): Promise<void>;
  released: boolean;
}

// The Stage media, and what the Player shows of them: the photo's URL and the swatches it shows it with.
function setup(context: TestContext) {
  const media = ref<Media | undefined>(undefined);
  const preparations = new Map<string, Preparation>();
  const scope = effectScope();
  context.after(() => scope.stop());
  const { shown, swatches } = scope.run(() =>
    useStagePhoto(media, (source) => {
      let show!: (url: string) => void;
      let measure!: (swatches: PhotoSwatches | null) => void;
      const preparation: Preparation = {
        measured: async (result) => {
          measure(result);
          await settle();
        },
        ready: async () => {
          show(`blob:${source}`);
          await settle();
        },
        released: false,
      };
      preparations.set(source, preparation);
      return {
        shown: new Promise((resolve) => (show = resolve)),
        swatches: new Promise((resolve) => (measure = resolve)),
        release: () => (preparation.released = true),
      };
    }),
  )!;
  const show = async (src: string | undefined) => {
    media.value = src === undefined ? undefined : { src, alt: "" };
    await settle();
  };
  // Shows a photo with these swatches and finishes its preparation.
  const showPhoto = async (src: string, result: PhotoSwatches | null) => {
    await show(src);
    await preparations.get(src)!.measured(result);
    await preparations.get(src)!.ready();
  };
  return {
    show,
    showPhoto,
    preparation: (src: string) => preparations.get(src)!,
    state: () => [shown.value?.url ?? null, swatches.value],
  };
}

async function settle() {
  for (let i = 0; i < 3; i++) await nextTick();
}

test("the previous photo and its colour stay while the next photo is prepared, which then shows with its own", async (context) => {
  const { show, showPhoto, preparation, state } = setup(context);
  const forest = colours();
  const sea = colours();
  await show("a/forest.jpg");
  assert.deepEqual(state(), [null, null], "the first photo is prepared on the empty Stage");
  await preparation("a/forest.jpg").measured(forest);
  await preparation("a/forest.jpg").ready();
  assert.deepEqual(state(), ["blob:a/forest.jpg", forest]);
  await show("a/sea.jpg");
  await preparation("a/sea.jpg").measured(sea);
  assert.deepEqual(state(), ["blob:a/forest.jpg", forest]);
  assert.equal(
    preparation("a/forest.jpg").released,
    false,
    "the forest's download stays while it shows",
  );
  await preparation("a/sea.jpg").ready();
  assert.deepEqual(state(), ["blob:a/sea.jpg", sea]);
  assert.equal(preparation("a/forest.jpg").released, true, "the forest's download goes with it");
  await showPhoto("a/forest.jpg", forest);
  assert.deepEqual(state(), ["blob:a/forest.jpg", forest]);
});

test("a photo replaced before it is ready never shows, and a photo shown again keeps showing", async (context) => {
  const { show, showPhoto, preparation, state } = setup(context);
  const forest = colours();
  await showPhoto("b/forest.jpg", forest);
  await show("b/passing.jpg");
  await show("b/sea.jpg");
  assert.equal(preparation("b/passing.jpg").released, true, "the passing photo's download stops");
  await preparation("b/passing.jpg").measured(colours());
  await preparation("b/passing.jpg").ready();
  // Back to the photo the Stage shows: the sea is given up, and the forest stays as it is.
  await show("b/forest.jpg");
  assert.equal(preparation("b/sea.jpg").released, true);
  await preparation("b/sea.jpg").measured(colours());
  await preparation("b/sea.jpg").ready();
  assert.deepEqual(state(), ["blob:b/forest.jpg", forest]);
  assert.equal(preparation("b/forest.jpg").released, false);
});

test("an unreadable photo keeps the previous colour, and the empty Stage gives the theme's at once", async (context) => {
  const { show, showPhoto, preparation, state } = setup(context);
  const forest = colours();
  await showPhoto("c/forest.jpg", forest);
  // Its pixels cannot be read, as from another origin that does not share them.
  await showPhoto("https://cdn.example/c.jpg", null);
  assert.deepEqual(state(), ["blob:https://cdn.example/c.jpg", forest]);
  await show(undefined);
  assert.deepEqual(state(), [null, null]);
  assert.equal(preparation("https://cdn.example/c.jpg").released, true);
});
