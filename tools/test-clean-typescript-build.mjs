import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

const repositoryRoot = process.cwd();
const fixtureRoot = mkdtempSync(resolve(tmpdir(), "clean-typescript-build-"));
const sourceBeforeRename = resolve(fixtureRoot, "tests/obsolete.test.ts");
const sourceAfterRename = resolve(fixtureRoot, "tests/renamed.test.ts");
const outputBeforeRename = resolve(fixtureRoot, "dist/tests/obsolete.test.js");
const outputAfterRename = resolve(fixtureRoot, "dist/tests/renamed.test.js");
const playerArtifact = resolve(fixtureRoot, "dist/player-app/required.txt");
const editorArtifact = resolve(fixtureRoot, "dist/editor/required.txt");

const repositoryPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

function buildTypeScript() {
  const result = spawnSync("npm", ["run", "build:typescript"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${resolve(repositoryRoot, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

try {
  mkdirSync(resolve(fixtureRoot, "tools"));
  mkdirSync(resolve(fixtureRoot, "tests"));
  mkdirSync(resolve(fixtureRoot, "dist/player-app"), { recursive: true });
  mkdirSync(resolve(fixtureRoot, "dist/editor"), { recursive: true });
  cpSync(
    resolve(repositoryRoot, "tools/clean-compiled-tests.mjs"),
    resolve(fixtureRoot, "tools/clean-compiled-tests.mjs"),
  );
  writeFileSync(
    resolve(fixtureRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      scripts: { "build:typescript": repositoryPackage.scripts["build:typescript"] },
      type: "module",
    })}\n`,
  );
  writeFileSync(
    resolve(fixtureRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "dist",
        rootDir: ".",
      },
      include: ["tests/**/*.ts"],
    })}\n`,
  );
  writeFileSync(resolve(fixtureRoot, "tests/required.test.ts"), "export {};\n");
  writeFileSync(sourceBeforeRename, "export {};\n");
  writeFileSync(playerArtifact, "required player artifact\n");
  writeFileSync(editorArtifact, "required editor artifact\n");

  buildTypeScript();
  assert.equal(existsSync(outputBeforeRename), true);
  const focusedResult = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "tools/test-output-filter.mjs"), outputBeforeRename],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  assert.equal(focusedResult.status, 0, `${focusedResult.stdout}${focusedResult.stderr}`);

  renameSync(sourceBeforeRename, sourceAfterRename);
  buildTypeScript();
  assert.equal(existsSync(outputBeforeRename), false);
  assert.equal(existsSync(outputAfterRename), true);

  rmSync(sourceAfterRename);
  buildTypeScript();
  assert.equal(existsSync(outputAfterRename), false);
  assert.equal(existsSync(playerArtifact), true);
  assert.equal(existsSync(editorArtifact), true);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
