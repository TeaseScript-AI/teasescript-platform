import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface GuardResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const repositoryRoot = process.cwd();
const guardPath = resolve(repositoryRoot, "tools/check-repository-docs.mjs");

function createRepositoryFixture(): { readonly root: string; readonly cleanup: () => void } {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "teasescript-doc-guard-"));
  const fixtureRoot = resolve(temporaryRoot, "repository");
  const excluded = new Set([".git", "dist", "node_modules"]);

  cpSync(repositoryRoot, fixtureRoot, {
    recursive: true,
    filter(source) {
      if (source === repositoryRoot) return true;
      return !excluded.has(basename(source));
    },
  });

  return {
    root: fixtureRoot,
    cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
  };
}

function runGuard(root: string): GuardResult {
  const result = spawnSync(process.execPath, [guardPath, "--root", root], {
    cwd: root,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function append(root: string, path: string, text: string): void {
  const absolutePath = resolve(root, path);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n${text}\n`);
}

function assertRejected(
  result: GuardResult,
  source: string,
  invariant: string,
): void {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(result.stderr, new RegExp(`\\[${invariant}\\]`, "u"));
  assert.match(result.stderr, /Repair:/u);
}

test("repository documentation guard accepts current routes and focused allowed context", () => {
  const fixture = createRepositoryFixture();
  try {
    mkdirSync(resolve(fixture.root, "docs/history"), { recursive: true });
    writeFileSync(
      resolve(fixture.root, "docs/history/WORK-PACKAGE-EVIDENCE.md"),
      `# Historical work-package evidence

- **Status:** Historical retained evidence
- **Authority:** Non-authoritative
- **Use when:** Investigating the retired repository publication route
- **Do not use for:** Current task routing or implementation instructions

The retired \`tools/work-packages/integrate.sh\` path may be named here as historical evidence.
`,
    );
    append(
      fixture.root,
      "docs/TESTING.md",
      "Diagnostic example: `npm run check:full-output` remains available after a compact failure.",
    );
    append(
      fixture.root,
      "CURRENT-DESIGN.md",
      "Local component context may explain a stable boundary without copying current execution state.",
    );
    append(
      fixture.root,
      "tools/chatgpt-project-agent/docs/PROJECT-INSTRUCTIONS.txt",
      "Git-canonical project-agent context may describe repository work without claiming a final archive contract.",
    );

    const result = runGuard(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^repository documentation guard: PASS /u);
    assert.equal(result.stdout.trim().split("\n").length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a broken selected local link", () => {
  const fixture = createRepositoryFixture();
  try {
    append(fixture.root, "README-FIRST.md", "[Broken current owner](docs/DOES-NOT-EXIST.md)");
    assertRejected(runGuard(fixture.root), "README-FIRST.md", "local-markdown-link");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a broken local reference definition", () => {
  const fixture = createRepositoryFixture();
  try {
    append(
      fixture.root,
      "docs/README.md",
      "[Broken reference][missing-owner]\n\n[missing-owner]: DOES-NOT-EXIST.md",
    );
    assertRejected(runGuard(fixture.root), "docs/README.md", "local-markdown-link");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a missing selected current path", () => {
  const fixture = createRepositoryFixture();
  try {
    rmSync(resolve(fixture.root, "tools/test-output-filter.mjs"));
    assertRejected(
      runGuard(fixture.root),
      "tools/test-output-filter.mjs",
      "selected-current-path",
    );
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects removal of a required current route", () => {
  const fixture = createRepositoryFixture();
  try {
    const source = "README-FIRST.md";
    const absolutePath = resolve(fixture.root, source);
    writeFileSync(
      absolutePath,
      readFileSync(absolutePath, "utf8").replaceAll(
        "`docs/review-and-audit/AUDIT.md`",
        "the explicit audit guide",
      ),
    );
    assertRejected(runGuard(fixture.root), source, "required-route");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a current retired work-package route", () => {
  const fixture = createRepositoryFixture();
  try {
    append(
      fixture.root,
      "docs/agents/CONNECTOR-LOCAL.md",
      "Use `tools/work-packages/integrate.sh` as the normal publication route.",
    );
    assertRejected(
      runGuard(fixture.root),
      "docs/agents/CONNECTOR-LOCAL.md",
      "retired-work-package-route",
    );
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a default route into history", () => {
  const fixture = createRepositoryFixture();
  try {
    mkdirSync(resolve(fixture.root, "docs/history"), { recursive: true });
    writeFileSync(
      resolve(fixture.root, "docs/history/ROUTED-HISTORY.md"),
      `# Routed history

- **Status:** Historical retained evidence
- **Authority:** Non-authoritative
- **Use when:** Investigating an old route
- **Do not use for:** Default task routing
`,
    );
    append(
      fixture.root,
      "README-FIRST.md",
      "Read `docs/history/ROUTED-HISTORY.md` for every task.",
    );
    assertRejected(runGuard(fixture.root), "README-FIRST.md", "default-route-history");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects missing selected lifecycle metadata", () => {
  const fixture = createRepositoryFixture();
  try {
    const source = "docs/planning/MAINTENANCE-CANDIDATES.md";
    const absolutePath = resolve(fixture.root, source);
    writeFileSync(
      absolutePath,
      readFileSync(absolutePath, "utf8").replace(
        "- **Authority:** Non-authoritative and evidence-dependent\n",
        "",
      ),
    );
    assertRejected(runGuard(fixture.root), source, "lifecycle-metadata");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a duplicate normal full-output gate", () => {
  const fixture = createRepositoryFixture();
  try {
    const packagePath = resolve(fixture.root, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    packageJson.scripts.check = "npm test && npm run check:full-output";
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    assertRejected(runGuard(fixture.root), "package.json", "compact-verification-gate");
  } finally {
    fixture.cleanup();
  }
});

test("repository documentation guard rejects a full-output command in normal CI", () => {
  const fixture = createRepositoryFixture();
  try {
    append(
      fixture.root,
      ".github/workflows/ci.yml",
      "      - name: Duplicate diagnostic gate\n        run: |\n          npm run check:full-output",
    );
    assertRejected(
      runGuard(fixture.root),
      ".github/workflows/ci.yml",
      "compact-verification-gate",
    );
  } finally {
    fixture.cleanup();
  }
});
