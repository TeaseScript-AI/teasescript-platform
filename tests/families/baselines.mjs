// node tests/families/baselines.mjs state <tree> <folder> [--read-only]
// node tests/families/baselines.mjs start <baseline> <current src tree>
// node tests/families/baselines.mjs queue <baseline> <script>
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
// the current tree's, else SUPERSEDED (the current tree), also once the fill began; its stored shards stay and are read
// as any others. `queue` copies the hook's script into the baseline for its jobs and undoes SUPERSEDED. Nothing here
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
 * appended to its MANIFEST once. `refused` says why it is not this tool's, holds foreign paths or holds the runs of
 * other inputs.
 */
export async function owned(root, identity, line) {
  const dir = pathOf(baselineIn(root, identity.src), "baseline");
  const header = headerOf(identity);
  const why = stale(root);
  if (why !== undefined) return { dir, refused: why };
  if (line !== null && !existsSync(path.join(dir, "MANIFEST"))) {
    const made = baselineIn(root, identity.src);
    mkdirSync(pathOf(made, "baseline"), { recursive: true });
    if (
      readdirSync(pathOf(made, "baseline")).every((name) => temporaryOf(name)?.name === "MANIFEST")
    ) {
      const tmp = path.join(pathOf(made, "baseline"), temporaryName("MANIFEST", WRITER));
      writeFileSync(tmp, header);
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
      return { refused: `${dir} holds runs of another ${differs.join(", ")} than this tree's` };
    }
    if (line !== null && !text.split("\n").includes(line))
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
  const identity = identityOf(tree);
  if (identity.src === null) {
    console.error(`${tree}/src holds no file`);
    return 2;
  }
  const sha = readFileSync(path.join(tree, ".sha"), "utf8").trim();
  const own = await owned(root, identity, readOnly ? null : `commit ${sha} ${tree}`);
  const refusal = (refused, foreign) =>
    console.log(JSON.stringify({ src: identity.src, baseline: own.dir, refused, foreign }));
  if (own.refused !== undefined) {
    refusal(own.refused, own.foreign);
    return 2;
  }
  const areas = areasOf(tree);
  if (areas.length === 0) {
    refusal(`${tree} has no area of the runner`);
    return 2;
  }
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
      if (other >= 0) {
        refusal(otherInputs(own.dir, shardFile(dir, other, shards), read[other].other));
        return 2;
      }
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
    console.log(JSON.stringify(line));
  }
  console.log(JSON.stringify({ src: identity.src, baseline: own.dir, complete, storing }));
  return complete ? 0 : 1;
}

/**
 * A fill job's first decision for the baseline `dir` (through the gate): STARTED where the baseline is the current
 * tree's (SUPERSEDED undone; STARTED written once, when the fill began), else SUPERSEDED, naming the current tree, also
 * once the fill began (#1567). The decision printed.
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const readOnly = args.includes("--read-only");
  const [first, second] = args.filter((arg) => !arg.startsWith("--"));
  /** A folder that lies in a baseline, or no baseline where one is named, refused (exit 2). */
  const refused = (why) => {
    console.error(why);
    process.exit(2);
  };
  if (command === "state" && second !== undefined)
    process.exitCode = await state(path.resolve(first), outside(second, [], refused), readOnly);
  else if (command === "start" && second !== undefined)
    process.exitCode = await start(baselineAt(first, refused), second);
  else if (command === "queue" && second !== undefined)
    process.exitCode = await queue(baselineAt(first, refused), path.resolve(second));
  else {
    console.error(
      "usage: node tests/families/baselines.mjs state <tree> <folder> [--read-only]\n" +
        "       node tests/families/baselines.mjs start <baseline> <current src tree>\n" +
        "       node tests/families/baselines.mjs queue <baseline> <script>",
    );
    process.exitCode = 2;
  }
}
