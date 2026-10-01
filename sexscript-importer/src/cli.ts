import { readFile } from "node:fs/promises";
import type { ParsedGroovyFile } from "./ast.ts";
import { emitTease } from "./emit-tease.ts";
import { inventoryFiles } from "./inventory.ts";
import { lowerParsedFile } from "./lower.ts";
import { analyzeFeasibility } from "./report.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "inventory") {
  if (args.length === 0) fail("Usage: node src/cli.ts inventory <ast.json> [...]");
  const files = await Promise.all(args.map(readParsedFile));
  process.stdout.write(`${JSON.stringify(inventoryFiles(files), null, 2)}\n`);
} else if (command === "report") {
  if (args.length === 0) fail("Usage: node src/cli.ts report <ast.json> [...]");
  const files = await Promise.all(args.map(readParsedFile));
  process.stdout.write(`${JSON.stringify(analyzeFeasibility(files), null, 2)}\n`);
} else if (command === "convert") {
  if (args.length !== 1) fail("Usage: node src/cli.ts convert <ast.json>");
  const program = lowerParsedFile(await readParsedFile(args[0]!));
  process.stdout.write(emitTease(program));
  for (const diagnostic of program.diagnostics) {
    const location = diagnostic.span === null ? "" : `:${diagnostic.span.line}:${diagnostic.span.column}`;
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code} ${program.sourceName}${location} ${diagnostic.message}\n`);
  }
  if (program.diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
} else {
  fail("Usage: node src/cli.ts <inventory|report|convert> ...");
}

async function readParsedFile(path: string): Promise<ParsedGroovyFile> {
  const value = JSON.parse(await readFile(path, "utf8")) as ParsedGroovyFile;
  if (value.formatVersion !== 1) throw new Error(`Unsupported parser format in ${path}`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
