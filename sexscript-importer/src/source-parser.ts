import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord, parseParsedGroovyFile, type ParsedGroovyFile } from "./ast.ts";

export type GroovyParseMode = "script-body" | "unit";
export type GroovyParserRunner = (
  mode: GroovyParseMode,
  sourcePath: string,
) => Promise<ParsedGroovyFile>;

const parserScript = fileURLToPath(new URL("../parser-groovy/bin/export-ast.sh", import.meta.url));

export async function parseGroovySource(
  sourcePath: string,
  runner: GroovyParserRunner = runLegacyGroovyParser,
): Promise<ParsedGroovyFile> {
  const scriptBody = await runner("script-body", sourcePath);
  if (scriptBody.diagnostics.length === 0) return scriptBody;

  const unit = await runner("unit", sourcePath);
  if (isAuxiliaryUnit(unit)) return unit;
  return scriptBody;
}

export async function runLegacyGroovyParser(
  mode: GroovyParseMode,
  sourcePath: string,
): Promise<ParsedGroovyFile> {
  const { stdout, stderr, status } = await run("bash", [parserScript, mode, sourcePath]);
  if (status !== 0) {
    throw new Error(
      `Legacy Groovy parser failed with exit code ${status}${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`,
    );
  }
  return parseParsedGroovyFile(JSON.parse(stdout), sourcePath);
}

function isAuxiliaryUnit(file: ParsedGroovyFile): boolean {
  if (file.diagnostics.length > 0 || file.root?.kind !== "compilationUnit") return false;
  const classes = Array.isArray(file.root.classes) ? file.root.classes : [];
  const topLevel = file.root.topLevel;
  const topLevelStatements =
    isRecord(topLevel) && Array.isArray(topLevel.statements) ? topLevel.statements : [];
  return classes.length > 0 && topLevelStatements.length === 0;
}

async function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, status: code ?? 1 }));
  });
}
