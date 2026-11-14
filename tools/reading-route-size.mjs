import { spawnSync } from "node:child_process";
import { posix } from "node:path";

import { anchoredHeadings, headingText, markdownProcessor } from "./repository-checks/markdown.mjs";

// Reports, never limits, the size in characters of what the repository's start route sends each workflow role to read
// before a task (owner, 2026-11-11: reported only, no limit):
//
//   node tools/reading-route-size.mjs [--rev REV] [--base REV]
//
// The route is stated in `AGENTS.md` ("Start and authority" and the sections after it), `README-FIRST.md`
// ("Documentation routing"), `docs/agents/README.md` and `docs/agents/DIRECT-REPOSITORY.md` ("Reading set"). `ROUTE`
// below is this tool's copy of the whole-document part: the documents every role reads whole before every task, whose
// sizes enter every role's total; the documents read only when the task meets their condition, printed with their size
// and outside every total; and the documents the route names without sending the agent to read them, not measured (the
// connector-local route, for an agent without a checkout, is one of those). Topic documents chosen by the task's subject
// (`README-FIRST.md`'s map) are in no list.
//
// The workflow document is read by section, and the route's table under "Workflow reading before starting" in
// `docs/agents/README.md` says which: the report reads that table at the revision, not a copy of it. A section is its
// heading and its text up to the next heading, so a child heading starts a section of its own, and a section is
// identified by its anchor as the doc-links check makes it (`repository-checks/markdown.mjs`). A role's total is the
// whole documents plus the workflow sections the table marks for that role. A revision whose router has no such heading
// and no such table predates section routing, and its roles read the whole workflow.
//
// So that the lists follow the route, the report also prints `not classified: <path> (named in <file>)` for each `.md`
// path that `AGENTS.md`, `docs/agents/README.md` or `docs/agents/DIRECT-REPOSITORY.md` names at REV and no list holds
// (a name resolves from the naming file's folder, else from the root; `no such file` when neither exists and no list
// holds either). A document named only in `README-FIRST.md` is not looked for.
//
// A size is the number of Unicode code points in the file's committed blob at REV (default `HEAD`), decoded as UTF-8
// (a byte-order mark counts as one); the working tree is never read, so commit first. With --base, each document's line
// also gives its difference from the base REV (CI passes a pull request's merge's first parent), `new` where the base
// lacks it, and each role's line its total at the base, read by the base's own table.
//
// Exit status: 0 when every measured document and every section the table names exist at REV, whatever is not
// classified; 1 when one is missing (its line says `missing`, and the totals leave it out); 2 when it cannot run (bad
// arguments, a revision that is no commit, a file it reads that is not UTF-8, a route table it cannot read). What is
// missing at the base is printed and does not change the status.

/** The start route's whole-document part, as the files named in the header state it. Paths are from the root. */
export const ROUTE = {
  roles: {
    A: "light/minimal builder",
    B: "full-route builder",
    R: "round reviewer",
    F: "independent final reviewer",
    C: "coordinator",
  },
  everyTask: [
    "AGENTS.md",
    "README-FIRST.md",
    "docs/agents/README.md",
    "docs/agents/DIRECT-REPOSITORY.md",
    "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md",
  ],
  workflow: {
    path: "docs/DEVELOPMENT-WORKFLOW.md",
    router: "docs/agents/README.md",
    heading: "Workflow reading before starting",
  },
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

/** The route table's first two header cells; its third, the case that sends other roles to a section, is not read. */
const TABLE_HEADER = ["Workflow section", "Startup roles"];

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

const codePoints = (text) => [...text].length;

/** A page's sections: each heading's anchor and the text from that heading up to the next one. */
export function sectionsOf(markdown) {
  const headings = anchoredHeadings(markdownProcessor().parse(markdown));
  return new Map(
    headings.map(({ node, anchor }, index) => [
      anchor,
      markdown.slice(node.position.start.offset, headings[index + 1]?.node.position.start.offset),
    ]),
  );
}

/** A table cell's text, every value below it. */
function cellText(node) {
  return node.value ?? (node.children ?? []).map(cellText).join("");
}

/**
 * The route table under `ROUTE.workflow.heading` in the router's `markdown`: one `{ anchor, roles }` per row, `roles`
 * the letters of `ROUTE.roles` the row names (none for `—`). Undefined when the router has neither the heading nor
 * such a table, as before section routing; a UsageError when it has one without the other or a row it cannot read.
 */
export function workflowSections(markdown) {
  const nodes = markdownProcessor().parse(markdown).children;
  const isRouteTable = (node) =>
    node.type === "table" &&
    TABLE_HEADER.every((text, index) => cellText(node.children[0].children[index] ?? {}) === text);
  const start = nodes.findIndex(
    (node) => node.type === "heading" && headingText(node) === ROUTE.workflow.heading,
  );
  if (start === -1) {
    if (nodes.some(isRouteTable))
      throw new UsageError(`route table without its heading "${ROUTE.workflow.heading}"`);
    return undefined;
  }
  const end = nodes.findIndex(
    (node, index) => index > start && node.type === "heading" && node.depth <= nodes[start].depth,
  );
  const table = nodes.slice(start + 1, end === -1 ? undefined : end).find(isRouteTable);
  if (table === undefined) throw new UsageError(`no route table under "${ROUTE.workflow.heading}"`);
  const rows = table.children.slice(1).map((row) => {
    const [section, startup] = row.children;
    const link = section?.children.find((node) => node.type === "link");
    const [path, anchor] = link?.url.split("#") ?? [];
    const cell = startup === undefined ? "" : cellText(startup).trim();
    const roles = cell === "—" ? [] : cell.split(/\s+/u);
    const valid =
      path !== undefined &&
      anchor !== undefined &&
      anchor !== "" &&
      posix.join(posix.dirname(ROUTE.workflow.router), path) === ROUTE.workflow.path &&
      roles.every((role) => Object.hasOwn(ROUTE.roles, role)) &&
      new Set(roles).size === roles.length;
    if (!valid) throw new UsageError(`unreadable route table row: ${cellText(row)}`);
    return { anchor, roles };
  });
  if (new Set(rows.map(({ anchor }) => anchor)).size !== rows.length)
    throw new UsageError("a workflow section appears twice in the route table");
  return rows;
}

/** What a revision's route reads: its documents' sizes, and its workflow sections or none. */
function routeAt(files, paths) {
  const sizes = new Map();
  for (const path of paths.filter((candidate) => files.has(candidate)))
    sizes.set(path, codePoints(files.text(path)));
  const rows = files.has(ROUTE.workflow.router)
    ? workflowSections(files.text(ROUTE.workflow.router))
    : undefined;
  const sections = files.has(ROUTE.workflow.path)
    ? sectionsOf(files.text(ROUTE.workflow.path))
    : new Map();
  return { sizes, rows, sections };
}

/** The workflow sections a revision's table names and its workflow lacks. */
function missingSections({ rows, sections }) {
  return (rows ?? [])
    .filter(({ anchor }) => !sections.has(anchor))
    .map(({ anchor }) => `${ROUTE.workflow.path}#${anchor}`);
}

/** A role's characters before starting: the whole documents and its workflow sections, or the whole workflow. */
function roleTotal({ sizes, rows, sections }, role) {
  const whole = ROUTE.everyTask.reduce((total, path) => total + (sizes.get(path) ?? 0), 0);
  if (rows === undefined) return whole + (sizes.get(ROUTE.workflow.path) ?? 0);
  return rows
    .filter(({ roles }) => roles.includes(role))
    .reduce((total, { anchor }) => total + codePoints(sections.get(anchor) ?? ""), whole);
}

/** A line for each `.md` name in the route statements that no list of `ROUTE` holds. */
function unclassified(files) {
  const classified = new Set([
    ...ROUTE.everyTask,
    ROUTE.workflow.path,
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
  const wholeDocuments = [...ROUTE.everyTask, ROUTE.workflow.path];
  const paths = [...wholeDocuments, ...ROUTE.whenNeeded.map((document) => document.path)];
  const files = filesAt(head);
  const route = routeAt(files, paths);
  const baseRoute = base === undefined ? undefined : routeAt(filesAt(base), paths);

  const difference = (size, baseSize) => {
    if (baseRoute === undefined) return "";
    if (baseSize === undefined) return `${"new".padStart(8)}  `;
    const delta = size - baseSize;
    return `${(delta > 0 ? `+${delta}` : String(delta)).padStart(8)}  `;
  };
  const line = (path, suffix = "") => {
    const size = route.sizes.get(path);
    if (size === undefined)
      return `  ${"missing".padStart(7)}  ${baseRoute === undefined ? "" : " ".repeat(10)}${path}${suffix}`;
    return `  ${String(size).padStart(7)}  ${difference(size, baseRoute?.sizes.get(path))}${path}${suffix}`;
  };

  const lines = [
    `Reading route at ${options.rev} (${head.slice(0, 8)}), in characters` +
      (base === undefined
        ? ""
        : `, with the difference from ${options.base} (${base.slice(0, 8)})`),
    "Whole documents (of the workflow, only the sections a role reads enter its total):",
    ...wholeDocuments.map((path) => line(path)),
    "Read only when the task needs it, in no total:",
    ...ROUTE.whenNeeded.map((document) => line(document.path, `: ${document.when}`)),
    "Before starting, by role:",
    ...Object.entries(ROUTE.roles).map(([role, name]) => {
      const total = roleTotal(route, role);
      const before = baseRoute === undefined ? undefined : roleTotal(baseRoute, role);
      return (
        `  ${role} ${name}: ${total}` +
        (before === undefined ? "" : ` (before ${before}, change ${total - before})`)
      );
    }),
    route.rows === undefined
      ? "Workflow sections: none, the whole workflow is read."
      : "Workflow sections, with the roles that read them before starting:",
    ...(route.rows ?? []).map(({ anchor, roles }) => {
      const section = route.sections.get(anchor);
      const size = section === undefined ? "missing" : String(codePoints(section));
      return `  ${size.padStart(7)}  ${(roles.join(" ") || "—").padEnd(9)}  ${ROUTE.workflow.path}#${anchor}`;
    }),
    ...unclassified(files),
  ];
  const missing = [...paths.filter((path) => !route.sizes.has(path)), ...missingSections(route)];
  if (missing.length > 0)
    lines.push(
      `missing at ${options.rev}: ${missing.join(", ")}; update ROUTE in tools/reading-route-size.mjs or the route table`,
    );
  const missingAtBase = baseRoute === undefined ? [] : missingSections(baseRoute);
  if (missingAtBase.length > 0)
    lines.push(`missing at ${options.base}, left out of its totals: ${missingAtBase.join(", ")}`);
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
