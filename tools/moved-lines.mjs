// Git's moved-line detection for a committed change, read once over the whole change (Git matches moved blocks across
// files): each changed file's added and removed lines, each marked moved or not. Shared by `pure-move-check.mjs` and
// `structure-report.mjs --diff --moved`.
//
// The diff is `git diff -M -U0 --color=always --color-moved=zebra --color-moved-ws=allow-indentation-change` between
// two commits. Every colour is pinned (`-c color.diff.*`, a moved block's alternate colours the same as its first), so a
// moved line and another are told apart by their colour alone, whatever the user's configuration; whitespace errors
// are not highlighted, and every other setting is pinned as `structure-report.mjs` pins its diffs. Zebra, not plain:
// plain marks any added line equal to a removed one anywhere, with no block threshold. Git's detection is heuristic:
// a moved block below its threshold (20 alphanumeric characters) is shown as added and removed, and its similarity
// threshold decides what a renamed file is.
import { execFileSync } from "node:child_process";

/** Why Git's output cannot be read as it wrote it. */
export class MovedLinesUnreadable extends Error {}

// the colours the diff is pinned to, each a plain SGR code a line starts with
const COLOURS = { old: "31", new: "32", oldMoved: "35", newMoved: "36" };
const PINS = [
  ["color.diff.old", "red"],
  ["color.diff.new", "green"],
  ["color.diff.oldMoved", "magenta"],
  ["color.diff.newMoved", "cyan"],
  ["color.diff.oldMovedAlternative", "magenta"],
  ["color.diff.newMovedAlternative", "cyan"],
  ["color.diff.oldMovedDimmed", "magenta"],
  ["color.diff.newMovedDimmed", "cyan"],
  ["color.diff.oldMovedAlternativeDimmed", "magenta"],
  ["color.diff.newMovedAlternativeDimmed", "cyan"],
  ["color.diff.context", "normal"],
  ["color.diff.meta", "normal"],
  ["color.diff.frag", "normal"],
  ["color.diff.func", "normal"],
  ["color.diff.commit", "normal"],
  ["color.diff.whitespace", "normal"],
  ["diff.noprefix", "false"],
  ["diff.mnemonicPrefix", "false"],
  ["diff.suppressBlankEmpty", "false"],
  ["core.quotePath", "false"],
];
// (built from the escape character's code: a regular expression literal may not hold a control character)
const ESCAPE = String.fromCharCode(27);
const SGR = new RegExp(`${ESCAPE}\\[([0-9;]*)m`, "gu");
const LEADING_SGR = new RegExp(`^${ESCAPE}\\[([0-9;]*)m`, "u");

/** Git's environment for the diff: without `GIT_DIFF_OPTS`, which would change its context. */
const { GIT_DIFF_OPTS: _diffOptions, ...environment } = process.env;

/** A name from a `---`/`+++` line, `null` for `/dev/null`; a quoted name (a tab, newline or quote in it) is refused. */
function nameOf(field, prefix) {
  if (field === "/dev/null") return null;
  if (field.startsWith('"'))
    throw new MovedLinesUnreadable(
      `moved-lines: a quoted file name Git wrote (${field}) is not read`,
    );
  if (!field.startsWith(prefix))
    throw new MovedLinesUnreadable(`moved-lines: an unexpected file line: ${field}`);
  return field.slice(prefix.length);
}

/**
 * Each changed file of `base`..`head` (commits; `paths` limits the diff, all files when empty): its names at both
 * sides (`null` where it does not exist), whether the change adds it, and its added and removed lines in order, each
 * `{ line, text, moved }` with `line` its line in its own side's blob.
 */
export function movedLinesOf(base, head, paths = [], cwd = process.cwd()) {
  const output = execFileSync(
    "git",
    [
      ...PINS.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--color=always",
      "--color-moved=zebra",
      "--color-moved-ws=allow-indentation-change",
      "--ws-error-highlight=none",
      "-M",
      "-U0",
      "--inter-hunk-context=0",
      base,
      head,
      "--",
      ...paths.map((file) => `:(literal)${file}`),
    ],
    { cwd, maxBuffer: 256 * 1024 * 1024, env: environment, encoding: "utf8" },
  );
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files = [];
  let file = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const text = raw.replace(SGR, "");
    if (text.startsWith("diff --git ")) {
      file = { old: null, file: null, added: false, addedLines: [], removedLines: [] };
      files.push(file);
      continue;
    }
    if (file === null)
      throw new MovedLinesUnreadable(`moved-lines: output before a file header: ${text}`);
    if (text.startsWith("new file mode ")) file.added = true;
    else if (text.startsWith("--- ")) file.old = nameOf(text.slice(4), "a/");
    else if (text.startsWith("+++ ")) file.file = nameOf(text.slice(4), "b/");
    else if (text.startsWith("rename from ")) file.old = text.slice("rename from ".length);
    else if (text.startsWith("rename to ")) file.file = text.slice("rename to ".length);
    else if (text.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
      if (hunk === null)
        throw new MovedLinesUnreadable(`moved-lines: an unreadable hunk header: ${text}`);
      let [oldAt, oldLeft] = [Number(hunk[1]), Number(hunk[2] ?? 1)];
      let [newAt, newLeft] = [Number(hunk[3]), Number(hunk[4] ?? 1)];
      while (oldLeft > 0 || newLeft > 0) {
        index += 1;
        const body = lines[index];
        if (body === undefined)
          throw new MovedLinesUnreadable("moved-lines: a hunk ends before its counts");
        const bodyText = body.replace(SGR, "");
        if (bodyText.startsWith("\\")) continue;
        const colour = LEADING_SGR.exec(body)?.[1] ?? "";
        if (bodyText.startsWith("+")) {
          if (colour !== COLOURS.new && colour !== COLOURS.newMoved)
            throw new MovedLinesUnreadable(
              `moved-lines: an added line in an unknown colour (${colour})`,
            );
          file.addedLines.push({
            line: newAt,
            text: bodyText.slice(1),
            moved: colour === COLOURS.newMoved,
          });
          newAt += 1;
          newLeft -= 1;
        } else if (bodyText.startsWith("-")) {
          if (colour !== COLOURS.old && colour !== COLOURS.oldMoved)
            throw new MovedLinesUnreadable(
              `moved-lines: a removed line in an unknown colour (${colour})`,
            );
          file.removedLines.push({
            line: oldAt,
            text: bodyText.slice(1),
            moved: colour === COLOURS.oldMoved,
          });
          oldAt += 1;
          oldLeft -= 1;
        } else
          throw new MovedLinesUnreadable(`moved-lines: a context line in a -U0 hunk: ${bodyText}`);
      }
    }
  }
  return files;
}
