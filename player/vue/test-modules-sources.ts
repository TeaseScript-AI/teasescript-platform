// The stamp of the Player test bundle's sources, `dist/player-test-modules/sources.json`, and the plugin that writes it.
// `tests/helpers/player-modules.ts` refuses a bundle whose stamp differs from the checkout's walk, so a compiled test
// cannot run against Player or engine code older than its own.
//
// The stamp covers the whole checkout, not the bundle's inputs: it names no input, so it cannot miss one in the
// checkout. Every entry is recorded by its path from the root with `/`, at any depth, apart from the root's own
// `BOOKKEEPING` and `OUTSIDE_THE_STAMP` entries:
// - a file by the SHA-256 of its content;
// - a symlink to a file by its target's identity (its path from the root, or its absolute path outside it) and that
//   content;
// - a symlink to a folder, a broken symlink, or an unreadable entry by what it is, which fails the build.
// The set of paths is part of the stamp, so an added, removed or renamed file is a change.
//
// It is a freshness check of the checkout's files, not a key of everything a build depends on. Not attested:
// - files outside the checkout, however they are reached (a link's target is stamped, not what a tool reads because of
//   it);
// - the root's excluded entries: `node_modules` beyond `package-lock.json`, which stands for the intended install and
//   not its bytes; `dist/`; the bookkeeping;
// - environment variables, Node's and the tools' versions, and another CLI or API mode or inline options than the
//   canonical `npm run build:player-test-modules`;
// - a change between configuration loading and the end of the build. The walk runs at `buildStart`, after Vite has
//   loaded the configuration and read the `.env` files, so the inputs must be stable from configuration loading through
//   the build. The loader checks before the first Player module each test process loads.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** The checkout's own bookkeeping in the root, of any kind, left out with its reasons: no build writes or reads it. */
const BOOKKEEPING = new Map([
  [".git", "the checkout's pointer to its repository, which differs between any two checkouts"],
  [
    ".sha",
    "the queue's tree marker: the commit the tree was made from, written after the tree is built",
  ],
  [".complete", "the queue's tree marker: the tree is complete, written after the tree is built"],
]);
/** The root folders, or links to folders, left out with their reasons. */
const OUTSIDE_THE_STAMP = new Map([
  [
    "node_modules",
    "the installed dependencies, for which the stamped `package-lock.json` stands (a folder, or the link `check-changed` makes in a worktree)",
  ],
  ["dist", "the build output, this bundle and its stamp among it"],
]);
/** What a stamp entry is when it is not a file the build can read; the build refuses these. */
const UNSTAMPABLE = /^(?:folder link|broken link|unreadable) /u;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const slashes = (path: string) => path.replaceAll("\\", "/");

/** The stamp entry of one path: its content's hash, a link's target and hash, or what keeps it from being read. */
function entry(root: string, path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return sha256(path);
    if (!existsSync(path))
      return `broken link ${slashes(resolve(dirname(path), readlinkSync(path)))}`;
    // A target in the checkout by its path from the root, one outside it by its absolute path: both stay as they are when
    // the checkout moves.
    const target = realpathSync(path);
    const inside = relative(root, target);
    const identity = slashes(
      isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) ? target : inside,
    );
    if (statSync(path).isDirectory()) return `folder link ${identity}`;
    return `link ${identity} ${sha256(path)}`;
  } catch {
    return `unreadable ${slashes(relative(root, path))}`;
  }
}

const folderOrLinkToOne = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** The stamp of the checkout at `checkout`: path from the root to entry, in path order. */
export function walkSources(checkout: string): Map<string, string> {
  // Link targets are named from the root's real path, as whichever path reached the checkout.
  const root = realpathSync(checkout);
  const stamp = new Map<string, string>();
  const walk = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (
        folder === root &&
        (BOOKKEEPING.has(item.name) ||
          (OUTSIDE_THE_STAMP.has(item.name) && folderOrLinkToOne(path)))
      )
        continue;
      if (item.isDirectory()) walk(path);
      else stamp.set(slashes(relative(root, path)), entry(root, path));
    }
  };
  walk(root);
  return new Map([...stamp].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The Vite plugin that stamps the checkout at the start of the build and writes `sources.json` with the bundle. */
export function testModulesSources(): Plugin {
  let config: ResolvedConfig;
  let stamp = new Map<string, string>();
  return {
    name: "test-modules-sources",
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      stamp = walkSources(config.root);
      for (const [path, value] of stamp)
        if (UNSTAMPABLE.test(value))
          this.error(`test-modules-sources: ${path} cannot be stamped (${value})`);
    },
    // Written by hand, as Vite emits no assets from a server-side build, and last, after any other stamping plugin.
    writeBundle: {
      order: "post",
      sequential: true,
      handler(options) {
        if (options.dir === undefined)
          this.error("test-modules-sources: the build has no output folder");
        writeFileSync(
          join(options.dir, "sources.json"),
          `${JSON.stringify(Object.fromEntries(stamp), null, 1)}\n`,
        );
      },
    },
  };
}
