import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IndentationText, NewLineKind, QuoteKind } from "ts-morph";

import { createCodemodProject } from "./project.mjs";

const tool = path.resolve("tools/ts-morph/rename-symbol.mjs");

function createFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teasescript-ts-morph-"));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2)}\n`,
  );
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

function run(root, arguments_) {
  try {
    const stdout = execFileSync(process.execPath, [tool, ...arguments_], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function renameArguments(mode, oldName = "oldName", newName = "newName") {
  return [`--${mode}`, "--file", "src/declaration.ts", "--old", oldName, "--new", newName];
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("reference-aware rename has check, write, exact changed files, and idempotent no-op behavior", () => {
  const untouched = "export  const   untouched = { spacing:  true };\n";
  const root = createFixture({
    "src/declaration.ts": "export function oldName(value: number): number {\n  return value + 1;\n}\n",
    "src/consumer.ts": "import { oldName } from \"./declaration.js\";\n\nexport const result = oldName(2);\n",
    "src/reexport.ts": "export { oldName } from \"./declaration.js\";\n",
    "src/untouched.ts": untouched,
  });
  try {
    const before = new Map([
      ["src/declaration.ts", fs.readFileSync(path.join(root, "src/declaration.ts"), "utf8")],
      ["src/consumer.ts", fs.readFileSync(path.join(root, "src/consumer.ts"), "utf8")],
      ["src/reexport.ts", fs.readFileSync(path.join(root, "src/reexport.ts"), "utf8")],
    ]);

    const checked = run(root, renameArguments("check"));
    assert.equal(checked.status, 1, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), {
      mode: "check",
      status: "changes-required",
      target: "src/declaration.ts",
      oldName: "oldName",
      newName: "newName",
      changedFiles: ["src/consumer.ts", "src/declaration.ts", "src/reexport.ts"],
    });
    for (const [relative, content] of before) assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), content);

    const written = run(root, renameArguments("write"));
    assert.equal(written.status, 0, written.stderr);
    assert.equal(JSON.parse(written.stdout).status, "written");
    assert.equal(
      fs.readFileSync(path.join(root, "src/declaration.ts"), "utf8"),
      "export function newName(value: number): number {\n  return value + 1;\n}\n",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "src/consumer.ts"), "utf8"),
      "import { newName } from \"./declaration.js\";\n\nexport const result = newName(2);\n",
    );
    assert.equal(fs.readFileSync(path.join(root, "src/reexport.ts"), "utf8"), "export { newName } from \"./declaration.js\";\n");
    assert.equal(fs.readFileSync(path.join(root, "src/untouched.ts"), "utf8"), untouched);

    const repeated = run(root, renameArguments("write"));
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).changedFiles, []);
    assert.equal(JSON.parse(repeated.stdout).status, "unchanged");
  } finally {
    removeFixture(root);
  }
});

test("rename rejects missing, ambiguous, unsupported, colliding, invalid, and escaping targets before writing", () => {
  const cases = [
    {
      files: { "src/declaration.ts": "export function otherName(): void {}\n" },
      args: renameArguments("write"),
      message: /found 0/u,
    },
    {
      files: { "src/declaration.ts": "export function oldName(value: string): string;\nexport function oldName(value: string): string { return value; }\n" },
      args: renameArguments("write"),
      message: /found 2/u,
    },
    {
      files: { "src/declaration.ts": "export namespace oldName {}\n" },
      args: renameArguments("write"),
      message: /Supported declarations/u,
    },
    {
      files: { "src/declaration.ts": "export function oldName(): void {}\nexport function newName(): void {}\n" },
      args: renameArguments("write"),
      message: /already contains/u,
    },
    {
      files: { "src/declaration.ts": "export function oldName(): void {}\n" },
      args: renameArguments("write", "oldName", "class"),
      message: /Invalid TypeScript identifier/u,
    },
  ];

  for (const testCase of cases) {
    const root = createFixture(testCase.files);
    try {
      const target = path.join(root, "src/declaration.ts");
      const before = fs.readFileSync(target, "utf8");
      const result = run(root, testCase.args);
      assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, testCase.message);
      assert.equal(fs.readFileSync(target, "utf8"), before);
    } finally {
      removeFixture(root);
    }
  }

  const root = createFixture({ "src/declaration.ts": "export function oldName(): void {}\n" });
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
  fs.writeFileSync(outside, "export function oldName(): void {}\n");
  try {
    const result = run(root, ["--write", "--file", `../${path.basename(outside)}`, "--old", "oldName", "--new", "newName"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /outside the repository/u);
  } finally {
    fs.rmSync(outside, { force: true });
    removeFixture(root);
  }
});

test("shared codemod project fixes repository formatting settings", () => {
  const root = createFixture({ "src/declaration.ts": "export const value = 1;\n" });
  try {
    const project = createCodemodProject(path.join(root, "tsconfig.json"));
    assert.equal(project.manipulationSettings.getIndentationText(), IndentationText.TwoSpaces);
    assert.equal(project.manipulationSettings.getNewLineKind(), NewLineKind.LineFeed);
    assert.equal(project.manipulationSettings.getQuoteKind(), QuoteKind.Double);
    assert.equal(project.manipulationSettings.getUseTrailingCommas(), true);
  } finally {
    removeFixture(root);
  }
});
