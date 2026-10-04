import type { ProjectDiagnostic } from "./compiler.js";
import { createDiagnostic, DiagnosticSeverity } from "./diagnostics.js";
import type { PlanImage } from "./plan/model.js";
import { packageAssetPathProblem } from "./project-paths.js";
import { createSourcePosition, createSourceSpan } from "./source.js";
import { addTag, readTagText, type Tag } from "./tags.js";

/** A package image by its path, with the keywords a host read from its XMP metadata (ADR 0023). */
export interface ProjectImageFile {
  readonly path: string;
  readonly keywords: readonly string[];
}

const imageDiagnosticCode = {
  invalidPath: "TSC009",
  ignoredKeywords: "TST003",
  conflictingTagValue: "TST004",
} as const;

/**
 * The image catalog of a project: each image once, in path order, with its keywords read as tags (`bedroom`,
 * `punishment: 4`) in name order. A keyword that is not a tag is ignored with a warning; a repeated tag counts once,
 * and its number wins over its absence.
 */
export function imageCatalog(images: readonly ProjectImageFile[]): {
  readonly images: readonly PlanImage[];
  readonly diagnostics: readonly ProjectDiagnostic[];
} {
  const diagnostics: ProjectDiagnostic[] = [];
  const byPath = new Map<string, PlanImage>();
  for (const image of images) {
    const problem = packageAssetPathProblem(image.path);
    if (problem !== null || byPath.has(image.path)) {
      diagnostics.push(
        imageDiagnostic(
          image.path,
          DiagnosticSeverity.Error,
          imageDiagnosticCode.invalidPath,
          problem === null
            ? `The project has more than one image '${image.path}'.`
            : `'${image.path}' is not a package image path: ${problem}.`,
        ),
      );
      continue;
    }
    const tags = new Map<string, Tag>();
    const ignored: string[] = [];
    for (const keyword of image.keywords) {
      const tag = readTagText(keyword);
      if (tag === null) {
        ignored.push(keyword);
      } else if (addTag(tags, tag) === "conflict") {
        diagnostics.push(
          imageDiagnostic(
            image.path,
            DiagnosticSeverity.Error,
            imageDiagnosticCode.conflictingTagValue,
            `The image has two different numbers for the tag '${tag.name}'; keep one keyword such as '${tag.name}: ${tag.value}'.`,
          ),
        );
      }
    }
    if (ignored.length > 0) {
      diagnostics.push(
        imageDiagnostic(
          image.path,
          DiagnosticSeverity.Warning,
          imageDiagnosticCode.ignoredKeywords,
          `Keywords that are not tags are ignored: ${ignored.map((keyword) => `'${keyword}'`).join(", ")}. A tag uses lowercase letters a–z, digits, and hyphens, with an optional number, such as 'punishment: 4'.`,
        ),
      );
    }
    byPath.set(image.path, {
      path: image.path,
      tags: [...tags.values()].sort((left, right) => (left.name < right.name ? -1 : 1)),
    });
  }
  return {
    images: [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
    diagnostics,
  };
}

function imageDiagnostic(
  path: string,
  severity: DiagnosticSeverity,
  code: string,
  message: string,
): ProjectDiagnostic {
  const start = createSourcePosition(0, 0, 0);
  return Object.freeze({
    ...createDiagnostic(severity, code, message, createSourceSpan(start, start)),
    path,
  });
}
