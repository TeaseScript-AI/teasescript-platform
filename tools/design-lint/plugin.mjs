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
// `[data-disabled]` menu items, at opacity 1), which overrides Tailwind's layered utilities. A `disabled:opacity-*` or
// `data-[disabled]:opacity-*` class on a Player control therefore never shows and misleads. `aria-disabled` stays
// outside this rule: the shared rule does not cover it, and it marks controls that dim while busy yet keep focus
// (LockDialog, PasswordField).
// A disabled variant anywhere in the token's variant chain (`dark:disabled:opacity-50`, `disabled:focus:opacity-50`).
const disabledVariant = /^(?:disabled|data-\[disabled\]|data-disabled)$/;
function disabledOpacity(token) {
  const parts = token.replace(/^!/, "").split(":");
  return (
    parts.length > 1 &&
    /^!?-?opacity-/.test(parts.at(-1)) &&
    parts.slice(0, -1).some((variant) => disabledVariant.test(variant))
  );
}
const noDisabledOpacity = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      opacity:
        "Disabled controls take the theme's disabled roles from style.css; an opacity class here is overridden and misleads.",
    },
  },
  create(context) {
    function check(node, text) {
      if (text.split(/\s+/).some((token) => disabledOpacity(token)))
        context.report({ node, messageId: "opacity" });
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
