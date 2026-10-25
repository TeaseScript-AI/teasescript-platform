import type {
  FunctionDeclaration,
  GlobalStatement,
  Identifier,
  SpeakerDeclaration,
} from "../ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "../diagnostics.js";
import { TEASESCRIPT_PROTECTED_NAMES } from "../language-facts.js";
import {
  PLAYER_DECLARATION,
  runsOnItsOwn,
  sessionDeclarations,
  setsDefaultSpeaker,
} from "../project-globals.js";
import type { ProjectProgram, SemanticValidationOptions } from "../semantic.js";
import type { SourceSpan } from "../source.js";
import { PLAYER } from "../speaker-terms.js";
import { LEAVES_TYPES_CHECKABLE, semanticCode, type NamePassCode } from "./diagnostics.js";
import { SemanticScope, type Binding, type ProjectDeclaration } from "./scope.js";

/** The project scope: host globals, then the globals, speakers, and global functions of every file. */
export class ProjectNames {
  readonly scope = new SemanticScope();

  /** The top-level labels of each file, by path, which transfers may name. */
  readonly labels = new Map<string, ReadonlySet<string>>();

  /** The files that run nothing on their own: they hold declarations only. */
  readonly declarationsOnly = new Set<string>();

  /** The tags of each file that runs something, by path, when they are known. */
  readonly tags = new Map<string, ReadonlyMap<string, number | null>>();

  /** The files that tagged picks with the same facts may choose (see `taggedCandidates`), by those facts. */
  readonly taggedPicks = new Map<string, readonly string[]>();

  /**
   * The files that the script references the project makes may name: those of its `script(...)` calls and
   * `findScripts(...)` lists; `null` once one may name any file, as a `script(...)` of a path computed otherwise than in
   * a text with `${...}`.
   */
  referencedScripts: Set<string> | null = new Set();

  /** The lists of files already in `referencedScripts`, each added once. */
  readonly #referred = new WeakSet<readonly string[]>();

  /** The files each `script(...)` text with `${...}` may name, by the texts around its `${...}`. */
  readonly #patterns = new Map<string, readonly string[]>();

  /** Adds files that a script reference may name, or any file with `null` (see `referencedScripts`). */
  public refer(paths: readonly string[] | null): void {
    if (this.referencedScripts === null || this.#referred.has(paths ?? [])) return;
    if (paths === null) {
      this.referencedScripts = null;
      return;
    }
    this.#referred.add(paths);
    for (const path of paths) this.referencedScripts.add(path);
  }

  /**
   * The files that a text with `${...}` may name: those whose path starts with its first text, ends with its last, and
   * holds the ones between in order, whatever the values give between them. Each pattern is matched once.
   */
  public filesLike(texts: readonly string[]): readonly string[] {
    const key = JSON.stringify(texts);
    const known = this.#patterns.get(key);
    if (known !== undefined) return known;
    if (texts.length === 1) {
      const files = this.labels.has(texts[0]!) ? [texts[0]!] : [];
      this.#patterns.set(key, files);
      return files;
    }
    const first = texts[0]!;
    const last = texts.at(-1)!;
    const files = [...this.labels.keys()].filter((path) => {
      if (
        path.length < first.length + last.length ||
        !path.startsWith(first) ||
        !path.endsWith(last)
      )
        return false;
      let at = first.length;
      const end = path.length - last.length;
      for (let index = 1; index < texts.length - 1; index += 1) {
        const text = texts[index]!;
        const found = path.indexOf(text, at);
        if (found < 0 || found + text.length > end) return false;
        at = found + text.length;
      }
      return true;
    });
    this.#patterns.set(key, files);
    return files;
  }

  readonly diagnostics: Diagnostic[][];

  /** Each global and speaker declaration with its position in the session-start order. */
  readonly #orders = new Map<GlobalStatement | SpeakerDeclaration, number>();

  #setsDefaultSpeaker: boolean | undefined;

  public constructor(
    readonly files: readonly ProjectProgram[],
    options: SemanticValidationOptions,
  ) {
    this.diagnostics = files.map(() => []);
    for (const { path, program } of files) {
      this.labels.set(
        path,
        new Set(
          program.statements.flatMap((statement) =>
            statement.kind === "labelStatement" ? [statement.name.name] : [],
          ),
        ),
      );
      if (!program.statements.some(runsOnItsOwn)) this.declarationsOnly.add(path);
    }
    for (const { path, tags } of files)
      if (tags !== undefined && tags !== null)
        this.tags.set(path, new Map(tags.map((tag) => [tag.name, tag.value])));
    for (const name of options.globals ?? []) this.scope.declare(name, { kind: "global" });
    const protectedNames = new Set([...TEASESCRIPT_PROTECTED_NAMES, ...(options.builtins ?? [])]);
    const declare = (
      name: Identifier,
      binding: Binding & { readonly project: ProjectDeclaration },
    ): void => {
      // A protected name is reported where the file's own statements are validated.
      if (protectedNames.has(name.name)) return;
      const existing = this.scope.resolve(name.name);
      if (existing === undefined) {
        this.scope.declare(name.name, binding);
        return;
      }
      if (existing.project === undefined) {
        this.report(
          binding.project.file,
          semanticCode.duplicateDeclaration,
          `'${name.name}' is already a global that the host gives every script. Choose another name.`,
          name.span,
        );
        return;
      }
      this.reportClash(name.name, binding.project, existing.project);
    };
    for (const [order, { file, declaration }] of sessionDeclarations(
      files.map((file) => file.program),
    ).entries()) {
      this.#orders.set(declaration, order);
      const speaker = declaration.kind === "speakerDeclaration";
      const binding = {
        kind: speaker ? "speaker" : "variable",
        project: {
          file,
          span: declaration.name.span,
          description: speaker ? "speaker" : "global",
          order,
        },
      } as const;
      // The built-in speaker has a protected name, which no script declaration may take.
      if (declaration === PLAYER_DECLARATION) this.scope.declare(PLAYER, binding);
      else declare(declaration.name, binding);
    }
    for (const [file, { program }] of files.entries())
      for (const statement of program.statements)
        if (statement.kind === "functionDeclaration" && statement.global)
          declare(statement.name, {
            kind: "function",
            declaration: statement,
            project: {
              file,
              span: statement.name.span,
              description: "global function",
              order: null,
            },
          });
  }

  /** Whether a file sets the default speaker anywhere, which a message without `as` needs for its `speaker`. */
  public get setsDefaultSpeaker(): boolean {
    this.#setsDefaultSpeaker ??= setsDefaultSpeaker(this.files.map((file) => file.program));
    return this.#setsDefaultSpeaker;
  }

  /** The position of a global or speaker in the session-start order. */
  public order(declaration: GlobalStatement | SpeakerDeclaration): number {
    return this.#orders.get(declaration)!;
  }

  /** Whether `declaration` is the one its name stands for, rather than a clashing second one. */
  public owns(declaration: GlobalStatement | SpeakerDeclaration | FunctionDeclaration): boolean {
    const binding = this.scope.resolve(declaration.name.name);
    return binding?.project !== undefined && binding.project.span === declaration.name.span;
  }

  /** Where a declaration is, as seen from `file`: `line 3` or `line 3 of helpers.tease`. */
  public where(declaration: { readonly file: number; readonly span: SourceSpan }, file: number) {
    const line = `line ${declaration.span.start.line + 1}`;
    return declaration.file === file ? line : `${line} of ${this.files[declaration.file]!.path}`;
  }

  /** Reports two declarations of one project name, at both places. */
  public reportClash(
    name: string,
    second: { readonly file: number; readonly span: SourceSpan; readonly description: string },
    first: ProjectDeclaration,
  ): void {
    const rule =
      "Globals, global functions, and speakers need a name of their own in the whole project. Rename one of them.";
    this.report(
      second.file,
      semanticCode.duplicateDeclaration,
      `'${name}' is already the name of the ${first.description} on ${this.where(first, second.file)}. ${rule}`,
      second.span,
    );
    this.report(
      first.file,
      semanticCode.duplicateDeclaration,
      `The ${first.description} '${name}' has the same name as the ${second.description} on ${this.where(second, first.file)}. ${rule}`,
      first.span,
    );
  }

  /** `checkable` marks an error that leaves the type check its basis (see `LEAVES_TYPES_CHECKABLE`). */
  public report(
    file: number,
    code: NamePassCode,
    message: string,
    span: SourceSpan,
    checkable = false,
  ): void {
    const diagnostic = createDiagnostic(DiagnosticSeverity.Error, code, message, span);
    if (checkable) LEAVES_TYPES_CHECKABLE.add(diagnostic);
    this.diagnostics[file]!.push(diagnostic);
  }
}
