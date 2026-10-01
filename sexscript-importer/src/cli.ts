import { readFile } from "node:fs/promises";
import { inventoryFiles } from "./inventory.ts";
import type { ParsedGroovyFile } from "./ast.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "inventory") {
  if (args.length === 0) fail("Usage: node src/cli.ts inventory <ast.json> [...]");
  const files = await Promise.all(args.map(readParsedFile));
  process.stdout.write(`${JSON.stringify(inventoryFiles(files), null, 2)}\n`);
} else {
  fail("Usage: node src/cli.ts inventory <ast.json> [...]");
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
