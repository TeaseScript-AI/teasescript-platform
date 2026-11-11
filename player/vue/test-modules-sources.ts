// The stamp of the Player test bundle's sources, `dist/player-test-modules/sources.json`, and the plugin that writes it.
// `tests/helpers/player-modules.ts` refuses a bundle whose stamp differs from the checkout's walk, so a compiled test
// cannot run against Player or engine code older than its own.
//
// The stamp covers the whole checkout, not the bundle's inputs: it names no input, so it cannot miss one in the
// checkout. The walk admits exactly one thing, at any depth, apart from the root's own `BOOKKEEPING` and
// `OUTSIDE_THE_STAMP` entries: a regular file, or a link that resolves to one, under a unique key, with a name, a link
// text and a link identity that are valid UTF-8. Everything else is refused, by default, whatever it is, and a refusal
// fails the build. An admitted entry's stamp determines every byte that reading it returns: a file's content, and a
// link's own text, the target it resolves to and that target's content. It is `file <SHA-256 of the content>`, or
// `link <text> <identity> <SHA-256 of the target's content>` with the text and the identity (the target's path from the
// root, or its absolute path outside it) as JSON strings. It does not attest metadata (mode, times, ownership, link
// count): a build that reads those is not attested.
// A key is the names the walk read, joined with `/`, none rewritten. Names, link texts and link targets are read as bytes
// and decoded by the platform's strict UTF-8 decoder, which is one-to-one, and a name holds no `/`: so keys are unique,
// and identities are lossless, so two links share one only when they resolve to one target. The set of keys is part of
// the stamp, so an added, removed or renamed file is a change.
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
import { isAbsolute, join, relative, sep } from "node:path";
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
/** The platform's strict decoder: it refuses any byte sequence that is not UTF-8, and keeps a leading byte order mark. */
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** A name's or a path's bytes as text, or `undefined` when they are not valid UTF-8. */
function text(bytes: Buffer): string | undefined {
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** A path with `/` for the host's own separator, where that is another one; nothing else is rewritten. */
const posix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"));

/** One entry's outcome: an admitted stamp, or why it is refused. */
type Entry = { stamp: string } | { refused: string };

/** The outcome of one path that is not a folder: only a regular file or a link that resolves to one is admitted. */
function entry(root: string, path: string): Entry {
  try {
    const status = lstatSync(path);
    if (!status.isSymbolicLink())
      return status.isFile() ? { stamp: `file ${sha256(path)}` } : { refused: "a special file" };
    // The link's own text, in bytes: what reading the link returns.
    const own = text(readlinkSync(path, { encoding: "buffer" }));
    if (own === undefined) return { refused: "a link whose text is not valid UTF-8" };
    if (!existsSync(path)) return { refused: "a broken link" };
    // The target as the system resolves it, in bytes: a target whose path is not UTF-8 has no lossless identity.
    const target = text(realpathSync.native(path, { encoding: "buffer" }));
    if (target === undefined) return { refused: "a link whose target's path is not valid UTF-8" };
    // A target in the checkout by its path from the root, one outside it by its absolute path: both stay as they are when
    // the checkout moves.
    const inside = relative(root, target);
    const identity = posix(
      isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`) ? target : inside,
    );
    const resolved = statSync(path);
    if (resolved.isFile())
      return { stamp: `link ${JSON.stringify(own)} ${JSON.stringify(identity)} ${sha256(path)}` };
    return {
      refused: `a link to ${resolved.isDirectory() ? "a folder" : "a special file"}, ${identity}`,
    };
  } catch {
    return { refused: "unreadable" };
  }
}

const folderOrLinkToOne = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** The checkout at `checkout`: its stamp, key to admitted entry in key order, and every refused entry with its reason. */
export function walkSources(checkout: string): {
  stamp: Map<string, string>;
  refused: (readonly [string, string])[];
} {
  const stamp = new Map<string, string>();
  const refused: (readonly [string, string])[] = [];
  // Link targets are named from the root's real path, as whichever path reached the checkout.
  let root;
  try {
    root = text(realpathSync.native(checkout, { encoding: "buffer" }));
  } catch {
    return { stamp, refused: [[".", "unreadable"]] };
  }
  if (root === undefined)
    return { stamp, refused: [[".", "the checkout's path is not valid UTF-8"]] };
  const walk = (folder: string, key: string) => {
    let items;
    try {
      items = readdirSync(folder, { withFileTypes: true, encoding: "buffer" });
    } catch {
      refused.push([key, "unreadable"]);
      return;
    }
    for (const item of items) {
      const name = text(item.name);
      // A name that is not UTF-8 is shown decoded, which loses bytes; its bytes are in the reason.
      const itemKey = `${key === "" ? "" : `${key}/`}${name ?? item.name.toString()}`;
      if (name === undefined) {
        refused.push([
          itemKey,
          `a name that is not valid UTF-8, bytes ${item.name.toString("hex")}`,
        ]);
        continue;
      }
      const path = join(folder, name);
      if (
        key === "" &&
        (BOOKKEEPING.has(name) || (OUTSIDE_THE_STAMP.has(name) && folderOrLinkToOne(path)))
      )
        continue;
      if (item.isDirectory()) walk(path, itemKey);
      else {
        const outcome = entry(root, path);
        if ("stamp" in outcome) stamp.set(itemKey, outcome.stamp);
        else refused.push([itemKey, outcome.refused]);
      }
    }
  };
  walk(root, "");
  return { stamp: new Map([...stamp].sort(([a], [b]) => (a < b ? -1 : 1))), refused };
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
      const walked = walkSources(config.root);
      if (walked.refused.length > 0)
        this.error(
          `test-modules-sources: ${walked.refused.map(([key, reason]) => `${key} cannot be stamped (${reason})`).join("; ")}`,
        );
      stamp = walked.stamp;
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
