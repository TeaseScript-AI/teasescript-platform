#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";

const LINK_SOURCES = [
  "AGENTS.md",
  "README-FIRST.md",
  "README.md",
  "CURRENT-DESIGN.md",
  "PHASE-STATUS.md",
  "docs/README.md",
  "docs/DOCUMENTATION-OWNERSHIP.md",
  "docs/DEVELOPMENT-WORKFLOW.md",
  "docs/TESTING.md",
  "docs/agents/README.md",
  "docs/agents/DIRECT-REPOSITORY.md",
  "docs/agents/CONNECTOR-LOCAL.md",
  "docs/agents/CONNECTOR-SOURCE-ACQUISITION.md",
  "docs/agents/PUBLICATION-CONSTRAINED.md",
  "docs/agents/ORCHESTRATOR.md",
  "docs/review-and-audit/README.md",
  "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md",
  "docs/review-and-audit/AUDIT.md",
  "docs/chatgpt-project/README-FIRST.md",
  "docs/planning/README.md",
  "docs/planning/POC-TO-ALPHA-BACKLOG.md",
  "docs/planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md",
  "docs/planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md",
  "docs/planning/MAINTENANCE-CANDIDATES.md",
  "docs/reference/README.md",
];

const DEFAULT_ROUTER_SOURCES = [
  "README-FIRST.md",
  "docs/agents/README.md",
  "docs/review-and-audit/README.md",
];

const OPT_IN_HISTORY_REFERENCE_MARKER =
  "<!-- repository-doc-guard: allow-opt-in-history-reference -->";

const REQUIRED_ROUTES = [
  ["AGENTS.md", "README-FIRST.md", "repository task router"],
  ["README-FIRST.md", "docs/agents/README.md", "technical capability router"],
  ["docs/agents/README.md", "docs/agents/DIRECT-REPOSITORY.md", "direct-repository capability route"],
  ["docs/agents/README.md", "docs/agents/CONNECTOR-LOCAL.md", "connector-local capability route"],
  ["docs/agents/README.md", "docs/agents/PUBLICATION-CONSTRAINED.md", "publication-constrained overlay"],
  ["docs/agents/README.md", "docs/agents/ORCHESTRATOR.md", "orchestrator coordination guide"],
  ["docs/agents/CONNECTOR-LOCAL.md", "docs/agents/CONNECTOR-SOURCE-ACQUISITION.md", "connector source procedure"],
  ["README-FIRST.md", "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md", "implementation and review guide"],
  ["README-FIRST.md", "docs/review-and-audit/AUDIT.md", "explicit audit guide"],
  ["README-FIRST.md", "CURRENT-DESIGN.md", "stable cross-component map"],
  ["README-FIRST.md", "PHASE-STATUS.md", "current capability status"],
  ["README-FIRST.md", "docs/planning/README.md", "active-planning lifecycle guide"],
  ["README-FIRST.md", "docs/planning/POC-TO-ALPHA-BACKLOG.md", "selected gate backlog"],
  ["README-FIRST.md", "docs/DOCUMENTATION-OWNERSHIP.md", "documentation ownership guide"],
  ["README-FIRST.md", "docs/DEVELOPMENT-WORKFLOW.md", "development workflow"],
  ["docs/README.md", "docs/DOCUMENTATION-OWNERSHIP.md", "documentation ownership guide"],
  ["docs/README.md", "docs/DEVELOPMENT-WORKFLOW.md", "development workflow"],
  ["docs/README.md", "docs/review-and-audit/README.md", "local review and audit map"],
  [
    "docs/review-and-audit/README.md",
    "docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md",
    "local implementation and review mirror",
  ],
  [
    "docs/review-and-audit/README.md",
    "docs/review-and-audit/AUDIT.md",
    "local explicit-audit mirror",
  ],
];

const REQUIRED_PATHS = [
  ["package.json", "normal npm verification scripts"],
  [".github/workflows/ci.yml", "normal CI verification workflow"],
  ["tools/test-output-filter.mjs", "compact compiled-test output filter"],
  ["tools/local-agent/check-local-agent.sh", "canonical local-agent verification command"],
];

const LIFECYCLE_CASES = [
  {
    source: "docs/planning/CAMERA-MEDIA-AND-TIME-INTEGRITY-FOLLOW-UPS.md",
    requiredFields: ["Status", "Authority", "Use when", "Do not use for"],
    expectedStatus: "Active non-implemented planning",
  },
  {
    source: "docs/planning/TIMER-AND-RECOVERY-FOLLOW-UPS.md",
    requiredFields: ["Status", "Authority", "Use when", "Do not use for"],
    expectedStatus: "Active non-implemented planning",
  },
  {
    source: "docs/planning/MAINTENANCE-CANDIDATES.md",
    requiredFields: ["Status", "Authority", "Use when", "Do not use for"],
    expectedStatus: "Active unscheduled maintenance candidates",
  },
  {
    source: "docs/planning/POC-TO-ALPHA-BACKLOG.md",
    requiredFields: ["Status", "Scope", "Scheduling"],
    expectedStatus: "Canonical selected backlog",
  },
];

const DOCUMENTED_VERIFICATION_POLICY_SOURCE = "docs/TESTING.md";
const DOCUMENTED_VERIFICATION_POLICY_BEGIN =
  "<!-- repository-doc-guard: begin normal-and-diagnostic-verification -->";
const DOCUMENTED_VERIFICATION_POLICY_END =
  "<!-- repository-doc-guard: end normal-and-diagnostic-verification -->";
const DOCUMENTED_VERIFICATION_POLICY = `
\`npm run check\` is the normal complete configured suite and preserves actionable
failure information. \`npm run test:full-output\` and \`npm run check:full-output\`
are diagnostic reruns only when compact output is insufficient for a failure or
specific investigation. Do not run a normal and full-output variant by default
for the same revision. Focused checks remain appropriate when they supply
distinct task-relevant evidence.
`;

const RETIRED_WORK_PACKAGE_PATTERN =
  /(?:^|[^A-Za-z0-9_.-])(?:tools\/work-packages(?:\/|\b)|work-packages\/(?:integrate\.sh|PACKAGE\.schema\.json))(?:$|[^A-Za-z0-9_.-])/u;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
const MARKDOWN_REFERENCE_PATTERN = /^\s*\[[^\]\n]+\]:\s*(\S+)/gmu;
const NPM_RUN_PATTERN = /\bnpm\s+(?:--silent\s+)?run\s+([A-Za-z0-9:._-]+)/gu;
const NPM_TEST_PATTERN = /\bnpm\s+test\b/u;
const FULL_OUTPUT_SCRIPT_PATTERN = /(?:^|:)full-output(?:$|:)/u;
const FULL_OUTPUT_NPM_REFERENCE_PATTERN =
  /\bnpm\s+(?:--silent\s+)?run\s+[A-Za-z0-9:._-]*full-output[A-Za-z0-9:._-]*/u;
const DIRECT_FULL_OUTPUT_SUITE_PATTERN =
  /\bnode\s+--test\b[^\n]*(?:dist\/tests\/\*\.test\.js|dist\/tests\/\*\.js)/u;
const HISTORICAL_CODE_TARGET_PATTERN =
  /`((?:docs\/history\/[^`\s]+|(?:[^`\s]+\/)?SUPERSEDED-[^`\s]+))`/gu;

function parseArguments(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--root requires a path");
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { root: resolve(root) };
}

function toRepositoryPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

function addFailure(failures, source, invariant, detail, repair) {
  failures.push({ source, invariant, detail, repair });
}

function readSource(root, source, failures, invariant = "selected-source-exists") {
  const absolutePath = resolve(root, source);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    addFailure(
      failures,
      source,
      invariant,
      "selected current repository source does not exist",
      "restore the source or update the explicit guard list in the same reviewed change",
    );
    return null;
  }
  return readFileSync(absolutePath, "utf8");
}

function stripCodeForMarkdownLinks(source) {
  const lines = source.split("\n");
  let fence = null;
  const kept = [];

  for (const line of lines) {
    const match = line.match(/^\s*(```+|~~~+)/u);
    if (match !== null) {
      const marker = match[1]?.[0];
      if (fence === null) {
        fence = marker ?? null;
      } else if (fence === marker) {
        fence = null;
      }
      kept.push("");
      continue;
    }
    kept.push(fence === null ? line.replace(/`[^`\n]*`/gu, "") : "");
  }

  return kept.join("\n");
}

function parseMarkdownDestination(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.length === 0) return null;

  let destination;
  if (trimmed.startsWith("<")) {
    const closing = trimmed.indexOf(">");
    if (closing === -1) return null;
    destination = trimmed.slice(1, closing);
  } else {
    destination = trimmed.split(/\s+/u, 1)[0] ?? "";
  }

  if (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)
  ) {
    return null;
  }

  const pathOnly = destination.split(/[?#]/u, 1)[0] ?? "";
  if (pathOnly.length === 0) return null;

  try {
    return decodeURIComponent(pathOnly.replace(/\\([() ])/gu, "$1"));
  } catch {
    return pathOnly;
  }
}

function extractLocalLinks(source) {
  const links = [];
  const markdown = stripCodeForMarkdownLinks(source);
  for (const pattern of [MARKDOWN_LINK_PATTERN, MARKDOWN_REFERENCE_PATTERN]) {
    for (const match of markdown.matchAll(pattern)) {
      const destination = parseMarkdownDestination(match[1] ?? "");
      if (destination !== null) links.push(destination);
    }
  }
  return links;
}

function resolveLocalTarget(root, source, destination) {
  if (destination.startsWith("/")) return resolve(root, `.${destination}`);
  return resolve(root, dirname(source), destination);
}

function isHistoricalRoute(repositoryPath) {
  return repositoryPath === "docs/history" ||
    repositoryPath.startsWith("docs/history/") ||
    repositoryPath.split("/").some((part) => part.startsWith("SUPERSEDED-"));
}

function validateLinks(root, failures) {
  let linkCount = 0;
  for (const source of LINK_SOURCES) {
    const contents = readSource(root, source, failures);
    if (contents === null) continue;

    for (const destination of extractLocalLinks(contents)) {
      linkCount += 1;
      const target = resolveLocalTarget(root, source, destination);
      const repositoryPath = toRepositoryPath(root, target);
      if (repositoryPath === ".." || repositoryPath.startsWith("../")) {
        addFailure(
          failures,
          source,
          "local-markdown-link",
          `local Markdown target ${JSON.stringify(destination)} escapes the repository`,
          "link to a Git-canonical repository target or use an explicit external URL",
        );
      } else if (!existsSync(target)) {
        addFailure(
          failures,
          source,
          "local-markdown-link",
          `local Markdown target ${JSON.stringify(destination)} does not exist`,
          "fix or remove the link, or add the intended reviewed repository target",
        );
      }
    }
  }
  return linkCount;
}

function validateRequiredPaths(root, failures) {
  for (const [source, description] of REQUIRED_PATHS) {
    const absolutePath = resolve(root, source);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      addFailure(
        failures,
        source,
        "selected-current-path",
        `${description} does not exist at the selected current path`,
        "restore the path or update the explicit owner and guard entry in the same reviewed change",
      );
    }
  }
}

function hasRequiredRouteReference(contents, source, target, linkedTargets) {
  if (linkedTargets.has(target)) return true;

  const relativeTarget = relative(dirname(source), target).split(sep).join("/");
  const candidates = new Set([target, relativeTarget]);
  return [...candidates].some((candidate) => contents.includes(`\`${candidate}\``));
}

function validateRequiredRoutes(root, failures) {
  const sourceDetails = new Map();

  for (const [source, target, description] of REQUIRED_ROUTES) {
    let details = sourceDetails.get(source);
    if (details === undefined) {
      const contents = readSource(root, source, failures, "required-route");
      const linkedTargets = new Set(
        contents === null
          ? []
          : extractLocalLinks(contents).map((destination) =>
              toRepositoryPath(root, resolveLocalTarget(root, source, destination)),
            ),
      );
      details = { contents, linkedTargets };
      sourceDetails.set(source, details);
    }

    const targetPath = resolve(root, target);
    if (!existsSync(targetPath) || !lstatSync(targetPath).isFile()) {
      addFailure(
        failures,
        source,
        "required-route",
        `${description} target ${target} does not exist`,
        "restore or intentionally replace the target and update the current route plus this explicit table",
      );
      continue;
    }

    if (
      details.contents !== null &&
      !hasRequiredRouteReference(details.contents, source, target, details.linkedTargets)
    ) {
      addFailure(
        failures,
        source,
        "required-route",
        `${description} no longer references ${target}`,
        "restore the route or update the explicit route table in the same reviewed routing change",
      );
    }

    if (isHistoricalRoute(target)) {
      addFailure(
        failures,
        source,
        "default-route-history",
        `${description} targets historical material at ${target}`,
        "route normal work to a current owner and keep history outside default reading",
      );
    }
  }
}

function historicalTargetsOnLine(root, source, line) {
  const targets = new Set();

  for (const destination of extractLocalLinks(line)) {
    const target = resolveLocalTarget(root, source, destination);
    const repositoryPath = toRepositoryPath(root, target);
    if (isHistoricalRoute(repositoryPath)) targets.add(repositoryPath);
  }

  for (const match of line.matchAll(HISTORICAL_CODE_TARGET_PATTERN)) {
    const target = match[1];
    if (target === undefined) continue;
    const repositoryPath = target.startsWith("docs/")
      ? target
      : toRepositoryPath(root, resolve(root, dirname(source), target));
    if (isHistoricalRoute(repositoryPath)) targets.add(repositoryPath);
  }

  return targets;
}

function validateDefaultRouterHistory(root, failures) {
  for (const source of DEFAULT_ROUTER_SOURCES) {
    const contents = readSource(root, source, failures, "default-route-history");
    if (contents === null) continue;

    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const targets = historicalTargetsOnLine(root, source, line);
      if (targets.size > 0) {
        const hasOptInMarker = lines[index - 1]?.trim() === OPT_IN_HISTORY_REFERENCE_MARKER;
        if (!hasOptInMarker) {
          for (const target of targets) {
            addFailure(
              failures,
              source,
              "default-route-history",
              `default router references historical material at ${target} without an explicit opt-in marker`,
              `remove the default route or place ${OPT_IN_HISTORY_REFERENCE_MARKER} on the immediately preceding line for a genuinely opt-in historical reference`,
            );
          }
        }
      }
    }
  }

  return DEFAULT_ROUTER_SOURCES.length;
}

function collectTextFiles(root, relativeRoot) {
  const absoluteRoot = resolve(root, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && /\.(?:md|txt)$/u.test(entry.name)) {
        files.push(toRepositoryPath(root, absolutePath));
      }
    }
  };
  visit(absoluteRoot);
  return files.sort();
}

function validateRetiredWorkPackageRoute(root, failures) {
  const sources = new Set([
    "AGENTS.md",
    "README-FIRST.md",
    "docs/README.md",
    "docs/DEVELOPMENT-WORKFLOW.md",
    ...collectTextFiles(root, "docs/agents"),
    ...collectTextFiles(root, "docs/review-and-audit"),
    ...collectTextFiles(root, "docs/chatgpt-project"),
    ...collectTextFiles(root, "tools/chatgpt-project-agent"),
  ]);

  for (const source of [...sources].sort()) {
    const contents = readSource(root, source, failures);
    if (contents === null) continue;
    if (RETIRED_WORK_PACKAGE_PATTERN.test(contents)) {
      addFailure(
        failures,
        source,
        "retired-work-package-route",
        "current/default Git guidance reintroduces the retired tools/work-packages route",
        "remove the current route; retain any necessary evidence only in explicitly historical material",
      );
    }
  }

  return sources.size;
}

function parseMetadata(contents) {
  const fields = new Map();
  for (const line of contents.split("\n").slice(0, 40)) {
    const markdown = line.match(/^\s*(?:-\s*)?\*\*([^*]+?):\*\*\s*(.*?)\s*$/u);
    if (markdown !== null) {
      fields.set(markdown[1]?.trim().toLowerCase(), markdown[2]?.trim() ?? "");
      continue;
    }
    const plain = line.match(/^\s*([A-Za-z][A-Za-z ]+):\s*(.*?)\s*$/u);
    if (plain !== null) {
      fields.set(plain[1]?.trim().toLowerCase(), plain[2]?.trim() ?? "");
    }
  }
  return fields;
}

function validateLifecycleMetadata(root, failures) {
  let caseCount = 0;
  for (const { source, requiredFields, expectedStatus } of LIFECYCLE_CASES) {
    caseCount += 1;
    const contents = readSource(root, source, failures, "lifecycle-metadata");
    if (contents === null) continue;
    const metadata = parseMetadata(contents);
    for (const field of requiredFields) {
      const value = metadata.get(field.toLowerCase());
      if (value === undefined || value.length === 0) {
        addFailure(
          failures,
          source,
          "lifecycle-metadata",
          `required lifecycle field ${JSON.stringify(field)} is missing or empty`,
          "restore the lightweight field or update the explicit lifecycle case after a reviewed reclassification",
        );
      }
    }

    const status = metadata.get("status");
    if (status !== expectedStatus) {
      addFailure(
        failures,
        source,
        "lifecycle-metadata",
        `selected planning Status must be ${JSON.stringify(expectedStatus)}; found ${JSON.stringify(status ?? "")}`,
        "restore the accepted planning classification or update the explicit lifecycle case after a reviewed reclassification",
      );
    }
  }

  const historyRoot = resolve(root, "docs/history");
  if (existsSync(historyRoot)) {
    for (const source of collectTextFiles(root, "docs/history").filter((path) => path.endsWith(".md"))) {
      caseCount += 1;
      const contents = readSource(root, source, failures, "lifecycle-metadata");
      if (contents === null) continue;
      const metadata = parseMetadata(contents);
      const requiredFields = ["Status", "Authority", "Use when", "Do not use for"];
      for (const field of requiredFields) {
        const value = metadata.get(field.toLowerCase());
        if (value === undefined || value.length === 0) {
          addFailure(
            failures,
            source,
            "lifecycle-metadata",
            `retained history requires non-empty ${JSON.stringify(field)} metadata`,
            "add the smallest lifecycle metadata that marks the file opt-in and non-authoritative",
          );
        }
      }
      if (!/histor/iu.test(metadata.get("status") ?? "")) {
        addFailure(
          failures,
          source,
          "lifecycle-metadata",
          "retained history Status does not identify the file as historical",
          "mark the retained record historical or move it back to its current owner",
        );
      }
      if (!/non-authoritative/iu.test(metadata.get("authority") ?? "")) {
        addFailure(
          failures,
          source,
          "lifecycle-metadata",
          "retained history Authority does not identify the file as non-authoritative",
          "mark the retained record non-authoritative or move accepted content to its canonical owner",
        );
      }
    }
  }

  return caseCount;
}

function normalizePolicyText(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function validateDocumentedVerificationPolicy(root, failures) {
  const source = DOCUMENTED_VERIFICATION_POLICY_SOURCE;
  const contents = readSource(root, source, failures, "documented-verification-policy");
  if (contents === null) return 0;

  const headingMatches = [
    ...contents.matchAll(/^## Normal and diagnostic verification\s*$/gmu),
  ];
  if (headingMatches.length !== 1) {
    addFailure(
      failures,
      source,
      "documented-verification-policy",
      `canonical normal and diagnostic verification section must occur once; found ${headingMatches.length}`,
      "restore the marked diagnostic-only policy section",
    );
    return 0;
  }

  const headingMatch = headingMatches[0];
  const sectionStart = (headingMatch?.index ?? 0) + (headingMatch?.[0].length ?? 0);
  const remainder = contents.slice(sectionStart);
  const nextHeadingMatch = remainder.match(/^#{2,3}\s+.+$/mu);
  const sectionEnd = nextHeadingMatch?.index ?? remainder.length;
  const actualSection = remainder.slice(0, sectionEnd);
  const expectedSection = `${DOCUMENTED_VERIFICATION_POLICY_BEGIN}\n${DOCUMENTED_VERIFICATION_POLICY}\n${DOCUMENTED_VERIFICATION_POLICY_END}`;

  if (normalizePolicyText(actualSection) !== normalizePolicyText(expectedSection)) {
    addFailure(
      failures,
      source,
      "documented-verification-policy",
      "canonical normal/full-output policy no longer states one normal compact suite with diagnostic-only full-output reruns",
      "restore the marked policy block and keep full-output commands out of the normal required gate",
    );
  }

  return 1;
}

function referencedScripts(command) {
  const references = [];
  for (const match of command.matchAll(NPM_RUN_PATTERN)) {
    if (match[1] !== undefined) references.push(match[1]);
  }
  if (NPM_TEST_PATTERN.test(command)) references.push("test");
  return references;
}

function isFullOutputCommand(script, command) {
  return FULL_OUTPUT_SCRIPT_PATTERN.test(script) ||
    FULL_OUTPUT_NPM_REFERENCE_PATTERN.test(command) ||
    DIRECT_FULL_OUTPUT_SUITE_PATTERN.test(command);
}

function extractWorkflowRunCommands(contents) {
  const lines = contents.split("\n");
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(\s*)run:\s*(.*?)\s*$/u);
    if (match === null) continue;

    const indentation = match[1]?.length ?? 0;
    const value = (match[2] ?? "").replace(/\s+#.*$/u, "").trim();
    if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
      commands.push(value);
      continue;
    }

    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const blockLine = lines[index] ?? "";
      if (blockLine.trim().length === 0) {
        block.push("");
        continue;
      }
      const blockIndentation = blockLine.match(/^\s*/u)?.[0].length ?? 0;
      if (blockIndentation <= indentation) {
        index -= 1;
        break;
      }
      block.push(blockLine.slice(indentation + 1).replace(/\s+#.*$/u, ""));
    }
    commands.push(block.join("\n"));
  }

  return commands;
}

function validateScriptGraph(root, failures) {
  const packageSource = "package.json";
  const packageContents = readSource(root, packageSource, failures, "compact-verification-gate");
  if (packageContents === null) return { reachableCount: 0, normalGateCount: 0 };

  let packageJson;
  try {
    packageJson = JSON.parse(packageContents);
  } catch (error) {
    addFailure(
      failures,
      packageSource,
      "compact-verification-gate",
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "repair package.json before changing verification routing",
    );
    return { reachableCount: 0, normalGateCount: 0 };
  }

  const scripts = packageJson?.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    addFailure(
      failures,
      packageSource,
      "compact-verification-gate",
      "package.json has no scripts object",
      "restore the configured npm scripts including the normal check entrypoint",
    );
    return { reachableCount: 0, normalGateCount: 0 };
  }

  if (typeof scripts["check:full-output"] !== "string") {
    addFailure(
      failures,
      packageSource,
      "compact-verification-gate",
      "diagnostic check:full-output command is missing",
      "restore a diagnostic full-output alternative without adding it to the normal check graph",
    );
  }

  if (typeof scripts.check !== "string") {
    addFailure(
      failures,
      packageSource,
      "compact-verification-gate",
      "normal npm check entrypoint is missing",
      "restore npm run check as the single compact complete suite",
    );
  }

  const pending = ["check"];
  const seen = new Set();
  let compactRunnerReachable = false;
  while (pending.length > 0) {
    const script = pending.pop();
    if (script === undefined || seen.has(script)) continue;
    seen.add(script);

    const command = scripts[script];
    if (typeof command !== "string") {
      addFailure(
        failures,
        packageSource,
        "compact-verification-gate",
        `normal check graph references missing npm script ${JSON.stringify(script)}`,
        "restore the referenced script or remove the stale normal-gate reference",
      );
      continue;
    }

    if (isFullOutputCommand(script, command)) {
      addFailure(
        failures,
        packageSource,
        "compact-verification-gate",
        `normal npm check graph reaches full-output script ${JSON.stringify(script)}`,
        "keep full-output commands diagnostic and remove them from scripts reachable from npm run check",
      );
    }

    if (command.includes("tools/test-output-filter.mjs")) compactRunnerReachable = true;
    for (const reference of referencedScripts(command)) pending.push(reference);
  }

  if (!compactRunnerReachable) {
    addFailure(
      failures,
      packageSource,
      "compact-verification-gate",
      "normal npm check graph no longer reaches the repository compact test output filter",
      "restore compact complete-suite output or intentionally update this invariant with the replacement mechanism",
    );
  }

  const ciSource = ".github/workflows/ci.yml";
  const ciContents = readSource(root, ciSource, failures, "compact-verification-gate");
  let normalGateCount = 0;
  if (ciContents !== null) {
    const runCommands = extractWorkflowRunCommands(ciContents);
    normalGateCount = runCommands.reduce(
      (count, command) =>
        count + [...command.matchAll(/\bnpm\s+run\s+check(?=\s*(?:$|&&|\|\||;))/gm)].length,
      0,
    );

    if (normalGateCount !== 1) {
      addFailure(
        failures,
        ciSource,
        "compact-verification-gate",
        `normal CI must invoke npm run check exactly once; found ${normalGateCount}`,
        "keep one normal compact complete-suite step and use focused checks only for distinct evidence",
      );
    }
    if (runCommands.some((command) => isFullOutputCommand("", command))) {
      addFailure(
        failures,
        ciSource,
        "compact-verification-gate",
        "normal CI invokes or embeds a full-output test command",
        "remove the duplicate full-output gate and retain it only as a manual diagnostic rerun",
      );
    }
  }

  return { reachableCount: seen.size, normalGateCount };
}

function run(root) {
  const failures = [];
  const linkCount = validateLinks(root, failures);
  validateRequiredPaths(root, failures);
  validateRequiredRoutes(root, failures);
  const defaultRouterCount = validateDefaultRouterHistory(root, failures);
  const scannedTextSourceCount = validateRetiredWorkPackageRoute(root, failures);
  const lifecycleCaseCount = validateLifecycleMetadata(root, failures);
  const documentedPolicyCount = validateDocumentedVerificationPolicy(root, failures);
  const { reachableCount, normalGateCount } = validateScriptGraph(root, failures);

  if (failures.length > 0) {
    console.error(`repository documentation guard: FAIL (${failures.length})`);
    for (const failure of failures) {
      console.error(
        `- ${failure.source} [${failure.invariant}] ${failure.detail}. Repair: ${failure.repair}.`,
      );
    }
    return 1;
  }

  console.log(
    `repository documentation guard: PASS (${LINK_SOURCES.length} link sources, ${linkCount} local links, ` +
      `${REQUIRED_PATHS.length} selected paths, ${scannedTextSourceCount} current text sources, ` +
      `${defaultRouterCount} default routers, ${lifecycleCaseCount} lifecycle cases, ` +
      `${documentedPolicyCount} documented policy, ${reachableCount} normal scripts, ` +
      `${normalGateCount} CI gate)`,
  );
  return 0;
}

try {
  const { root } = parseArguments(process.argv.slice(2));
  process.exitCode = run(root);
} catch (error) {
  console.error(
    `repository documentation guard: ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
}
