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
// read before anything else), the gate holds the baseline's lock (`flock` on its folder) and checks that no foreign
// path is there, then writes; a writer whose baseline was retired while it waited starts a new one. A folder holding
// a foreign path is neither written into (the writer is refused, exit 2, naming the path) nor removed. An area's PLAN,
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

/** This process, as its claims and temporary files and folders name it (`<pid>-<start time>`). */
export const WRITER = `${process.pid}-${startOf(process.pid)}`;

/** Whether a writer (`<pid>-<start time>`) still runs. */
const running = (writer) => {
  const [pid, start] = writer.trim().split("-");
  return start !== undefined && startOf(Number(pid)) === start;
};

/** Whether a folder carries this tool's MANIFEST (its first line), read without writing anything into the folder. */
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

/** A path this tool writes at a baseline's top: its MANIFEST, the hook's markers and copy, with their temporary files. */
const TOOL_TOP = /^(MANIFEST|(STARTED|SUPERSEDED|baseline\.sh)(\.\d+-\d+\.tmp)?)$/;

/** A file this tool writes in an area of `shards` shards: its PLAN, each shard's file and claim, their temporary files. */
function toolFile(name, shards) {
  if (/^PLAN(\.\d+-\d+\.tmp)?$/.test(name)) return true;
  const shard = /^(?:(\d+)of(\d+)\.runs\.jsonl|\.(\d+)of(\d+)\.claim)(?:\.\d+-\d+\.tmp)?$/.exec(
    name,
  );
  if (shard === null) return false;
  const [index, count] = shard[1] !== undefined ? [shard[1], shard[2]] : [shard[3], shard[4]];
  return Number(count) === shards && Number(index) < shards;
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
        if (!inner.isFile() || !toolFile(inner.name, areas.get(entry.name).shards))
          foreign.push(`${entry.name}/${inner.name}${inner.isDirectory() ? "/" : ""}`);
    } else if (!entry.isFile() || !TOOL_TOP.test(entry.name))
      foreign.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }
  return foreign.sort();
}

/** What `gate` returns where the baseline was retired (renamed by `prune`) while this process waited for its lock. */
const RETIRED = Symbol("retired");

/**
 * `action(text)`, given the MANIFEST's text: the one way anything is written into a baseline (`dir`). The folder must be
 * this tool's; the action runs while this process holds the baseline's lock (`flock` on the folder, held by a child
 * that ends with this process) and only where the folder holds no foreign path (else `refused`, naming the paths);
 * `RETIRED` where the folder was gone or replaced once the lock was held.
 */
async function gate(dir, action) {
  if (!isOwned(dir))
    return { refused: `${dir} is not this tool's: it has no MANIFEST of this tool` };
  let before;
  try {
    before = statSync(dir).ino;
  } catch {
    return RETIRED;
  }
  const holder = spawn("flock", [dir, "-c", "echo held && exec cat > /dev/null"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
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
    return await action(text);
  } finally {
    holder.stdin.end();
  }
}

/** `file` made whole with `text` where it does not exist yet (in a gate), else left as it is: what it holds. */
function created(file, text) {
  const tmp = `${file}.${WRITER}.tmp`;
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
  writeFileSync(`${file}.${WRITER}.tmp`, text);
  renameSync(`${file}.${WRITER}.tmp`, file);
}

/**
 * The baseline of a tree's identity in `root`, made where it does not exist (unless `line` is null): its MANIFEST
 * written in a `.creating-` folder of this writer's, which is then renamed into place (onto no folder or an empty one;
 * a folder holding anything stays as it is). Then joined through the gate, `line` appended to its MANIFEST once; one
 * retired while this writer waited is made anew. `refused` says why it is not this tool's, holds foreign paths or holds
 * the runs of other inputs.
 */
export async function owned(root, identity, line) {
  const dir = path.join(root, identity.src);
  const header = headerOf(identity);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (line !== null && !existsSync(path.join(dir, "MANIFEST"))) {
      mkdirSync(root, { recursive: true });
      const creating = path.join(root, `.${identity.src}.creating-${WRITER}`);
      mkdirSync(creating);
      writeFileSync(path.join(creating, "MANIFEST"), header);
      try {
        renameSync(creating, dir);
      } catch (error) {
        rmSync(creating, { recursive: true, force: true });
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      }
    }
    if (!existsSync(dir)) return { dir, absent: true };
    const joined = await gate(dir, (text) => {
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
    if (joined !== RETIRED) return { dir, ...joined };
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
export async function planned(top, area, plan) {
  const id = hash(plan);
  const { shards, places } = parsePlan(plan);
  const outcome = await gate(top, (text) => {
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
 * claim, a dead writer's temporary files of the shard removed; `refused` where the baseline refuses the writer.
 */
export async function beginShard(top, area, shard, shards, plan, places) {
  const dir = path.join(top, area);
  const file = shardFile(dir, shard, shards);
  const outcome = await gate(top, () => {
    if (verified(file, plan, places)) return { skipped: "stored" };
    if (!claimed(path.join(dir, `.${shard}of${shards}.claim`)))
      return { skipped: "being stored by another writer" };
    const prefix = `${path.basename(file)}.`;
    for (const entry of readdirSync(dir))
      if (
        entry.startsWith(prefix) &&
        entry.endsWith(".tmp") &&
        !running(entry.slice(prefix.length, -4))
      )
        rmSync(path.join(dir, entry), { force: true });
    return {};
  });
  if (outcome === RETIRED) return { refused: `${top} was retired while this writer began a shard` };
  return { top, dir, file, plan, places, ...outcome };
}

/**
 * The shard published whole through the gate, its lines (`lines`) then its total last: a new one by a hard link, one
 * that does not verify by a rename over it, one another writer published meanwhile kept; the claim released. Whether
 * the shard then verifies, or why the baseline refused it.
 */
export async function endShard({ top, dir, file, plan, places }, lines, total) {
  const body = lines.join("");
  const ended = `${JSON.stringify({ total: { ...total, plan, places, lines: hash(body) } })}\n`;
  const outcome = await gate(top, () => {
    const tmp = `${file}.${WRITER}.tmp`;
    writeFileSync(tmp, body + ended);
    try {
      linkSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!verified(file, plan, places)) renameSync(tmp, file);
    }
    rmSync(tmp, { force: true });
    const claim = path.join(dir, `.${path.basename(file).replace(".runs.jsonl", "")}.claim`);
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
async function start(dir, current) {
  const outcome = await gate(dir, () => {
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
async function queue(dir, script) {
  const outcome = await gate(dir, () => {
    copyFileSync(script, path.join(dir, `baseline.sh.${WRITER}.tmp`));
    renameSync(path.join(dir, `baseline.sh.${WRITER}.tmp`), path.join(dir, "baseline.sh"));
    rmSync(path.join(dir, "SUPERSEDED"), { force: true });
    return { queued: dir };
  });
  console.log(JSON.stringify(outcome === RETIRED ? { refused: `${dir} was retired` } : outcome));
  return outcome === RETIRED || outcome.refused !== undefined ? 2 : 0;
}

/**
 * A folder this tool made outside a baseline (`.pruning-…` or `.creating-…`, named by its writer) removed once that
 * writer ended (`writer`, or this process where it is null), where it holds this tool's MANIFEST and no foreign path;
 * else kept, and named.
 */
function recover(dir, writer) {
  if (writer !== null && running(writer)) return;
  const text = isOwned(dir) ? readFileSync(path.join(dir, "MANIFEST"), "utf8") : null;
  const foreign = text === null ? ["(no MANIFEST of this tool)"] : foreignIn(dir, text);
  if (foreign.length > 0) console.log(JSON.stringify({ kept: dir, foreign }));
  else rmSync(dir, { recursive: true, force: true });
}

/**
 * Each baseline of this tool in `root` none of whose trees remains and into which no writer stores, retired: decided
 * through the gate from its MANIFEST and renamed there to a `.pruning-` folder of this writer's, which is then removed
 * as `recover` removes one; a baseline the gate refuses for a foreign path is kept and named. A folder that is not this
 * tool's is not touched.
 */
async function prune(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const made = /^\.(?:pruning-.+|[0-9a-f]+\.creating)-(\d+-\d+)$/.exec(entry.name);
    if (made !== null) {
      recover(dir, made[1]);
      continue;
    }
    if (entry.name.startsWith(".") || !isOwned(dir)) continue;
    const retired = path.join(root, `.pruning-${entry.name}-${WRITER}`);
    const outcome = await gate(dir, (text) => {
      const trees = [...text.matchAll(/^commit \S+ (.+)$/gm)].map(([, tree]) => tree);
      if (trees.length === 0 || trees.some((tree) => existsSync(tree))) return null;
      const areas = readdirSync(dir, { withFileTypes: true }).filter((area) => area.isDirectory());
      if (areas.some((area) => claimedIn(path.join(dir, area.name)))) return null;
      renameSync(dir, retired);
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
  if (command === "state" && second !== undefined)
    process.exitCode = await state(path.resolve(first), second, readOnly);
  else if (command === "prune" && first !== undefined) await prune(first);
  else if (command === "start" && second !== undefined)
    process.exitCode = await start(path.resolve(first), second);
  else if (command === "queue" && second !== undefined)
    process.exitCode = await queue(path.resolve(first), path.resolve(second));
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
