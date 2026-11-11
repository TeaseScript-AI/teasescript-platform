import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * A module belongs to reka-ui when the nearest `package.json` with a `name` above its real path names `reka-ui`; that
 * manifest's folder is the package's root, and `dist/ScrollArea/ScrollAreaThumb.js` under it is its thumb. A build that
 * bundles a module of a reka-ui root patches that root's thumb, or fails naming the root; a build that bundles no
 * reka-ui module, as the development server's dependency scan, passes. It fails too when either patched line is not
 * found exactly once, so an upgrade cannot drop the patch silently. A copy whose manifest was renamed, or a fork
 * published under another name, is not reka-ui. Each build is judged alone, also when one plugin serves several (Vite's
 * dependency optimizer reuses it). Remove this plugin once reka-ui moves the thumb outside the scroll event and stops
 * the loop when scrolling settles.
 */
export function rekaScrollThumbPatch(): Plugin {
  /** Each reka-ui root the build bundles a module of, and whether its thumb was patched. */
  const roots = new Map<string, boolean>();
  /** The folder of the nearest named manifest at or above each folder looked up, and that name; `null` for none. */
  const owners = new Map<string, { root: string; name: string } | null>();
  function owner(folder: string): { root: string; name: string } | null {
    const known = owners.get(folder);
    if (known !== undefined) return known;
    const manifest = join(folder, "package.json");
    let found: { root: string; name: string } | null = null;
    // A manifest that is no JSON fails the build.
    const parsed: unknown = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8"))
      : null;
    const name =
      typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;
    if (typeof name === "string" && name !== "") found = { root: folder, name };
    else if (dirname(folder) !== folder) found = owner(dirname(folder));
    owners.set(folder, found);
    return found;
  }
  return {
    name: "reka-scroll-thumb-patch",
    buildStart() {
      roots.clear();
      owners.clear();
    },
    transform(code, id) {
      if (id.startsWith("\0")) return;
      const file = id.split("?")[0] ?? id;
      if (!existsSync(file)) return;
      const real = realpathSync(file);
      const found = owner(dirname(real));
      if (found?.name !== "reka-ui") return;
      if (!roots.has(found.root)) roots.set(found.root, false);
      if (real !== join(found.root, "dist/ScrollArea/ScrollAreaThumb.js")) return;
      let result = code;
      for (const [line, replacement] of PATCHES) {
        const matches = result.match(line);
        if (matches === null || matches.length !== 1)
          this.error(
            `reka-ui's ScrollAreaThumb changed; review reka-scroll-thumb-patch.ts (${line}).`,
          );
        result = result.replace(line, replacement);
      }
      roots.set(found.root, true);
      return { code: `${result}\n${SETTLING_SCROLL_LISTENER}`, map: null };
    },
    buildEnd(error) {
      if (error !== undefined) return;
      for (const [root, patched] of roots)
        if (!patched)
          this.error(
            `reka-ui at ${root} was bundled without its ScrollAreaThumb (dist/ScrollArea/ScrollAreaThumb.js) patched; review reka-scroll-thumb-patch.ts.`,
          );
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
