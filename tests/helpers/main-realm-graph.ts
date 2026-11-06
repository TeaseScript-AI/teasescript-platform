import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";
import { compileTemplate, parse as parseSfc } from "vue/compiler-sfc";

/*
 * The main-realm walk behind `tests/player-main-realm.test.ts`. It is a progress ratchet for the L5 series and a guard
 * against honest mistakes, not the proof that the main bundle holds no engine code: the bundle provenance check at
 * activation is that proof. It handles exactly:
 * - ESM imports, re-exports and literal `import()` in `.ts`, read from TypeScript's own emit under
 *   `verbatimModuleSyntax` (the Player's Vue build), so the compiler decides what is type syntax and erased;
 * - a `.vue` file's inline blocks, its template compiled by `compileTemplate`;
 * - Vite's `?raw` import, `?url` glob and `new Worker(new URL(…, import.meta.url))`;
 * - local specifiers that name one file.
 *
 * It refuses other SFC forms, other Vite queries and globs, other `new URL(…, import.meta.url)`, CommonJS, and ambiguous
 * or non-code local targets.
 */

/** An import of a value from a module the main realm may not load: who imports it, from where, and which name. */
export interface MainRealmOffender {
  readonly importer: string;
  readonly target: string;
  readonly name: string;
}

export interface MainRealmGraphOptions {
  /** The repository root; every path in and out is relative to it, with `/` separators. */
  readonly root: string;
  readonly entry: string;
  /** Where `@/` points. */
  readonly aliasRoot: string;
  /** The `src/` modules the main realm may load. */
  readonly allowedSource: ReadonlySet<string>;
  /** The Player modules that run in the engine Worker. */
  readonly workerModules: ReadonlySet<string>;
  /** Main-realm modules whose imports are not judged (until activation removes them). */
  readonly exempt: ReadonlySet<string>;
}

/** Stops the walk at a loading form it does not model, rather than letting that load pass unseen. */
function refuse(label: string, form: string): never {
  throw new Error(`${label}: the main-realm walk does not model ${form}`);
}

/**
 * Whether an identifier refers to a binding, rather than being a name that something declares or accesses, a key, or a
 * label. A shorthand property `{ require }` refers to one.
 */
function refersToBinding(node: ts.Identifier): boolean {
  // EVIDENCE: validation: each of these optional fields, where a node kind has it, holds a child node.
  const parent = node.parent as ts.Node & {
    name?: ts.Node;
    propertyName?: ts.Node;
    label?: ts.Node;
  };
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return parent.name !== node && parent.propertyName !== node && parent.label !== node;
}

/**
 * TypeScript's checker over one emitted module alone, with no library or other file: a name it resolves has a declaration
 * in the module, by the language's own scope rules; a global, such as CommonJS's `require`, resolves to nothing.
 */
function moduleChecker(source: ts.SourceFile): ts.TypeChecker {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === source.fileName,
    readFile: () => undefined,
  };
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
  };
  return ts.createProgram({ rootNames: [source.fileName], options, host }).getTypeChecker();
}

/** Whether `inner` lies within `outer`, both of one source file. */
const within = (inner: ts.Node, outer: ts.Node): boolean =>
  inner.pos >= outer.pos && inner.end <= outer.end;

/**
 * Whether identifier `node` refers to a binding the module declares (`checker` from `moduleChecker`). The checker also
 * resolves a parameter's initializer to a declaration in its function's body, which it only reports (TS2373): at run
 * time the parameters cannot see the body, so the name resolves from outside that function instead.
 */
function declaredInModule(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  let symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  for (;;) {
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0) return false;
    let hiding: ts.Node | undefined;
    for (let scope = node.parent; scope !== undefined && hiding === undefined; scope = scope.parent)
      if (
        ts.isFunctionLike(scope) &&
        "body" in scope &&
        scope.body !== undefined &&
        scope.parameters.some((parameter) => within(node, parameter)) &&
        declarations.every((declaration) => within(declaration, scope.body!))
      )
        hiding = scope;
    if (hiding === undefined) return true;
    symbol = checker
      .getSymbolsInScope(hiding.parent, ts.SymbolFlags.Value)
      .find((candidate) => candidate.name === node.text);
  }
}

/** Whether `node` is `import.meta.<name>`. */
function isImportMeta(node: ts.Node, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === name
  );
}

/** TypeScript's emit of one module as the Player's Vue build keeps it: every import not written as a type import. */
const EMIT: ts.TranspileOptions = {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    verbatimModuleSyntax: true,
  },
  fileName: "module.ts",
};

/**
 * The value imports of one module's code, read from its emit, each with the names it takes (`*` for a whole module). Of Vite's own loading
 * forms it models the ones the Player uses, none of which loads code into the main realm: a `?raw` import (text), an
 * `import.meta.glob` with `query: "?url"` (URLs), and `new Worker(new URL(…, import.meta.url))` (another realm). It
 * refuses any other query, glob, `new URL(…, import.meta.url)`, or `import()` of a computed specifier.
 */
function valueImports(
  code: string,
  file: string,
  label: string,
): { specifier: string; names: string[] }[] {
  // The emit for ES modules drops `import x = require(…)`, so that form is refused before it.
  const typed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (
    typed.statements.some(
      (statement) =>
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference),
    )
  )
    refuse(label, "CommonJS require()");
  const emitted = ts.transpileModule(code, EMIT).outputText;
  const source = ts.createSourceFile(
    "/module.ts",
    emitted,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let checker: ts.TypeChecker | null = null;
  const found: { specifier: string; names: string[] }[] = [];
  const pending: ts.Node[] = [source];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause === undefined) found.push({ specifier: node.moduleSpecifier.text, names: ["*"] });
      else {
        const names: string[] = [];
        if (clause.name !== undefined) names.push("default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            names.push((element.propertyName ?? element.name).text);
        // `import { type A } from "m"` emits `import {} from "m"`, which still loads `m`.
        found.push({
          specifier: node.moduleSpecifier.text,
          names: names.length > 0 ? names : ["*"],
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names =
        clause === undefined || !ts.isNamedExports(clause)
          ? ["*"]
          : clause.elements.map((element) => (element.propertyName ?? element.name).text);
      // `export { type A } from "m"` emits `export {} from "m"`, which still loads `m`.
      found.push({ specifier: node.moduleSpecifier.text, names: names.length > 0 ? names : ["*"] });
    } else if (
      ts.isIdentifier(node) &&
      node.text === "require" &&
      refersToBinding(node) &&
      !declaredInModule(node, (checker ??= moduleChecker(source)))
    ) {
      // Any reference to the global `require`, not only a direct call: `(require)(…)`, `require!(…)` and an alias too.
      refuse(label, "CommonJS require()");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument === undefined || !ts.isStringLiteralLike(argument))
        refuse(label, "an import() of a computed specifier");
      found.push({ specifier: argument.text, names: ["*"] });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const glob = node.expression;
      if (ts.isMetaProperty(glob.expression) && glob.name.text.startsWith("glob")) {
        // Only a literal options object of plain properties whose one `query` is "?url": a spread, a computed key or a
        // second `query` could override it.
        const settings = node.arguments[1];
        const properties =
          settings !== undefined && ts.isObjectLiteralExpression(settings)
            ? settings.properties
            : [];
        const plain = properties.flatMap((property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [{ key: property.name.text, value: property.initializer }]
            : [],
        );
        const [query, ...more] = plain.filter(({ key }) => key === "query");
        const urls =
          isImportMeta(glob, "glob") &&
          plain.length === properties.length &&
          query !== undefined &&
          more.length === 0 &&
          ts.isStringLiteralLike(query.value) &&
          query.value.text === "?url";
        if (!urls)
          refuse(label, `${node.expression.getText(source)} without one literal query "?url"`);
      }
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "URL" &&
      node.arguments?.[1] !== undefined &&
      isImportMeta(node.arguments[1], "url")
    ) {
      const parent = node.parent;
      const workerEntry =
        ts.isNewExpression(parent) &&
        parent.expression.getText(source) === "Worker" &&
        parent.arguments?.[0] === node;
      if (!workerEntry) refuse(label, "new URL(…, import.meta.url) outside new Worker(…)");
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return found.filter(({ specifier }) => {
    const query = /\?(.*)$/su.exec(specifier)?.[1];
    if (query === undefined) return true;
    if (query === "raw") return false;
    return refuse(label, `the query of "${specifier}"`);
  });
}

/**
 * A module's executable code: the file itself, or a `.vue` file's inline `<script>`, `<script setup>` and template,
 * compiled by Vue's template compiler, whose code can `import()` too. The walk refuses every other part the Vue plugin
 * turns into code: a block with `src`, CSS `v-bind()`, and custom blocks.
 */
function scripts(file: string, label: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) return [text];
  const { descriptor, errors } = parseSfc(text, { filename: file });
  // Vue's parser itself refuses `<script setup src>`.
  if (errors.length > 0) throw new Error(`${label}: ${String(errors[0])}`);
  const { script, scriptSetup, template, styles, cssVars, customBlocks } = descriptor;
  const external = [script, template, ...styles].find((block) => block?.src !== undefined);
  if (external) refuse(label, `<${external.type} src>`);
  if (cssVars.length > 0) refuse(label, "CSS v-bind()");
  if (customBlocks[0] !== undefined) refuse(label, `the custom block <${customBlocks[0].type}>`);
  const code = [script?.content, scriptSetup?.content].filter(
    (content): content is string => content !== undefined,
  );
  if (template !== null) {
    const compiled = compileTemplate({
      source: template.content,
      filename: file,
      id: file,
      compilerOptions: { isTS: [script?.lang, scriptSetup?.lang].includes("ts") },
    });
    if (compiled.errors.length > 0) throw new Error(`${label}: ${String(compiled.errors[0])}`);
    code.push(compiled.code);
  }
  return code;
}

/** The file extensions a local specifier may leave out or name. */
const EXTENSIONS = [
  ".ts",
  ".vue",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
];

/**
 * The one repository file a local specifier names (a `.ts` or `.vue` module, or a stylesheet), or `null` for a package.
 * A specifier with an extension names that file, or the `.ts` file for a `.js` one that is missing; one without names a
 * file with one of `EXTENSIONS`, else a directory's `index` file. Where two candidates exist, which one loads depends on
 * the bundler's order, so the walk refuses it, as it refuses a file of any other kind.
 */
function resolveSpecifier(
  from: string,
  specifier: string,
  aliasRoot: string,
  label: string,
  name: (file: string) => string,
): string | null {
  const base = specifier.startsWith("@/")
    ? join(aliasRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) {
    if (specifier.startsWith("/")) refuse(label, `the root-relative specifier "${specifier}"`);
    return null;
  }
  const extension = EXTENSIONS.find((candidate) => base.endsWith(candidate));
  const groups =
    extension === undefined
      ? [
          EXTENSIONS.map((ext) => `${base}${ext}`),
          EXTENSIONS.map((ext) => join(base, `index${ext}`)),
        ]
      : [extension === ".js" ? [base, `${base.slice(0, -3)}.ts`] : [base]];
  const found =
    groups
      .map((group) => group.filter((file) => existsSync(file) && statSync(file).isFile()))
      .find((group) => group.length > 0) ?? [];
  if (found.length > 1)
    refuse(label, `"${specifier}", which could name ${found.map(name).join(" or ")}`);
  const [file] = found;
  if (file === undefined || !/\.(?:ts|vue|css)$/u.test(file))
    refuse(label, `"${specifier}", a local specifier that names no .ts, .vue or .css file`);
  return file;
}

/**
 * Walks the main realm's modules from `entry`: every Player module it reaches that is not a Worker module, and every
 * allowed `src/` module. An import of a value from any other module is an offender, and the walk does not go through it.
 * Each module is visited once, so a cycle is no special case.
 */
export function mainRealmGraph(options: MainRealmGraphOptions): {
  readonly modules: readonly string[];
  readonly offenders: readonly MainRealmOffender[];
} {
  const root = resolve(options.root);
  const name = (file: string) => relative(root, file).split(sep).join("/");
  const aliasRoot = join(root, options.aliasRoot);
  const visited = new Set<string>();
  const offenders: MainRealmOffender[] = [];
  const pending = [join(root, options.entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const importer = name(file);
    if (options.exempt.has(importer)) continue;
    for (const code of scripts(file, importer))
      for (const { specifier, names } of valueImports(code, file, importer)) {
        const resolved = resolveSpecifier(file, specifier, aliasRoot, importer, name);
        // A package, or a stylesheet, which holds no code.
        if (resolved === null || resolved.endsWith(".css")) continue;
        const target = name(resolved);
        const mainRealm = target.startsWith("src/")
          ? options.allowedSource.has(target)
          : !options.workerModules.has(target);
        if (mainRealm) pending.push(resolved);
        else for (const imported of names) offenders.push({ importer, target, name: imported });
      }
  }
  const unique = new Map(offenders.map((o) => [`${o.importer} ${o.target} ${o.name}`, o]));
  return {
    modules: [...visited].map(name).sort(),
    offenders: [...unique.values()].sort((a, b) =>
      `${a.importer} ${a.target} ${a.name}`.localeCompare(`${b.importer} ${b.target} ${b.name}`),
    ),
  };
}
