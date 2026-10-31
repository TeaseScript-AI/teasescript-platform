// node tests/families/baselines.mjs state <tree> <folder> [--read-only]
// node tests/families/baselines.mjs prune <folder>
// The corpus runner's stored baselines (#1541): every read and write of <folder>/<src tree>/ is here. A baseline holds
// the runs of the trees of one `src/` tree (`git rev-parse <commit>:src`) whose runs depend on the same inputs beside it:
// the oracle library as built (`dist/tests/helpers/type-core-oracles.js` and the helpers it imports), the lockfile and
// Node. Its folder is this tool's only when this tool made it with its MANIFEST already inside (written whole, then the
// folder renamed into place). The MANIFEST names the src tree and those inputs, which every writer must share, then,
// appended and never rewritten, each commit stored there and each area's PLAN. This tool knows each path it writes:
// the MANIFEST, its locks, the hook's markers and copy, and in each area the MANIFEST names its PLAN and its planned
// shards' files, claims and temporary files; any other path is foreign, and a folder holding one is neither written
// into (a writer is refused, exit 2, naming it) nor removed. An area's PLAN, made whole by its first writer, binds its
// run: each shard's sources in their order, each generator's checks, the allowances and limits; a writer that would run
// another is refused. A shard counts only once verified: its last line, its total, names the PLAN, its sources and the
// hash of every line before it. One running writer at a time stores a shard (its claim), and publishes it whole: a new
// shard by a hard link, so the first stays, one that does not verify by a rename over it. An area is complete when
// each planned shard verifies. Joining a baseline, planning an area, publishing a shard and pruning hold the baseline's
// lock (`flock` on its `.lock`); a writer whose baseline was retired while it waited starts a new one.
//
// `state` prints each area of a built tree (the folders of tests/families/ with generators, and tools/corpus/fixture/)
// as one JSON line: `complete`, `another plan` (its PLAN is not the tree's), `storing` (a running writer's claim),
// `damaged` (a stored shard that does not verify), `partial` or `absent`, with the shards to store; then a line for the
// baseline. It makes or joins the baseline and appends the tree's commit, unless `--read-only`, and plans an area that is
// already complete again only with `--read-only`. It exits 0 when every area is complete, 1 when one is not, 2 when the
// folder is not this tool's, holds foreign paths or holds the runs of other inputs. `prune` retires each baseline of this
// tool none of whose trees remains, into which no writer is storing and that holds no foreign path: under its lock it
// reads the MANIFEST, decides and renames the folder to a `.pruning-` sibling, then removes that.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
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

/** `file` made whole with `text` where it does not exist yet, else left as another writer made it: what it holds. */
export function created(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
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

/** What `locked` returns where the baseline was retired (renamed by `prune`) while this process waited for its lock. */
const RETIRED = Symbol("retired");

/**
 * `action`'s result, run while this process holds the baseline's lock: `flock` on `<dir>/.lock`, held by a child that
 * ends with this process; `RETIRED` where the folder was gone or replaced once the lock was held.
 */
async function locked(dir, action) {
  let before;
  try {
    before = statSync(dir).ino;
  } catch {
    return RETIRED;
  }
  const holder = spawn(
    "flock",
    [path.join(dir, ".lock"), "-c", "echo held && exec cat > /dev/null"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const held = await new Promise((resolve) => {
    holder.stdout.once("data", () => resolve(true));
    holder.once("error", () => resolve(false));
    holder.once("exit", () => resolve(false));
  });
  try {
    if (!held) return RETIRED;
    let now;
    try {
      now = statSync(dir).ino;
    } catch {
      return RETIRED;
    }
    return now === before ? await action() : RETIRED;
  } finally {
    holder.stdin.end();
  }
}

/** A path this tool writes at a baseline's top: its MANIFEST, its locks, the hook's markers and copy. */
const TOOL_TOP =
  /^(MANIFEST|\.lock|\.queue\.lock|\.start\.lock|STARTED(\.tmp)?|SUPERSEDED(\.tmp)?|baseline\.sh(\.tmp)?)$/;

/** A file this tool writes in an area of `shards` shards: its PLAN, each shard's file, claim and temporary files. */
function toolFile(name, shards) {
  if (/^PLAN(\.\d+\.tmp)?$/.test(name)) return true;
  const shard =
    /^(\d+)of(\d+)\.runs\.jsonl$/.exec(name) ??
    /^\.(\d+)of(\d+)\.(?:claim(?:\.\d+\.tmp)?|runs\.jsonl\.\d+-\d+\.tmp)$/.exec(name);
  return shard !== null && Number(shard[2]) === shards && Number(shard[1]) < shards;
}

/** The paths of a baseline (`dir`, its MANIFEST's `text`) this tool did not write (see above), each relative to it. */
function foreignIn(dir, text) {
  const areas = new Map(
    [...text.matchAll(/^area (\S+) (\d+) [0-9a-f]{64}$/gm)].map(([, name, shards]) => [
      name,
      Number(shards),
    ]),
  );
  const foreign = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && areas.has(entry.name)) {
      for (const inner of readdirSync(path.join(dir, entry.name), { withFileTypes: true }))
        if (!inner.isFile() || !toolFile(inner.name, areas.get(entry.name)))
          foreign.push(`${entry.name}/${inner.name}${inner.isDirectory() ? "/" : ""}`);
    } else if (!entry.isFile() || !TOOL_TOP.test(entry.name))
      foreign.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }
  return foreign.sort();
}

/** Whether a folder's MANIFEST is this tool's (its first line), read before any lock, so as to write nothing into another's. */
function isOwned(dir) {
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

/** Why a baseline holding foreign paths is refused. */
const foreignly = (dir, foreign) =>
  `${dir} holds foreign contents, which this tool did not write: ${foreign.join(", ")}`;

/**
 * The baseline of a tree's identity in `root`: made (unless `line` is null) whole with its MANIFEST and renamed into
 * place, or joined under its lock, `line` appended to its MANIFEST once; one retired while this process waited is made
 * anew. `refused` says why it is not this tool's, holds foreign paths or holds the runs of other inputs.
 */
export async function owned(root, identity, line) {
  const dir = path.join(root, identity.src);
  const manifest = path.join(dir, "MANIFEST");
  const header = headerOf(identity);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (line !== null && !existsSync(manifest)) {
      mkdirSync(root, { recursive: true });
      const tmp = mkdtempSync(path.join(root, `.${identity.src}.`));
      writeFileSync(path.join(tmp, "MANIFEST"), header);
      try {
        // (onto a folder that does not exist or is empty; a folder holding anything stays as it is)
        renameSync(tmp, dir);
      } catch (error) {
        rmSync(tmp, { recursive: true, force: true });
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      }
    }
    if (!existsSync(dir)) return { dir, absent: true };
    if (!isOwned(dir))
      return { dir, refused: `${dir} is not this tool's: it has no MANIFEST of this tool` };
    const joined = await locked(dir, () => {
      const text = readFileSync(manifest, "utf8");
      if (!text.startsWith(header)) {
        const [ours, theirs] = [header, text].map((part) => part.split("\n").slice(1, 5));
        const differs = ours
          .filter((field, index) => field !== theirs[index])
          .map((field) => field.split(" ")[0]);
        return {
          dir,
          refused: `${dir} holds runs of another ${differs.join(", ")} than this tree's`,
        };
      }
      const foreign = foreignIn(dir, text);
      if (foreign.length > 0) return { dir, refused: foreignly(dir, foreign), foreign };
      if (line !== null && !text.split("\n").includes(line)) appendFileSync(manifest, `${line}\n`);
      return { dir };
    });
    if (joined !== RETIRED) return joined;
  }
  return { dir, refused: `${dir} was retired each time this writer joined it` };
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
export const shardFile = (dir, shard, shards) => path.join(dir, `${shard}of${shards}.runs.jsonl`);

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

/** A process's start time (Linux's `/proc`), which with its pid names one process for good; none once it ended. */
function startOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** This process, as its claims and temporary files name it. */
export const WRITER = `${process.pid} ${startOf(process.pid)}`;

/** Whether a writer (`<pid> <start time>`, as a claim or a temporary file names it) still runs. */
const running = (writer) => {
  const [pid, start] = writer.trim().split(/[ -]/);
  return start !== undefined && startOf(Number(pid)) === start;
};

/** Whether a running writer claims a shard of the area in `dir`, or the shard `shard` of `shards` only. */
function claimedIn(dir, shard, shards) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (name) =>
      (shard === undefined
        ? /^\.\d+of\d+\.claim$/.test(name)
        : name === `.${shard}of${shards}.claim`) &&
      running(readFileSync(path.join(dir, name), "utf8")),
  );
}

/**
 * This process's claim on a shard, taken while no running writer holds it: a writer that ended without releasing its
 * claim (killed) holds it no longer. Two writers may still both take it after such an end; they then store the same
 * shard, and the first to publish it keeps it.
 */
function claimed(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let holder;
    try {
      holder = created(file, `${WRITER}\n`).trim();
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (holder === WRITER) return true;
    if (running(holder)) return false;
    rmSync(file, { force: true });
  }
  return false;
}

/**
 * The area of a baseline (`dir`, its MANIFEST in `top`) planned as `plan`, made whole by its first writer under the
 * baseline's lock, with its MANIFEST line: the PLAN's hash and each shard's hash of places, or why it is refused.
 */
export async function planned(top, dir, plan) {
  const outcome = await locked(top, () => {
    const manifest = path.join(top, "MANIFEST");
    const foreign = foreignIn(top, readFileSync(manifest, "utf8"));
    if (foreign.length > 0) return { refused: foreignly(top, foreign) };
    mkdirSync(dir, { recursive: true });
    const stored = created(path.join(dir, "PLAN"), plan);
    if (stored !== plan)
      return {
        refused: `${dir} is planned otherwise (another set, order or count of shards, or checks)`,
      };
    const line = `area ${path.basename(dir)} ${parsePlan(plan).shards} ${hash(plan)}`;
    if (!readFileSync(manifest, "utf8").split("\n").includes(line))
      appendFileSync(manifest, `${line}\n`);
    return { plan: hash(plan), ...parsePlan(plan) };
  });
  return outcome === RETIRED
    ? { refused: `${top} was retired while this writer planned it` }
    : outcome;
}

/**
 * A shard to store: `skipped` where it verifies or a running writer stores it, else this process's claim and the
 * temporary file it writes, a dead writer's temporary files of the shard removed.
 */
export function beginShard(top, dir, shard, shards, plan, places) {
  const file = shardFile(dir, shard, shards);
  const claim = path.join(dir, `.${shard}of${shards}.claim`);
  if (verified(file, plan, places)) return { file, skipped: "stored" };
  if (!claimed(claim)) return { file, skipped: "being stored by another writer" };
  // (stored between the look and the claim)
  if (verified(file, plan, places)) {
    rmSync(claim, { force: true });
    return { file, skipped: "stored" };
  }
  const prefix = `.${path.basename(file)}.`;
  for (const entry of readdirSync(dir))
    if (
      entry.startsWith(prefix) &&
      entry.endsWith(".tmp") &&
      !running(entry.slice(prefix.length, -4))
    )
      rmSync(path.join(dir, entry), { force: true });
  const tmp = `${dir}/${prefix}${WRITER.replace(" ", "-")}.tmp`;
  writeFileSync(tmp, "");
  return { top, file, claim, tmp, plan, places };
}

/**
 * The shard published whole under the baseline's lock, its total last: a new one by a hard link, one that does not
 * verify by a rename over it, one another writer published meanwhile kept; not at all where the baseline holds foreign
 * paths or was retired (`refused`); the claim released. Whether the shard then verifies.
 */
export async function endShard({ top, file, claim, tmp, plan, places }, total) {
  const lines = hash(readFileSync(tmp));
  appendFileSync(tmp, `${JSON.stringify({ total: { ...total, plan, places, lines } })}\n`);
  const outcome = await locked(top, () => {
    const foreign = foreignIn(top, readFileSync(path.join(top, "MANIFEST"), "utf8"));
    if (foreign.length > 0) return { refused: foreignly(top, foreign) };
    try {
      linkSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!verified(file, plan, places)) renameSync(tmp, file);
    }
    return {};
  });
  rmSync(tmp, { force: true });
  if (existsSync(claim) && readFileSync(claim, "utf8").trim() === WRITER)
    rmSync(claim, { force: true });
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
  if (own.refused !== undefined) {
    const { refused, foreign } = own;
    console.log(JSON.stringify({ src: identity.src, baseline: own.dir, refused, foreign }));
    return 2;
  }
  const areas = areasOf(tree);
  if (areas.length === 0) {
    console.log(
      JSON.stringify({
        src: identity.src,
        baseline: own.dir,
        refused: `${tree} has no area of the runner`,
      }),
    );
    return 2;
  }
  let complete = true;
  let storing = false;
  for (const folder of areas) {
    const area = path.basename(folder);
    const dir = path.join(own.dir, area);
    const stored = existsSync(path.join(dir, "PLAN"))
      ? readFileSync(path.join(dir, "PLAN"), "utf8")
      : null;
    const { shards, places } = stored === null ? { shards: 0, places: [] } : parsePlan(stored);
    const id = stored === null ? null : hash(stored);
    const good = places.map((place, shard) => verified(shardFile(dir, shard, shards), id, place));
    const count = good.filter(Boolean).length;
    let line;
    if (stored === null) line = { area, folder, state: "absent", store: "all" };
    else if (
      (readOnly || count < shards) &&
      planOf(area, await generatorsOf(folder), shards) !== stored
    )
      line = { area, folder, state: "another plan" };
    else {
      const store = good.flatMap((ok, shard) =>
        ok || claimedIn(dir, shard, shards) ? [] : [shard],
      );
      const damaged = good.filter(
        (ok, shard) => !ok && existsSync(shardFile(dir, shard, shards)),
      ).length;
      const name =
        count === shards
          ? "complete"
          : claimedIn(dir)
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
    if (line.state !== "complete") complete = false;
    if (line.state === "storing") storing = true;
    console.log(JSON.stringify(line));
  }
  console.log(JSON.stringify({ src: identity.src, baseline: own.dir, complete, storing }));
  return complete ? 0 : 1;
}

/**
 * Each baseline of this tool in `root` none of whose trees remains, into which no writer stores and that holds no
 * foreign path, retired: decided from its MANIFEST read under its lock and renamed to a `.pruning-` sibling under it,
 * then removed; one kept for a foreign path is named. A `.pruning-` folder left by an earlier call is removed.
 */
async function prune(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".pruning-")) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    // (a folder that is not this tool's is never locked: `flock` would write its `.lock` into it)
    if (entry.name.startsWith(".") || !isOwned(dir)) continue;
    const outcome = await locked(dir, () => {
      const text = readFileSync(path.join(dir, "MANIFEST"), "utf8");
      if (!text.startsWith("baseline 3\n")) return null;
      const trees = [...text.matchAll(/^commit \S+ (.+)$/gm)].map(([, tree]) => tree);
      if (trees.length === 0 || trees.some((tree) => existsSync(tree))) return null;
      const areas = readdirSync(dir, { withFileTypes: true }).filter((area) => area.isDirectory());
      if (areas.some((area) => claimedIn(path.join(dir, area.name)))) return null;
      const foreign = foreignIn(dir, text);
      if (foreign.length > 0) return { kept: dir, foreign };
      const retired = path.join(root, `.pruning-${entry.name}-${process.pid}-${Date.now()}`);
      renameSync(dir, retired);
      return { pruned: dir, retired };
    });
    if (outcome?.retired !== undefined) {
      rmSync(outcome.retired, { recursive: true, force: true });
      console.log(JSON.stringify({ pruned: outcome.pruned }));
    } else if (outcome?.kept !== undefined) console.log(JSON.stringify(outcome));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const readOnly = args.includes("--read-only");
  const [first, second] = args.filter((arg) => !arg.startsWith("--"));
  if (command === "state" && second !== undefined)
    process.exitCode = await state(path.resolve(first), second, readOnly);
  else if (command === "prune" && first !== undefined) await prune(first);
  else {
    console.error(
      "usage: node tests/families/baselines.mjs state <tree> <folder> [--read-only]\n" +
        "       node tests/families/baselines.mjs prune <folder>",
    );
    process.exitCode = 2;
  }
}
