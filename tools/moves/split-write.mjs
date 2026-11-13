// Writes a decided file split into the working tree: each top-level statement of OLD, with the blank and comment lines
// above it, copied verbatim into the file an assignment gives it, in OLD's order. It does not choose the seam: the
// assignment names every test's file, and the declarations follow their readers by one rule.
//
//   node tools/moves/split-write.mjs ASSIGN [--base REV]
//   node tools/moves/split-write.mjs --list OLD [--base REV]
//
// OLD is read from commit REV (default HEAD), so the split can be written again after a change to ASSIGN; paths are
// relative to the repository's top folder. `--list` prints OLD's statements and writes nothing, to write the assignment
// from: each with its lines, a test with its number and title, a declaration with its names and the top-level names it
// reads; and the comment lines above OLD's first statement after its imports (a docblock, which goes with that
// statement, to the setup module when it is a shared declaration, unless a range gives it to a file).
//
// ASSIGN is a JSON file, kept with the split's evidence:
//   { "old": PATH,
//     "setup": { "path": PATH, "header": SENTENCE, "lines": [[A, B]…] },
//     "files": { PATH: { "header": SENTENCE | null, "tests": [N…], "lines": [[A, B]…] }, … } }
// A test is a top-level call whose first argument is a string (`test("…", …)`), numbered from 1 in OLD's order. Each
// test is named by exactly one file. `"lines"` (optional) gives OLD's lines A to B (1-based, inclusive) to that file
// whole, statements and comments alike: a docblock that describes another file's tests, a range of declarations that
// belong in the setup module. A range within OLD's leading `//` lines (a pin mark) puts those lines first in that
// file's header instead. A `header` sentence is wrapped to 120 columns as `//` lines above the file's imports; `null`
// writes none (the file that keeps OLD's own docblock).
//
// The rule for what is not a test: a declaration (its names, a destructuring pattern's included) goes to the file whose
// tests read it, through the declarations they read in turn; to the setup module when tests of two files read it, or
// when a setup declaration reads it. A setup declaration another file reads gains `export `; each file imports, by
// name, the setup names it reads (once each; an interface or a type alias with `type`), and OLD's imports filtered to
// the names its statements use (a relative specifier rewritten for its folder; an import without bindings goes to every
// file). OLD's imports are only their own lines, wherever they stand: the code between two imports is placed as any
// statement. Lines after OLD's last statement go with it.
//
// Refused, writing nothing (exit 2): a leading `//` line of OLD in no range (it would be lost), or a comment above a
// later import in none; a test named twice or not at all, or a number OLD does not have; a statement that is neither a
// test nor a declaration and in no range; a declaration no test reaches; statements of two files on one line; a range
// that overlaps another, cuts a statement's own lines, holds an import or crosses from OLD's leading `//` lines into
// the body; a file whose declaration reads one placed in another file that is not the setup module; a path outside the
// repository; a target that exists at REV and is not OLD; a missing header. On success it removes OLD from the working
// tree unless OLD is a target, and prints each file written with its line count. Prettier is not run: format the
// written files afterwards. Beside ASSIGN it writes `renames.json`, OLD to every written file (`{ "renames": { OLD:
// [FILE, …] } }`), the map `pure-move-check --renames` and `move-sweep --renames` read. Last it lists each string in
// OLD's code outside an import or export declaration that starts with `./` or `../` and went to a file in another
// folder than OLD's (`relative paths to read: N`, then each with its file and OLD line): a path relative to the file,
// which the move may break and the tool cannot tell from data, for the builder to read.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";

const USAGE =
  "usage: node tools/moves/split-write.mjs ASSIGN [--base REV] | --list OLD [--base REV]";
const WIDTH = 120;

class Refused extends Error {}

/** Throws a refusal unless `condition` holds. */
function refuseUnless(condition, message) {
  if (!condition) throw new Refused(message);
}

/** The number of a file's leading `//` lines. */
function leadingComments(lines) {
  let at = 0;
  while (at < lines.length && lines[at].startsWith("//")) at += 1;
  return at;
}

/**
 * OLD's structure: its imports (each with its first and last line, its bindings and specifier), and its other
 * top-level statements, each a test (`test`, its number and title) or a declaration (`names`), with its own first line
 * (`own`, after its doc comments), its last line, and the top-level names it reads (`reads`).
 */
function scan(file, text) {
  const host = ts.createCompilerHost({});
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  host.getSourceFile = (name) => (name === file ? source : undefined);
  const program = ts.createProgram({
    rootNames: [file],
    // (`allowJs`: without it a JavaScript OLD is no file of the program, its names have no symbols, and the checker
    // throws on some reads)
    options: { noResolve: true, noLib: true, allowJs: true },
    host,
  });
  const checker = program.getTypeChecker();
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const imports = [];
  const statements = [];
  const declared = new Map();
  const imported = new Map();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = [];
      const add = (name, text) => {
        imported.set(checker.getSymbolAtLocation(name), name.text);
        bindings.push({ local: name.text, text });
      };
      if (clause?.name) add(clause.name, clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        add(clause.namedBindings.name, `* as ${clause.namedBindings.name.text}`);
      else
        for (const element of clause?.namedBindings?.elements ?? [])
          add(element.name, element.getText(source));
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: clause?.isTypeOnly ?? false,
        defaultName: clause?.name?.text,
        namespace: clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings),
        bindings,
        bare: clause === undefined,
        first: lineOf(node.getStart(source)),
        last: lineOf(node.end),
      });
      continue;
    }
    const names = [];
    // (a binding's names, a destructuring pattern's included)
    const bound = (name) =>
      ts.isIdentifier(name)
        ? [name]
        : name.elements.flatMap((element) =>
            ts.isOmittedExpression(element) ? [] : bound(element.name),
          );
    if (node.name && ts.isIdentifier(node.name)) names.push(node.name);
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations)
        names.push(...bound(declaration.name));
    for (const name of names) declared.set(checker.getSymbolAtLocation(name), name.text);
    const call = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression);
    const title = call ? node.expression.arguments[0] : undefined;
    statements.push({
      node,
      names: names.map((name) => name.text),
      title: title && ts.isStringLiteralLike(title) ? title.text : undefined,
      type: ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
      own: lineOf(node.getStart(source)),
      last: lineOf(node.end),
    });
  }
  let tests = 0;
  for (const statement of statements) {
    if (statement.title !== undefined) statement.test = ++tests;
    statement.reads = new Set();
    statement.uses = new Set();
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
          symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
        if (ts.isExportSpecifier(node.parent))
          symbol = checker.getExportSpecifierLocalTargetSymbol(node.parent) ?? symbol;
        const name = declared.get(symbol);
        if (name !== undefined && !statement.names.includes(name)) statement.reads.add(name);
        if (imported.has(symbol)) statement.uses.add(imported.get(symbol));
      }
      ts.forEachChild(node, visit);
    };
    visit(statement.node);
  }
  // (each string that may be a path relative to the file: an import or export declaration's specifier is rewritten)
  const relative = [];
  const strings = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)) &&
      /^\.\.?\//u.test(node.text)
    )
      relative.push(lineOf(node.getStart(source)));
    ts.forEachChild(node, strings);
  };
  strings(source);
  // (the comment lines above the first statement after the imports: a file's docblock)
  const first = statements[0]?.node;
  const lead = leadingComments(text.split("\n"));
  const comments = (
    first ? (ts.getLeadingCommentRanges(text, first.getFullStart()) ?? []) : []
  ).filter((range) => lineOf(range.pos) > lead);
  const docblock =
    comments.length > 0 ? { from: lineOf(comments[0].pos), to: lineOf(comments.at(-1).end) } : null;
  return { imports, statements, tests, relative, docblock };
}

/** The file each of OLD's lines goes to, by the assignment's ranges, tests and the declaration rule. */
function place(old, lines, assign) {
  const lead = leadingComments(lines);
  const setup = assign.setup.path;
  /** OLD's imports and other statements in OLD's order, each with its own first line (`own`) and its last. */
  const nodes = [
    ...old.imports.map((entry) => ({ import: true, own: entry.first, last: entry.last })),
    ...old.statements,
  ].sort((a, b) => a.own - b.own);
  /** OLD line (1-based) → its file, from the ranges. */
  const ranged = new Map();
  for (const [file, spec] of [[setup, assign.setup], ...Object.entries(assign.files)])
    for (const [from, to] of spec.lines ?? []) {
      refuseUnless(
        Number.isInteger(from) &&
          Number.isInteger(to) &&
          from >= 1 &&
          from <= to &&
          to <= lines.length,
        `${file}: the range ${from}-${to} names no lines of OLD`,
      );
      refuseUnless(
        to <= lead || from > lead,
        `${file}: the range ${from}-${to} crosses from OLD's leading // lines into its body`,
      );
      for (const node of nodes)
        refuseUnless(
          !node.import || node.last < from || node.own > to,
          `${file}: the range ${from}-${to} holds the import at line ${node.own}`,
        );
      for (let line = from; line <= to; line += 1) {
        refuseUnless(
          !ranged.has(line),
          `${file}: the range ${from}-${to} overlaps another at line ${line}`,
        );
        ranged.set(line, file);
      }
    }
  for (let line = 1; line <= lead; line += 1)
    refuseUnless(ranged.has(line), `OLD's leading line ${line} is in no range: ${lines[line - 1]}`);
  const fileOfTest = new Map();
  for (const [file, spec] of Object.entries(assign.files))
    for (const test of spec.tests ?? []) {
      refuseUnless(test >= 1 && test <= old.tests, `${file}: OLD has no test ${test}`);
      refuseUnless(
        !fileOfTest.has(test),
        `test ${test} is named by ${fileOfTest.get(test)} and ${file}`,
      );
      fileOfTest.set(test, file);
    }
  for (let test = 1; test <= old.tests; test += 1)
    refuseUnless(fileOfTest.has(test), `test ${test} is named by no file`);
  const byName = new Map(old.statements.flatMap((s) => s.names.map((name) => [name, s])));
  for (const statement of old.statements) {
    const own = [];
    for (let line = statement.own; line <= statement.last; line += 1) own.push(ranged.get(line));
    refuseUnless(
      own.every((file) => file === own[0]),
      `line ${statement.own}: a range cuts the statement's lines ${statement.own}-${statement.last}`,
    );
    if (own[0] !== undefined) statement.file = own[0];
    else if (statement.test !== undefined) statement.file = fileOfTest.get(statement.test);
  }
  // The declarations: by the files whose placed statements read them, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const readers = new Map();
    for (const statement of old.statements)
      if (statement.file !== undefined)
        for (const name of statement.reads)
          (readers.get(name) ?? readers.set(name, new Set()).get(name)).add(statement.file);
    for (const statement of old.statements) {
      if (statement.names.length === 0 || ranged.has(statement.own)) continue;
      const files = new Set(statement.names.flatMap((name) => [...(readers.get(name) ?? [])]));
      const file =
        files.size === 0 ? undefined : files.size > 1 || files.has(setup) ? setup : [...files][0];
      if (file !== statement.file) [statement.file, changed] = [file, true];
    }
  }
  for (const statement of old.statements) {
    refuseUnless(
      statement.file !== undefined,
      `line ${statement.own}: ${statement.names.length === 0 ? "a statement that is neither a test nor a declaration, in no range" : `${statement.names.join(", ")}: no test reaches it`}`,
    );
    for (const name of statement.reads) {
      const target = byName.get(name).file;
      refuseUnless(
        target === statement.file || target === setup,
        `line ${statement.own}: ${statement.file} reads ${name}, placed in ${target}`,
      );
    }
  }
  // Each line: a range's file, else the statement's below it (its blank and comment lines above it), else the last's.
  // An import's own lines are written again in each file's imports; above it, only blank lines may go unplaced.
  const fileOf = new Map(ranged);
  let from = lead + 1;
  let previous;
  for (const node of nodes) {
    if (node.import)
      for (let line = from; line < node.own; line += 1)
        refuseUnless(
          fileOf.has(line) || lines[line - 1].trim() === "",
          `line ${line}: a comment above the import at line ${node.own}, in no range`,
        );
    else {
      refuseUnless(
        previous === undefined ||
          previous.import ||
          node.own > previous.last ||
          previous.file === node.file,
        `line ${node.own}: statements of two files on one line`,
      );
      for (let line = from; line <= node.last; line += 1)
        if (!fileOf.has(line)) fileOf.set(line, node.file);
    }
    from = Math.max(from, node.last + 1);
    previous = node;
  }
  for (let line = from; line <= lines.length; line += 1)
    if (!fileOf.has(line)) fileOf.set(line, old.statements.at(-1)?.file);
  return { fileOf, lead, byName };
}

/** `sentence` as `//` lines of at most WIDTH columns. */
function wrap(sentence) {
  const out = [];
  let line = "//";
  for (const word of sentence.split(" ")) {
    if (line !== "//" && line.length + 1 + word.length > WIDTH) {
      out.push(line);
      line = "//";
    }
    line += ` ${word}`;
  }
  return [...out, line];
}

/** A relative specifier of OLD's, rewritten for a file in `file`'s folder. */
function respecified(specifier, oldPath, file) {
  if (!specifier.startsWith(".")) return specifier;
  const relative = path.posix.relative(
    path.posix.dirname(file),
    path.posix.join(path.posix.dirname(oldPath), specifier),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The text of each target file. */
function render(old, lines, assign, { fileOf, lead, byName }) {
  const setup = assign.setup.path;
  const targets = [...Object.entries(assign.files), [setup, assign.setup]];
  const readElsewhere = new Set(
    old.statements.filter((s) => s.file !== setup).flatMap((s) => [...s.reads]),
  );
  const exportLines = new Set(
    old.statements
      .filter((s) => s.file === setup && s.names.some((name) => readElsewhere.has(name)))
      .filter((s) => !lines[s.own - 1].startsWith("export "))
      .map((s) => s.own),
  );
  // (once each: an overloaded function's signatures are statements of one name)
  const setupNames = [
    ...new Set(old.statements.filter((s) => s.file === setup).flatMap((s) => s.names)),
  ];
  const texts = new Map();
  for (const [file, spec] of targets) {
    refuseUnless(
      typeof spec.header === "string" || (spec.header === null && file !== setup),
      `${file}: no header sentence`,
    );
    const statements = old.statements.filter((s) => s.file === file);
    const uses = new Set(statements.flatMap((s) => [...s.uses]));
    const header = [];
    for (let line = 1; line <= lead; line += 1)
      if (fileOf.get(line) === file) header.push(lines[line - 1]);
    if (spec.header !== null) header.push(...wrap(spec.header));
    const imports = [];
    for (const entry of old.imports) {
      const kept = entry.bindings.filter((binding) => uses.has(binding.local));
      if (!entry.bare && kept.length === 0) continue;
      if (imports.length > 0 && lines[entry.first - 2] === "") imports.push("");
      const from = respecified(entry.specifier, assign.old, file);
      if (entry.bare) imports.push(`import "${from}";`);
      else {
        const named = kept.filter((b) => b.local !== entry.defaultName && !entry.namespace);
        const clause = [
          ...kept
            .filter((b) => b.local === entry.defaultName || entry.namespace)
            .map((b) => b.text),
          ...(named.length > 0 ? [`{ ${named.map((b) => b.text).join(", ")} }`] : []),
        ].join(", ");
        imports.push(`import ${entry.typeOnly ? "type " : ""}${clause} from "${from}";`);
      }
    }
    if (file !== setup) {
      const read = new Set(statements.flatMap((s) => [...s.reads]));
      const names = setupNames.filter((name) => read.has(name));
      if (names.length > 0) {
        const target = respecified(
          `./${path.posix.basename(setup).replace(/\.(m?)ts$/u, ".$1js")}`,
          setup,
          file,
        );
        const list = names.map((name) => (byName.get(name).type ? `type ${name}` : name));
        imports.push(`import { ${list.join(", ")} } from "${target}";`);
      }
    }
    const body = [];
    for (let line = lead + 1; line <= lines.length; line += 1)
      if (fileOf.get(line) === file)
        body.push(exportLines.has(line) ? `export ${lines[line - 1]}` : lines[line - 1]);
    while (body[0] === "") body.shift();
    const parts = [header, imports, body].filter((part) => part.length > 0);
    texts.set(file, `${parts.map((part) => part.join("\n")).join("\n\n")}\n`);
  }
  return texts;
}

/** Runs the tool with `argv` in `cwd`; returns the exit status. */
export function main(argv, cwd = process.cwd(), print = console.log) {
  const positional = [];
  let base = "HEAD";
  let list;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--base" && argv[i + 1] !== undefined) base = argv[++i];
      else if (argv[i] === "--list") {
        list = argv[++i];
        refuseUnless(
          list !== undefined && !list.startsWith("-") && !list.endsWith(".json"),
          `--list takes OLD, the file to split, not an assignment: --list OLD [--base REV]\n${USAGE}`,
        );
      } else {
        refuseUnless(!argv[i].startsWith("-"), USAGE);
        positional.push(argv[i]);
      }
    }
    refuseUnless(positional.length === (list === undefined ? 1 : 0), USAGE);
    const git = (...args) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const top = git("rev-parse", "--show-toplevel").trim();
    const read = (file) => {
      try {
        return git("show", `${base}:${file}`);
      } catch {
        throw new Refused(`cannot read ${file} at ${base}`);
      }
    };
    if (list !== undefined) {
      const old = scan(list, read(list));
      for (const s of old.statements) {
        if (s === old.statements[0] && old.docblock !== null)
          print(`${old.docblock.from}-${old.docblock.to} comment above the first statement`);
        print(
          `${s.own}-${s.last} ${s.test === undefined ? `${s.names.join(", ") || "(statement)"} reads: ${[...s.reads].join(", ")}` : `test ${s.test}: ${s.title}`}`,
        );
      }
      return 0;
    }
    let assign;
    try {
      assign = JSON.parse(readFileSync(path.resolve(cwd, positional[0]), "utf8"));
    } catch (error) {
      throw new Refused(`cannot read ${positional[0]}: ${error.message}`);
    }
    refuseUnless(
      typeof assign?.old === "string" && typeof assign.setup?.path === "string" && assign.files,
      `${positional[0]}: wants { "old", "setup": { "path", "header" }, "files": { … } }`,
    );
    refuseUnless(
      !(assign.setup.path in assign.files),
      `${assign.setup.path} is the setup and a file`,
    );
    for (const file of [assign.old, assign.setup.path, ...Object.keys(assign.files)])
      refuseUnless(
        !path.posix.isAbsolute(file) && !path.posix.normalize(file).startsWith("../"),
        `${file} is not a path inside the repository`,
      );
    const text = read(assign.old);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const old = scan(assign.old, text);
    const placed = place(old, lines, assign);
    const texts = render(old, lines, assign, placed);
    for (const file of texts.keys())
      if (file !== assign.old) {
        let tracked = true;
        try {
          git("cat-file", "-e", `${base}:${file}`);
        } catch {
          tracked = false;
        }
        refuseUnless(!tracked, `${file} exists at ${base} and is not OLD`);
      }
    for (const [file, content] of texts) {
      mkdirSync(path.dirname(path.join(top, file)), { recursive: true });
      writeFileSync(path.join(top, file), content);
      print(`${file}: ${content.split("\n").length - 1} lines`);
    }
    if (!texts.has(assign.old)) {
      rmSync(path.join(top, assign.old), { force: true });
      print(`${assign.old}: removed`);
    }
    const map = path.join(path.dirname(positional[0]), "renames.json");
    writeFileSync(
      path.resolve(cwd, map),
      `${JSON.stringify({ renames: { [assign.old]: [...texts.keys()].sort() } }, null, 2)}\n`,
    );
    print(`${map}: the renames map`);
    const moved = [...new Set(old.relative)].filter(
      (line) => path.posix.dirname(placed.fileOf.get(line)) !== path.posix.dirname(assign.old),
    );
    print(`relative paths to read: ${moved.length}`);
    for (const line of moved)
      print(`  ${placed.fileOf.get(line)} (old ${line}): ${lines[line - 1].trim()}`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(`split-write: ${error.message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
