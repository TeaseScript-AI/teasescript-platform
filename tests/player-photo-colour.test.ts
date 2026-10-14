import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, ref, type Ref, type ShallowRef } from "vue";

import type { PhotoSwatches } from "../player/theme/node-vibrant/swatches.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

let usePhotoSwatches: (
  source: Readonly<Ref<string | null>>,
  read: (source: string) => PhotoSwatches | null | undefined,
) => ShallowRef<PhotoSwatches | null>;

// Load the real Vue composable through the existing build tool, like the Player session host tests.
before(async () => {
  const module = await loadPlayerModule("player/vue/src/usePhotoSwatches.ts");
  assert.equal(typeof module.usePhotoSwatches, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export was checked callable just above.
  usePhotoSwatches = module.usePhotoSwatches as typeof usePhotoSwatches;
});

const SETTLE_MS = 200;
// Distinct swatches per photo; only their identity matters here.
function photo(): PhotoSwatches {
  const colour = { rgb: [60, 140, 60] as const, population: 1 };
  return {
    Vibrant: colour,
    LightVibrant: null,
    DarkVibrant: null,
    Muted: null,
    LightMuted: null,
    DarkMuted: null,
  };
}

// The Stage's photo source, what each source reads as, and the swatches the Player follows. Sources are unique per
// test, as measured swatches are kept per source for the page.
function setup(
  context: TestContext,
  readings: Readonly<Record<string, () => PhotoSwatches | null | undefined>>,
) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = ref<string | null>(null);
  const reads: string[] = [];
  const scope = effectScope();
  context.after(() => scope.stop());
  const swatches = scope.run(() =>
    usePhotoSwatches(source, (src) => {
      reads.push(src);
      return readings[src]!();
    }),
  )!;
  const show = async (src: string | null, wait = SETTLE_MS) => {
    source.value = src;
    await nextTick();
    context.mock.timers.tick(wait);
  };
  return { swatches, reads, show };
}

test("an unreadable or cross-origin photo keeps the previous photo's colour, and the empty Stage the theme's", async (context) => {
  const forest = photo();
  const { swatches, show } = setup(context, {
    "a/forest.jpg": () => forest,
    // Another origin that does not share the image: the canvas is unreadable and reading it throws.
    "https://cdn.example/b.jpg": () => {
      throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
    },
    "a/unreadable.jpg": () => null,
  });
  await show("a/forest.jpg");
  assert.equal(swatches.value, forest);
  await show("https://cdn.example/b.jpg");
  assert.equal(swatches.value, forest, "a cross-origin photo");
  await show("a/unreadable.jpg");
  assert.equal(swatches.value, forest, "an unreadable photo");
  await show(null);
  assert.equal(swatches.value, null, "the empty Stage");
});

test("the Player follows a photo once it settled, and measures each photo once", async (context) => {
  const first = photo();
  const second = photo();
  const { swatches, reads, show } = setup(context, {
    "c/first.jpg": () => first,
    "c/passing.jpg": () => photo(),
    "c/second.jpg": () => second,
    // The Stage shows another image by the time it is read.
    "c/replaced.jpg": () => undefined,
  });
  await show("c/first.jpg");
  // A photo the Stage replaces before it settled is never measured.
  await show("c/passing.jpg", SETTLE_MS - 1);
  await show("c/second.jpg");
  assert.equal(swatches.value, second);
  await show("c/first.jpg");
  assert.equal(swatches.value, first);
  assert.deepEqual(reads, ["c/first.jpg", "c/second.jpg"], "the first photo's swatches were kept");
  // A photo the Stage no longer shows when it is read keeps the colour, and is read again when it comes back.
  await show("c/replaced.jpg");
  assert.equal(swatches.value, first);
  await show("c/second.jpg");
  await show("c/replaced.jpg");
  assert.equal(swatches.value, second);
  assert.deepEqual(reads.slice(2), ["c/replaced.jpg", "c/replaced.jpg"]);
});
