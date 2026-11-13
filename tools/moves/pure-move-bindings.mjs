// The pure-move check's binding comparison: each import's bindings on both sides, its relative targets resolved from
// that side's committed tree, and every other module reference refused by name (`pure-move-check.mjs` states the rule).

import path from "node:path";
import { ts } from "ts-morph";
import { PARSED, regular, gitLines } from "./pure-move-forms.mjs";

// the resolver's root for a committed tree's paths
const ROOT = "/tree/";

/**
 * The families a move's renames make: each old path with its new paths, joined where they share one (a merge), each
 * path mapped to its family's name, its lexicographically smallest member (any one member would do: the comparison only
 * needs the same name on both sides).
 */
function familiesOf(renames) {
  const parent = new Map();
  const find = (path) => {
    while (parent.has(path) && parent.get(path) !== path) path = parent.get(path);
    return path;
  };
  const join = (a, b) => {
    for (const path of [a, b]) if (!parent.has(path)) parent.set(path, path);
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  for (const [old, to] of Object.entries(renames)) for (const path of [to].flat()) join(old, path);
  const family = new Map();
  for (const path of parent.keys()) family.set(path, find(path));
  return family;
}

/**
 * TypeScript's resolution over one side's committed tree (`ref`, its files `tree`, its folders `folders`): a host that
 * reads only that tree's blobs (cached); a file's configuration (`configOf`: `{ options }` or `{ refused: reason }`);
 * and its implied module format (`formatOf`: `package.json`'s `type` and the file's extension). A file's configuration
 * is that of the nearest committed `tsconfig.json` whose root files (its `files`, `include` and `exclude`, matched by
 * TypeScript's own `matchFiles` over the tree) include it; a config matching no file is passed over, and one with any
 * other error (an `extends` the tree does not hold) refuses the files below it by name. With none: a JavaScript file,
 * or any file of a tree with no `tsconfig.json`, resolves as Node runs it (NodeNext); a TypeScript file is refused.
 * JavaScript and JSON targets resolve even where a config disables them, as they load at runtime.
 */
function treeResolver(ref, tree, folders, git) {
  // a resolver path's tree path: the root as `/tree` or `/tree/`, a path below it, or `null` outside the tree
  const inTree = (name) =>
    name === ROOT.slice(0, -1)
      ? ""
      : name.startsWith(ROOT)
        ? name.slice(ROOT.length).replace(/\/$/u, "")
        : null;
  const blobs = new Map();
  const readFile = (name) => {
    const file = inTree(name);
    if (file === null || !tree.has(file)) return undefined;
    if (!blobs.has(file)) blobs.set(file, git("cat-file", "blob", `${ref}:${file}`));
    return blobs.get(file);
  };
  const host = {
    fileExists: (name) => {
      const file = inTree(name);
      return file !== null && tree.has(file);
    },
    directoryExists: (name) => {
      const folder = inTree(name);
      return folder !== null && folders.has(folder);
    },
    readFile,
    realpath: (name) => name,
    getCurrentDirectory: () => ROOT,
    useCaseSensitiveFileNames: true,
  };
  const configs = new Map();
  const entries = new Map();
  for (const file of tree) {
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (!entries.has(dir)) entries.set(dir, { files: [], directories: [] });
    entries.get(dir).files.push(path.posix.basename(file));
  }
  for (const folder of folders) {
    if (folder === "") continue;
    const parent = path.posix.dirname(folder) === "." ? "" : path.posix.dirname(folder);
    if (!entries.has(parent)) entries.set(parent, { files: [], directories: [] });
    entries.get(parent).directories.push(path.posix.basename(folder));
  }
  const readDirectory = (root, extensions, excludes, includes, depth) =>
    ts.matchFiles(
      root,
      extensions,
      excludes,
      includes,
      true,
      ROOT,
      depth,
      (dir) => {
        const at = inTree(dir);
        return (at === null ? undefined : entries.get(at)) ?? { files: [], directories: [] };
      },
      (name) => name,
    );
  const parse = (config) => {
    if (!configs.has(config)) {
      const read = ts.readConfigFile(ROOT + config, readFile);
      const parsed = ts.parseJsonConfigFileContent(
        read.config ?? {},
        { ...host, readDirectory },
        ROOT + path.posix.dirname(config),
        undefined,
        ROOT + config,
      );
      // a config that matches no file says so as an error (TS18003); that is no error of its settings
      const errors = [read.error, ...parsed.errors].filter(
        (error) => error && error.code !== 18003,
      );
      configs.set(config, {
        options: { ...parsed.options, allowJs: true, resolveJsonModule: true },
        files: new Set(parsed.fileNames),
        error:
          errors.length === 0 ? null : ts.flattenDiagnosticMessageText(errors[0].messageText, " "),
      });
    }
    return configs.get(config);
  };
  const anyConfig = [...tree].some((file) => path.posix.basename(file) === "tsconfig.json");
  const NODE = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  const configOf = (file) => {
    let dir = path.posix.dirname(file);
    let nearest = null;
    for (;;) {
      const config = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
      if (tree.has(config)) {
        nearest ??= config;
        const parsed = parse(config);
        if (parsed.error !== null) return { refused: `${config}: ${parsed.error}` };
        if (parsed.files.has(ROOT + file)) return { options: parsed.options };
      }
      if (dir === "." || dir === "") break;
      dir = path.posix.dirname(dir);
    }
    if (!anyConfig || /\.(js|mjs|cjs|jsx)$/u.test(file)) return { options: NODE };
    return {
      refused:
        nearest === null
          ? "no committed tsconfig.json is above it"
          : `no committed tsconfig.json includes it (the nearest, ${nearest}, leaves it out)`,
    };
  };
  const formatOf = (file, options) =>
    ts.getImpliedNodeFormatForFile(ROOT + file, undefined, host, options);
  return { host, configOf, formatOf, NODE };
}

/**
 * A blob's bindings: `{ kind, target, name, as, typeOnly, line, specifier }`, one per imported or re-exported name (a
 * default import's name is `default`, a namespace's `*`, `import x = require()`'s `=`; a side-effect import's, and an
 * empty clause's (`import {} from`, `export {} from`), empty, its local name `{}` for the clause). Its target is
 * `{ type, path }`: `bare` with the specifier itself, compared by its spelling; `file`, a relative specifier resolved by
 * TypeScript's resolver over that side's committed tree (`resolver`: the file's configuration, its implied module format
 * and the specifier's own usage mode, `import` or `require`); `missing`, a relative one that resolves to no file; or
 * `refused`, a relative one in a file whose configuration the tree does not establish (`reason`). Every other module
 * reference (outside the import, re-export and import-equals statements above) is a `reference` whose target is
 * `refused`, one per line.
 */
function bindingsOf(file, text, resolver) {
  if (!PARSED.test(file)) return [];
  const config = resolver.configOf(file);
  const options = config.options ?? resolver.NODE;
  const source = ts.createSourceFile(
    file,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: resolver.formatOf(file, options),
    },
    true,
  );
  const { lineOf } = gitLines(text);
  const resolve = (node) => {
    const specifier = node.text;
    if (!specifier.startsWith(".")) return { type: "bare", path: specifier };
    const at = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (config.refused) return { type: "refused", path: at, reason: config.refused };
    const mode = ts.getModeForUsageLocation(source, node, options);
    const found = ts.resolveModuleName(
      specifier,
      ROOT + file,
      options,
      resolver.host,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    if (found !== undefined && found.resolvedFileName.startsWith(ROOT))
      return { type: "file", path: found.resolvedFileName.slice(ROOT.length) };
    return {
      type: "missing",
      path: at,
      reason: "resolves to no file under the committed configuration",
    };
  };
  const out = [];
  const compared = new Set();
  for (const statement of source.statements) {
    const line = lineOf(statement.getStart(source));
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      compared.add(statement);
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "import", target: resolve(statement.moduleSpecifier), line, specifier };
      const clause = statement.importClause;
      if (clause === undefined) out.push({ ...at, name: "", as: "", typeOnly: false });
      else {
        if (clause.name)
          out.push({ ...at, name: "default", as: clause.name.text, typeOnly: clause.isTypeOnly });
        const bindings = clause.namedBindings;
        if (
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length === 0
        )
          out.push({ ...at, name: "", as: "{}", typeOnly: clause.isTypeOnly });
        if (bindings && ts.isNamespaceImport(bindings))
          out.push({ ...at, name: "*", as: bindings.name.text, typeOnly: clause.isTypeOnly });
        else if (bindings)
          for (const element of bindings.elements)
            out.push({
              ...at,
              name: (element.propertyName ?? element.name).text,
              as: element.name.text,
              typeOnly: clause.isTypeOnly || element.isTypeOnly,
            });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      compared.add(statement);
      const specifier = statement.moduleSpecifier.text;
      const at = { kind: "re-export", target: resolve(statement.moduleSpecifier), line, specifier };
      const clause = statement.exportClause;
      if (clause === undefined)
        out.push({ ...at, name: "*", as: "*", typeOnly: statement.isTypeOnly });
      else if (ts.isNamespaceExport(clause))
        out.push({ ...at, name: "*", as: clause.name.text, typeOnly: statement.isTypeOnly });
      else if (clause.elements.length === 0)
        out.push({ ...at, name: "", as: "{}", typeOnly: statement.isTypeOnly });
      else
        for (const element of clause.elements)
          out.push({
            ...at,
            name: (element.propertyName ?? element.name).text,
            as: element.name.text,
            typeOnly: statement.isTypeOnly || element.isTypeOnly,
          });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      compared.add(statement);
      const specifier = statement.moduleReference.expression.text;
      out.push({
        kind: "import",
        target: resolve(statement.moduleReference.expression),
        line,
        specifier,
        name: "=",
        as: statement.name.text,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
  out.push(...otherReferencesOf(source, text, compared, lineOf));
  return out;
}

/**
 * Every other module reference of `source` (its `text`), refused by name, one per line, as a `reference` whose target
 * is `refused`: an `import` keyword (not `import.meta`) or a `require` identifier outside the `compared` statements, a
 * triple-slash reference directive, or a comment (JSDoc included) holding `import(` or `@import`.
 */
function otherReferencesOf(source, text, compared, lineOf) {
  const out = [];
  const lines = new Map();
  // (a line is one refusal, named by its first reference, and marked dynamic only while every reference on it is a
  // dynamic import)
  const refuse = (at, shown, what, dynamic = false) => {
    const line = lineOf(at);
    if (lines.has(line)) {
      lines.get(line).dynamic &&= dynamic;
      return;
    }
    const specifier = shown.split("\n")[0].slice(0, 60);
    const entry = {
      kind: "reference",
      target: {
        type: "refused",
        path: specifier,
        reason: `${what}, a module reference the binding rule does not compare`,
      },
      line,
      specifier,
      name: "",
      as: "",
      typeOnly: false,
      dynamic,
    };
    lines.set(line, entry);
    out.push(entry);
  };
  for (const [list, what] of [
    [source.referencedFiles, "a `/// <reference path>`"],
    [source.typeReferenceDirectives, "a `/// <reference types>`"],
    [source.libReferenceDirectives, "a `/// <reference lib>`"],
  ])
    for (const directive of list) refuse(directive.pos, directive.fileName, what);
  const comments = new Set();
  // a JSDoc comment is read twice: its parsed tokens as code's, below (never within a compared statement, whose binding
  // it is not), and its text as a comment's, from the token it precedes
  const visit = (node, inCompared, inDoc) => {
    const doc =
      inDoc ||
      (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode);
    const within = !doc && (inCompared || compared.has(node));
    // every child, a token's too (the end-of-file token holds the JSDoc after the last statement)
    for (const child of node.getChildren(source)) visit(child, within, doc);
    if (node.kind > ts.SyntaxKind.LastToken) return;
    for (const range of doc
      ? []
      : [
          ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
          ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
        ]) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      const found = /import\(|@import/u.exec(text.slice(range.pos, range.end));
      if (found !== null)
        refuse(
          range.pos + found.index,
          text.slice(range.pos + found.index, range.end),
          `a comment's \`${found[0]}\``,
        );
    }
    if (within) return;
    const parent = node.parent ?? node;
    if (node.kind === ts.SyntaxKind.ImportKeyword && !ts.isMetaProperty(parent))
      refuse(
        node.getStart(source),
        parent.getText(source),
        "an `import`",
        ts.isCallExpression(parent) && parent.expression === node,
      );
    else if (ts.isIdentifier(node) && node.text === "require")
      refuse(
        node.getStart(source),
        (ts.isCallExpression(parent) ? parent : node).getText(source),
        "a `require`",
      );
  };
  visit(source, false, false);
  return out;
}

/**
 * The bindings on one side only: over `files`, the set of `{ kind, target, name, as, typeOnly }` before and after. A
 * target is its type and path (`bare` and `file` apart), a file the move relocated keyed by its family (`renames`);
 * bindings within one family are left out. A relative specifier either side cannot resolve (`missing`, `refused`) is
 * no binding but a refusal, `{ side, file, line, specifier, reason }` (its side `removed` or `added`, as a
 * declaration names it), which the check reports unless it is declared.
 */
export function bindingDifferences(mergeBase, head, files, renames, git) {
  const family = familiesOf(renames ?? {});
  const keyOf = (target) =>
    target.type === "file"
      ? `file:${family.get(target.path) ?? target.path}`
      : `${target.type}:${target.path}`;
  // a side's files: its tree's regular files, the only ones the resolver reads (a symbolic link's blob is a path, a
  // gitlink names a commit)
  const listed = (ref) =>
    new Set(
      git("ls-tree", "-r", "-z", "--full-tree", ref)
        .split("\0")
        .filter((entry) => regular(entry, entry.slice(0, entry.indexOf(" "))))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    );
  const trees = { before: listed(mergeBase), after: listed(head) };
  // each side's folders, for the resolver's `directoryExists`
  const foldersOf = (paths) => {
    const out = new Set([""]);
    for (const one of paths)
      for (let at = one.lastIndexOf("/"); at > 0; at = one.lastIndexOf("/", at - 1))
        out.add(one.slice(0, at));
    return out;
  };
  const folders = { before: foldersOf(trees.before), after: foldersOf(trees.after) };
  const resolvers = {
    before: treeResolver(mergeBase, trees.before, folders.before, git),
    after: treeResolver(head, trees.after, folders.after, git),
  };
  const sides = { before: new Map(), after: new Map() };
  const relocated = new Set();
  // the files the change edits, on each side
  const changed = {
    before: new Set(files.map((change) => change.old)),
    after: new Set(files.map((change) => change.file)),
  };
  const refusals = new Map();
  for (const change of files) {
    if (change.binary) continue;
    for (const [side, ref, file, mode] of [
      ["before", mergeBase, change.old, change.oldMode],
      ["after", head, change.file, change.newMode],
    ]) {
      if (!regular(file, mode)) continue;
      const text = git("cat-file", "blob", `${ref}:${file}`);
      const lines = text.split("\n");
      for (const binding of bindingsOf(file, text, resolvers[side])) {
        if (binding.target.type === "missing" || binding.target.type === "refused") {
          const refusal = {
            side: side === "before" ? "removed" : "added",
            file,
            line: binding.line,
            text: lines[binding.line - 1],
            specifier: binding.specifier,
            reason: binding.target.reason,
            dynamic: binding.dynamic === true,
          };
          refusals.set(JSON.stringify([side, file, binding.line, binding.specifier]), refusal);
          continue;
        }
        const target = keyOf(binding.target);
        if (family.has(file) && target === keyOf({ type: "file", path: file })) continue;
        // a resolved file that is there on one side only, with no family: a relocation the renames do not name
        const other = side === "before" ? trees.after : trees.before;
        const { type, path: at } = binding.target;
        if (type === "file" && !other.has(at) && !family.has(at)) relocated.add(at);
        // another file the change edits, there on both sides: one a family could join with the importer
        const sibling =
          type === "file" && at !== file && other.has(at) && changed[side].has(at) ? at : null;
        const key = JSON.stringify([
          binding.kind,
          target,
          binding.name,
          binding.as,
          binding.typeOnly,
        ]);
        if (!sides[side].has(key)) sides[side].set(key, { ...binding, file, target, sibling });
      }
    }
  }
  const only = (side, other) =>
    [...sides[side]]
      .filter(([key]) => !sides[other].has(key))
      .map(([, binding]) => ({ side, ...binding }));
  const differing = [...only("before", "after"), ...only("after", "before")];
  const joinable = new Map();
  for (const { file, sibling } of differing)
    if (sibling !== null) joinable.set(JSON.stringify([file, sibling]), [file, sibling]);
  return {
    differing,
    relocated: [...relocated],
    joinable: [...joinable.values()],
    refusals: [...refusals.values()],
  };
}
