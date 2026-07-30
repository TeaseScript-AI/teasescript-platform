#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Node, ts } from "ts-morph";

import { createCodemodProject } from "./project.mjs";

const USAGE = `Usage:
  npm run codemod:rename-symbol -- --check --file <path> --old <name> --new <name> [--project <path>]
  npm run codemod:rename-symbol -- --write --file <path> --old <name> --new <name> [--project <path>]`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    mode: undefined,
    file: undefined,
    oldName: undefined,
    newName: undefined,
    project: "tsconfig.json",
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check" || argument === "--write") {
      if (options.mode !== undefined) fail("Provide exactly one of --check or --write.");
      options.mode = argument.slice(2);
      continue;
    }

    const keyByArgument = new Map([
      ["--file", "file"],
      ["--old", "oldName"],
      ["--new", "newName"],
      ["--project", "project"],
    ]);
    const key = keyByArgument.get(argument);
    if (key === undefined) fail(`Unknown argument: ${argument}\n\n${USAGE}`);
    if (seen.has(key)) fail(`Argument ${argument} may be provided only once.`);
    seen.add(key);

    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      fail(`Argument ${argument} requires a value.`);
    }
    options[key] = value;
    index += 1;
  }

  if (options.mode === undefined || options.file === undefined || options.oldName === undefined || options.newName === undefined) {
    fail(USAGE);
  }
  if (options.oldName === options.newName) fail("--old and --new must be different identifiers.");
  return options;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveRepositoryFile(root, input, label, extensions) {
  if (path.isAbsolute(input)) fail(`${label} must be repository-relative.`);
  const absolute = path.resolve(root, input);
  if (!isWithin(root, absolute)) fail(`${label} resolves outside the repository: ${input}`);

  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail(`${label} does not exist: ${input}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`${label} may not be a symbolic link: ${input}`);
  if (!stat.isFile()) fail(`${label} must be a regular file: ${input}`);

  const real = fs.realpathSync(absolute);
  if (!isWithin(root, real) || real !== absolute) fail(`${label} must not traverse symbolic links: ${input}`);
  if (!extensions.some((extension) => absolute.endsWith(extension))) {
    fail(`${label} must use one of these extensions: ${extensions.join(", ")}`);
  }
  return absolute;
}

function isValidIdentifier(name) {
  const source = ts.createSourceFile(
    "identifier-check.ts",
    `const ${name} = 0;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = source.statements[0];
  if (source.parseDiagnostics.length > 0 || statement === undefined || !ts.isVariableStatement(statement)) return false;
  const declaration = statement.declarationList.declarations[0];
  return declaration !== undefined && ts.isIdentifier(declaration.name) && declaration.name.text === name;
}

function supportedDeclarations(sourceFile, name) {
  const matches = [];
  for (const statement of sourceFile.getStatements()) {
    if (
      Node.isFunctionDeclaration(statement)
      || Node.isClassDeclaration(statement)
      || Node.isInterfaceDeclaration(statement)
      || Node.isTypeAliasDeclaration(statement)
      || Node.isEnumDeclaration(statement)
    ) {
      if (statement.getName() === name) matches.push(statement);
      continue;
    }
    if (!Node.isVariableStatement(statement)) continue;
    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();
      if (Node.isIdentifier(nameNode) && nameNode.getText() === name) matches.push(declaration);
    }
  }
  return matches;
}

function repositoryRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function assertWritableChangedFiles(root, sourceFiles) {
  for (const sourceFile of sourceFiles) {
    const absolute = sourceFile.getFilePath();
    if (!isWithin(root, absolute)) fail(`Rename would modify a file outside the repository: ${absolute}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(absolute) !== absolute) {
      fail(`Rename would modify an unsupported file path: ${repositoryRelative(root, absolute)}`);
    }
  }
}

export function runRenameSymbol(argv, workingDirectory = process.cwd()) {
  const options = parseArguments(argv);
  const root = fs.realpathSync(workingDirectory);
  const projectPath = resolveRepositoryFile(root, options.project, "Project config", [".json"]);
  const targetPath = resolveRepositoryFile(root, options.file, "Declaration file", [".ts", ".tsx", ".mts", ".cts"]);
  if (targetPath.endsWith(".d.ts")) fail("Declaration file may not be a generated .d.ts file.");
  if (!isValidIdentifier(options.oldName)) fail(`Invalid TypeScript identifier for --old: ${options.oldName}`);
  if (!isValidIdentifier(options.newName)) fail(`Invalid TypeScript identifier for --new: ${options.newName}`);

  const project = createCodemodProject(projectPath);
  const target = project.getSourceFile(targetPath);
  if (target === undefined) {
    fail(`Declaration file is not included by ${repositoryRelative(root, projectPath)}: ${options.file}`);
  }

  const oldMatches = supportedDeclarations(target, options.oldName);
  const newMatches = supportedDeclarations(target, options.newName);
  if (oldMatches.length === 0) {
    if (newMatches.length === 1) {
      return {
        mode: options.mode,
        status: "unchanged",
        target: repositoryRelative(root, targetPath),
        oldName: options.oldName,
        newName: options.newName,
        changedFiles: [],
      };
    }
    fail(
      `Expected exactly one supported top-level declaration named ${options.oldName} in ${options.file}; found 0. `
      + `Supported declarations are functions, classes, interfaces, type aliases, enums, and identifier variables.`,
    );
  }
  if (oldMatches.length !== 1) {
    fail(`Expected exactly one supported top-level declaration named ${options.oldName} in ${options.file}; found ${oldMatches.length}.`);
  }
  if (newMatches.length > 0) {
    fail(`Declaration file already contains a supported top-level declaration named ${options.newName}.`);
  }

  const declaration = oldMatches[0];
  if (typeof declaration.rename !== "function") fail(`Declaration ${options.oldName} does not support reference-aware rename.`);

  const before = new Map(project.getSourceFiles().map((sourceFile) => [sourceFile.getFilePath(), sourceFile.getFullText()]));
  declaration.rename(options.newName, { renameInComments: false, renameInStrings: false });
  const changedSourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => sourceFile.getFullText() !== before.get(sourceFile.getFilePath()))
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
  if (changedSourceFiles.length === 0) fail("ts-morph reported no changed files for the requested rename.");
  assertWritableChangedFiles(root, changedSourceFiles);

  const changedFiles = changedSourceFiles.map((sourceFile) => repositoryRelative(root, sourceFile.getFilePath()));
  if (options.mode === "write") {
    for (const sourceFile of changedSourceFiles) sourceFile.saveSync();
  }

  return {
    mode: options.mode,
    status: options.mode === "write" ? "written" : "changes-required",
    target: repositoryRelative(root, targetPath),
    oldName: options.oldName,
    newName: options.newName,
    changedFiles,
  };
}

function main() {
  try {
    const result = runRenameSymbol(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "changes-required") process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rename-symbol: ${message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
