import { ts } from "ts-morph";

import { scriptsOf, sfcErrorsOf } from "./comments.mjs";

const blanketRuleNames = new Set([
  "all",
  "correctness",
  "nursery",
  "pedantic",
  "perf",
  "restriction",
  "style",
  "suspicious",
]);

const ruleNamePattern = /^(?:@?[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*$/i;
const allowedDirectivePattern = /^oxlint-(?:disable-next-line|disable-line)\b/;
const oxlintDirectivePattern = /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/;
const eslintDirectivePattern = /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/;
const eslintConfigPattern = /^eslint\s+@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\s*:/i;

function getCommentLines(commentText, isLineComment) {
  if (isLineComment) {
    return [commentText.slice(2).trim()];
  }

  const lines = commentText
    .slice(2, -2)
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\*?\s?/u, "").trim());

  return [...lines, lines.join(" ").trim()];
}

function getCommentRanges(sourceFile, sourceText) {
  const ranges = new Map();
  const nodes = [sourceFile];

  while (nodes.length > 0) {
    const node = nodes.pop();
    const nodeRanges = [
      ...(ts.getLeadingCommentRanges(sourceText, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(sourceText, node.end) ?? []),
    ];

    for (const range of nodeRanges) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
    nodes.push(...node.getChildren(sourceFile));
  }

  return [...ranges.values()].sort((left, right) => left.pos - right.pos);
}

function validateAllowedDirective(text) {
  const evidenceMarker = " -- EVIDENCE:";
  const markerIndex = text.indexOf(evidenceMarker);

  if (markerIndex === -1 || text.slice(markerIndex + evidenceMarker.length).trim() === "") {
    return "Oxlint exceptions must include `-- EVIDENCE: <factual explanation>`.";
  }

  const directiveAndRules = text.slice(0, markerIndex).trim();
  const rulesText = directiveAndRules.replace(allowedDirectivePattern, "").trim();
  const rules = rulesText.split(",").map((rule) => rule.trim());

  if (
    rules.length === 0 ||
    rules.some(
      (rule) =>
        rule === "" || blanketRuleNames.has(rule.toLowerCase()) || !ruleNamePattern.test(rule),
    )
  ) {
    return "Oxlint exceptions must name one or more explicit rules.";
  }

  return undefined;
}

/**
 * Checks actual comments in a JavaScript or TypeScript source file, or a `.vue` file's `<script>` blocks, for bounded
 * lint exceptions.
 *
 * @param {string} fileName
 * @param {string} sourceText
 * @returns {{ fileName: string, line: number, column: number, message: string }[]}
 */
export function checkEvidenceComments(fileName, sourceText) {
  if (!fileName.endsWith(".vue")) return checkScript(fileName, sourceText);
  // A block that Vue's parser refuses is not among the scripts below, though oxlint lints it: a file Vue cannot parse
  // may hold no lint directive.
  const [error] = sfcErrorsOf(fileName, sourceText);
  const directive =
    error === undefined ? null : /(?:oxlint|eslint)-(?:disable|enable)/u.exec(sourceText);
  if (directive !== null) {
    const before = sourceText.slice(0, directive.index).split("\n");
    return [
      {
        fileName,
        line: before.length,
        column: before.at(-1).length + 1,
        message: `Vue cannot parse this file (${error}), so its lint directives cannot be checked: fix the file, or remove the directive.`,
      },
    ];
  }
  return scriptsOf(fileName, sourceText).flatMap(({ text, lineOffset, columnOffset }) =>
    checkScript(fileName, text).map((diagnostic) => ({
      ...diagnostic,
      line: diagnostic.line + lineOffset,
      // a script's first line starts after its tag
      column: diagnostic.line === 1 ? diagnostic.column + columnOffset : diagnostic.column,
    })),
  );
}

/** The exceptions of one script, at its own lines and columns. */
function checkScript(fileName, sourceText) {
  const scriptKind = ts.getScriptKindFromFileName(fileName) || ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const diagnostics = [];

  for (const range of getCommentRanges(sourceFile, sourceText)) {
    const isLineComment = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const commentText = sourceText.slice(range.pos, range.end);

    for (const lineText of getCommentLines(commentText, isLineComment)) {
      let message;

      if (allowedDirectivePattern.test(lineText)) {
        message = isLineComment
          ? validateAllowedDirective(lineText)
          : "Oxlint exceptions must use single-line comments.";
      } else if (oxlintDirectivePattern.test(lineText)) {
        message = "Block, file-wide, and enable-style Oxlint directives are not allowed.";
      } else if (eslintDirectivePattern.test(lineText) || eslintConfigPattern.test(lineText)) {
        message = "ESLint suppression and inline rule configuration comments are not allowed.";
      }

      if (message !== undefined) {
        const location = sourceFile.getLineAndCharacterOfPosition(range.pos);
        diagnostics.push({
          fileName,
          line: location.line + 1,
          column: location.character + 1,
          message,
        });
        break;
      }
    }
  }

  return diagnostics;
}
