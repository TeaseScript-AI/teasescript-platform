// The routes class text reaches an element by, each one branch below: a static `class` attribute; a `:class`
// expression; a direct `v-bind="{ … }"` object's statically named `class` property, read as a `:class` expression; and
// the arguments of `cn`, `clsx` and `cva`. Class text built elsewhere (helpers, spreads, data flow) is not read.

/** Whether `object` is the props object of a direct `v-bind="{ … }"`, not a class map. */
function vBindProps(object) {
  const container = object?.parent;
  const attribute = container?.parent;
  return (
    object?.type === "ObjectExpression" &&
    container?.type === "VExpressionContainer" &&
    attribute?.type === "VAttribute" &&
    attribute.directive &&
    attribute.key.name.name === "bind" &&
    !attribute.key.argument
  );
}
/** Whether `property` of a `v-bind` props object is its statically named `class` (`class` or `'class'`). */
function classProperty(property) {
  if (property.computed) return false;
  const key = property.key;
  return (key.type === "Identifier" && key.name === "class") || key.value === "class";
}
// Vue/clsx class maps use keys as classes and values as truthiness guards. CVA variant maps
// are not class maps: their values are classes.
function classMap(object) {
  let node = object;
  // Arrays and conditional/logical results still pass the map itself to the class binding.
  while (
    node.parent?.type === "ArrayExpression" ||
    (node.parent?.type === "ConditionalExpression" && node.parent.test !== node) ||
    (node.parent?.type === "LogicalExpression" && node.parent.right === node)
  )
    node = node.parent;
  const parent = node.parent;
  if (parent?.type === "VExpressionContainer") return !vBindProps(node);
  if (parent?.type === "Property" && parent.value === node && vBindProps(parent.parent))
    return classProperty(parent);
  return (
    parent?.type === "CallExpression" &&
    parent.callee.type === "Identifier" &&
    ["cn", "clsx"].includes(parent.callee.name)
  );
}
// Tailwind scans complete class names, not runtime string interpolation. Check direct
// class expressions without pretending to resolve arbitrary helpers or runtime data.
function classContext(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === "Property" && parent.value === child && vBindProps(parent.parent))
      return classProperty(parent);
    if (parent.type === "Property" && parent.value === child && classMap(parent.parent))
      return false;
    if (parent.type === "ConditionalExpression" && parent.test === child) return false;
    if (parent.type === "LogicalExpression" && parent.operator === "&&" && parent.left === child)
      return false;
    if (parent.type === "BinaryExpression" && parent.operator !== "+") return false;
    if (parent.type === "VAttribute") {
      return (
        parent.directive &&
        parent.key.name.name === "bind" &&
        parent.key.argument?.type === "VIdentifier" &&
        parent.key.argument.name === "class"
      );
    }
    if (parent.type === "CallExpression") {
      return (
        parent.callee.type === "Identifier" && ["cn", "clsx", "cva"].includes(parent.callee.name)
      );
    }
    if (["Statement", "Declaration"].some((suffix) => parent.type.endsWith(suffix))) return false;
  }
  return false;
}
function literal(node) {
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}
const noFragmentedClasses = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      fragmented:
        "Use complete literal class names (for example, a conditional or lookup), not fragments assembled at runtime; Tailwind cannot reliably generate them.",
    },
  },
  create(context) {
    function report(node) {
      if (classContext(node)) context.report({ node, messageId: "fragmented" });
    }
    const visitors = {
      TemplateLiteral(node) {
        if (
          node.expressions.some(
            (_, index) =>
              /\S$/.test(node.quasis[index].value.cooked ?? "") ||
              /^\S/.test(node.quasis[index + 1].value.cooked ?? ""),
          )
        )
          report(node);
      },
      BinaryExpression(node) {
        if (node.operator !== "+") return;
        const left = literal(node.left);
        const right = literal(node.right);
        if (
          left !== undefined && right !== undefined
            ? /\S$/.test(left) && /^\S/.test(right)
            : (left !== undefined && /\S$/.test(left)) || (right !== undefined && /^\S/.test(right))
        )
          report(node);
      },
    };
    return (
      context.sourceCode.parserServices.defineTemplateBodyVisitor?.(visitors, visitors) ?? visitors
    );
  },
};
// Disabled controls take the theme's disabled roles from one unlayered rule in `style.css` (native disabled controls,
// and `[data-disabled]` menu items, at opacity 1), which overrides Tailwind's layered utilities. An opacity class on the
// element's own disabled state either never shows or, with `!important`, overrides the theme's disabled treatment; this
// rule refuses both, so disabled controls keep the theme's treatment.
//
// The variants before an opacity utility are admitted only in the forms below, none of which selects the element's
// own disabled state; a pseudo-element only as the last variant, as some compositions after one are nested. A disabled
// variant is refused, and so is every other variant, such as an arbitrary selector (`[&:not(:enabled)]` selects a
// disabled control too), `not-*`, `has-*` or `in-*`: nothing here shows that it cannot select one. A form that can be
// shown so takes a row here and in `test.mjs`, whose oracle checks the forms against Tailwind's output.
export const ADMITTED_VARIANTS = {
  breakpoint: /^(?:max-)?(?:sm|md|lg|xl|2xl)$/,
  media:
    /^(?:dark|motion-safe|motion-reduce|contrast-more|contrast-less|forced-colors|print|portrait|landscape)$/,
  direction: /^(?:ltr|rtl)$/,
  "element state":
    /^(?:hover|focus|focus-visible|focus-within|active|visited|target|enabled|checked|indeterminate|default|open|required|optional|valid|invalid|user-valid|user-invalid|in-range|out-of-range|placeholder-shown|autofill|read-only|empty|first|last|only|odd|even|first-of-type|last-of-type|only-of-type)$/,
  "pseudo-element":
    /^(?:before|after|placeholder|file|marker|selection|first-line|first-letter|backdrop)$/,
  // ARIA states are outside the shared rule: `aria-disabled` marks controls that dim while busy yet keep focus
  // (LockDialog, PasswordField).
  aria: /^aria-(?:[a-z]+|\[[a-z-]+(?:=[^\]]+)?\])$/,
  // A data attribute other than `data-disabled`, which the shared rule covers.
  "data attribute":
    /^data-(?!\[?disabled\b)(?:[a-z][a-z0-9-]*|\[[a-z][a-z0-9-]*(?:[~|^$*]?=[^\]]+)?\])$/,
  // Another element's state: an ancestor's or a sibling's, which the shared rule does not set on this one.
  "another element": /^(?:group|peer)-.+$/,
};
// The variants the shared rule overrides, for the message: `disabled`, `data-disabled` and `data-[disabled…]`, and an
// arbitrary selector naming `:disabled`, `[disabled]` or `[data-disabled]`.
const DISABLED_VARIANT =
  /^(?:disabled|data-disabled|data-\[disabled(?:[~|^$*]?=[^\]]*)?\])$|^\[.*(?::disabled|\[(?:data-)?disabled\b)/;

// The class syntax this rule reads, a closed grammar: `!`? (variant `:`)* utility `!`?, each variant and the utility a
// name (`hover`, `group-hover/item`, `opacity-50`), a name with a bracketed or parenthesised value (`data-[state=open]`,
// `opacity-[0.4]`, `opacity-(--dim)`), or a bracketed selector or property (`[&_svg]`, `[opacity:0.5]`). A value holds
// letters, digits and `_&:.=#%,>+~*|^$@/-`, with balanced brackets and parentheses; quotes, backslashes and anything
// else are outside it. A class with `opacity` that this grammar does not read is refused, never skipped.
const CLASS_CHARACTERS = /^[A-Za-z0-9_&:.=#%,>+~*|^$@/()[\]!-]+$/;
const CLASS_PART =
  /^(?:\*{1,2}|-?@?[a-z0-9]+(?:[-.][a-z0-9]+)*(?:-(?:\[.+\]|\(.+\)))?(?:\/[a-z0-9-]+)?|\[.+\])$/;

/**
 * The variants of a class token and its utility, split at the colons outside brackets and parentheses, or `null` when
 * the token is outside the grammar above.
 */
function readClass(token) {
  const body = token.replace(/^!/, "").replace(/!$/, "");
  if (!CLASS_CHARACTERS.test(body) || body.includes("!")) return null;
  const parts = [];
  const open = [];
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === "[" || character === "(") open.push(character === "[" ? "]" : ")");
    else if (character === "]" || character === ")") {
      if (open.pop() !== character) return null;
    } else if (character === ":" && open.length === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  if (open.length > 0 || !parts.every((part) => CLASS_PART.test(part))) return null;
  return { variants: parts.slice(0, -1), utility: parts.at(-1) };
}

/**
 * How the rule decides one class token: `null` when it sets no opacity under a variant; `[{ variant: token, kind:
 * "unreadable" }]` when it names opacity outside the grammar; else one decision per variant, `{ variant, kind }` with
 * `kind` a form of `ADMITTED_VARIANTS`, `"disabled"`, `"unclassified"`, or `"misplaced"` for a pseudo-element before
 * another variant.
 */
export function classifyOpacityToken(token) {
  if (!/opacity/i.test(token)) return null;
  const read = readClass(token);
  if (read === null) return [{ variant: token, kind: "unreadable" }];
  // `opacity-*` in each spelling, and the arbitrary property `[opacity:…]`.
  if (read.variants.length === 0 || !/^(?:-?opacity-.+|\[opacity:.+\])$/i.test(read.utility))
    return null;
  return read.variants.map((variant, index) => {
    if (DISABLED_VARIANT.test(variant)) return { variant, kind: "disabled" };
    const form = Object.keys(ADMITTED_VARIANTS).find((name) =>
      ADMITTED_VARIANTS[name].test(variant),
    );
    if (form === "pseudo-element" && index < read.variants.length - 1)
      return { variant, kind: "misplaced" };
    return { variant, kind: form ?? "unclassified" };
  });
}

const noDisabledOpacity = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      opacity:
        "Disabled controls take the theme's disabled treatment from style.css; an opacity class on their own disabled state is overridden, or with !important overrides that treatment.",
      unclassified:
        "'{{variant}}' before an opacity class is not a form this rule admits, as nothing shows that it cannot select a disabled control (tools/design-lint/plugin.mjs, ADMITTED_VARIANTS).",
      misplaced:
        "'{{variant}}' is a pseudo-element before another variant; some such compositions are nested, which this rule does not read. Put the pseudo-element last, next to the utility.",
      unreadable:
        "'{{variant}}' names opacity in a form this rule cannot read, such as quotes, a backslash or unbalanced brackets; write it in a form the class grammar in tools/design-lint/plugin.mjs reads, or add the form there.",
    },
  },
  create(context) {
    function check(node, text) {
      for (const token of text.split(/\s+/)) {
        const decisions = classifyOpacityToken(token) ?? [];
        const named = ["unreadable", "misplaced", "unclassified"]
          .map((kind) => decisions.find((decision) => decision.kind === kind))
          .find(Boolean);
        if (decisions.some(({ kind }) => kind === "disabled"))
          context.report({ node, messageId: "opacity" });
        else if (named)
          context.report({ node, messageId: named.kind, data: { variant: named.variant } });
      }
    }
    const visitors = {
      Literal(node) {
        if (typeof node.value === "string" && classContext(node)) check(node, node.value);
      },
      TemplateLiteral(node) {
        if (classContext(node))
          check(node, node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" "));
      },
    };
    const template = {
      ...visitors,
      VAttribute(node) {
        if (!node.directive && node.key.name === "class" && node.value)
          check(node, node.value.value);
      },
    };
    return (
      context.sourceCode.parserServices.defineTemplateBodyVisitor?.(template, visitors) ?? visitors
    );
  },
};
export default {
  rules: { "no-fragmented-classes": noFragmentedClasses, "no-disabled-opacity": noDisabledOpacity },
};
