// The oracle of design/no-disabled-opacity's tests (docs/LINTING.md): Tailwind's own CSS for a class, read with
// postcss and postcss-selector-parser, judged by the subject of each selector that sets opacity.
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

/** Tailwind's design system for the Player's `style.css`, from `root` (the repository). */
export async function loadTailwind(root) {
  const tailwind = await import("tailwindcss");
  const cssFile = path.join(root, "player/vue/src/style.css");
  return tailwind.__unstable__loadDesignSystem(readFileSync(cssFile, "utf8"), {
    base: path.dirname(cssFile),
    async loadStylesheet(id, base) {
      let file = path.resolve(base, id);
      if (!id.startsWith(".")) {
        const directory = path.join(root, "node_modules", id);
        const entry = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        file = path.join(directory, entry.exports?.["."]?.style ?? entry.style);
      }
      return { base: path.dirname(file), content: readFileSync(file, "utf8") };
    },
  });
}

// The subject atoms the oracle knows, besides class, type, universal, id and attribute selectors: what the admitted
// variants emit (`test.mjs` checks each admitted representative against this inventory).
const PSEUDO_ELEMENTS = new Set([
  "::before",
  "::after",
  "::placeholder",
  "::file-selector-button",
  "::marker",
  "::-webkit-details-marker",
  "::selection",
  "::first-line",
  "::first-letter",
  "::backdrop",
]);
const PSEUDO_CLASSES = new Set([
  ":hover",
  ":focus",
  ":focus-visible",
  ":focus-within",
  ":active",
  ":visited",
  ":target",
  ":enabled",
  ":checked",
  ":indeterminate",
  ":default",
  ":open",
  ":popover-open",
  ":required",
  ":optional",
  ":valid",
  ":invalid",
  ":user-valid",
  ":user-invalid",
  ":in-range",
  ":out-of-range",
  ":placeholder-shown",
  ":autofill",
  ":read-only",
  ":empty",
  ":first-child",
  ":last-child",
  ":only-child",
  ":first-of-type",
  ":last-of-type",
  ":only-of-type",
]);
/** Functional pseudo-classes, each only with the arguments the admitted variants emit. */
const FUNCTIONAL_PSEUDO_CLASSES = new Map([
  [":nth-child", new Set(["odd", "even"])],
  [":dir", new Set(["ltr", "rtl"])],
]);
// The predicates of the element's own disabled state: what the shared rule in `style.css` overrides, conservatively.
const DISABLED_ATTRIBUTES = new Set(["disabled", "data-disabled"]);
// At-rules a declaration may sit in without changing which element it styles.
const CONDITIONAL_AT_RULES = new Set(["media", "supports", "container"]);

/**
 * The compounds that style the selector's subject: those after its last combinator, with each `:is()`/`:where()` in
 * them expanded into its alternatives' own subject compounds.
 */
function subjectCompounds(selector) {
  let start = 0;
  selector.nodes.forEach((node, index) => {
    if (node.type === "combinator") start = index + 1;
  });
  let compounds = [[]];
  for (const node of selector.nodes.slice(start)) {
    if (node.type === "pseudo" && (node.value === ":is" || node.value === ":where")) {
      const alternatives = node.nodes.flatMap(subjectCompounds);
      compounds = compounds.flatMap((compound) =>
        alternatives.map((alternative) => [...compound, ...alternative]),
      );
    } else compounds = compounds.map((compound) => [...compound, node]);
  }
  return compounds;
}

/** One subject atom: `"own"` (a disabled predicate), `"known"`, or `"unknown"`. */
function atomKind(node) {
  // HTML attribute names are case-insensitive: `[DISABLED]` matches a disabled control too.
  if (node.type === "attribute")
    return DISABLED_ATTRIBUTES.has(node.attribute.toLowerCase()) ? "own" : "known";
  if (["class", "tag", "universal", "id", "comment"].includes(node.type)) return "known";
  if (node.type !== "pseudo") return "unknown";
  if (node.value === ":disabled") return "own";
  if (node.nodes.length === 0)
    return PSEUDO_ELEMENTS.has(node.value) || PSEUDO_CLASSES.has(node.value) ? "known" : "unknown";
  const allowed = FUNCTIONAL_PSEUDO_CLASSES.get(node.value);
  return allowed?.has(String(node.nodes[0]).trim()) && node.nodes.length === 1
    ? "known"
    : "unknown";
}

/**
 * What Tailwind's CSS for one class does with opacity: `"none"` (no opacity declaration, or no CSS), `"own"` (a
 * subject compound holds `:disabled`, `[disabled]` or `[data-disabled…]`), `"unknown"` (a nested style rule, an
 * at-rule that is not conditional, or a subject atom outside the inventory), else `"clean"`.
 */
export function judge(css) {
  if (css === null) return "none";
  let verdict = "none";
  postcss.parse(css).walkDecls("opacity", (declaration) => {
    const rules = [];
    let unknown = false;
    for (let node = declaration.parent; node && node.type !== "root"; node = node.parent) {
      if (node.type === "rule") rules.push(node);
      else if (node.type !== "atrule" || !CONDITIONAL_AT_RULES.has(node.name)) unknown = true;
    }
    let own = false;
    if (rules.length !== 1) unknown = true;
    else
      selectorParser((list) => {
        for (const compound of list.nodes.flatMap(subjectCompounds))
          for (const node of compound) {
            const kind = atomKind(node);
            if (kind === "own") own = true;
            else if (kind === "unknown") unknown = true;
          }
      }).processSync(rules[0].selector);
    const found = own ? "own" : unknown ? "unknown" : "clean";
    const rank = { none: 0, clean: 1, unknown: 2, own: 3 };
    if (rank[found] > rank[verdict]) verdict = found;
  });
  return verdict;
}
