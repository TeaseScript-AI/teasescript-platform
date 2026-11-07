/**
 * Legacy image folders as image tags (ADR 0023 §5, #572; converter owner decision 2026-10-05): every image of a package
 * carries one tag for its full legacy folder path, `images/Domme3/Pack 2/x.jpg` → `images-domme3-pack-2`, written as
 * an XMP keyword in a generated sidecar next to it. A tag query for that one tag then finds exactly the images directly
 * in the folder, as the legacy folder listing did.
 */
import type { MediaFile } from "./workarounds.ts";

/**
 * The tag of a legacy folder path, such as `images/Domme3/Pack 2`: lower case, with every run of other characters than
 * ASCII letters and digits as one hyphen, and none at either end. The `pathTag` helper does the same at runtime.
 */
export function pathTag(folder: string): string {
  return folder
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part !== "")
    .join("-");
}

/** The tag of an image's folder; the image's path is below `images/`. */
export function imageFolderTag(imagePath: string): string {
  const slash = imagePath.replaceAll("\\", "/").lastIndexOf("/");
  return pathTag(slash < 0 ? "images" : `images/${imagePath.slice(0, slash)}`);
}

/** The package's images as the compiler's image catalog sees them once their sidecars are written. */
export function imageCatalog(
  media: readonly MediaFile[],
): Array<{ path: string; keywords: string[] }> {
  return media.map((file) => ({
    path: file.path.replaceAll("\\", "/"),
    keywords: [imageFolderTag(file.path)],
  }));
}

/** An XMP sidecar (`image.jpg.xmp`) whose keywords are `tags`. */
export function imageSidecar(tags: readonly string[]): string {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "   <dc:subject>",
    "    <rdf:Bag>",
    ...tags.map((tag) => `     <rdf:li>${tag}</rdf:li>`),
    "    </rdf:Bag>",
    "   </dc:subject>",
    "  </rdf:Description>",
    " </rdf:RDF>",
    "</x:xmpmeta>",
    "",
  ].join("\n");
}
