#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Node, ts } from "ts-morph";

import { createCodemodProject } from "./project.mjs";

const USAGE = `Usage:
  npm run codemod:rename-symbol -- --check --file <path> --old <name> --new <name> [--project <path>]
  npm run codemod:rename-symbol -- --write --file <path> --old <name> --new <name> [--project <path>]`;

const RENAME_OPTIONS = Object.freeze({
  renameInComments: false,
  renameInStrings: false,
});

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

function isValidModuleBindingIdentifier(name) {
  const fileName = "identifier-check.ts";
  const text = `export const ${name} = 0;`;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options = {
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    noLib: true,
    noResolve: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = {
    ...ts.createCompilerHost(options),
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (candidate) => candidate === fileName ? source : undefined,
    readFile: (candidate) => candidate === fileName ? text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const program = ts.createProgram([fileName], options, host);
  return program.getSyntacticDiagnostics(source).length === 0
    && program.getSemanticDiagnostics(source).length === 0;
}

function isTypeScriptDeclarationFile(filePath) {
  return /\.d\.(?:ts|mts|cts)$/u.test(filePath);
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

function declarationNameNode(declaration) {
  const nameNode = declaration.getNameNode?.();
  if (nameNode === undefined || !Node.isIdentifier(nameNode)) {
    fail(`Declaration ${declaration.getKindName()} does not have a supported identifier name node.`);
  }
  return nameNode;
}

function expectedPostRenameLocations(project, declaration, newName) {
  const locations = project
    .getLanguageService()
    .findRenameLocations(declarationNameNode(declaration), RENAME_OPTIONS);
  if (locations.length === 0) fail("TypeScript reported no rename locations for the selected declaration.");

  const byFile = new Map();
  for (const location of locations) {
    const filePath = location.getSourceFile().getFilePath();
    const fileLocations = byFile.get(filePath) ?? [];
    fileLocations.push(location);
    byFile.set(filePath, fileLocations);
  }

  const expected = [];
  for (const [filePath, fileLocations] of byFile) {
    let offset = 0;
    for (const location of fileLocations.sort((left, right) => left.getTextSpan().getStart() - right.getTextSpan().getStart())) {
      const span = location.getTextSpan();
      const prefix = location.getPrefixText() ?? "";
      const suffix = location.getSuffixText() ?? "";
      expected.push({
        filePath,
        start: span.getStart() + offset + prefix.length,
        length: newName.length,
      });
      offset += prefix.length + newName.length + suffix.length - span.getLength();
    }
  }
  return expected;
}

function locationKey(location) {
  return JSON.stringify([location.filePath, location.start, location.length]);
}

function formatLocation(root, location) {
  const filePath = isWithin(root, location.filePath)
    ? repositoryRelative(root, location.filePath)
    : location.filePath;
  return `${filePath}:${location.start}`;
}

function assertRenameReferenceIdentity(root, project, target, newName, expectedLocations) {
  const renamedMatches = supportedDeclarations(target, newName);
  if (renamedMatches.length !== 1) {
    fail(`Expected exactly one renamed declaration named ${newName}; found ${renamedMatches.length}.`);
  }

  const actualLocations = project
    .getLanguageService()
    .findRenameLocations(declarationNameNode(renamedMatches[0]), RENAME_OPTIONS)
    .map((location) => ({
      filePath: location.getSourceFile().getFilePath(),
      start: location.getTextSpan().getStart(),
      length: location.getTextSpan().getLength(),
    }));

  const remainingActual = new Map();
  for (const location of actualLocations) {
    const key = locationKey(location);
    const entries = remainingActual.get(key) ?? [];
    entries.push(location);
    remainingActual.set(key, entries);
  }

  const missing = [];
  for (const location of expectedLocations) {
    const key = locationKey(location);
    const entries = remainingActual.get(key);
    if (entries === undefined || entries.length === 0) missing.push(location);
    else entries.pop();
  }
  const unexpected = [...remainingActual.values()].flat();

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...missing.slice(0, 5).map((location) => `lost ${formatLocation(root, location)}`),
      ...unexpected.slice(0, 5).map((location) => `unexpected ${formatLocation(root, location)}`),
    ].join("; ");
    fail(`Rename would change symbol identity and was not written: ${details}`);
  }
}

function repositoryRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function diagnosticMessage(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, "\n");
}

function diagnosticFile(root, diagnostic) {
  const sourceFile = diagnostic.getSourceFile();
  if (sourceFile === undefined) return "<global>";
  const filePath = sourceFile.getFilePath();
  return isWithin(root, filePath) ? repositoryRelative(root, filePath) : filePath;
}

function errorDiagnostics(project) {
  return project
    .getPreEmitDiagnostics()
    .filter((diagnostic) => diagnostic.getCategory() === ts.DiagnosticCategory.Error);
}

function diagnosticKey(root, diagnostic) {
  return JSON.stringify([
    diagnosticFile(root, diagnostic),
    diagnostic.getCode(),
    diagnosticMessage(diagnostic),
  ]);
}

function introducedDiagnostics(root, before, after) {
  const remaining = new Map();
  for (const diagnostic of before) {
    const key = diagnosticKey(root, diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const introduced = [];
  for (const diagnostic of after) {
    const key = diagnosticKey(root, diagnostic);
    const count = remaining.get(key) ?? 0;
    if (count === 0) introduced.push(diagnostic);
    else remaining.set(key, count - 1);
  }
  return introduced;
}

function formatDiagnostics(root, diagnostics) {
  return diagnostics
    .slice(0, 5)
    .map((diagnostic) => `${diagnosticFile(root, diagnostic)} TS${diagnostic.getCode()}: ${diagnosticMessage(diagnostic)}`)
    .join("; ");
}

function staleTargetBindings(project, target, oldName) {
  const targetPath = target.getFilePath();
  const stale = [];

  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (declaration.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      for (const specifier of declaration.getNamedImports()) {
        if (specifier.getName() === oldName) {
          stale.push({ filePath: sourceFile.getFilePath(), description: `import ${oldName}` });
        }
      }

      const namespaceImport = declaration.getNamespaceImport();
      if (namespaceImport === undefined) continue;
      const namespaceName = namespaceImport.getText();
      for (const access of sourceFile.getDescendantsOfKind(ts.SyntaxKind.PropertyAccessExpression)) {
        if (access.getExpression().getText() === namespaceName && access.getName() === oldName) {
          stale.push({ filePath: sourceFile.getFilePath(), description: `${namespaceName}.${oldName}` });
        }
      }
    }

    for (const declaration of sourceFile.getExportDeclarations()) {
      if (declaration.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      for (const specifier of declaration.getNamedExports()) {
        if (specifier.getName() === oldName) {
          stale.push({ filePath: sourceFile.getFilePath(), description: `export ${oldName}` });
        }
      }
    }
  }

  return stale;
}

function assertVerifiableNoOp(root, project, target, oldName, newName) {
  const stale = staleTargetBindings(project, target, oldName);
  if (stale.length > 0) {
    fail(
      `Cannot verify idempotent no-op for ${oldName} -> ${newName}; stale target bindings remain: `
      + stale
        .slice(0, 5)
        .map((entry) => `${repositoryRelative(root, entry.filePath)}: ${entry.description}`)
        .join("; "),
    );
  }

  const diagnostics = errorDiagnostics(project);
  if (diagnostics.length > 0) {
    fail(
      `Cannot verify idempotent no-op for ${oldName} -> ${newName} while the project has TypeScript errors: `
      + formatDiagnostics(root, diagnostics),
    );
  }
}

function assertWritableChangedFiles(root, sourceFiles) {
  for (const sourceFile of sourceFiles) {
    const absolute = sourceFile.getFilePath();
    if (!isWithin(root, absolute)) fail(`Rename would modify a file outside the repository: ${absolute}`);
    if (isTypeScriptDeclarationFile(absolute)) {
      fail(`Rename would modify a TypeScript declaration artifact: ${repositoryRelative(root, absolute)}`);
    }
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
  if (isTypeScriptDeclarationFile(targetPath)) {
    fail("Declaration file may not be a TypeScript declaration artifact (.d.ts, .d.mts, or .d.cts).");
  }
  if (!isValidModuleBindingIdentifier(options.oldName)) fail(`Invalid TypeScript module binding identifier for --old: ${options.oldName}`);
  if (!isValidModuleBindingIdentifier(options.newName)) fail(`Invalid TypeScript module binding identifier for --new: ${options.newName}`);

  const project = createCodemodProject(projectPath);
  const target = project.getSourceFile(targetPath);
  if (target === undefined) {
    fail(`Declaration file is not included by ${repositoryRelative(root, projectPath)}: ${options.file}`);
  }

  const oldMatches = supportedDeclarations(target, options.oldName);
  const newMatches = supportedDeclarations(target, options.newName);
  if (oldMatches.length === 0) {
    if (newMatches.length === 1) {
      assertVerifiableNoOp(root, project, target, options.oldName, options.newName);
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

  const diagnosticsBefore = errorDiagnostics(project);
  const expectedLocations = expectedPostRenameLocations(project, declaration, options.newName);
  const before = new Map(project.getSourceFiles().map((sourceFile) => [sourceFile.getFilePath(), sourceFile.getFullText()]));
  declaration.rename(options.newName, RENAME_OPTIONS);
  const changedSourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => sourceFile.getFullText() !== before.get(sourceFile.getFilePath()))
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
  if (changedSourceFiles.length === 0) fail("ts-morph reported no changed files for the requested rename.");
  assertWritableChangedFiles(root, changedSourceFiles);

  const newDiagnostics = introducedDiagnostics(root, diagnosticsBefore, errorDiagnostics(project));
  if (newDiagnostics.length > 0) {
    fail(`Rename would introduce TypeScript errors and was not written: ${formatDiagnostics(root, newDiagnostics)}`);
  }
  assertRenameReferenceIdentity(root, project, target, options.newName, expectedLocations);

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
