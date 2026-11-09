// Git's moved-line detection for a committed change, read once over the whole change (Git matches moved blocks across
// files): each changed file's added and removed lines, each marked moved or not. Shared by `pure-move-check.mjs` and
// `structure-report.mjs --diff --moved`.
//
// Two diffs with the same options, `git diff -M -U0 --color-moved=zebra --color-moved-ws=allow-indentation-change`
// between two commits: one without colour, whose text is every line's exact bytes, and one with colour, of which only
// each line's leading colour is read (so a line's own bytes, an escape sequence in a string included, never pass
// through colour handling). Every colour is pinned (`-c color.diff.*`, a moved block's alternate colours the same as
// its first), so a moved line and another are told apart by their colour alone, whatever the user's configuration;
// whitespace errors are not highlighted, and every other setting is pinned as `structure-report.mjs` pins its diffs.
// Zebra, not plain: plain marks any added line equal to a removed one anywhere, with no block threshold. Git's
// detection is heuristic: a moved block below its threshold (20 alphanumeric characters) is shown as added and
// removed, and its similarity threshold decides what a renamed file is. A quoted file name (one with a tab, newline,
// quote or backslash) is refused, and a binary change is reported as such, its lines unread.
import { execFileSync } from "node:child_process";

/** Why Git's output cannot be read as it wrote it. */
export class MovedLinesUnreadable extends Error {}

// the colours the coloured diff is pinned to, each the SGR code its lines start with
const COLOURS = { old: "31", new: "32", oldMoved: "35", newMoved: "36" };
const COLOUR_PINS = [
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
];
const PINS = [
  ["diff.noprefix", "false"],
  ["diff.mnemonicPrefix", "false"],
  ["diff.suppressBlankEmpty", "false"],
  ["core.quotePath", "false"],
];
// (built from the escape character's code: a regular expression literal may not hold a control character)
const LEADING_SGR = new RegExp(`^${String.fromCharCode(27)}\\[([0-9;]*)m`, "u");

/** Git's environment for the diff: without `GIT_DIFF_OPTS`, which would change its context. */
const { GIT_DIFF_OPTS: _diffOptions, ...environment } = process.env;

/** A name as Git wrote it in a header, refused where Git quoted it. */
function unquoted(name, line) {
  if (name.startsWith('"'))
    throw new MovedLinesUnreadable(
      `moved-lines: a quoted file name Git wrote is not read: ${line}`,
    );
  return name;
}

/**
 * A name from a `---`/`+++` line, `null` for `/dev/null`. Git ends a name that holds a space with a tab, which is not
 * part of the name (a tab in a name makes Git quote it, which is refused).
 */
function nameOf(field, prefix, line) {
  const name = field.endsWith("\t") ? field.slice(0, -1) : field;
  if (name === "/dev/null") return null;
  unquoted(name, line);
  if (!name.startsWith(prefix))
    throw new MovedLinesUnreadable(`moved-lines: an unexpected file line: ${line}`);
  return name.slice(prefix.length);
}

/** One of the two diffs, as its lines. */
function diffLines(base, head, paths, cwd, coloured) {
  const output = execFileSync(
    "git",
    [
      ...[...PINS, ...(coloured ? COLOUR_PINS : [])].flatMap(([key, value]) => [
        "-c",
        `${key}=${value}`,
      ]),
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      coloured ? "--color=always" : "--no-color",
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
  return lines;
}

/**
 * Each changed file of `base`..`head` (commits; `paths` limits the diff, all files when empty): its names at both
 * sides (`null` where it does not exist), its `diff --git` line, whether the change adds it, whether Git shows it as binary (its lines then
 * unread), and its added and removed lines in order, each `{ line, text, moved }` with `line` its line in its own
 * side's blob and `text` its exact bytes.
 */
export function movedLinesOf(base, head, paths = [], cwd = process.cwd()) {
  const lines = diffLines(base, head, paths, cwd, false);
  const coloured = diffLines(base, head, paths, cwd, true);
  if (coloured.length !== lines.length)
    throw new MovedLinesUnreadable(
      `moved-lines: the coloured diff has ${coloured.length} lines and the plain one ${lines.length}`,
    );
  const colourAt = (index) => LEADING_SGR.exec(coloured[index])?.[1] ?? "";
  const files = [];
  let file = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (text.startsWith("diff --git ")) {
      file = {
        header: text,
        old: null,
        file: null,
        added: false,
        binary: false,
        addedLines: [],
        removedLines: [],
      };
      files.push(file);
      continue;
    }
    if (file === null)
      throw new MovedLinesUnreadable(`moved-lines: output before a file header: ${text}`);
    if (text.startsWith("new file mode ")) file.added = true;
    else if (text.startsWith("--- ")) file.old = nameOf(text.slice(4), "a/", text);
    else if (text.startsWith("+++ ")) file.file = nameOf(text.slice(4), "b/", text);
    else if (text.startsWith("rename from "))
      file.old = unquoted(text.slice("rename from ".length), text);
    else if (text.startsWith("rename to "))
      file.file = unquoted(text.slice("rename to ".length), text);
    else if (text.startsWith("Binary files ") && text.endsWith(" differ")) file.binary = true;
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
        if (body.startsWith("\\")) continue;
        const colour = colourAt(index);
        if (body.startsWith("+")) {
          if (colour !== COLOURS.new && colour !== COLOURS.newMoved)
            throw new MovedLinesUnreadable(
              `moved-lines: an added line in an unknown colour (${colour})`,
            );
          file.addedLines.push({
            line: newAt,
            text: body.slice(1),
            moved: colour === COLOURS.newMoved,
          });
          newAt += 1;
          newLeft -= 1;
        } else if (body.startsWith("-")) {
          if (colour !== COLOURS.old && colour !== COLOURS.oldMoved)
            throw new MovedLinesUnreadable(
              `moved-lines: a removed line in an unknown colour (${colour})`,
            );
          file.removedLines.push({
            line: oldAt,
            text: body.slice(1),
            moved: colour === COLOURS.oldMoved,
          });
          oldAt += 1;
          oldLeft -= 1;
        } else throw new MovedLinesUnreadable(`moved-lines: a context line in a -U0 hunk: ${body}`);
      }
    }
  }
  return files;
}
