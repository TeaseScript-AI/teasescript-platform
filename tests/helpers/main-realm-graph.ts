import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";
import { parse as parseSfc } from "vue/compiler-sfc";

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

/** The value imports of one module's code, each with the names it takes (`*` for a whole module). */
function valueImports(code: string, file: string): { specifier: string; names: string[] }[] {
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
      if (names.length > 0) found.push({ specifier: node.moduleSpecifier.text, names });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument))
        found.push({ specifier: argument.text, names: ["*"] });
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return found;
}

/** A module's script code: the file itself, or a `.vue` file's script blocks. */
function scripts(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) return [text];
  const { descriptor } = parseSfc(text, { filename: file });
  return [descriptor.script?.content, descriptor.scriptSetup?.content].filter(
    (content): content is string => content !== undefined,
  );
}

/** The repository file a local specifier names, or `null` for a package or a non-script file. */
function resolveSpecifier(from: string, specifier: string, aliasRoot: string): string | null {
  const bare = specifier.replace(/\?.*$/u, "");
  const base = bare.startsWith("@/")
    ? join(aliasRoot, bare.slice(2))
    : bare.startsWith(".")
      ? resolve(dirname(from), bare)
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
    for (const code of scripts(file))
      for (const { specifier, names } of valueImports(code, file)) {
        const resolved = resolveSpecifier(file, specifier, aliasRoot);
        if (resolved === null) continue;
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
