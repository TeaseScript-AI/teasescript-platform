// node tests/families/baselines.mjs state <tree> <folder> [--read-only]
// node tests/families/baselines.mjs prune <folder>
// The corpus runner's stored baselines (#1541): every read and write of <folder>/<src tree>/ is here. A baseline holds
// the runs of the trees of one `src/` tree (`git rev-parse <commit>:src`) whose runs depend on the same inputs beside it:
// the oracle library (`tests/helpers/type-core-oracles.ts` and the helpers it imports), the lockfile and Node. Its folder
// is this tool's only when this tool made it with its MANIFEST already inside (written whole, then the folder renamed
// into place); a folder that holds anything else is never written into or removed. The MANIFEST names the src tree and
// those inputs, which every writer must share, then, appended and never rewritten, each commit stored there and each
// area's PLAN. An area's PLAN, made whole by its first writer, binds its run: each shard's sources in their order, each
// generator's checks, the allowances and limits; a writer that would run another is refused (exit 2). A shard counts
// only once verified: its last line, its total, names the PLAN, its sources and the hash of every line before it. One
// running writer at a time stores a shard (its claim), and publishes it whole: a new shard by a hard link, so the first
// stays, a shard that does not verify by a rename over it. An area is complete when each planned shard verifies.
//
// `state` prints each area of a built tree (the folders of tests/families/ with generators, and tools/corpus/fixture/)
// as one JSON line: `complete`, `another plan` (its PLAN is not the tree's), `storing` (a running writer's claim),
// `damaged` (a stored shard that does not verify), `partial` or `absent`, with the shards to store; then a line for the
// baseline. It makes or joins the baseline and appends the tree's commit, unless `--read-only`, and plans an area that is
// already complete again only with `--read-only`. It exits 0 when every area is complete, 1 when one is not, 2 when the
// folder is not this tool's or its inputs are not the tree's. `prune` removes each baseline of this tool none of whose
// trees remains and into which no writer is storing.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
 * The oracle library's id: each helper it loads (`type-core-oracles.ts` and, through `./*.js` imports, the helpers of
 * its folder those name) by its blob id; `none` where the tree has no library source.
 */
function oraclesId(helpers) {
  const seen = new Map();
  const pending = ["type-core-oracles.ts"];
  while (pending.length > 0) {
    const name = pending.pop();
    const file = path.join(helpers, name);
    if (seen.has(name) || !existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(name, blobId(file));
    for (const [, imported] of text.matchAll(/from\s+"\.\/([^"/]+)\.js"/g))
      pending.push(`${imported}.ts`);
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
    oracles: oraclesId(path.join(tree, "tests", "helpers")),
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

/**
 * The baseline of a tree's identity in `root`: made (unless `line` is null) whole with its MANIFEST and renamed into
 * place, or joined, `line` appended to its MANIFEST once. `refused` says why it is not this tool's or not the tree's.
 */
export function owned(root, identity, line) {
  const dir = path.join(root, identity.src);
  const manifest = path.join(dir, "MANIFEST");
  const header = headerOf(identity);
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
  const text = existsSync(manifest) ? readFileSync(manifest, "utf8") : "";
  if (!text.startsWith("baseline 3\n"))
    return { dir, refused: `${dir} is not this tool's: it holds what this tool did not write` };
  if (!text.startsWith(header)) {
    const [ours, theirs] = [header, text].map((part) => part.split("\n").slice(1, 5));
    const differs = ours
      .filter((field, index) => field !== theirs[index])
      .map((field) => field.split(" ")[0]);
    return { dir, refused: `${dir} holds runs of another ${differs.join(", ")} than this tree's` };
  }
  if (line !== null && !text.split("\n").includes(line)) appendFileSync(manifest, `${line}\n`);
  return { dir };
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
 * The area of a baseline (`dir`, its MANIFEST in `top`) planned as `plan`, made whole by its first writer, and its
 * MANIFEST line: the PLAN's hash and each shard's hash of places, or why it is refused (another plan).
 */
export function planned(top, dir, plan) {
  mkdirSync(dir, { recursive: true });
  const stored = created(path.join(dir, "PLAN"), plan);
  if (stored !== plan)
    return {
      refused: `${dir} is planned otherwise (another set, order or count of shards, or checks)`,
    };
  const id = hash(plan);
  const line = `area ${path.basename(dir)} ${parsePlan(plan).shards} ${id}`;
  const manifest = path.join(top, "MANIFEST");
  if (!readFileSync(manifest, "utf8").split("\n").includes(line))
    appendFileSync(manifest, `${line}\n`);
  return { plan: id, ...parsePlan(plan) };
}

/**
 * A shard to store: `skipped` where it verifies or a running writer stores it, else this process's claim and the
 * temporary file it writes, a dead writer's temporary files of the shard removed.
 */
export function beginShard(dir, shard, shards, plan, places) {
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
  return { file, claim, tmp, plan, places };
}

/**
 * The shard published whole, its total last: a new one by a hard link, one that does not verify by a rename over it,
 * one another writer published meanwhile kept; the claim released. Whether the shard then verifies.
 */
export function endShard({ file, claim, tmp, plan, places }, total) {
  const lines = hash(readFileSync(tmp));
  appendFileSync(tmp, `${JSON.stringify({ total: { ...total, plan, places, lines } })}\n`);
  try {
    linkSync(tmp, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!verified(file, plan, places)) renameSync(tmp, file);
  }
  rmSync(tmp, { force: true });
  if (existsSync(claim) && readFileSync(claim, "utf8").trim() === WRITER)
    rmSync(claim, { force: true });
  return verified(file, plan, places);
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
  const own = owned(root, identity, readOnly ? null : `commit ${sha} ${tree}`);
  if (own.refused !== undefined) {
    console.log(JSON.stringify({ src: identity.src, baseline: own.dir, refused: own.refused }));
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

/** Each baseline of this tool in `root` none of whose trees remains and into which no writer stores, removed. */
function prune(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = path.join(root, entry.name);
    const manifest = path.join(dir, "MANIFEST");
    if (!entry.isDirectory() || entry.name.startsWith(".") || !existsSync(manifest)) continue;
    const text = readFileSync(manifest, "utf8");
    if (!text.startsWith("baseline 3\n")) continue;
    const trees = [...text.matchAll(/^commit \S+ (.+)$/gm)].map(([, tree]) => tree);
    if (trees.length === 0 || trees.some((tree) => existsSync(tree))) continue;
    if (
      readdirSync(dir, { withFileTypes: true }).some(
        (area) => area.isDirectory() && claimedIn(path.join(dir, area.name)),
      )
    )
      continue;
    rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify({ pruned: dir }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const readOnly = args.includes("--read-only");
  const [first, second] = args.filter((arg) => !arg.startsWith("--"));
  if (command === "state" && second !== undefined)
    process.exitCode = await state(path.resolve(first), second, readOnly);
  else if (command === "prune" && first !== undefined) prune(first);
  else {
    console.error(
      "usage: node tests/families/baselines.mjs state <tree> <folder> [--read-only]\n" +
        "       node tests/families/baselines.mjs prune <folder>",
    );
    process.exitCode = 2;
  }
}
