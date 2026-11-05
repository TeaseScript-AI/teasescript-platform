import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";
import { compileTemplate, parse as parseSfc } from "vue/compiler-sfc";

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

/** Whether `node` is `import.meta.<name>`. */
function isImportMeta(node: ts.Node, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === name
  );
}

/**
 * The value imports of one module's code, each with the names it takes (`*` for a whole module). Of Vite's own loading
 * forms it models the ones the Player uses, none of which loads code into the main realm: a `?raw` import (text), an
 * `import.meta.glob` with `query: "?url"` (URLs), and `new Worker(new URL(…, import.meta.url))` (another realm). It
 * refuses any other query, glob, `new URL(…, import.meta.url)`, or `import()` of a computed specifier.
 */
function valueImports(
  code: string,
  file: string,
  label: string,
): { specifier: string; names: string[] }[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { specifier: string; names: string[] }[] = [];
  const pending: ts.Node[] = [source];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause === undefined) found.push({ specifier: node.moduleSpecifier.text, names: ["*"] });
      else if (!clause.isTypeOnly) {
        const names: string[] = [];
        if (clause.name !== undefined) names.push("default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings !== undefined && ts.isNamedImports(bindings))
          for (const element of bindings.elements)
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
        // `import { type A } from "m"` still loads `m` under `verbatimModuleSyntax` (the Player's Vue build), so a
        // declaration that is not `import type` always counts.
        found.push({
          specifier: node.moduleSpecifier.text,
          names: names.length > 0 ? names : ["*"],
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      const clause = node.exportClause;
      const names =
        clause === undefined || !ts.isNamedExports(clause)
          ? ["*"]
          : clause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => (element.propertyName ?? element.name).text);
      // `export { type A } from "m"` and `export {} from "m"` still load `m` under `verbatimModuleSyntax`.
      found.push({ specifier: node.moduleSpecifier.text, names: names.length > 0 ? names : ["*"] });
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

/** The local files the Player imports that hold no code (styles). */
const NON_CODE = /\.css$/u;

/** The repository file a local specifier names, or `null` for a package or a non-script file. */
function resolveSpecifier(from: string, specifier: string, aliasRoot: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(aliasRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [
    base.replace(/\.js$/u, ".ts"),
    base,
    `${base}.ts`,
    `${base}.vue`,
    join(base, "index.ts"),
  ])
    if (/\.(ts|vue)$/u.test(candidate) && existsSync(candidate) && statSync(candidate).isFile())
      return candidate;
  return null;
}

/**
 * Walks the main realm's modules from `entry`: every Player module it reaches that is not a Worker module, and every
 * allowed `src/` module. An import of a value from any other module is an offender, and the walk does not go through it.
 * A local specifier must name a `.ts` or `.vue` module or a stylesheet; the walk refuses any other. Each module is
 * visited once, so a cycle is no special case.
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
        const resolved = resolveSpecifier(file, specifier, aliasRoot);
        if (resolved === null) {
          // A package, or a local file that holds no code; any other local file is a load the walk does not model.
          if (/^(\.|\/|@\/)/u.test(specifier) && !NON_CODE.test(specifier))
            refuse(importer, `"${specifier}", a local specifier that names no .ts or .vue module`);
          continue;
        }
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
