import { globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Resolves every relative link and `#anchor` in the repository's Markdown files as GitHub does, and prints one line per
// broken link (`npm run check:doc-links`, part of `check:pretest`):
//
//   node tools/repository-checks/doc-links.mjs
//
// Links: inline links and images, reference definitions (not footnotes), and the `href` and `src` of raw HTML,
// outside fenced code, code spans and HTML comments. A destination with a scheme (`https:`, `mailto:`) or `//` is
// external and is not checked. Every other one names a file or folder of the repository: relative to the linking file,
// or to the root when it starts with `/`. Its path must exist with exactly that case, inside the repository and outside
// `node_modules`, `dist`, `coverage` and `.git`. A fragment must then name an anchor of the target. In a Markdown file,
// or the `README.md` GitHub shows for a folder, that is a heading's slug (`slugger`), an HTML `id` or an `<a name>`; in
// any other file, a line or line range it has (`#L12`, `#L12-L20`).
//
// Exit status: 1 when a link is broken, else 0.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Folders whose files GitHub's copy of the repository does not have, or that no link may name. */
const EXCLUDED = ["node_modules", "dist", "coverage", ".git"];

/** The repository's Markdown files, relative to `root`, sorted. */
function markdownFiles(root) {
  return globSync("**/*.md", { cwd: root, exclude: EXCLUDED.map((folder) => `${folder}/**`) })
    .map((file) => file.split(sep).join("/"))
    .sort();
}

/**
 * GitHub's heading slugs (github-slugger): lowercase, every character but a letter, mark, number, `_`, `-` or space
 * removed, each space a `-`; a repeated slug gets `-1`, `-2`, … in document order, skipping one already taken.
 */
function slugger() {
  const taken = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-");
    let slug = base;
    while (taken.has(slug)) {
      const count = taken.get(base) + 1;
      taken.set(base, count);
      slug = `${base}-${count}`;
    }
    taken.set(slug, 0);
    return slug;
  };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return String.fromCodePoint(code);
  });
}

/**
 * The text GitHub renders for a heading's Markdown, from which its slug is made: code spans keep their content;
 * links and images keep their text (an image none); HTML tags, emphasis and backslash escapes go.
 */
function headingText(markdown) {
  const parts = [];
  let rest = markdown;
  while (rest.length > 0) {
    const open = /`+/u.exec(rest);
    if (open === null) {
      parts.push({ code: false, text: rest });
      break;
    }
    const close = new RegExp(`(?<!\`)${open[0]}(?!\`)`, "u").exec(
      rest.slice(open.index + open[0].length),
    );
    if (close === null) {
      parts.push({ code: false, text: rest });
      break;
    }
    const start = open.index + open[0].length;
    parts.push({ code: false, text: rest.slice(0, open.index) });
    parts.push({
      code: true,
      text: rest.slice(start, start + close.index).replace(/^ (.*) $/su, "$1"),
    });
    rest = rest.slice(start + close.index + open[0].length);
  }
  return parts
    .map(({ code, text }) =>
      code
        ? text
        : decodeEntities(
            text
              .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "")
              .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/gu, "$1")
              .replace(/<[^>]*>/gu, "")
              .replace(/(^|[^\p{L}\p{N}_\\])_+(?=\S)/gu, "$1")
              .replace(/(?<=[^\s\\])_+(?=$|[^\p{L}\p{N}_])/gu, "")
              .replace(/\\([!-/:-@[-`{-~])/gu, "$1"),
          ),
    )
    .join("")
    .trim();
}

const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/u;

/**
 * `source` with fenced code, code spans and HTML comments replaced by spaces (line breaks kept, so every offset and
 * line stays) as `text`; with fenced code and HTML comments alone replaced, as `uncommented`; and the indexes of the
 * lines that fenced code holds, as `code`.
 */
function masked(source) {
  const lines = source.split("\n");
  const code = new Set();
  let fence = null;
  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line);
    if (fence === null) {
      if (match !== null && !(match[1][0] === "`" && match[2].includes("`"))) {
        fence = match[1];
        code.add(index);
      }
    } else {
      code.add(index);
      if (
        match !== null &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        match[2].trim() === ""
      )
        fence = null;
    }
  }
  const blank = (text) => text.replace(/[^\n]/gu, " ");
  let text = lines.map((line, index) => (code.has(index) ? blank(line) : line)).join("\n");
  text = text.replace(/<!--[\s\S]*?-->/gu, blank);
  const uncommented = text;
  // a code span: a run of backticks to the next run of the same length, within one paragraph
  text = text.replace(/(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?)(?<!`)\1(?!`)/gu, blank);
  return { text, uncommented, code };
}

/** The line and column, both from 1, of `offset` in `text`. */
function position(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/**
 * The destination of an inline link whose `](` ends just before `start` in `text`, and the offset it starts at; or
 * `null` when no destination and closing `)` follow, which GitHub then renders as text.
 */
function inlineDestination(text, start) {
  let at = start;
  while (text[at] === " " || text[at] === "\t" || text[at] === "\n") at += 1;
  let destination;
  const from = at;
  if (text[at] === "<") {
    const end = text.indexOf(">", at);
    if (end === -1 || text.slice(at, end).includes("\n")) return null;
    destination = text.slice(at + 1, end);
    at = end + 1;
  } else {
    let depth = 0;
    while (at < text.length && !/\s/u.test(text[at])) {
      if (text[at] === "\\") at += 1;
      else if (text[at] === "(") depth += 1;
      else if (text[at] === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      at += 1;
    }
    destination = text.slice(from, at);
  }
  const title = /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))?\s*\)/su.exec(
    text.slice(at),
  );
  if (title === null) return null;
  return { destination, offset: from };
}

/**
 * Whether the `]` at `close` closes a `[` of the same paragraph: brackets nest, and a backslash escapes one.
 */
function closesBracket(text, close) {
  let depth = 0;
  for (let at = close - 1; at >= 0; at -= 1) {
    // a blank line ends the paragraph
    if (text[at] === "\n" && text.slice(text.lastIndexOf("\n", at - 1) + 1, at).trim() === "")
      return false;
    if (at > 0 && text[at - 1] === "\\") continue;
    if (text[at] === "]") depth += 1;
    else if (text[at] === "[") {
      if (depth === 0) return true;
      depth -= 1;
    }
  }
  return false;
}

/** Every link of a Markdown `source`: its destination as written, and where it starts. */
export function links(source) {
  const { text } = masked(source);
  const found = [];
  for (const match of text.matchAll(/(?<!\\)\]\(/gu)) {
    if (!closesBracket(text, match.index)) continue;
    const link = inlineDestination(text, match.index + 2);
    if (link !== null) found.push(link);
  }
  for (const match of text.matchAll(
    /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(?:\n[ \t]*)?(<[^>\n]*>|\S+)/gmu,
  )) {
    const raw = match[1];
    const destination = raw.startsWith("<") ? raw.slice(1, -1) : raw;
    found.push({ destination, offset: match.index + match[0].length - raw.length });
  }
  for (const match of text.matchAll(
    /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*(["'])(.*?)\1/gisu,
  ))
    found.push({
      destination: match[2],
      offset: match.index + match[0].length - match[2].length - 1,
    });
  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ destination, offset }) => ({ destination, ...position(text, offset) }));
}

/** The anchors GitHub makes in a Markdown `source`: its headings' slugs, every HTML `id`, and each `<a name>`. */
export function anchors(source) {
  const { text, uncommented, code } = masked(source);
  const lines = uncommented.split("\n");
  const slug = slugger();
  const found = new Set();
  for (const [index, line] of lines.entries()) {
    if (code.has(index)) continue;
    const content = line.replace(/^ {0,3}(?:>[ \t]?)*/u, "");
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u.exec(content);
    if (atx !== null) {
      found.add(slug(headingText(atx[1] ?? "")));
      continue;
    }
    const next = lines[index + 1];
    if (
      next !== undefined &&
      !code.has(index + 1) &&
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(next) &&
      content.trim() !== "" &&
      !/^ {0,3}(?:[-*+]|\d+[.)])(?:[ \t]|$)|^ {0,3}(?:[-*_][ \t]*){3,}$|^ {0,3}\||^ {0,3}</u.test(
        content,
      ) &&
      (index === 0 || lines[index - 1].trim() === "" || /^ {0,3}#/u.test(lines[index - 1]))
    )
      found.add(slug(headingText(content)));
  }
  for (const match of text.matchAll(
    /<(?:[a-z][a-z0-9]*\b[^>]*?\sid|a\b[^>]*?\sname)\s*=\s*(["'])(.*?)\1/gisu,
  ))
    found.add(match[2]);
  return found;
}

/** The anchor nearest to `wanted` by edit distance, when it is near enough to be a likely meaning. */
function nearest(wanted, candidates) {
  let best = null;
  let bestDistance = Math.max(2, Math.floor(wanted.length / 4)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate, bestDistance);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}

function editDistance(a, b, bound) {
  if (Math.abs(a.length - b.length) >= bound) return bound;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The broken links of the Markdown `files` under `root`, each `{ fileName, line, column, destination, message }`.
 */
export function brokenLinks(root, files = markdownFiles(root)) {
  const sources = new Map();
  const read = (file) => {
    if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), "utf8"));
    return sources.get(file);
  };
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(read(file)));
    return anchorCache.get(file);
  };
  const listings = new Map();
  /** Whether `path` (relative to `root`, `/`-separated) exists with exactly this case. */
  const exists = (path) =>
    path.split("/").every((name, index, names) => {
      const folder = names.slice(0, index).join("/");
      if (!listings.has(folder)) {
        try {
          listings.set(folder, new Set(readdirSync(join(root, folder))));
        } catch {
          listings.set(folder, new Set());
        }
      }
      return listings.get(folder).has(name);
    });

  const broken = [];
  for (const file of files) {
    for (const { destination, line, column } of links(read(file))) {
      const report = (message) =>
        broken.push({ fileName: file, line, column, destination, message });
      const written = destination.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
      if (written === "" || /^[a-z][a-z0-9+.-]*:/iu.test(written) || written.startsWith("//"))
        continue;
      const hash = written.indexOf("#");
      const pathPart = (hash === -1 ? written : written.slice(0, hash)).replace(/\?.*$/su, "");
      const fragment = hash === -1 ? null : decode(written.slice(hash + 1));
      let target = file;
      if (pathPart !== "") {
        const absolute = pathPart.startsWith("/")
          ? resolve(root, `.${decode(pathPart)}`)
          : resolve(root, dirname(file), decode(pathPart));
        const inside = relative(resolve(root), absolute).split(sep).join("/");
        if (inside.startsWith("../") || inside === "..") {
          report(`the link '${destination}' leads outside the repository`);
          continue;
        }
        if (inside !== "" && EXCLUDED.includes(inside.split("/")[0])) {
          report(`the link '${destination}' names '${inside}', which the repository does not hold`);
          continue;
        }
        if (inside !== "" && !exists(inside)) {
          report(`the link '${destination}' names '${inside}', which does not exist`);
          continue;
        }
        target = inside;
      }
      if (fragment === null || fragment === "") continue;
      const isFolder = target === "" || statSync(join(root, target)).isDirectory();
      // the file whose anchors the fragment names: a folder's is the README.md GitHub shows below it
      const shown = isFolder ? (target === "" ? "README.md" : `${target}/README.md`) : target;
      if (isFolder && !exists(shown)) {
        report(
          `the link '${destination}' names an anchor in '${target || "."}', a folder without a README.md`,
        );
        continue;
      }
      if (shown.endsWith(".md")) {
        const known = anchorsOf(shown);
        if (known.has(fragment)) continue;
        const near = nearest(fragment, known);
        report(
          `the link '${destination}' names the anchor '#${fragment}', which ${shown === file ? "this file" : `'${shown}'`} does not have` +
            (near === null ? "" : `: the nearest it has is '#${near}'`),
        );
        continue;
      }
      const lines = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/u.exec(fragment);
      if (lines === null) {
        report(
          `the link '${destination}' names the anchor '#${fragment}' in '${shown}', which is no Markdown file: only a line ('#L12') or lines ('#L12-L20') resolve there`,
        );
        continue;
      }
      const text = read(shown);
      const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const outside = [lines[1], lines[2]].map(Number).find((n) => n < 1 || n > count);
      if (outside !== undefined)
        report(
          `the link '${destination}' names line ${outside} of '${shown}', which has ${count} lines`,
        );
    }
  }
  return broken;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const broken = brokenLinks(repositoryRoot);
  for (const { fileName, line, column, message } of broken)
    console.error(`${fileName}:${line}:${column}: ${message}`);
  if (broken.length > 0) {
    console.error(`check:doc-links: ${broken.length} broken links`);
    process.exitCode = 1;
  }
}
