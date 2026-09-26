// Tailwind scans complete class names, not runtime string interpolation. Check direct
// class expressions without pretending to resolve arbitrary helpers or runtime data.
function classContext(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
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
export default { rules: { "no-fragmented-classes": noFragmentedClasses } };
