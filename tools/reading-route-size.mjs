import { spawnSync } from "node:child_process";
import { posix } from "node:path";

// Reports, never limits, the size in characters of what the repository's start route sends an implementing agent to
// read before a task (owner, 2026-11-11: reported only, no limit):
//
//   node tools/reading-route-size.mjs [--rev REV] [--base REV]
//
// The route is stated in `AGENTS.md` ("Start and authority" and the sections after it), `README-FIRST.md`
// ("Documentation routing"), `docs/agents/README.md` and `docs/agents/DIRECT-REPOSITORY.md` ("Reading set"). `ROUTE`
// below is this tool's one copy of it: the documents read before every implementing task, whose sizes make the total;
// the documents read only when the task meets their condition, each printed with its size and not in the total; and
// the documents the route names without sending the agent to read them, which are not measured. The connector-local
// route, for an agent without a checkout, is one of those: its guides are not measured. Topic documents chosen by the
// task's subject (`README-FIRST.md`'s map) are in no list.
//
// So that the list follows the route, the report also prints `not classified: <path> (named in <file>)` for each `.md`
// path that `AGENTS.md`, `docs/agents/README.md` or `docs/agents/DIRECT-REPOSITORY.md` names at REV and no list holds
// (a name resolves from the naming file's folder, else from the root; `no such file` when neither exists and no list
// holds either). A document named only in `README-FIRST.md` is not looked for. `reading-route-size.test.mjs` checks
// that every listed document exists.
//
// A size is the number of Unicode code points in the file's committed blob at REV (default `HEAD`), decoded as UTF-8
// (a byte-order mark counts as one); the working tree is never read, so commit first. With --base, each line also
// gives the difference from the same file at the base REV (CI passes a pull request's merge's first parent), `new`
// where the base lacks it, and the total's difference. The lists are this tool's, for both sides.
//
// Exit status: 0 when every measured document (the first two lists) exists at REV, whatever is not classified; 1 when
// one is missing (its line says `missing`, and the total leaves it out); 2 when it cannot run (bad arguments, a
// revision that is no commit, a file it reads that is not UTF-8).

/** The start route, as the files named in the header state it. Paths are from the repository's root. */
export const ROUTE = {
  everyTask: [
    "AGENTS.md",
    "README-FIRST.md",
    "docs/agents/README.md",
    "docs/agents/DIRECT-REPOSITORY.md",
    "docs/DEVELOPMENT-WORKFLOW.md",
    "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md",
  ],
  whenNeeded: [
    { path: "docs/TESTING.md", when: "before adding, removing or materially changing tests" },
    {
      path: "docs/DOCUMENTATION-OWNERSHIP.md",
      when: "for a non-trivial documentation change or review",
    },
    { path: "docs/review-and-audit/AUDIT.md", when: "for an explicitly assigned audit" },
    { path: "CURRENT-DESIGN.md", when: "for architecture-affecting or broad cross-component work" },
    {
      path: "PHASE-STATUS.md",
      when: "for milestone, gate, integration-status or current-capability work",
    },
    {
      path: "docs/agents/PUBLICATION-CONSTRAINED.md",
      when: "after a normal-publication restriction is verified",
    },
  ],
  notRead: [
    {
      path: "docs/agents/CONNECTOR-LOCAL.md",
      why: "the connector-local route, for an agent without a checkout",
    },
    {
      path: "docs/agents/CONNECTOR-SOURCE-ACQUISITION.md",
      why: "the connector-local route's source acquisition",
    },
    { path: "docs/PATCH-PUBLICATION.md", why: "excluded while normal publication is available" },
  ],
};

/** The files whose `.md` names the report checks against `ROUTE`. */
const ROUTE_STATEMENTS = ["AGENTS.md", "docs/agents/README.md", "docs/agents/DIRECT-REPOSITORY.md"];

class UsageError extends Error {}

function git(args) {
  const result = spawnSync("git", args, { maxBuffer: 1 << 28 });
  if (result.error) throw new UsageError(`git could not run: ${result.error.message}`);
  return result;
}

/** The full SHA of `rev`'s commit; a UsageError when it is none. */
function commitOf(rev) {
  const result = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  if (result.status !== 0) throw new UsageError(`${rev} is no commit in this repository`);
  return result.stdout.toString("utf8").trim();
}

/** A commit's files: `has(path)`, and `text(path)` of one it has. */
function filesAt(commit) {
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (tree.status !== 0)
    throw new UsageError(`git ls-tree failed: ${tree.stderr.toString("utf8").trim()}`);
  const blobs = new Set(
    tree.stdout
      .toString("utf8")
      .split("\0")
      .filter((entry) => /^\d+ blob /u.test(entry))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return {
    has: (path) => blobs.has(path),
    text(path) {
      const blob = git(["cat-file", "blob", `${commit}:${path}`]);
      if (blob.status !== 0)
        throw new UsageError(
          `git cat-file failed for ${path}: ${blob.stderr.toString("utf8").trim()}`,
        );
      try {
        return decoder.decode(blob.stdout);
      } catch {
        throw new UsageError(`${path} at ${commit.slice(0, 8)} is not UTF-8`);
      }
    },
  };
}

/** Each path's size in code points in `files`; absent where it has no such file. */
function sizesOf(files, paths) {
  const sizes = new Map();
  for (const path of paths.filter((candidate) => files.has(candidate))) {
    let count = 0;
    for (const _ of files.text(path)) count += 1;
    sizes.set(path, count);
  }
  return sizes;
}

/** A line for each `.md` name in the route statements that no list of `ROUTE` holds. */
function unclassified(files) {
  const classified = new Set([
    ...ROUTE.everyTask,
    ...ROUTE.whenNeeded.map((document) => document.path),
    ...ROUTE.notRead.map((document) => document.path),
  ]);
  const lines = new Set();
  for (const file of ROUTE_STATEMENTS.filter((statement) => files.has(statement))) {
    for (const [name] of files.text(file).matchAll(/[\w./-]+\.md\b/gu)) {
      const candidates = [posix.join(posix.dirname(file), name), posix.normalize(name)];
      const path = candidates.find((candidate) => files.has(candidate));
      if (path === undefined) {
        if (!candidates.some((candidate) => classified.has(candidate)))
          lines.add(`not classified: ${name} (named in ${file}; no such file)`);
      } else if (!classified.has(path)) lines.add(`not classified: ${path} (named in ${file})`);
    }
  }
  return [...lines];
}

function parseArguments(argv) {
  const options = { rev: "HEAD", base: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if ((name === "--rev" || name === "--base") && index + 1 < argv.length) {
      options[name.slice(2)] = argv[(index += 1)];
    } else {
      throw new UsageError(
        `unknown or incomplete argument ${name}; usage: reading-route-size.mjs [--rev REV] [--base REV]`,
      );
    }
  }
  return options;
}

/** The report's lines and its exit status. */
function report(argv) {
  const options = parseArguments(argv);
  const head = commitOf(options.rev);
  const base = options.base === undefined ? undefined : commitOf(options.base);
  const paths = [...ROUTE.everyTask, ...ROUTE.whenNeeded.map((document) => document.path)];
  const files = filesAt(head);
  const sizes = sizesOf(files, paths);
  const baseSizes = base === undefined ? undefined : sizesOf(filesAt(base), paths);

  const difference = (size, baseSize) => {
    if (baseSizes === undefined) return "";
    if (baseSize === undefined) return `${"new".padStart(8)}  `;
    const delta = size - baseSize;
    return `${(delta > 0 ? `+${delta}` : String(delta)).padStart(8)}  `;
  };
  const line = (path, suffix = "") => {
    const size = sizes.get(path);
    if (size === undefined)
      return `  ${"missing".padStart(7)}  ${baseSizes === undefined ? "" : " ".repeat(10)}${path}${suffix}`;
    return `  ${String(size).padStart(7)}  ${difference(size, baseSizes?.get(path))}${path}${suffix}`;
  };
  const sum = (map) => ROUTE.everyTask.reduce((total, path) => total + (map.get(path) ?? 0), 0);
  const total = sum(sizes);

  const lines = [
    `Reading route at ${options.rev} (${head.slice(0, 8)}), in characters` +
      (base === undefined
        ? ""
        : `, with the difference from ${options.base} (${base.slice(0, 8)})`),
    "Read before every implementing task:",
    ...ROUTE.everyTask.map((path) => line(path)),
    `  ${String(total).padStart(7)}  ${difference(total, baseSizes === undefined ? undefined : sum(baseSizes))}total`,
    "Read only when the task needs it, not in the total:",
    ...ROUTE.whenNeeded.map((document) => line(document.path, `: ${document.when}`)),
    ...unclassified(files),
  ];
  const missing = paths.filter((path) => !sizes.has(path));
  if (missing.length > 0)
    lines.push(
      `missing at ${options.rev}: ${missing.join(", ")}; update ROUTE in tools/reading-route-size.mjs`,
    );
  return { lines, status: missing.length > 0 ? 1 : 0 };
}

function main() {
  try {
    const { lines, status } = report(process.argv.slice(2));
    console.log(lines.join("\n"));
    process.exitCode = status;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`reading-route-size: ${error.message}`);
    process.exitCode = 2;
  }
}

if (import.meta.main) main();
