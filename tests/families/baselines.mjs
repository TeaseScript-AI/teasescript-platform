// node tests/families/baselines.mjs state <tree> <folder> [--read-only]
// node tests/families/baselines.mjs prune <folder>
// node tests/families/baselines.mjs start <baseline> <current src tree>
// node tests/families/baselines.mjs queue <baseline> <script>
// The corpus runner's stored baselines (#1541): every read and write of <folder>/<src tree>/ is here. A baseline holds
// the runs of the trees of one `src/` tree (`git rev-parse <commit>:src`) whose runs depend on the same inputs beside it:
// the oracle library as built (`dist/tests/helpers/type-core-oracles.js` and the helpers it imports), the lockfile and
// Node. Its folder is this tool's only when this tool made it with its MANIFEST already inside (written in a folder of
// its own in <folder>, then renamed into place). The MANIFEST names the src tree and those inputs, which every writer
// must share, then, appended and never rewritten, each commit stored there and each area with its PLAN's hash, recorded
// before the area is made. This tool knows each path it writes: the MANIFEST, the hook's markers and copy, and in each
// recorded area its PLAN and its planned shards' files and claims, with their temporary files. Any other path is
// foreign.
//
// Nothing is written into a baseline but through `gate`: the folder must be this tool's (its MANIFEST's first line,
// read before anything else), the gate holds the baseline's lock (`flock` on a descriptor of its folder) and checks
// that no foreign path is there, then writes; a writer whose baseline was retired while it waited starts a new one. A
// folder holding
// a foreign path is neither written into (the writer is refused, exit 2, naming the path) nor removed. The gate removes
// the temporary files a writer that ended (killed) left. An area's PLAN,
// made by its first writer, binds its run: each shard's sources in their order, each generator's checks, the
// allowances and limits; a writer that would run another is refused ("another plan"). A recorded area not made yet,
// or made without its PLAN, is the next writer's to finish. A shard counts only once verified: its last line, its
// total, names the PLAN, its sources and the hash of every line before it. One running writer at a time stores a shard
// (its claim) and publishes it whole: a new shard by a hard link, so the first stays, one that does not verify by a
// rename over it.
//
// `state` prints each area of a built tree (the folders of tests/families/ with generators, and tools/corpus/fixture/)
// as one JSON line: `complete`, `another plan` (its PLAN is not the tree's), `storing` (a running writer's claim),
// `damaged` (a stored shard that does not verify), `partial` or `absent`, with the shards to store; then a line for the
// baseline. It makes or joins the baseline and appends the tree's commit, unless `--read-only`, and plans an area that is
// already complete again only with `--read-only`. It exits 0 when every area is complete, 1 when one is not, 2 when the
// folder is not this tool's, holds a foreign path or holds the runs of other inputs. `start` is a fill job's first
// decision (`tools/corpus/baseline.sh`): STARTED where the baseline is the current tree's or the fill began, else
// SUPERSEDED (the current tree). `queue` copies the hook's script into the baseline for its jobs and undoes SUPERSEDED.
// `prune` retires each baseline none of whose trees remains and into which no writer stores: through the gate it
// decides from the MANIFEST and renames the folder to a `.pruning-` folder of its own, then removes that. A folder this
// tool made outside a baseline (`.pruning-`, `.creating-`) is removed once its writer ended, if it holds this tool's
// MANIFEST and no foreign path; any other folder in <folder> is kept, and one kept for a foreign path is named.
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

/** What a tree's stored runs depend on: its `src/` tree, its oracle library, its lockfile and this Node. */
export function identityOf(tree) {
  return {
    src: treeId(path.join(tree, "src"))?.toString("hex") ?? null,
    oracles: oraclesId(path.join(tree, "dist", "tests", "helpers")),
    lock: blobId(path.join(tree, "package-lock.json")),
    node: process.version,
  };
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
const creatingName = (src, writer) => `.${src}.creating-${writer}`;
const retiredName = (src, writer) => `.pruning-${src}-${writer}`;

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

/** The writer of a folder this tool made beside its baselines (`.creating-`, `.pruning-`), else undefined. */
function leftoverOf(name) {
  const parts =
    /^\.(.+)\.creating-(\d+-\d+)$/.exec(name) ?? /^\.pruning-(.+)-(\d+-\d+)$/.exec(name);
  const writer = parts === null ? undefined : writerOf(parts[2]);
  if (writer === undefined || !isBaselineName(parts[1])) return undefined;
  return [creatingName(parts[1], writer), retiredName(parts[1], writer)].includes(name)
    ? writer
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
  name === "MANIFEST" ||
  ["STARTED", "SUPERSEDED", "baseline.sh"].includes(temporaryOf(name)?.name ?? name);

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

/** What `gate` returns where the baseline was retired (renamed by `prune`) while this process waited for its lock. */
const RETIRED = Symbol("retired");

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
// and no folder of baselines it was checked against), `beside` (a folder of this tool's beside the baselines of such a
// folder, which no baseline is nor holds) or `baseline` (a baseline's folder in such a folder). `pathOf` gives its
// path, and refuses anything else before any filesystem call, so that no writer can write by a path's unchecked
// spelling.
const checked = new WeakMap();
function checkedPath(real, kind) {
  const value = Object.freeze({});
  checked.set(value, { real, kind });
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
  let baseline;
  for (let folder = real; baseline === undefined; folder = path.dirname(folder)) {
    if (isOwned(folder)) baseline = folder;
    if (path.dirname(folder) === folder) break;
  }
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

/** The folder `name` of this tool's beside the baselines in `root` (an `outside` path): `.`-named, which no baseline is. */
export function beside(root, name) {
  if (!/^\.[^/]+$/.test(name) || name === "..")
    throw new Error(`${name} is no name of a folder beside the baselines`);
  return checkedPath(path.join(pathOf(root, "outside"), name), "beside");
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
 * written in a `.creating-` folder of this writer's, which is then renamed into place (onto no folder or an empty one;
 * a folder holding anything stays as it is). Then joined through the gate, `line` appended to its MANIFEST once; one
 * retired while this writer waited is made anew. `refused` says why it is not this tool's, holds foreign paths or holds
 * the runs of other inputs.
 */
export async function owned(root, identity, line) {
  const baseline = baselineIn(root, identity.src);
  const dir = pathOf(baseline, "baseline");
  const header = headerOf(identity);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (line !== null && !existsSync(path.join(dir, "MANIFEST"))) {
      mkdirSync(pathOf(root, "outside"), { recursive: true });
      const creating = beside(root, creatingName(identity.src, WRITER));
      mkdirSync(pathOf(creating, "beside"));
      writeFileSync(path.join(pathOf(creating, "beside"), "MANIFEST"), header);
      try {
        renameSync(pathOf(creating, "beside"), pathOf(baseline, "baseline"));
      } catch (error) {
        rmSync(pathOf(creating, "beside"), { recursive: true, force: true });
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      }
    }
    if (!existsSync(dir)) return { baseline, dir, absent: true };
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
    if (joined !== RETIRED) return { baseline, dir, ...joined };
  }
  return { baseline, dir, refused: `${dir} was retired each time this writer joined it` };
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

/** Whether a stored shard verifies: its last line, its total, names `plan` and `places`, and hashes every line before it. */
export function verified(file, plan, places) {
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return false;
  }
  const cut = body.lastIndexOf(10, body.length - 2);
  let total;
  try {
    ({ total } = JSON.parse(body.subarray(cut + 1).toString()));
  } catch {
    return false;
  }
  return (
    total?.plan === plan &&
    total?.places === places &&
    total?.lines === hash(body.subarray(0, cut + 1))
  );
}

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
export async function planned(baseline, area, plan) {
  const top = pathOf(baseline, "baseline");
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
    created(path.join(top, area, "PLAN"), plan);
    return {};
  });
  if (outcome === RETIRED) return { refused: `${top} was retired while this writer planned it` };
  return outcome.refused === undefined ? { plan: id, shards, places } : outcome;
}

/**
 * A shard to store (through the gate): `skipped` where it verifies or a running writer stores it, else this process's
 * claim; `refused` where the baseline refuses the writer.
 */
export async function beginShard(baseline, area, shard, shards, plan, places) {
  const top = pathOf(baseline, "baseline");
  const dir = path.join(top, area);
  const file = shardFile(dir, shard, shards);
  const outcome = await gate(baseline, () => {
    if (verified(file, plan, places)) return { skipped: "stored" };
    if (!claimed(path.join(dir, claimName(shard, shards))))
      return { skipped: "being stored by another writer" };
    return {};
  });
  if (outcome === RETIRED) return { refused: `${top} was retired while this writer began a shard` };
  return { baseline, dir, file, shard, shards, plan, places, ...outcome };
}

/**
 * The shard published whole through the gate, its lines (`lines`) then its total last: a new one by a hard link, one
 * that does not verify by a rename over it, one another writer published meanwhile kept; the claim released. Whether
 * the shard then verifies, or why the baseline refused it.
 */
export async function endShard({ baseline, dir, file, shard, shards, plan, places }, lines, total) {
  const top = pathOf(baseline, "baseline");
  const body = lines.join("");
  const ended = `${JSON.stringify({ total: { ...total, plan, places, lines: hash(body) } })}\n`;
  const outcome = await gate(baseline, () => {
    const tmp = temporaryName(file, WRITER);
    writeFileSync(tmp, body + ended);
    try {
      linkSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!verified(file, plan, places)) renameSync(tmp, file);
    }
    rmSync(tmp, { force: true });
    const claim = path.join(dir, claimName(shard, shards));
    if (existsSync(claim) && readFileSync(claim, "utf8").trim() === WRITER)
      rmSync(claim, { force: true });
    return {};
  });
  if (outcome === RETIRED)
    return { refused: `${top} was retired while this writer stored into it` };
  return outcome.refused === undefined ? { verified: verified(file, plan, places) } : outcome;
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
  const records = own.absent
    ? new Map()
    : recorded(readFileSync(path.join(own.dir, "MANIFEST"), "utf8"));
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
      const good = places.map((place, shard) =>
        verified(shardFile(dir, shard, shards), record.plan, place),
      );
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
 * tree's (SUPERSEDED undone) or the fill already began, else SUPERSEDED, naming the current tree. The decision printed.
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
  console.log(JSON.stringify(outcome === RETIRED ? { refused: `${dir} was retired` } : outcome));
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
  console.log(JSON.stringify(outcome === RETIRED ? { refused: `${dir} was retired` } : outcome));
  return outcome === RETIRED || outcome.refused !== undefined ? 2 : 0;
}

/**
 * A folder this tool made outside a baseline (`.pruning-…` or `.creating-…`, named by its writer) removed once that
 * writer ended (`writer`, or this process where it is null), where it is empty or holds this tool's MANIFEST and no
 * foreign path; else kept, and named (as is one so named but not by a writer of this tool, `writer` undefined).
 */
function recover(folder, writer) {
  const dir = pathOf(folder, "beside");
  if (writer === undefined) {
    console.log(JSON.stringify({ kept: dir, foreign: ["(not named by a writer of this tool)"] }));
    return;
  }
  if (writer !== null && running(writer)) return;
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    const text = isOwned(dir) ? readFileSync(path.join(dir, "MANIFEST"), "utf8") : null;
    const foreign = text === null ? ["(no MANIFEST of this tool)"] : foreignIn(dir, text);
    if (foreign.length > 0) {
      console.log(JSON.stringify({ kept: dir, foreign }));
      return;
    }
    // the MANIFEST last, so that a removal cut short leaves a folder still this tool's, for the next call to finish
    for (const entry of entries.filter((name) => name !== "MANIFEST"))
      rmSync(path.join(dir, entry), { recursive: true, force: true });
    rmSync(path.join(dir, "MANIFEST"), { force: true });
  }
  rmdirSync(dir);
}

/**
 * Each baseline of this tool in `root` none of whose trees remains and into which no writer stores, retired: decided
 * through the gate from its MANIFEST and renamed there to a `.pruning-` folder of this writer's, which is then removed
 * as `recover` removes one; a baseline the gate refuses for a foreign path is kept and named. A folder that is not this
 * tool's is not touched.
 */
async function prune(root) {
  const folder = pathOf(root, "outside");
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // (a folder named as this tool names one beside its baselines, which may be another's: `recover` decides)
    if (/^\.(?:pruning-|.*\.creating-)/.test(entry.name)) {
      recover(beside(root, entry.name), leftoverOf(entry.name));
      continue;
    }
    if (!isBaselineName(entry.name) || !isOwned(path.join(folder, entry.name))) continue;
    const baseline = baselineIn(root, entry.name);
    const dir = pathOf(baseline, "baseline");
    const retired = beside(root, retiredName(entry.name, WRITER));
    const outcome = await gate(baseline, (text) => {
      const trees = [...text.matchAll(/^commit \S+ (.+)$/gm)].map(([, tree]) => tree);
      if (trees.length === 0 || trees.some((tree) => existsSync(tree))) return null;
      const areas = [...recorded(text)];
      if (areas.some(([area, { shards }]) => claimedIn(path.join(dir, area), shards))) return null;
      renameSync(pathOf(baseline, "baseline"), pathOf(retired, "beside"));
      return { pruned: dir };
    });
    if (outcome?.foreign !== undefined)
      console.log(JSON.stringify({ kept: dir, foreign: outcome.foreign }));
    else if (outcome?.pruned !== undefined) {
      recover(retired, null);
      console.log(JSON.stringify(outcome));
    }
  }
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
  else if (command === "prune" && first !== undefined) await prune(outside(first, [], refused));
  else if (command === "start" && second !== undefined)
    process.exitCode = await start(baselineAt(first, refused), second);
  else if (command === "queue" && second !== undefined)
    process.exitCode = await queue(baselineAt(first, refused), path.resolve(second));
  else {
    console.error(
      "usage: node tests/families/baselines.mjs state <tree> <folder> [--read-only]\n" +
        "       node tests/families/baselines.mjs prune <folder>\n" +
        "       node tests/families/baselines.mjs start <baseline> <current src tree>\n" +
        "       node tests/families/baselines.mjs queue <baseline> <script>",
    );
    process.exitCode = 2;
  }
}
