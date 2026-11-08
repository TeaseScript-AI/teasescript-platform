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
  if (parent?.type === "VExpressionContainer") return true;
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
// Disabled controls take the theme's disabled roles from one unlayered rule in `style.css` (native `:disabled`, and
// `[data-disabled]` menu items, at opacity 1), which overrides Tailwind's layered utilities. An opacity class whose
// variants select a disabled control therefore never shows and misleads.
//
// The variants before an opacity utility are admitted only in the forms below, none of which selects the control's
// own disabled state. A disabled variant is refused, and so is every other variant, such as an arbitrary selector
// (`[&:not(:enabled)]` selects a disabled control too), `not-*`, `has-*` or `in-*`: nothing here shows that it cannot
// select one. A form that can be shown so takes a row here and in `test.mjs`.
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
// arbitrary selector naming `:disabled` or `[disabled]`.
const DISABLED_VARIANT =
  /^(?:disabled|data-disabled|data-\[disabled(?:[~|^$*]?=[^\]]*)?\])$|^\[.*(?::disabled|\[disabled)/;

/** The variants of a class token and its utility, split at the colons outside brackets and parentheses. */
function variantChain(token) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if ((character === "]" || character === ")") && depth > 0) depth--;
    else if (character === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  return { variants: parts, utility: token.slice(start) };
}

/**
 * How the rule decides one class token: `null` when it sets no opacity under a variant, else one decision per variant,
 * `{ variant, kind }` with `kind` a form of `ADMITTED_VARIANTS`, `"disabled"` or `"unclassified"`.
 */
export function classifyOpacityToken(token) {
  const { variants, utility } = variantChain(token.replace(/^!/, ""));
  // `opacity-*` in each spelling, and the arbitrary property `[opacity:…]`.
  if (variants.length === 0 || !/^(?:-?opacity-.+|\[opacity:.+\])$/.test(utility.replace(/!$/, "")))
    return null;
  return variants.map((variant) => {
    if (DISABLED_VARIANT.test(variant)) return { variant, kind: "disabled" };
    const form = Object.keys(ADMITTED_VARIANTS).find((name) =>
      ADMITTED_VARIANTS[name].test(variant),
    );
    return { variant, kind: form ?? "unclassified" };
  });
}

const noDisabledOpacity = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      opacity:
        "Disabled controls take the theme's disabled roles from style.css; an opacity class here is overridden and misleads.",
      unclassified:
        "'{{variant}}' before an opacity class is not a form this rule admits, as nothing shows that it cannot select a disabled control (tools/design-lint/plugin.mjs, ADMITTED_VARIANTS).",
    },
  },
  create(context) {
    function check(node, text) {
      for (const token of text.split(/\s+/)) {
        const decisions = classifyOpacityToken(token) ?? [];
        const unclassified = decisions.find(({ kind }) => kind === "unclassified");
        if (decisions.some(({ kind }) => kind === "disabled"))
          context.report({ node, messageId: "opacity" });
        else if (unclassified)
          context.report({
            node,
            messageId: "unclassified",
            data: { variant: unclassified.variant },
          });
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
