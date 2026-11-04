// node tests/families/mutant-proof.mjs <checkout> <patch>
// The proof that a mutant's checkout is its head with the patch applied as the queue applies it (#1684), by doing it
// again: in the checkout's own repository, a fresh detached worktree of the head, the queue's command on the same patch
// bytes (`git apply --whitespace=nowarn`), and for each path the application touched (the patch's own paths, whole, and
// every path `git status --porcelain -z --ignored --untracked-files=all` lists in the fresh tree) the checkout must
// hold what the fresh tree holds: the same kind (file, link or none), executable bit and raw bytes, paths and link
// targets compared as bytes. A path the checkout changed that the application did not touch is reported (`outside`),
// not part of the proof.
// Its domain (`DOMAIN`): a repository with no user code in the conversion path, where git's own conversions are all a
// replay can repeat. A filter driver or a hook runs arbitrary code during an apply or a checkout, whose result may
// depend on where it runs or hide a change from status, so the proof refuses, by presence alone and naming what it
// found: any `filter.*` config in any scope, an executable hook in the effective hooks directory, any attributes source
// (a `.gitattributes` in the head tree, `.git/info/attributes`, `core.attributesFile`, the default global attributes
// file), `core.fileMode=false`, a gitlink or `.gitmodules` at the head. The queue's checkouts carry none of these.
// Prints the proof as one JSON object (the domain, the patch's sha256, each touched path's state, the paths outside);
// exits 2 outside the domain or where the fresh application fails (an empty or broken patch), 1 where the checkout
// differs at a touched path, naming it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DOMAIN =
  "a repository with no user code in the conversion path: no filter config, hooks, attributes sources, " +
  "core.fileMode=false or gitlinks";

const [checkoutArgument, patchFile] = process.argv.slice(2);
if (patchFile === undefined) {
  process.stderr.write("usage: node tests/families/mutant-proof.mjs <checkout> <patch>\n");
  process.exit(2);
}
const [checkout, patch] = [resolve(checkoutArgument), resolve(patchFile)];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A git command's run in `cwd`, its output as bytes. */
const git = (cwd, args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 1 << 28 });

/** A git command's output in `cwd`, which must succeed. */
function output(cwd, args) {
  const ran = git(cwd, args);
  if (ran.status !== 0) throw new Error(`git ${args[0]}: ${ran.stderr.toString().trim()}`);
  return ran.stdout;
}

/** A buffer's NUL-separated fields, the empty field after the last NUL left out. */
function fields(buffer) {
  const out = [];
  let start = 0;
  for (let index = buffer.indexOf(0); index !== -1; index = buffer.indexOf(0, start)) {
    out.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}

/** A path's name for messages and the proof: its bytes as UTF-8 (a byte that is none shows as U+FFFD). */
const named = (path) => JSON.stringify(path.toString("utf8"));

/** A path under `root`, as bytes: the root's name, `/`, the path's own bytes. */
const under = (root, path) => Buffer.concat([Buffer.from(`${root}/`), path]);

/** Refuses outside the domain: what was found. */
function outsideDomain() {
  const found = [];
  const filters = git(checkout, ["config", "--get-regexp", "^filter\\."]);
  if (filters.status === 0) found.push("filter config");
  const hooks = output(checkout, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
    .toString("utf8")
    .trim();
  if (existsSync(hooks))
    for (const entry of readdirSync(hooks, { withFileTypes: true }))
      if (
        !entry.name.endsWith(".sample") &&
        (entry.isFile() || entry.isSymbolicLink()) &&
        (lstatSync(join(hooks, entry.name)).mode & 0o111) !== 0
      )
        found.push(`the hook ${JSON.stringify(entry.name)}`);
  const info = output(checkout, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/attributes",
  ])
    .toString("utf8")
    .trim();
  if (existsSync(info)) found.push(".git/info/attributes");
  if (git(checkout, ["config", "--get", "core.attributesFile"]).status === 0)
    found.push("core.attributesFile");
  const xdg = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  if (existsSync(join(xdg, "git", "attributes"))) found.push(join(xdg, "git", "attributes"));
  const fileMode = git(checkout, ["config", "--type=bool", "--get", "core.fileMode"]);
  if (fileMode.status === 0 && fileMode.stdout.toString("utf8").trim() === "false")
    found.push("core.fileMode=false");
  for (const entry of fields(output(checkout, ["ls-tree", "-r", "-z", "HEAD"]))) {
    const tab = entry.indexOf(9);
    const [mode, path] = [entry.subarray(0, 6).toString("latin1"), entry.subarray(tab + 1)];
    const last = path.subarray(path.lastIndexOf(47) + 1).toString("latin1");
    if (mode === "160000") found.push(`the gitlink ${named(path)}`);
    if (last === ".gitattributes" || last === ".gitmodules") found.push(named(path));
  }
  return found;
}

/** The patch's own paths, whole (`added<TAB>deleted<TAB>path`, a rename's or copy's source and destination after it). */
function patchPaths() {
  const records = fields(
    output(checkout, ["apply", "--numstat", "-z", "--whitespace=nowarn", patch]),
  );
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const second = record.indexOf(9, record.indexOf(9) + 1);
    const path = record.subarray(second + 1);
    if (path.length > 0) paths.push(path);
    else paths.push(records[++index], records[++index]);
  }
  return paths;
}

/** The paths `git status` lists in `cwd`, whole (`XY path`, a rename's or copy's source after it). */
function changed(cwd, extra) {
  const entries = fields(
    output(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...extra]),
  );
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    paths.push(entries[index].subarray(3));
    if (entries[index][0] === 82 || entries[index][0] === 67) paths.push(entries[++index]);
  }
  return paths;
}

/** A path's state in a tree: its kind, executable bit and the sha256 of its bytes (a link's target's bytes). */
function state(root, path) {
  const full = under(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { kind: "none" };
  }
  if (stat.isSymbolicLink())
    return { kind: "link", sha256: sha256(readlinkSync(full, { encoding: "buffer" })) };
  if (!stat.isFile()) return { kind: "other" };
  return {
    kind: "file",
    executable: (stat.mode & 0o111) !== 0,
    sha256: sha256(readFileSync(full)),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "mutant-proof-"));
const fresh = join(scratch, "fresh");
/** Unregisters and removes the fresh worktree, registered or half-made; an entry left behind is reported. */
const cleanup = () => {
  git(checkout, ["worktree", "remove", "--force", fresh]);
  rmSync(scratch, { recursive: true, force: true });
  git(checkout, ["worktree", "prune"]);
  const left = git(checkout, ["worktree", "list", "--porcelain", "-z"]).stdout.toString("utf8");
  if (left.includes(`worktree ${fresh}\0`))
    process.stderr.write(`mutant-proof: the worktree ${fresh} is still registered\n`);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup();
    process.exit(2);
  });
let status = 0;
let message = "";
try {
  const found = outsideDomain();
  if (found.length > 0) {
    status = 2;
    message = `outside the proof's domain (${DOMAIN}): ${found.join(", ")}`;
  } else {
    const add = git(checkout, ["worktree", "add", "--quiet", "--detach", fresh, "HEAD"]);
    if (add.status !== 0) throw new Error(`git worktree add: ${add.stderr.toString().trim()}`);
    const applied = git(fresh, ["apply", "--whitespace=nowarn", patch]);
    if (applied.status !== 0) {
      status = 2;
      message = `the patch does not apply to the head as the queue applies it: ${applied.stderr.toString().trim()}`;
    } else {
      const keys = new Map();
      for (const path of [...patchPaths(), ...changed(fresh, ["--ignored"])])
        keys.set(path.toString("hex"), path);
      const touched = [...keys.keys()].sort().map((key) => keys.get(key));
      const paths = touched.map((path) => ({
        path: path.toString("utf8"),
        pathHex: path.toString("hex"),
        ...state(fresh, path),
      }));
      const differing = paths.filter(
        ({ path: _path, pathHex, ...expected }) =>
          JSON.stringify(state(checkout, Buffer.from(pathHex, "hex"))) !== JSON.stringify(expected),
      );
      const outside = changed(checkout, []).filter((path) => !keys.has(path.toString("hex")));
      process.stdout.write(
        `${JSON.stringify({ domain: DOMAIN, patch: sha256(readFileSync(patch)), paths, outside: outside.map((path) => path.toString("utf8")) })}\n`,
      );
      if (touched.length === 0) {
        status = 2;
        message = "the patch touches no path";
      } else if (differing.length > 0) {
        status = 1;
        message = `the checkout is not the head with the patch applied at ${differing.map((each) => named(Buffer.from(each.pathHex, "hex"))).join(", ")}`;
      } else if (outside.length > 0)
        process.stderr.write(
          `mutant-proof: changed outside the patch's paths, not part of the proof: ${outside.map(named).join(", ")}\n`,
        );
    }
  }
} catch (error) {
  status = 2;
  message = error instanceof Error ? error.message : String(error);
} finally {
  cleanup();
}
if (status !== 0) process.stderr.write(`mutant-proof: ${message}\n`);
process.exit(status);
