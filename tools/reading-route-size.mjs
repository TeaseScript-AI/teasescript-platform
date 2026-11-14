import { spawnSync } from "node:child_process";
import { posix } from "node:path";

import GithubSlugger from "github-slugger";
import { remark } from "remark";
import remarkGfm from "remark-gfm";

// Reports, never limits, the size in characters of what the repository's start route sends each workflow role to
// read before a task (owner, 2026-11-11: reported only, no limit):
//
//   node tools/reading-route-size.mjs [--rev REV] [--base REV]
//
// The route is stated in `AGENTS.md` ("Start and authority" and the sections after it), `README-FIRST.md`
// ("Documentation routing"), `docs/agents/README.md` and `docs/agents/DIRECT-REPOSITORY.md` ("Reading set"). `ROUTE`
// below names the common whole-file reads and the canonical role/section table in docs/agents/README.md. A workflow
// section ends at the next heading, including a child heading; only rows naming a role count towards its startup
// total. Conditional whole-document sizes remain visible outside startup totals. Documents named without a
// reading requirement are not measured. The connector-local
// route, for an agent without a checkout, is one of those: its guides are not measured. Topic documents chosen by the
// task's subject (`README-FIRST.md`'s map) are in no list.
//
// So that the list follows the route, the report also prints `not classified: <path> (named in <file>)` for each `.md`
// path that `AGENTS.md`, `docs/agents/README.md` or `docs/agents/DIRECT-REPOSITORY.md` names at REV and no list holds
// (a name resolves from the naming file's folder, else from the root; `no such file` when neither exists and no list
// holds either). A document named only in `README-FIRST.md` is not looked for. The test checks every named document
// and workflow heading, including conditional rows; this is a report, never a reading-size gate.
//
// A size is the number of Unicode code points in the file's committed blob at REV (default `HEAD`), decoded as UTF-8
// (a byte-order mark counts as one); the working tree is never read, so commit first. With --base, each line also
// gives each document's difference and each role's before/after total. Each revision's canonical table selects its
// workflow sections. Revisions predating that table read the whole workflow, as the earlier start route required.
// The common whole-file and conditional lists are this tool's on both sides; topic sources are additional.
//
// Exit status: 0 when the measured documents and named sections exist, whatever is not classified; 1 when
// one is missing (its line says `missing`, and the total leaves it out); 2 when it cannot run (bad arguments, a
// revision that is no commit, a file it reads that is not UTF-8).

/** The start route, as the files named in the header state it. Paths are from the repository's root. */
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
    route: "docs/agents/README.md",
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

function textOf(node) {
  return node.value ?? node.alt ?? (node.children ?? []).map(textOf).join("");
}

/** Markdown heading anchors and their direct text, excluding child sections and fenced pseudo-headings. */
export function sectionsOf(markdown) {
  const slugger = new GithubSlugger();
  const headings = remark()
    .use(remarkGfm)
    .parse(markdown)
    .children.filter((node) => node.type === "heading");
  return new Map(
    headings.map((node, index) => [
      slugger.slug(textOf(node)),
      markdown.slice(node.position.start.offset, headings[index + 1]?.position.start.offset),
    ]),
  );
}

/** The canonical workflow table; undefined for the earlier whole-workflow route. */
export function workflowSections(markdown) {
  const nodes = remark().use(remarkGfm).parse(markdown).children;
  const isRouteTable = (node) =>
    node.type === "table" &&
    textOf(node.children[0].children[0]) === "Workflow section" &&
    textOf(node.children[0].children[1]) === "Startup roles";
  const start = nodes.findIndex(
    (node) => node.type === "heading" && textOf(node) === ROUTE.workflow.heading,
  );
  if (start === -1) {
    if (nodes.some(isRouteTable))
      throw new UsageError(`missing route heading: ${ROUTE.workflow.heading}`);
    return undefined;
  }
  const end = nodes.findIndex(
    (node, index) => index > start && node.type === "heading" && node.depth <= nodes[start].depth,
  );
  const table = nodes.slice(start + 1, end === -1 ? undefined : end).find(isRouteTable);
  if (table === undefined)
    throw new UsageError(`missing workflow table under ${ROUTE.workflow.heading}`);
  const sections = table.children.slice(1).map((row) => {
    const link = row.children[0].children.find((node) => node.type === "link");
    const [path, anchor] = link?.url.split("#") ?? [];
    const roles = textOf(row.children[1]).replace(/\s|—/gu, "");
    if (
      !path ||
      !anchor ||
      posix.join(posix.dirname(ROUTE.workflow.route), path) !== ROUTE.workflow.path ||
      [...roles].some((role) => !Object.hasOwn(ROUTE.roles, role))
    ) {
      throw new UsageError(`invalid workflow route row: ${textOf(row)}`);
    }
    return { anchor, roles };
  });
  if (new Set(sections.map(({ anchor }) => anchor)).size !== sections.length)
    throw new UsageError("duplicate workflow section in route");
  return sections;
}

function workflowAt(files) {
  const selected = files.has(ROUTE.workflow.route)
    ? workflowSections(files.text(ROUTE.workflow.route))
    : undefined;
  const sections = files.has(ROUTE.workflow.path)
    ? sectionsOf(files.text(ROUTE.workflow.path))
    : new Map();
  return { selected, sections };
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
  const paths = [
    ...ROUTE.everyTask,
    ROUTE.workflow.path,
    ...ROUTE.whenNeeded.map((document) => document.path),
  ];
  const files = filesAt(head);
  const sizes = sizesOf(files, paths);
  const baseFiles = base === undefined ? undefined : filesAt(base);
  const baseSizes = baseFiles === undefined ? undefined : sizesOf(baseFiles, paths);
  const workflow = workflowAt(files);
  const baseWorkflow = baseFiles === undefined ? undefined : workflowAt(baseFiles);

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
  const workflowSize = (selection, map, role) =>
    selection.selected === undefined
      ? (map.get(ROUTE.workflow.path) ?? 0)
      : selection.selected
          .filter(({ roles }) => roles.includes(role))
          .reduce(
            (total, { anchor }) => total + [...(selection.sections.get(anchor) ?? "")].length,
            0,
          );

  const lines = [
    `Reading route at ${options.rev} (${head.slice(0, 8)}), in characters` +
      (base === undefined
        ? ""
        : `, with the difference from ${options.base} (${base.slice(0, 8)})`),
    "Whole-document sizes (the workflow's role sections, not its whole size, enter startup totals):",
    ...[...ROUTE.everyTask, ROUTE.workflow.path].map((path) => line(path)),
    "Conditional whole-document sizes, outside startup totals:",
    ...ROUTE.whenNeeded.map((document) => line(document.path, `: ${document.when}`)),
    "Before starting, by role (common whole files plus selected workflow sections):",
    ...Object.entries(ROUTE.roles).map(([role, name]) => {
      const total = sum(sizes) + workflowSize(workflow, sizes, role);
      const before =
        baseWorkflow === undefined
          ? undefined
          : sum(baseSizes) + workflowSize(baseWorkflow, baseSizes, role);
      return (
        `  ${role} ${name}: ${total}` +
        (before === undefined ? "" : ` (before ${before}, change ${total - before})`)
      );
    }),
    workflow.selected === undefined
      ? "Workflow: whole document (before section routing)."
      : "Workflow sections:",
    ...(workflow.selected ?? []).map(
      ({ anchor, roles }) =>
        `  ${workflow.sections.has(anchor) ? [...workflow.sections.get(anchor)].length : "missing"}  ${roles || "conditional"}  ${ROUTE.workflow.path}#${anchor}`,
    ),
    ...unclassified(files),
  ];
  const missing = paths.filter((path) => !sizes.has(path));
  for (const selection of [workflow, baseWorkflow].filter(Boolean))
    for (const { anchor } of selection.selected ?? [])
      if (!selection.sections.has(anchor)) missing.push(`${ROUTE.workflow.path}#${anchor}`);
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
