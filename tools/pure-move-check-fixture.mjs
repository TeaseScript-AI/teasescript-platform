// The pure-move check's test fixture, shared by `pure-move-check.test.mjs` and `pure-move-check-bindings.test.mjs`:
// a repository committed before and after a change, the check run there, and the split both files use.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("./pure-move-check.mjs", import.meta.url));

/** A function long enough that Git marks it moved: each body line well over its 20-character block threshold. */
export const helper = (name, change = "") =>
  [
    `function ${name}(values: readonly number[]): number {`,
    "  let total = 0;",
    "  for (const value of values) total += value * value;",
    `  return total + values.length${change};`,
    "}",
  ].join("\n");

/**
 * A repository at `before`, then committed at `after` (a file's text, `null` to remove it, or `{ executable: text }`);
 * `run(args)` runs the check there.
 */
export function moveOf(before, after) {
  const root = mkdtempSync(join(tmpdir(), "pure-move-check-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      if (text === null) rmSync(join(root, path));
      else if (text.executable !== undefined) {
        writeFileSync(join(root, path), text.executable);
        chmodSync(join(root, path), 0o755);
      } else writeFileSync(join(root, path), text);
    }
  };
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write(before);
  git("add", "-A");
  git("commit", "-qm", "before");
  const base = git("rev-parse", "HEAD");
  write(after);
  git("add", "-A");
  git("commit", "-qm", "after");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [tool, base, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout + result.stderr };
  };
  // (inside the fixture, so `done` removes it; untracked, so the check, which reads committed trees, never sees it)
  const declare = (entries) => {
    const path = join(root, "declare.json");
    writeFileSync(path, JSON.stringify(entries));
    return path;
  };
  // the move sweep's map, beside the declarations
  const renames = (map) => {
    const path = join(root, "renames.json");
    writeFileSync(path, JSON.stringify({ renames: map }));
    return path;
  };
  return {
    root,
    run,
    declare,
    renames,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const main = `${helper("sumOfSquares")}\n\n${helper("weighted")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`;
/** The split's family: `a.ts` keeps one function, `b.ts` takes the other. */
export const splitFamily = { "a.ts": ["a.ts", "b.ts"] };
export const split = {
  "a.ts": `import { weighted } from "./b.js";\n\n${helper("sumOfSquares")}\n\nexport const used = sumOfSquares([1]) + weighted([2]);\n`,
  "b.ts": `export ${helper("weighted")}\n`,
};
