/**
 * The rules of an `askImage(...)` request (V30 §20) that the compiler, the plan and snapshot validators, the engine, and
 * the Player share: which file extensions and MIME types it may restrict to, and what the transcript shows for an answer.
 */

/** The named arguments of `askImage` besides the message. */
export const IMAGE_REQUEST_OPTIONS: ReadonlySet<string> = new Set([
  "allowCamera",
  "allowFile",
  "types",
  "mime",
]);

/** The player's transcript entry for an image answer; the image itself is never shown as text. */
export const IMAGE_ANSWER_TRANSCRIPT_TEXT = "Image";

/** A file extension of `types:`, such as `".png"`. */
function isImageFileType(text: string): boolean {
  return /^\.[a-z0-9]+$/iu.test(text);
}

/** An image MIME type of `mime:`, such as `"image/png"`; `askImage` asks for images only. */
function isImageMimeType(text: string): boolean {
  return /^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(text);
}

/** Why a `types:` or `mime:` text is not accepted, or `null` when it is. */
export function imageFilterTextProblem(option: "types" | "mime", text: string): string | null {
  if (option === "types")
    return isImageFileType(text)
      ? null
      : `askImage(types:) takes file extensions such as ".png", not '${text}'.`;
  return isImageMimeType(text)
    ? null
    : `askImage(mime:) takes image MIME types such as "image/png", not '${text}'.`;
}

export const IMAGE_NO_SOURCE_MESSAGE =
  "askImage needs allowCamera: or allowFile: to be true; otherwise the player cannot answer.";

export function emptyImageFilterMessage(option: "types" | "mime"): string {
  return option === "types"
    ? 'askImage(types:) needs at least one extension, such as [".png"]; leave it out to accept any image.'
    : 'askImage(mime:) needs at least one MIME type, such as ["image/png"]; leave it out to accept any image.';
}

/**
 * Whether the request fields of an image interaction UI are valid: two sources that are not both off, and `types` and
 * `mime` each `null` or a non-empty list of valid texts. `count` measures each text against the shared interaction
 * text limit and returns whether it fits.
 */
export function validImageRequestFields(
  ui: { readonly [field: string]: unknown },
  count: (text: string) => boolean,
): boolean {
  if (
    typeof ui.allowCamera !== "boolean" ||
    typeof ui.allowFile !== "boolean" ||
    (!ui.allowCamera && !ui.allowFile)
  )
    return false;
  return (
    validImageFilter(ui.types, isImageFileType, count) &&
    validImageFilter(ui.mime, isImageMimeType, count)
  );
}

function validImageFilter(
  value: unknown,
  valid: (text: string) => boolean,
  count: (text: string) => boolean,
): boolean {
  if (value === null) return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((text: unknown) => typeof text === "string" && valid(text) && count(text))
  );
}
