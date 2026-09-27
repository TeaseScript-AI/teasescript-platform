import assert from "node:assert/strict";
import test from "node:test";
import { authoredColorToOklch, contrastRatio } from "../player/theme/color.js";
import { speakerAvatarColors } from "../player/vue/src/phase2c/speakerAvatar.js";

test("automatic avatar colours are distinct, stable, and readable", () => {
  const first = speakerAvatarColors("inherit", 0);
  const second = speakerAvatarColors("inherit", 1);
  assert.notDeepEqual(first, second);
  assert.deepEqual(first, speakerAvatarColors(undefined, 0));
  assert.deepEqual(first, speakerAvatarColors("inherit", 6));
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    const pair = speakerAvatarColors(undefined, ordinal);
    assert.ok(
      contrastRatio(authoredColorToOklch(pair.color), authoredColorToOklch(pair.background)) >= 4.5,
    );
  }
});

test("authored speaker colour overrides the automatic palette with a readable letter", () => {
  for (const authored of ["#c65b75", "#ffffff", "#000000", "#777777"]) {
    const first = speakerAvatarColors(authored, 0);
    const second = speakerAvatarColors(authored, 1);
    assert.deepEqual(first, second);
    assert.deepEqual(authoredColorToOklch(first.color), authoredColorToOklch(authored));
    assert.ok(
      contrastRatio(authoredColorToOklch(first.color), authoredColorToOklch(first.background)) >=
        4.5,
    );
  }
});
