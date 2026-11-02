// node tests/families/baselines.mjs state <tree> <folder> [--read-only]
// node tests/families/baselines.mjs start <baseline> <current src tree>
// node tests/families/baselines.mjs queue <baseline> <script>
// node tests/families/baselines.mjs seed|compiled <tree> <folder>
// node tests/families/baselines.mjs import <central folder> <computed folder> [<area> <i>/<N> [<stalls.json>]]
// node tests/families/baselines.mjs status <central folder> <src tree>
// node tests/families/baselines.mjs alone <area folder> <shard> <new area folder>
// node tests/families/baselines.mjs stalls <shard> <alone shard or -> <area> <i>/<N> <stalls.json>
// The corpus runner's stored baselines (#1541): every read and write of <folder>/<src tree>/ is here. A baseline holds
// the runs of the trees of one `src/` tree (`git rev-parse <commit>:src`) whose runs depend on the same inputs beside it:
// the oracle library as built (`dist/tests/helpers/type-core-oracles.js` and the helpers it imports), the lockfile and
// Node. Its folder (absent, or empty: a sandbox makes it before the store runs, #1542) is this tool's only once this
// tool wrote its MANIFEST into it while it held nothing else. The MANIFEST names the src tree and those inputs, which
// every writer must share, then, appended and never rewritten, each commit stored there and each area with its PLAN's
// hash, recorded before the area is made. This tool knows each path it writes: the MANIFEST, the hook's markers and
// copy, and in each recorded area its PLAN and its planned shards' files and claims, with their temporary files. Any
// other path is foreign. A store writes nothing outside its baseline's folder (and its own `--out`), so that it runs
// with only that folder writable (`sx-sandbox`, tools/corpus/baseline.sh).
//
// Nothing is written into a baseline but the MANIFEST at its making and then through `gate`: the folder must be this
// tool's (its MANIFEST's first line, read before anything else), the gate holds the baseline's lock (`flock` on a
// descriptor of its folder) and checks that no foreign path is there, then writes. A folder holding a foreign path is
// not written into (the writer is refused, exit 2, naming the path). The gate removes the temporary files a writer
// that ended (killed) left. An area's PLAN, made by its first writer, binds its run: each shard's sources in their
// order, each generator's checks, the allowances and limits; a writer that would run another is refused ("another
// plan"). A recorded area not made yet, or made without its PLAN or with another one, is the next writer's to
// finish. One running writer at
// a time stores a shard (its claim) and publishes it whole: a new shard by a hard link, so the first stays, one that
// does not count by a rename over it.
//
// One rule says whether a stored shard counts (`shardIn`), and status, the store (which skips a shard that counts and
// replaces one that does not) and the comparison (`storedRuns`, `run.mjs --baseline`) all read shards through it: its
// last line, its total, names its own baseline's inputs (its MANIFEST's src tree, oracle library, lockfile and Node),
// the area's PLAN and the shard's planned sources, which are its lines in their order, and hashes every line before it.
// A shard that would count but names other inputs than its MANIFEST makes its baseline hold runs of other inputs, which
// status and the comparison refuse (exit 2), naming it; a store of that shard replaces it.
//
// `state` prints each area of a built tree (the folders of tests/families/ with generators, and tools/corpus/fixture/)
// as one JSON line: `complete`, `another plan` (its PLAN is not the tree's), `storing` (a running writer's claim),
// `damaged` (a stored shard that does not count), `partial` or `absent`, with the shards to store; then a line for the
// baseline. It makes or joins the baseline and appends the tree's commit, unless `--read-only`, and plans an area that is
// already complete again only with `--read-only`. It exits 0 when every area is complete, 1 when one is not, 2 when the
// folder is not this tool's, holds a foreign path or holds the runs of other inputs (than the tree's, or than its own
// MANIFEST names). `start` is a fill job's first decision (`tools/corpus/baseline.sh`): STARTED where the baseline is
// the current tree's or the fill began, else SUPERSEDED (the current tree). `queue` copies the hook's script into the
// baseline for its jobs and undoes SUPERSEDED. A fill on any worker into a central store (#1590): `seed` makes a
// baseline of a tree with every area planned and no shard, `compiled` names a tree's build in a baseline, `import`
// writes into a central store (a seed's MANIFEST and PLANs, or a shard computed from it, compared where one is there),
// `status` reads a central baseline without a tree, `alone` and `stalls` judge a computed shard's stalls. Nothing here
// removes a baseline.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatorsOf, placeOf } from "./sources.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** The runner's defaults, at which a baseline is stored: 180 s (60 s in CI), 2,048 MB, the three allowances. */
export const DEFAULTS = {
  timeout: process.env.CI === "true" ? 60 : 180,
  memory: 2048,
  allowances: "natural,16,256",
};

/** A git object's id, as `git hash-object` gives a blob's. */
const gitId = (type, body) =>
  createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest();

/**
 * A folder's git tree id, as a commit holds it (`git rev-parse <commit>:src` for a tree's `src/`): its files, executables
 * and links by their content, in git's order (a folder's name sorts as if it ended in `/`), empty folders left out;
 * `null` for a folder with no file.
 */
function treeId(folder) {
  const entries = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const id = treeId(file);
      if (id !== null)
        entries.push({ order: `${entry.name}/`, mode: "40000", name: entry.name, id });
    } else {
      const link = entry.isSymbolicLink();
      const mode = link ? "120000" : statSync(file).mode & 0o100 ? "100755" : "100644";
      const body = link ? Buffer.from(readlinkSync(file)) : readFileSync(file);
      entries.push({ order: entry.name, mode, name: entry.name, id: gitId("blob", body) });
    }
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.order), Buffer.from(b.order)));
  const body = entries.flatMap(({ mode, name, id }) => [Buffer.from(`${mode} ${name}\0`), id]);
  return gitId("tree", Buffer.concat(body));
}

/** A file's git blob id, or `none`. */
const blobId = (file) =>
  existsSync(file) ? gitId("blob", readFileSync(file)).toString("hex") : "none";

/**
 * The oracle library's id: each file of it the runs load (`type-core-oracles.js` and, through `./*.js` imports, the
 * files of its folder those name) by its blob id; `none` where the tree has none.
 */
function oraclesId(helpers) {
  const seen = new Map();
  const pending = ["type-core-oracles.js"];
  while (pending.length > 0) {
    const name = pending.pop();
    const file = path.join(helpers, name);
    if (seen.has(name) || !existsSync(file)) continue;
    seen.set(name, blobId(file));
    for (const [, imported] of readFileSync(file, "utf8").matchAll(/from\s+"\.\/([^"/]+\.js)"/g))
      pending.push(imported);
  }
  if (seen.size === 0) return "none";
  return hash(
    [...seen]
      .sort()
      .map(([name, id]) => `${name} ${id}\n`)
      .join(""),
  );
}

/** A built tree's `dist/`: the checkout's, or the tree itself where it is a `dist/` (the runner loads from it). */
export const distOf = (root) =>
  existsSync(path.join(root, "dist", "tests")) ? path.join(root, "dist") : root;

/**
 * A tree as a comparison of the runner names it (#1564): what the runner executes, read from the build it loads
 * (`distOf`, resolved once), the compiled compiler (`compiled`, its `src/` folder's tree) and the oracle library
 * (`oracles`), for a checkout, its `dist/` and a tree without sources alike; and its `identityOf` (`identity`), by which
 * it is matched against a stored base's MANIFEST.
 */
export function comparedOf(root) {
  const dist = distOf(root);
  const compiled = path.join(dist, "src");
  return {
    compiled: existsSync(compiled) ? (treeId(compiled)?.toString("hex") ?? null) : null,
    oracles: oraclesId(path.join(dist, "tests", "helpers")),
    identity: identityOf(root),
  };
}

/** What a tree's stored runs depend on: its `src/` tree, its oracle library, its lockfile and this Node. */
export function identityOf(tree) {
  return {
    src: existsSync(path.join(tree, "src"))
      ? (treeId(path.join(tree, "src"))?.toString("hex") ?? null)
      : null,
    oracles: oraclesId(path.join(tree, "dist", "tests", "helpers")),
    lock: blobId(path.join(tree, "package-lock.json")),
    node: process.version,
  };
}

/**
 * What a baseline's runs depend on, as its MANIFEST's header (`text`) names it, where that header is exactly one
 * `headerOf` (below) renders (its five lines, in order, nothing else in them); else undefined. The gate and the
 * comparison (`storedRuns`) accept a MANIFEST only so (#1542 r6).
 */
function identityIn(text) {
  const parts = /^baseline 3\nsrc (\S+)\noracles (\S+)\nlock (\S+)\nnode (\S+)\n/.exec(text);
  if (parts === null) return undefined;
  const identity = { src: parts[1], oracles: parts[2], lock: parts[3], node: parts[4] };
  return isBaselineName(identity.src) && text.startsWith(headerOf(identity)) ? identity : undefined;
}

const headerOf = ({ src, oracles, lock, node }) =>
  `baseline 3\nsrc ${src}\noracles ${oracles}\nlock ${lock}\nnode ${node}\n`;

/** A process's start time (Linux's `/proc`), which with its pid names one process for good; none once it ended. */
function startOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

// The names this tool gives what it writes. A name counts as one of these only where rendering what it parses back
// through the same producer gives that name exactly, so that no other spelling (`00of1`, a writer with a leading zero)
// passes for one of this tool's.
const writerName = (pid, start) => `${pid}-${start}`;
const shardName = (shard, shards) => `${shard}of${shards}.runs.jsonl`;
const claimName = (shard, shards) => `.${shard}of${shards}.claim`;
const temporaryName = (name, writer) => `${name}.${writer}.tmp`;

/** This process, as its claims and temporary files and folders name it (`<pid>-<start time>`). */
export const WRITER = writerName(process.pid, startOf(process.pid));

/** `text` where it is a writer's name as this tool renders one, else undefined. */
function writerOf(text) {
  const parts = /^(\d+)-(\d+)$/.exec(text);
  return parts !== null && writerName(BigInt(parts[1]), BigInt(parts[2])) === text
    ? text
    : undefined;
}

/** A baseline's name, its `src/` tree's id as `identityOf` renders it. */
const isBaselineName = (name) =>
  /^[0-9a-f]{40}$/.test(name) && Buffer.from(name, "hex").toString("hex") === name;

/** What a temporary file of this tool's (`<name>.<writer>.tmp`) is named for and who wrote it, else undefined. */
function temporaryOf(name) {
  const parts = /^(.+)\.(\d+-\d+)\.tmp$/.exec(name);
  const writer = parts === null ? undefined : writerOf(parts[2]);
  return writer !== undefined && temporaryName(parts[1], writer) === name
    ? { name: parts[1], writer }
    : undefined;
}

/** Whether a writer (`<pid>-<start time>`) still runs. */
const running = (writer) => {
  const named = writerOf(writer.trim());
  if (named === undefined) return false;
  const [pid, start] = named.split("-");
  return startOf(Number(pid)) === start;
};

/** Whether a folder carries this tool's MANIFEST (its first line), read without writing anything into the folder. */
export function isOwned(dir) {
  let fd;
  try {
    fd = openSync(path.join(dir, "MANIFEST"), "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(11);
    return head.subarray(0, readSync(fd, head, 0, 11, 0)).toString() === "baseline 3\n";
  } finally {
    closeSync(fd);
  }
}

/** Whether this tool writes `name` at a baseline's top: its MANIFEST, the hook's markers and copy, their temporary files. */
const isTopFile = (name) =>
  ["MANIFEST", "STARTED", "SUPERSEDED", "baseline.sh"].includes(temporaryOf(name)?.name ?? name);

/** Whether this tool writes `name` in an area of `shards` shards: its PLAN, each shard's file and claim, their temporary files. */
function isAreaFile(name, shards) {
  const own = temporaryOf(name)?.name ?? name;
  if (own === "PLAN") return true;
  const parts = /^\.?(\d+)of(\d+)\.(?:runs\.jsonl|claim)$/.exec(own);
  if (parts === null) return false;
  const [shard, count] = [Number(parts[1]), Number(parts[2])];
  return (
    count === shards &&
    shard < shards &&
    [shardName(shard, count), claimName(shard, count)].includes(own)
  );
}

/** The areas a MANIFEST records, each with its count of shards and its PLAN's hash. */
const recorded = (text) =>
  new Map(
    [...text.matchAll(/^area (\S+) (\d+) ([0-9a-f]{64})$/gm)].map(([, name, shards, plan]) => [
      name,
      { shards: Number(shards), plan },
    ]),
  );

/** The paths of a baseline (`dir`, its MANIFEST's `text`) this tool did not write (see above), each relative to it. */
function foreignIn(dir, text) {
  const areas = recorded(text);
  const foreign = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && areas.has(entry.name)) {
      for (const inner of readdirSync(path.join(dir, entry.name), { withFileTypes: true }))
        if (!inner.isFile() || !isAreaFile(inner.name, areas.get(entry.name).shards))
          foreign.push(`${entry.name}/${inner.name}${inner.isDirectory() ? "/" : ""}`);
    } else if (!entry.isFile() || !isTopFile(entry.name))
      foreign.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }
  return foreign.sort();
}

/** What `gate` returns where the baseline's folder was gone or replaced once this process held its lock. */
const RETIRED = Symbol("replaced");

/**
 * `action(text)`, given the MANIFEST's text: the one way anything is written into a baseline (`dir`). The folder must be
 * this tool's; the action runs while this process holds the baseline's lock (`flock` on a descriptor of the folder,
 * opened for reading, never created: a folder gone by then fails to open; held by a child that ends with this process)
 * and only where the folder holds no foreign path (else `refused`, naming the paths); `RETIRED` where the folder was
 * gone or replaced once the lock was held.
 */
async function gate(baseline, action) {
  const dir = pathOf(baseline, "baseline");
  if (!isOwned(dir))
    return { refused: `${dir} is not this tool's: it has no MANIFEST of this tool` };
  let before;
  try {
    before = statSync(dir).ino;
  } catch {
    return RETIRED;
  }
  // (a baseline path stands for the folder it was issued for, never another one found at its path later)
  const issued = checked.get(baseline).ino;
  if (issued !== undefined && issued !== before) return RETIRED;
  const holder = spawn(
    "bash",
    ["-c", 'exec 9< "$0" && flock 9 && echo held && exec cat > /dev/null', dir],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const held = await new Promise((resolve) => {
    holder.stdout.once("data", () => resolve(true));
    holder.once("error", () => resolve(false));
    holder.once("exit", () => resolve(false));
  });
  try {
    if (!held || !existsSync(dir) || statSync(dir).ino !== before) return RETIRED;
    const text = readFileSync(path.join(dir, "MANIFEST"), "utf8");
    const foreign = foreignIn(dir, text);
    if (foreign.length > 0)
      return {
        refused: `${dir} holds foreign contents, which this tool did not write: ${foreign.join(", ")}`,
        foreign,
      };
    if (identityIn(text) === undefined)
      return { refused: `${dir}'s MANIFEST has a header this tool does not write` };
    // the temporary files a writer left when it ended (killed) before renaming or linking them
    const folders = [dir, ...[...recorded(text).keys()].map((area) => path.join(dir, area))];
    for (const folder of folders.filter((folder) => existsSync(folder)))
      for (const name of readdirSync(folder)) {
        const writer = temporaryOf(name)?.writer;
        if (writer !== undefined && !running(writer))
          rmSync(path.join(folder, name), { force: true });
      }
    return await action(text);
  } finally {
    holder.stdin.end();
  }
}

/** `file` made whole with `text` where it does not exist yet (in a gate), else left as it is: what it holds. */
function created(file, text) {
  const tmp = temporaryName(file, WRITER);
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(file, "utf8");
}

/** `file` replaced whole with `text` (in a gate): written beside it, then renamed over it. */
function replaced(file, text) {
  writeFileSync(temporaryName(file, WRITER), text);
  renameSync(temporaryName(file, WRITER), file);
}

/**
 * The real path of `file`, as the system resolves it: component by component, each link followed where it lies and a
 * `..` taken after it, as far as the path exists.
 */
function realOf(file) {
  const pending = (path.isAbsolute(file) ? file : `${process.cwd()}/${file}`).split("/");
  let real = "/";
  for (let links = 0; pending.length > 0;) {
    const part = pending.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      real = path.dirname(real);
      continue;
    }
    let link;
    try {
      link = readlinkSync(path.join(real, part));
    } catch {
      // (no link: absent, or a file or folder)
    }
    if (link === undefined) real = path.join(real, part);
    else if ((links += 1) > 40) throw new Error(`${file}: too many links`);
    else {
      pending.unshift(...link.split("/"));
      if (link.startsWith("/")) real = "/";
    }
  }
  return real;
}

// A path the writers below take, made only here: `outside` (a path, as the system resolves it, that lies in no baseline
// and no folder of baselines it was checked against) or `baseline` (a baseline's folder in such a folder). `pathOf`
// gives its path, and refuses anything else before any filesystem call, so that no writer can write by a path's
// unchecked spelling.
// A `baseline` path names the folder it was issued for (its inode, where it exists then): the gate refuses it for any
// other folder found at that path later.
const checked = new WeakMap();
function checkedPath(real, kind) {
  const value = Object.freeze({});
  let ino;
  try {
    ino = kind === "baseline" ? statSync(real).ino : undefined;
  } catch {
    // (a baseline not made yet)
  }
  checked.set(value, { real, kind, ino });
  return value;
}

/** The path of a checked path of `kind` (above); anything else throws. */
export function pathOf(value, kind) {
  const entry = checked.get(value);
  if (entry === undefined || entry.kind !== kind)
    throw new TypeError(`${String(value)} is no ${kind} path this tool checked`);
  return entry.real;
}

/**
 * `file` as an `outside` path (its real path, above), where it lies (its links followed) in none of the baselines
 * folders `roots` and in no folder that carries this tool's MANIFEST, nor is one; else `refuse(why)`, which ends the
 * process.
 */
export function outside(file, roots, refuse) {
  const real = realOf(file);
  const within = (folder) => real === folder || real.startsWith(`${folder}${path.sep}`);
  const root = roots.find((folder) => within(realOf(folder)));
  const baseline = baselineHolding(real);
  const why =
    baseline !== undefined
      ? `${file} lies in the baseline ${baseline}: give a path outside it`
      : root !== undefined
        ? `${file} lies in the baselines folder ${root}: give a path outside it`
        : undefined;
  if (why === undefined) return checkedPath(real, "outside");
  refuse(why);
  throw new Error(why);
}

/** The baseline (a folder that carries this tool's MANIFEST) that `real` lies in or is, else undefined. */
function baselineHolding(real) {
  for (let folder = real; ; folder = path.dirname(folder)) {
    if (isOwned(folder)) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
}

/** Why the `outside` path `root` no longer is one (a link put in its way, or a baseline round it), else undefined. */
function stale(root) {
  const real = pathOf(root, "outside");
  if (realOf(real) !== real) return `${real} resolves elsewhere since it was checked`;
  const baseline = baselineHolding(real);
  return baseline === undefined
    ? undefined
    : `${real} lies in the baseline ${baseline} since it was checked`;
}

/** The baseline `name` (a `src/` tree's id) in `root` (an `outside` path). */
function baselineIn(root, name) {
  if (!isBaselineName(name)) throw new Error(`${name} is no baseline's name`);
  return checkedPath(path.join(pathOf(root, "outside"), name), "baseline");
}

/** The baseline that `file` names, as the system resolves it, in a folder of baselines that lies in no baseline. */
function baselineAt(file, refuse) {
  const real = realOf(file);
  if (!isBaselineName(path.basename(real)))
    refuse(`${file} is no baseline: its name is no src/ tree's`);
  return baselineIn(outside(path.dirname(real), [], refuse), path.basename(real));
}

/** The folders a run that reads the baseline area `folder` (`--baseline`) must not write in, as the system resolves them. */
export function readFrom(folder) {
  const real = realOf(folder);
  return [real, ...(isOwned(path.dirname(real)) ? [path.dirname(path.dirname(real))] : [])];
}

/**
 * The baseline of a tree's identity in `root`, made where it does not exist (unless `line` is null): its MANIFEST
 * written into its folder, made if absent, while the folder holds nothing else (a folder holding anything stays as it
 * is), by a temporary file linked into place so that one writer's MANIFEST wins. Then joined through the gate, `line`
 * appended to its MANIFEST once. `whole`, where given, is the text it is made with instead (a seed's MANIFEST, which
 * `import` adopts, #1590), and nothing is appended. `refused` says why it is not this tool's, holds foreign paths or
 * holds the runs of other inputs (`another`).
 */
export async function owned(root, identity, line, whole) {
  const dir = pathOf(baselineIn(root, identity.src), "baseline");
  const header = headerOf(identity);
  const why = stale(root);
  if (why !== undefined) return { dir, refused: why };
  if (whole !== undefined && !whole.startsWith(header))
    throw new Error(`a MANIFEST made for ${identity.src} begins with its header`);
  if ((line !== null || whole !== undefined) && !existsSync(path.join(dir, "MANIFEST"))) {
    const made = baselineIn(root, identity.src);
    mkdirSync(pathOf(made, "baseline"), { recursive: true });
    if (
      readdirSync(pathOf(made, "baseline")).every((name) => temporaryOf(name)?.name === "MANIFEST")
    ) {
      const tmp = path.join(pathOf(made, "baseline"), temporaryName("MANIFEST", WRITER));
      writeFileSync(tmp, whole ?? header);
      try {
        linkSync(tmp, path.join(pathOf(made, "baseline"), "MANIFEST"));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
  if (!existsSync(dir)) return { dir, absent: true };
  // (issued for the folder found now: another one at this path later is another baseline)
  const baseline = baselineIn(root, identity.src);
  const joined = await gate(baseline, (text) => {
    if (!text.startsWith(header)) {
      const [ours, theirs] = [header, text].map((part) => part.split("\n").slice(1, 5));
      const differs = ours
        .filter((field, index) => field !== theirs[index])
        .map((field) => field.split(" ")[0]);
      return {
        refused: `${dir} holds runs of another ${differs.join(", ")} than this tree's`,
        another: true,
      };
    }
    if (line !== null && whole === undefined && !text.split("\n").includes(line))
      appendFileSync(path.join(dir, "MANIFEST"), `${line}\n`);
    return {};
  });
  if (joined === RETIRED)
    return { dir, refused: `${dir} was replaced while this writer joined it` };
  return { baseline, dir, ...joined };
}

/**
 * An area's PLAN for its generators (`generatorsOf`) in `shards` shards at the runner's defaults: each generator's
 * checks, then each shard's count of sources and the hash of their places, in the runner's order.
 */
export function planOf(area, generators, shards) {
  const lines = [
    "plan 1",
    `area ${area}`,
    `shards ${shards}`,
    `limits ${DEFAULTS.timeout} s, ${DEFAULTS.memory} MB`,
    `allowances ${DEFAULTS.allowances}`,
  ];
  for (const { name, checks } of generators) lines.push(`checks ${name} ${checks.join(",")}`);
  for (let shard = 0; shard < shards; shard += 1) {
    const places = generators.flatMap(({ name, sources }) =>
      sources.filter((_, index) => index % shards === shard).map((source) => placeOf(name, source)),
    );
    lines.push(`shard ${shard} ${places.length} ${hash(places.join("\n"))}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A PLAN's count of shards and each shard's hash of places. */
function parsePlan(text) {
  const shards = Number(/^shards (\d+)$/m.exec(text)?.[1] ?? 0);
  const places = [...text.matchAll(/^shard (\d+) \d+ ([0-9a-f]{64})$/gm)].map(([, , id]) => id);
  return { shards, places };
}

/** The file of a shard. */
export const shardFile = (dir, shard, shards) => path.join(dir, shardName(shard, shards));

/**
 * A stored shard as the one rule reads it, which status, the store (which skips a shard that counts and replaces one
 * that does not) and the comparison (`storedRuns`) share: `lines` (each source's runs) where it counts; `other` (the
 * inputs it names otherwise) where it would count but names other inputs than its own baseline's MANIFEST (`identity`:
 * its src tree, oracle library, lockfile and Node; any commit of that tree, never the tree run against it), which makes
 * the baseline hold runs of other inputs; else nothing (absent or damaged). It counts where its last line, its total,
 * names `identity`, the area's PLAN (`plan`) and the shard's planned sources (`places`), which are its lines in their
 * order, and hashes every line before it.
 */
function shardIn(body, plan, places, identity) {
  if (body === undefined) return {};
  const cut = body.lastIndexOf(10, body.length - 2);
  let total;
  let lines;
  try {
    ({ total } = JSON.parse(body.subarray(cut + 1).toString()));
    lines = body
      .subarray(0, cut + 1)
      .toString()
      .split("\n")
      .slice(0, -1);
    const listed = lines.map((line) => {
      const { generator, source, key } = JSON.parse(line);
      return JSON.stringify([generator, source, key]);
    });
    if (hash(listed.join("\n")) !== places) return {};
  } catch {
    return {};
  }
  if (
    total?.plan !== plan ||
    total?.places !== places ||
    total?.lines !== hash(body.subarray(0, cut + 1))
  )
    return {};
  const other = ["src", "oracles", "lock", "node"].filter(
    (key) => identity?.[key] === undefined || total[key] !== identity[key],
  );
  return other.length > 0 ? { other } : { lines };
}

/** A file's bytes, or undefined. */
function bytesOf(file) {
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

/** Whether the stored shard `file` counts (`shardIn`). */
export const verified = (file, plan, places, identity) =>
  shardIn(bytesOf(file), plan, places, identity).lines !== undefined;

/** Whether a running writer claims a shard of the area of `shards` shards in `dir`, or the shard `shard` only. */
function claimedIn(dir, shards, shard) {
  const claims = shard === undefined ? [...Array(shards).keys()] : [shard];
  return claims.some((index) => {
    try {
      return running(readFileSync(path.join(dir, claimName(index, shards)), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * This process's claim on a shard (in a gate), taken where no running writer holds it: a writer that ended without
 * releasing its claim (killed) holds it no longer.
 */
function claimed(file) {
  const holder = created(file, `${WRITER}\n`).trim();
  if (holder === WRITER) return true;
  if (running(holder)) return false;
  replaced(file, `${WRITER}\n`);
  return true;
}

/**
 * The area `area` of the baseline `top` planned as `plan`: recorded in the MANIFEST (`area <name> <shards> <PLAN hash>`)
 * before its folder and PLAN are made, which a writer interrupted in between leaves to the next. The PLAN's hash and
 * each shard's hash of places, or why it is refused: another plan recorded, or the baseline's state.
 */
/** `area` where it is an area's name (one plain path component), else this throws before any filesystem call. */
function areaName(area) {
  if (typeof area !== "string" || !/^[^/]+$/.test(area) || [".", ".."].includes(area))
    throw new TypeError(`${String(area)} is no area's name`);
  return area;
}

export async function planned(baseline, area, plan) {
  const top = pathOf(baseline, "baseline");
  areaName(area);
  const id = hash(plan);
  const { shards, places } = parsePlan(plan);
  const outcome = await gate(baseline, (text) => {
    const record = recorded(text).get(area);
    if (record === undefined)
      appendFileSync(path.join(top, "MANIFEST"), `area ${area} ${shards} ${id}\n`);
    else if (record.plan !== id)
      return {
        refused: `${top}/${area} is planned otherwise: another plan (set, order, count of shards or checks)`,
      };
    mkdirSync(path.join(top, area), { recursive: true });
    // (a PLAN that is not the recorded one is the next writer's to replace, as a shard that does not count is)
    if (hash(created(path.join(top, area, "PLAN"), plan)) !== id)
      replaced(path.join(top, area, "PLAN"), plan);
    return {};
  });
  if (outcome === RETIRED) return { refused: `${top} was replaced while this writer planned it` };
  return outcome.refused === undefined ? { plan: id, shards, places } : outcome;
}

// A claim on a shard (`beginShard`), which only `endShard` takes, once: the shard's paths are made from it and from its
// baseline path, never from a caller's argument.
const claims = new WeakMap();

/**
 * A shard to store (through the gate): `skipped` where it counts or a running writer stores it, else this process's
 * `claim` on it (above) and its `file`; `refused` where the baseline refuses the writer.
 */
export async function beginShard(baseline, area, shard, shards, plan, places) {
  const top = pathOf(baseline, "baseline");
  const dir = path.join(top, areaName(area));
  const file = shardFile(dir, shard, shards);
  const outcome = await gate(baseline, (text) => {
    if (verified(file, plan, places, identityIn(text))) return { skipped: "stored" };
    if (!claimed(path.join(dir, claimName(shard, shards))))
      return { skipped: "being stored by another writer" };
    const claim = Object.freeze({});
    claims.set(claim, { baseline, area, shard, shards, plan, places });
    return { claim };
  });
  if (outcome === RETIRED)
    return { refused: `${top} was replaced while this writer began a shard` };
  return { file, ...outcome };
}

/**
 * The shard of the claim `claim` (above) published whole through the gate, its lines (`lines`) then its total last: a
 * new one by a hard link, one that does not count by a rename over it, one another writer published meanwhile kept;
 * the claim released. Whether the shard then counts, or why the baseline refused it.
 */
export async function endShard(claim, lines, total) {
  const held = claims.get(claim);
  if (held === undefined) throw new TypeError(`${String(claim)} is no claim this tool gave`);
  claims.delete(claim);
  const { baseline, area, shard, shards, plan, places } = held;
  const top = pathOf(baseline, "baseline");
  const dir = path.join(top, area);
  const file = shardFile(dir, shard, shards);
  const body = lines.join("");
  const ended = `${JSON.stringify({ total: { ...total, plan, places, lines: hash(body) } })}\n`;
  const outcome = await gate(baseline, (text) => {
    const identity = identityIn(text);
    const tmp = temporaryName(file, WRITER);
    writeFileSync(tmp, body + ended);
    try {
      linkSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!verified(file, plan, places, identity)) renameSync(tmp, file);
    }
    rmSync(tmp, { force: true });
    const claimFile = path.join(dir, claimName(shard, shards));
    if (existsSync(claimFile) && readFileSync(claimFile, "utf8").trim() === WRITER)
      rmSync(claimFile, { force: true });
    return { verified: verified(file, plan, places, identity) };
  });
  if (outcome === RETIRED)
    return { refused: `${top} was replaced while this writer stored into it` };
  return outcome;
}

/** The refusal for a shard (`file`) that names other inputs (`other`) than its baseline's MANIFEST. */
const otherInputs = (dir, file, other) =>
  `${dir} holds runs of another ${other.join(", ")} than its MANIFEST names: ${path.relative(dir, file)}`;

/**
 * The runs stored in the baseline area `folder` (`--baseline`, as the system resolves it), read only through the rule
 * of `shardIn`, as status reads them: an area recorded in the MANIFEST of a baseline of this tool that holds no foreign
 * path and is named by its MANIFEST's src tree, its PLAN the recorded one and every planned shard counting. Its lines
 * (each source's, the totals left out) and its MANIFEST's identity (what its runs depend on); else why not, with the
 * exit status status gives it: 2 where the folder is no area of such a baseline, the baseline holds a foreign path or a
 * shard of other inputs, 1 where the area is not complete (not recorded, its PLAN not the recorded one, a shard absent
 * or damaged).
 */
export function storedRuns(folder) {
  const real = realOf(folder);
  const [dir, area] = [path.dirname(real), path.basename(real)];
  if (!isOwned(dir))
    return {
      status: 2,
      refused: `${folder} is no area of a baseline of this tool: ${dir} has no MANIFEST of this tool`,
    };
  const text = readFileSync(path.join(dir, "MANIFEST"), "utf8");
  const foreign = foreignIn(dir, text);
  if (foreign.length > 0)
    return {
      status: 2,
      refused: `${dir} holds foreign contents, which this tool did not write: ${foreign.join(", ")}`,
    };
  const identity = identityIn(text);
  if (identity === undefined)
    return { status: 2, refused: `${dir}'s MANIFEST has a header this tool does not write` };
  if (identity.src !== path.basename(dir))
    return { status: 2, refused: `${dir}'s MANIFEST names another src tree than its folder` };
  const record = recorded(text).get(area);
  const plan = bytesOf(path.join(real, "PLAN"))?.toString();
  if (record === undefined || plan === undefined || hash(plan) !== record.plan)
    return {
      status: 1,
      refused: `${folder} is no complete area: ${record === undefined ? "not recorded in its baseline" : "its PLAN is not the recorded one"}`,
    };
  const { shards, places } = parsePlan(plan);
  const lines = [];
  let incomplete;
  for (let shard = 0; shard < shards; shard += 1) {
    const file = shardFile(real, shard, shards);
    const read = shardIn(bytesOf(file), record.plan, places[shard], identity);
    if (read.other !== undefined) return { status: 2, refused: otherInputs(dir, file, read.other) };
    if (read.lines === undefined)
      incomplete ??= `${folder} is no complete area: ${shardName(shard, shards)} ${existsSync(file) ? "does not verify" : "is absent"}`;
    else lines.push(...read.lines);
  }
  return incomplete === undefined ? { lines, identity } : { status: 1, refused: incomplete };
}

/** A built tree's areas: the folders of tests/families/ with generators, and tools/corpus/fixture/. */
function areasOf(tree) {
  const families = path.join(tree, "tests", "families");
  return [
    ...(existsSync(families) ? readdirSync(families, { withFileTypes: true }) : [])
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(families, entry.name)),
    path.join(tree, "tools", "corpus", "fixture"),
  ].filter(
    (folder) => existsSync(folder) && readdirSync(folder).some((name) => name.endsWith(".mjs")),
  );
}

/** Each area's state in the baseline of `tree` (see above), one JSON line each, then the baseline's; the exit status. */
async function state(tree, root, readOnly) {
  const { lines, status } = await stateOf(tree, root, readOnly);
  for (const line of lines) console.log(JSON.stringify(line));
  return status;
}

/** What `state` prints (`lines`, without a tree's `src/` an error printed and none) and its exit status. */
async function stateOf(tree, root, readOnly) {
  const identity = identityOf(tree);
  if (identity.src === null) {
    console.error(`${tree}/src holds no file`);
    return { lines: [], status: 2 };
  }
  const sha = readFileSync(path.join(tree, ".sha"), "utf8").trim();
  const own = await owned(root, identity, readOnly ? null : `commit ${sha} ${tree}`);
  const lines = [];
  const refusal = (refused, foreign) => {
    lines.push({ src: identity.src, baseline: own.dir, refused, foreign });
    return { lines, status: 2 };
  };
  if (own.refused !== undefined) return refusal(own.refused, own.foreign);
  const areas = areasOf(tree);
  if (areas.length === 0) return refusal(`${tree} has no area of the runner`);
  const manifest = own.absent ? "" : readFileSync(path.join(own.dir, "MANIFEST"), "utf8");
  const records = recorded(manifest);
  let complete = true;
  let storing = false;
  for (const folder of areas) {
    const area = path.basename(folder);
    const dir = path.join(own.dir, area);
    const record = records.get(area);
    const stored = existsSync(path.join(dir, "PLAN"))
      ? readFileSync(path.join(dir, "PLAN"), "utf8")
      : null;
    let line;
    if (record === undefined) line = { area, folder, state: "absent", store: "all" };
    else if (stored === null || hash(stored) !== record.plan)
      // (recorded, its PLAN not made yet: the next writer's to finish, in the recorded count)
      line = { area, folder, state: "absent", shards: record.shards, verified: 0, store: "all" };
    else {
      const { shards, places } = parsePlan(stored);
      const read = places.map((place, shard) =>
        shardIn(bytesOf(shardFile(dir, shard, shards)), record.plan, place, identityIn(manifest)),
      );
      const other = read.findIndex((shard) => shard.other !== undefined);
      if (other >= 0)
        return refusal(otherInputs(own.dir, shardFile(dir, other, shards), read[other].other));
      const good = read.map((shard) => shard.lines !== undefined);
      const count = good.filter(Boolean).length;
      if (
        (readOnly || count < shards) &&
        hash(planOf(area, await generatorsOf(folder), shards)) !== record.plan
      )
        line = { area, folder, state: "another plan" };
      else {
        const store = good.flatMap((ok, shard) =>
          ok || claimedIn(dir, shards, shard) ? [] : [shard],
        );
        const damaged = good.filter(
          (ok, shard) => !ok && existsSync(shardFile(dir, shard, shards)),
        ).length;
        const name =
          count === shards
            ? "complete"
            : claimedIn(dir, shards)
              ? "storing"
              : damaged > 0
                ? "damaged"
                : "partial";
        line = {
          area,
          folder,
          state: name,
          verified: count,
          shards,
          ...(damaged > 0 ? { damaged } : {}),
          store,
        };
      }
    }
    if (line.state !== "complete") complete = false;
    if (line.state === "storing") storing = true;
    lines.push(line);
  }
  lines.push({ src: identity.src, baseline: own.dir, complete, storing });
  return { lines, status: complete ? 0 : 1 };
}

/**
 * A fill job's first decision for the baseline `dir` (through the gate): STARTED where the baseline is the current
 * tree's (SUPERSEDED undone; STARTED written once, when the fill began) or the fill already began, else SUPERSEDED,
 * naming the current tree (#1513; a started fill is completed, #1590 reversing #1567). The decision printed.
 */
async function start(baseline, current) {
  const dir = pathOf(baseline, "baseline");
  const outcome = await gate(baseline, () => {
    const marker = (name) => path.join(dir, name);
    if (path.basename(dir) === current) {
      rmSync(marker("SUPERSEDED"), { force: true });
      if (!existsSync(marker("STARTED")))
        replaced(marker("STARTED"), `${new Date().toISOString()}\n`);
      return { decision: "started" };
    }
    if (existsSync(marker("STARTED"))) return { decision: "started" };
    replaced(marker("SUPERSEDED"), `${current}\n`);
    return { decision: "superseded", by: current };
  });
  console.log(JSON.stringify(outcome === RETIRED ? { refused: `${dir} was replaced` } : outcome));
  return outcome === RETIRED || outcome.refused !== undefined ? 2 : 0;
}

/** The hook's `script` copied into the baseline `dir` for its jobs, and SUPERSEDED undone (through the gate). */
async function queue(baseline, script) {
  const dir = pathOf(baseline, "baseline");
  const outcome = await gate(baseline, () => {
    copyFileSync(script, path.join(dir, temporaryName("baseline.sh", WRITER)));
    renameSync(path.join(dir, temporaryName("baseline.sh", WRITER)), path.join(dir, "baseline.sh"));
    rmSync(path.join(dir, "SUPERSEDED"), { force: true });
    return { queued: dir };
  });
  console.log(JSON.stringify(outcome === RETIRED ? { refused: `${dir} was replaced` } : outcome));
  return outcome === RETIRED || outcome.refused !== undefined ? 2 : 0;
}

/** The builds of the compiler a MANIFEST names (`compiled <id>`, #1590), in its order. */
const compiledIn = (text) => [...text.matchAll(/^compiled ([0-9a-f]{40})$/gm)].map(([, id]) => id);

/**
 * The tree's baseline in `root` (made already) named by the tree's build of the compiler (`comparedOf`'s `compiled`, its
 * `dist/src/` tree, #1590): `compiled <id>` appended to its MANIFEST through the gate where no line names that id, so
 * that a baseline stored from two builds names both. The baseline's folder, or why it is refused.
 */
async function compiledInto(root, tree) {
  const identity = identityOf(tree);
  const { compiled } = comparedOf(tree);
  if (identity.src === null || compiled === null)
    return { refused: `${tree} has no ${identity.src === null ? "src/" : "dist/src/"}` };
  const own = await owned(root, identity, null);
  if (own.refused !== undefined || own.absent)
    return { refused: own.refused ?? `${own.dir} holds no baseline yet` };
  const outcome = await gate(own.baseline, (text) => {
    if (!compiledIn(text).includes(compiled))
      appendFileSync(path.join(own.dir, "MANIFEST"), `compiled ${compiled}\n`);
    return { compiled, baseline: own.dir };
  });
  return outcome === RETIRED
    ? { refused: `${own.dir} was replaced while this writer joined it` }
    : outcome;
}

/**
 * A seed (#1590): the tree's baseline in `root` made or joined as `state` makes it (its commit appended), every area of
 * the tree planned (in the count its MANIFEST records, else 16 shards), no shard stored, and then named by the tree's
 * build (`compiledInto`); then `state`'s lines printed and `<root>/shards.tsv` written (a new file), one line per shard to store
 * (`<area>\t<i>\t<N>`), as the hook queues them. Its exit status as `state`'s, but 0 where the baseline is incomplete.
 */
async function seed(tree, root, refuse) {
  const identity = identityOf(tree);
  if (identity.src === null) refuse(`${tree}/src holds no file`);
  const sha = readFileSync(path.join(tree, ".sha"), "utf8").trim();
  const own = await owned(root, identity, `commit ${sha} ${tree}`);
  if (own.refused !== undefined) refuse(own.refused);
  const records = recorded(readFileSync(path.join(own.dir, "MANIFEST"), "utf8"));
  for (const folder of areasOf(tree)) {
    const area = path.basename(folder);
    const plan = planOf(area, await generatorsOf(folder), records.get(area)?.shards ?? 16);
    const made = await planned(own.baseline, area, plan);
    if (made.refused !== undefined) refuse(made.refused);
  }
  // (its last write: a MANIFEST that names a build records every area of its tree, which `status` reads without one)
  const named = await compiledInto(root, tree);
  if (named.refused !== undefined) refuse(named.refused);
  const { lines, status } = await stateOf(tree, root, false);
  for (const line of lines) console.log(JSON.stringify(line));
  if (status === 2) return 2;
  const stored = lines
    .filter((line) => line.area !== undefined && line.store !== undefined)
    .flatMap(({ area, shards = 16, store }) =>
      (store === "all" ? [...Array(shards).keys()] : store).map(
        (shard) => `${area}\t${shard}\t${shards}\n`,
      ),
    );
  const list = outside(path.join(pathOf(root, "outside"), "shards.tsv"), [], refuse);
  rmSync(pathOf(list, "outside"), { force: true });
  writeFileSync(pathOf(list, "outside"), stored.join(""), { flag: "wx" });
  return 0;
}

/**
 * The one baseline of this tool that the folder `root` holds (a seed's or a computed shard's `<out>`, #1590), read whole:
 * its folder, MANIFEST (`text`), identity and each recorded area's PLAN, which must be the recorded one; or why not.
 */
function heldIn(root) {
  const real = realOf(root);
  const names =
    existsSync(real) && statSync(real).isDirectory()
      ? readdirSync(real).filter((name) => isBaselineName(name) && isOwned(path.join(real, name)))
      : [];
  if (names.length !== 1)
    return {
      refused: `${root} holds ${names.length === 0 ? "no" : "more than one"} baseline of this tool`,
    };
  const dir = path.join(real, names[0]);
  const text = readFileSync(path.join(dir, "MANIFEST"), "utf8");
  const identity = identityIn(text);
  if (identity === undefined)
    return { refused: `${dir}'s MANIFEST has a header this tool does not write` };
  if (identity.src !== names[0])
    return { refused: `${dir}'s MANIFEST names another src tree than its folder` };
  const foreign = foreignIn(dir, text);
  if (foreign.length > 0)
    return {
      refused: `${dir} holds foreign contents, which this tool did not write: ${foreign.join(", ")}`,
    };
  const plans = new Map();
  for (const [area, record] of recorded(text)) {
    const plan = bytesOf(path.join(dir, area, "PLAN"))?.toString();
    if (plan === undefined || hash(plan) !== record.plan)
      return { refused: `${dir}/${area}'s PLAN is not the one its MANIFEST records` };
    plans.set(area, plan);
  }
  return { dir, text, identity, plans };
}

/** Where a computed baseline's MANIFEST (`given`) and the central one (`held`) differ, each line named by what it records. */
function differenceOf(held, given) {
  const lines = (text) => text.split("\n").filter((line) => line !== "");
  const meaning = (line) =>
    ({
      compiled: "a build of the compiler, dist/src/",
      area: "an area's PLAN",
      commit: "a commit and tree stored there",
    })[line.split(" ")[0]] ?? "what its runs depend on";
  const only = (one, other) =>
    lines(one)
      .filter((line) => !lines(other).includes(line))
      .map((line) => `"${line}" (${meaning(line)})`);
  const [adds, lacks] = [only(given, held), only(held, given)];
  return (
    [
      ...(adds.length > 0 ? [`it names ${adds.join(", ")}`] : []),
      ...(lacks.length > 0 ? [`the central one names ${lacks.join(", ")}`] : []),
    ].join("; ") || "its lines are in another order"
  );
}

/**
 * A seed's MANIFEST and PLANs (`held`, `heldIn`, naming the build of the compiler its shards are stored from) adopted
 * into the folder of baselines `central` (#1590): its baseline made with that MANIFEST where it is absent or empty, else checked equal and never written over (`differs`); then each
 * area's PLAN made where the baseline lacks it (`planned`). `seed` says whether anything was written.
 */
async function adopt(central, held) {
  if (compiledIn(held.text).length === 0)
    return {
      refused: `${held.dir}'s MANIFEST names no build of the compiler (dist/src/) its shards are stored from`,
    };
  const dir = pathOf(baselineIn(central, held.identity.src), "baseline");
  let wrote = !isOwned(dir);
  const own = await owned(central, held.identity, null, held.text);
  if (own.refused !== undefined)
    return own.another ? { differs: own.refused } : { refused: own.refused };
  const outcome = await gate(own.baseline, (text) =>
    text === held.text
      ? {}
      : {
          differs: `${held.dir}'s MANIFEST is not the central one: ${differenceOf(text, held.text)}`,
        },
  );
  if (outcome === RETIRED) return { refused: `${dir} was replaced while this writer adopted it` };
  if (outcome.differs !== undefined || outcome.refused !== undefined) return outcome;
  for (const [area, plan] of held.plans) {
    if (bytesOf(path.join(dir, area, "PLAN"))?.toString() !== plan) wrote = true;
    const made = await planned(own.baseline, area, plan);
    if (made.refused !== undefined) return made;
  }
  return { baseline: dir, seed: wrote ? "adopted" : "equal" };
}

/**
 * The stored shard `file` of `area` that a computed baseline holds (its PLAN's hash `plan` and planned `places`, its
 * MANIFEST's `identity`), read where it counts under `shardIn` and each source that stalled in it is one that `listing`
 * (stalls.json, `stallsOf`) shows stalling alone, as many as its total counts (#1590): its `body` and `lines`; else why
 * it is refused.
 */
function shardOf(file, plan, places, identity, listing) {
  const body = bytesOf(file);
  const read = shardIn(body, plan, places, identity);
  if (read.other !== undefined)
    return { refused: otherInputs(path.dirname(file), file, read.other) };
  if (read.lines === undefined)
    return { refused: `${file} is no shard that counts: absent or damaged` };
  const { total } = JSON.parse(body.subarray(body.lastIndexOf(10, body.length - 2) + 1).toString());
  const stalled = read.lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.stalled !== undefined);
  if (total.stalled !== stalled.length)
    return {
      refused: `${file}'s total counts ${total.stalled} stalled sources, its lines ${stalled.length}`,
    };
  for (const source of stalled) {
    const entry = listing.find((one) => placeIn(one) === placeIn(source));
    if (entry?.stalled !== source.stalled || entry.alone?.stalled === undefined)
      return {
        refused: `${file}: ${source.generator} ${source.source} stalled (${source.stalled}), and stalls.json does not show it stalling alone`,
      };
  }
  if (listing.length !== stalled.length)
    return {
      refused: `stalls.json lists ${listing.length} stalled sources of ${file}, which has ${stalled.length}`,
    };
  return { body, lines: read.lines };
}

/**
 * The stored shard `<shard>of<shards>` of `area` that `held` (`heldIn`) holds, imported into the folder of baselines
 * `central` (#1590), accepted only where its MANIFEST and the area's PLAN are the central ones (its build of the
 * compiler, src tree, oracle library, lockfile and Node among them) and it reads under `shardOf`, its stalls those
 * `listing` lists for it; else `refused`. It is published through the gate as `endShard` publishes one; a shard the
 * central baseline already holds is compared instead, by its lines (no time is stored in them), and one that differs
 * replaces nothing (`differs`).
 */
async function importShard(central, held, area, shard, shards, listing) {
  const record = recorded(held.text).get(area);
  if (record === undefined) return { refused: `${held.dir} records no area ${area}` };
  if (record.shards !== shards)
    return { refused: `${held.dir} plans ${area} in ${record.shards} shards, not ${shards}` };
  const plan = held.plans.get(area);
  const { places } = parsePlan(plan);
  const baseline = baselineIn(central, held.identity.src);
  const dir = pathOf(baseline, "baseline");
  if (!isOwned(dir))
    return { refused: `${dir} is no baseline of this tool: import its seed first` };
  const outcome = await gate(baseline, (text) => {
    if (text !== held.text)
      return {
        refused: `${held.dir}'s MANIFEST is not the central one: ${differenceOf(text, held.text)}`,
      };
    if (bytesOf(path.join(dir, area, "PLAN"))?.toString() !== plan)
      return { refused: `${dir}/${area} holds no PLAN or another one: import its seed first` };
    const file = shardFile(path.join(held.dir, area), shard, shards);
    const listed = listing.filter(
      (entry) => entry.area === area && entry.shard === `${shard}/${shards}`,
    );
    const read = shardOf(file, record.plan, places[shard], held.identity, listed);
    if (read.refused !== undefined) return read;
    const target = shardFile(path.join(dir, area), shard, shards);
    const there = shardIn(bytesOf(target), record.plan, places[shard], identityIn(text));
    if (there.other !== undefined) return { refused: otherInputs(dir, target, there.other) };
    if (there.lines !== undefined) {
      const at = there.lines.findIndex((line, index) => line !== read.lines[index]);
      if (at < 0) return { equal: target };
      const { generator, source } = JSON.parse(there.lines[at]);
      return { differs: `${file} says otherwise than ${target} of ${generator} ${source}` };
    }
    const tmp = temporaryName(target, WRITER);
    writeFileSync(tmp, read.body);
    try {
      linkSync(tmp, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      renameSync(tmp, target);
    }
    rmSync(tmp, { force: true });
    return {
      imported: target,
      verified: verified(target, record.plan, places[shard], identityIn(text)),
    };
  });
  return outcome === RETIRED
    ? { refused: `${dir} was replaced while this writer imported into it` }
    : outcome;
}

/**
 * `import <central root> <computed root> [<area> <i>/<N> [<stalls.json>]]` (#1590): the baseline `computed` holds
 * (`heldIn`), a seed adopted (`adopt`) or, with an area, one shard (`importShard`, its stalls listed in `stalls.json`
 * beside it unless named), into the folder of baselines `central`. One JSON line; exit 0 imported or equal, 2 refused,
 * 3 differs.
 */
async function importing(central, computed, area, shard, listed, refuse) {
  const held = heldIn(computed);
  let outcome;
  if (held.refused !== undefined) outcome = held;
  else if (held.dir === path.join(pathOf(central, "outside"), held.identity.src))
    outcome = { refused: `${held.dir} is the central baseline itself` };
  else if (area === undefined) outcome = await adopt(central, held);
  else {
    const [index, count] = /^\d+\/\d+$/.test(shard) ? shard.split("/").map(Number) : [];
    if (!/^[^/]+$/.test(area) || [".", ".."].includes(area) || !(index < count))
      refuse(`${area} ${shard} is no area's shard i/N with 0 <= i < N`);
    const file = listed ?? path.join(realOf(computed), "stalls.json");
    let listing = [];
    try {
      if (existsSync(file)) listing = JSON.parse(readFileSync(file, "utf8")).stalls;
      if (!Array.isArray(listing)) throw new Error("it lists no stalls");
    } catch (error) {
      refuse(`${file}: ${error.message}`);
    }
    outcome = await importShard(central, held, area, index, count, listing);
  }
  console.log(JSON.stringify(outcome));
  if (outcome.refused !== undefined || outcome.verified === false) return 2;
  return outcome.differs !== undefined ? 3 : 0;
}

/**
 * The baseline `src` of the folder of baselines `root` without a tree (#1590), as one line: absent, incomplete (each
 * recorded area with its shards that count under `shardIn`, of its PLAN's count) or complete. Read only, as `storedRuns`
 * reads. Exit 0 only where its MANIFEST names a build (a seed's, written once every area of its tree was recorded) and
 * every area it records is complete, 1 where one is not, it names no build or it is absent, 2 where the folder is not this tool's, holds a foreign path or the runs of other inputs.
 */
function statusOf(root, src) {
  const say = (text, status) => {
    console.log(`baseline ${src}: ${text}`);
    return status;
  };
  if (!isBaselineName(src)) return say("this is no src/ tree's id", 2);
  const dir = path.join(pathOf(root, "outside"), src);
  if (!isOwned(dir))
    return existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)
      ? say(`${dir} is not this tool's: it has no MANIFEST of this tool`, 2)
      : say(`${dir}: absent`, 1);
  const text = readFileSync(path.join(dir, "MANIFEST"), "utf8");
  const foreign = foreignIn(dir, text);
  if (foreign.length > 0)
    return say(
      `${dir} holds foreign contents, which this tool did not write: ${foreign.join(", ")}`,
      2,
    );
  const identity = identityIn(text);
  if (identity === undefined)
    return say(`${dir}'s MANIFEST has a header this tool does not write`, 2);
  if (identity.src !== src)
    return say(`${dir}'s MANIFEST names another src tree than its folder`, 2);
  const areas = [];
  // (a MANIFEST names a build only once a seed recorded every area of its tree; else its areas are known only with it)
  const seeded = compiledIn(text).length > 0;
  for (const [area, record] of recorded(text)) {
    const plan = bytesOf(path.join(dir, area, "PLAN"))?.toString();
    if (plan === undefined || hash(plan) !== record.plan) {
      areas.push({ area, state: "absent", count: 0, shards: record.shards });
      continue;
    }
    const { shards, places } = parsePlan(plan);
    let count = 0;
    let damaged = false;
    for (let shard = 0; shard < shards; shard += 1) {
      const file = shardFile(path.join(dir, area), shard, shards);
      const read = shardIn(bytesOf(file), record.plan, places[shard], identity);
      if (read.other !== undefined) return say(otherInputs(dir, file, read.other), 2);
      if (read.lines !== undefined) count += 1;
      else if (existsSync(file)) damaged = true;
    }
    const state = count === shards ? "complete" : damaged ? "damaged" : "partial";
    areas.push({ area, state, count, shards });
  }
  const done = areas.filter(({ state }) => state === "complete").map(({ area }) => area);
  if (seeded && areas.length > 0 && done.length === areas.length)
    return say(`${dir}: complete: ${done.join(" ")}`, 0);
  const parts = [
    ...(done.length > 0 ? [`${done.join(" ")} complete`] : []),
    ...areas
      .filter(({ state }) => state !== "complete")
      .map(({ area, state, count, shards }) => `${area} ${state} ${count}/${shards}`),
  ];
  const unseeded = seeded
    ? []
    : [
        "no seed recorded its areas (a baseline stored before #1590: ask `baseline.sh status` with its tree)",
      ];
  return say(
    `${dir}: incomplete: ${[...unseeded, ...(parts.length > 0 ? [parts.join("; ")] : ["no area planned"])].join(": ")}`,
    1,
  );
}

/** A stored shard's sources, each line read, its total left out; `refuse(why)` where it does not read as one. */
function linesOf(file, refuse) {
  try {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    if (lines.at(-1)?.total === undefined) throw new Error("it has no total");
    return lines.slice(0, -1);
  } catch (error) {
    return refuse(`${file}: ${error.message}`);
  }
}

/** A source's place in a stored shard: its generator, its name and its key (`placeOf`). */
const placeIn = ({ generator, source, key }) => JSON.stringify([generator, source, key]);

/**
 * The sources that stalled in the stored shard `file` of the area `folder`, each once, as the new area `into` (an
 * outside path, a new folder named as the area): one module per generator, named as it, with its checks and those
 * sources as fixed cases, so that `run.mjs --store` runs them alone at the PLAN's limits and stores each under its own
 * place (#1590). Prints their count.
 */
async function alone(folder, file, into, refuse) {
  const stalled = new Set(
    linesOf(file, refuse)
      .filter((line) => line.stalled !== undefined)
      .map(placeIn),
  );
  if (stalled.size > 0) {
    const target = pathOf(into, "outside");
    if (existsSync(target)) refuse(`${target} exists: name a new folder`);
    mkdirSync(target, { recursive: true });
    const found = new Set();
    for (const { name, checks, sources } of await generatorsOf(folder)) {
      const cases = [];
      for (const source of sources) {
        const place = placeOf(name, source);
        if (stalled.has(place) && !found.has(place)) {
          found.add(place);
          cases.push([source.name, source.files, source.globals]);
        }
      }
      if (cases.length === 0) continue;
      const module = outside(path.join(target, name), [], refuse);
      writeFileSync(
        pathOf(module, "outside"),
        `// ${name}'s sources that stalled in a stored shard, run alone (tests/families/baselines.mjs alone)\n` +
          `export const checks = ${JSON.stringify(checks)};\nexport const cases = ${JSON.stringify(cases)};\n`,
      );
    }
    const missing = [...stalled].filter((place) => !found.has(place));
    if (missing.length > 0) refuse(`${folder} holds no source ${missing.join(", ")}`);
  }
  console.log(JSON.stringify({ stalled: stalled.size }));
}

/**
 * Whether each source that stalled in the stored shard `file` (`<shard>` of `area`) stalled alone too, in `ran` (the
 * shard `alone`'s sources stored at the PLAN's limits; `-` where none stalled), a stall of its own (#1590): then `out`
 * (an outside path, a new file, stalls.json) lists each with its reason and its run alone, `import`'s evidence, exit 0;
 * else the sources that ended alone or did not run alone, a stall of the machine's load, exit 1, nothing written.
 */
function stallsOf(file, ran, area, shard, out, refuse) {
  if (!/^[^/]+$/.test(area) || !/^\d+\/\d+$/.test(shard))
    refuse(`${area} ${shard} is no area's shard i/N`);
  const runs = new Map(
    (ran === "-" ? [] : linesOf(ran, refuse)).map((line) => [placeIn(line), line]),
  );
  const stalls = [];
  const load = [];
  for (const line of linesOf(file, refuse).filter((source) => source.stalled !== undefined)) {
    const { generator, source, key, stalled } = line;
    const run = runs.get(placeIn(line));
    if (run?.stalled !== undefined)
      stalls.push({ area, shard, generator, source, key, stalled, alone: run });
    else
      load.push({
        generator,
        source,
        key,
        stalled,
        alone: run === undefined ? "not run" : "ended",
      });
  }
  if (load.length > 0) {
    console.log(JSON.stringify({ load }));
    return 1;
  }
  const target = pathOf(out, "outside");
  rmSync(target, { force: true });
  writeFileSync(target, `${JSON.stringify({ area, shard, stalls })}\n`, { flag: "wx" });
  console.log(JSON.stringify({ stalls: stalls.length }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const readOnly = args.includes("--read-only");
  const named = args.filter((arg) => !arg.startsWith("--"));
  const [first, second] = named;
  /** A folder that lies in a baseline, or no baseline where one is named, refused (exit 2). */
  const refused = (why) => {
    console.error(why);
    process.exit(2);
  };
  const out = (file) => outside(file, [], refused);
  if (command === "state" && second !== undefined)
    process.exitCode = await state(path.resolve(first), out(second), readOnly);
  else if (command === "start" && second !== undefined)
    process.exitCode = await start(baselineAt(first, refused), second);
  else if (command === "queue" && second !== undefined)
    process.exitCode = await queue(baselineAt(first, refused), path.resolve(second));
  else if (command === "seed" && named.length === 2)
    process.exitCode = await seed(path.resolve(first), out(second), refused);
  else if (command === "compiled" && named.length === 2) {
    const outcome = await compiledInto(out(second), path.resolve(first));
    console.log(JSON.stringify(outcome));
    process.exitCode = outcome.refused === undefined ? 0 : 2;
  } else if (command === "import" && [2, 4, 5].includes(named.length))
    process.exitCode = await importing(out(first), second, named[2], named[3], named[4], refused);
  else if (command === "status" && named.length === 2)
    process.exitCode = statusOf(out(first), second);
  else if (command === "alone" && named.length === 3)
    await alone(path.resolve(first), second, out(named[2]), refused);
  else if (command === "stalls" && named.length === 5)
    process.exitCode = stallsOf(first, second, named[2], named[3], out(named[4]), refused);
  else {
    console.error(
      "usage: node tests/families/baselines.mjs state <tree> <folder> [--read-only]\n" +
        "       node tests/families/baselines.mjs start <baseline> <current src tree>\n" +
        "       node tests/families/baselines.mjs queue <baseline> <script>\n" +
        "       node tests/families/baselines.mjs seed <tree> <folder>\n" +
        "       node tests/families/baselines.mjs compiled <tree> <folder>\n" +
        "       node tests/families/baselines.mjs import <central folder> <computed folder> [<area> <i>/<N> [<stalls.json>]]\n" +
        "       node tests/families/baselines.mjs status <central folder> <src tree>\n" +
        "       node tests/families/baselines.mjs alone <area folder> <shard> <new area folder>\n" +
        "       node tests/families/baselines.mjs stalls <shard> <alone shard or -> <area> <i>/<N> <stalls.json>",
    );
    process.exitCode = 2;
  }
}
