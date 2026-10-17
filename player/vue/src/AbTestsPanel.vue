<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { PHOTO_FAMILIES, type PhotoFamily } from "../../theme/photo-theme.js";
import type { PhotoFadeTime } from "./usePhotoColour";

// The A/B tests panel (PLAYER-UI "Player Settings"): the presentation variants the owner approved for comparison, so
// they can be flipped while watching the Player. A radio button takes either option in one click; a dropdown test's
// Next option steps to its following option and wraps around without opening the dropdown, and keeps focus, so Enter or
// Space steps again. The choices are browser-local Player preferences.
const titlebar = defineModel<"left" | "overlap">("titlebar", { required: true });
const photoAccent = defineModel<"photo" | "theme">("photoAccent", { required: true });
const photoFamily = defineModel<PhotoFamily>("photoFamily", { required: true });
/** The least share of the photo, in percent, that makes a Vibrant swatch large enough. */
const photoFamilyShare = defineModel<number>("photoFamilyShare", { required: true });
const photoFadeTime = defineModel<PhotoFadeTime>("photoFadeTime", { required: true });
const photoBlending = defineModel<"oklab" | "srgb">("photoBlending", { required: true });

const familyLabels: Readonly<Record<PhotoFamily, string>> = {
  vibrant: "A · Vibrant",
  muted: "B · Muted",
  "large-vibrant": "C · Vibrant if large enough, else Muted",
};
function next<T>(options: readonly T[], current: T): T {
  return options[(options.indexOf(current) + 1) % options.length]!;
}
// A share outside 0-100 % or no number at all leaves the stored one.
function setShare(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  if (value >= 0 && value <= 100) photoFamilyShare.value = value;
  else input.value = String(photoFamilyShare.value);
}
</script>

<template>
  <div class="grid gap-4 p-4 text-sm" data-ab-tests-panel>
    <p class="text-muted-foreground">
      Variants of the Player's look that are being compared. A choice applies at once and stays in this browser.
    </p>
    <fieldset class="grid gap-2 border-t pt-4" data-ab-test="titlebar">
      <legend class="font-medium">Title bar on short screens</legend>
      <label class="flex items-start gap-2">
        <input v-model="titlebar" type="radio" name="titlebar-option" value="left" />
        A · Always visible, controls left
      </label>
      <label class="flex items-start gap-2">
        <input v-model="titlebar" type="radio" name="titlebar-option" value="overlap" />
        B · Auto-hide, controls right
      </label>
    </fieldset>
    <fieldset class="grid gap-2 border-t pt-4" data-ab-test="photo-accent">
      <legend class="font-medium">Photo accent</legend>
      <label class="flex items-start gap-2">
        <input v-model="photoAccent" type="radio" name="photo-accent-option" value="photo" />
        A · Accent follows the photo
      </label>
      <label class="flex items-start gap-2">
        <input v-model="photoAccent" type="radio" name="photo-accent-option" value="theme" />
        B · Theme accent
      </label>
    </fieldset>
    <fieldset class="grid gap-2 border-t pt-4" data-ab-test="photo-family">
      <legend class="font-medium">Photo colour family</legend>
      <!-- A select is as wide as its longest option; min-w-0 keeps a long one within the panel. -->
      <select
        v-model="photoFamily"
        aria-label="Photo colour family"
        class="min-h-11 min-w-0 rounded-md border border-input bg-transparent px-3"
      >
        <option v-for="family in PHOTO_FAMILIES" :key="family" :value="family">
          {{ familyLabels[family] }}
        </option>
      </select>
      <label class="flex flex-wrap items-center gap-2">
        C counts as large enough from
        <input
          type="number"
          min="0"
          max="100"
          step="0.5"
          inputmode="decimal"
          :value="photoFamilyShare"
          class="min-h-11 w-20 rounded-md border border-input bg-transparent px-3"
          data-ab-test-share
          @change="setShare"
        />
        % of the photo
      </label>
      <p class="text-muted-foreground">Near-white and transparent pixels do not count.</p>
      <div>
        <Button
          variant="outline"
          size="sm"
          aria-label="Next option: Photo colour family"
          @click="photoFamily = next(PHOTO_FAMILIES, photoFamily)"
        >
          Next option
        </Button>
      </div>
    </fieldset>
    <fieldset class="grid gap-2 border-t pt-4" data-ab-test="photo-fade-time">
      <legend class="font-medium">Photo colour fade time</legend>
      <label class="flex items-start gap-2">
        <input v-model="photoFadeTime" type="radio" name="photo-fade-time-option" value="0.6s" />
        A · 0.6 s
      </label>
      <label class="flex items-start gap-2">
        <input v-model="photoFadeTime" type="radio" name="photo-fade-time-option" value="0.3s" />
        B · 0.3 s, like Milovana
      </label>
    </fieldset>
    <fieldset class="grid gap-2 border-t pt-4" data-ab-test="photo-blending">
      <legend class="font-medium">Photo colour blending</legend>
      <label class="flex items-start gap-2">
        <input v-model="photoBlending" type="radio" name="photo-blending-option" value="oklab" />
        A · Oklab
      </label>
      <label class="flex items-start gap-2">
        <input v-model="photoBlending" type="radio" name="photo-blending-option" value="srgb" />
        B · sRGB, like Milovana
      </label>
    </fieldset>
  </div>
</template>
