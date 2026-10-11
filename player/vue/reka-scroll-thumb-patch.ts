import type { Plugin } from "vite";

/**
 * Patches reka-ui 2.10.4's `ScrollAreaThumb` (`dist/ScrollArea/ScrollAreaThumb.js`) in two places:
 *
 * 1. Its viewport `scroll` handler moved the thumb at once, inside the scroll event, which Firefox reports as a
 *    scroll-linked effect ("This site appears to use a scroll-linked positioning effect"). The thumb now moves in the
 *    next animation frame instead.
 * 2. From the first scroll on, the handler's animation-frame loop polled the scroll position every frame until the thumb
 *    unmounted, so a page with a scroll area, such as the transcript, never went frame-idle. The loop now stops once the
 *    position has not changed for {@link SETTLED_FRAMES} frames, and the next scroll starts it again.
 *
 * The build fails when either patched line is not found exactly once, so an upgrade cannot drop the patch silently.
 * Remove this plugin once reka-ui moves the thumb outside the scroll event and stops the loop when scrolling settles.
 */
export function rekaScrollThumbPatch(): Plugin {
  let patched = false;
  return {
    name: "reka-scroll-thumb-patch",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/reka-ui/dist/ScrollArea/ScrollAreaThumb.js")) return;
      let result = code;
      for (const [line, replacement] of PATCHES) {
        const found = result.match(line);
        if (found === null || found.length !== 1)
          this.error(
            `reka-ui's ScrollAreaThumb changed; review reka-scroll-thumb-patch.ts (${line}).`,
          );
        result = result.replace(line, replacement);
      }
      patched = true;
      return { code: `${result}\n${SETTLING_SCROLL_LISTENER}`, map: null };
    },
    buildEnd(error) {
      if (error === undefined && !patched)
        this.error("reka-ui's ScrollAreaThumb was not patched; review reka-scroll-thumb-patch.ts.");
    },
  };
}

/** How many unchanged animation frames end the loop that follows scrolling. */
const SETTLED_FRAMES = 10;

const PATCHES: readonly (readonly [RegExp, string])[] = [
  [
    /const listener = addUnlinkedScrollListener\(viewport\.value, scrollbarContextVisible\.onThumbPositionChange\);/g,
    "const listener = settlingScrollListener(viewport.value, scrollbarContextVisible.onThumbPositionChange, () => { removeUnlinkedScrollListenerRef.value = void 0; });",
  ],
  // The loop's first frame moves the thumb instead.
  [
    /(removeUnlinkedScrollListenerRef\.value = listener;)\s*scrollbarContextVisible\.onThumbPositionChange\(\);/g,
    "$1",
  ],
];

// reka-ui's `addUnlinkedScrollListener`, which moves the thumb in its first frame and whenever the position changed, and
// ends after SETTLED_FRAMES unchanged frames, calling `settled`.
const SETTLING_SCROLL_LISTENER = `
function settlingScrollListener(node, handler, settled) {
	let previous = null;
	let unchanged = 0;
	let frame = window.requestAnimationFrame(function loop() {
		const position = { left: node.scrollLeft, top: node.scrollTop };
		if (previous === null || position.left !== previous.left || position.top !== previous.top) {
			unchanged = 0;
			handler();
		} else if (++unchanged >= ${SETTLED_FRAMES}) return settled();
		previous = position;
		frame = window.requestAnimationFrame(loop);
	});
	return () => window.cancelAnimationFrame(frame);
}
`;
