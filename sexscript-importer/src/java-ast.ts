/** Small AST queries shared by the Java and data API rules (java-data.ts, java-time.ts). */
import { constantString, isAstNode, isRecord, variableName, type AstNode } from "./ast.ts";

export interface Tree {
  parents: Map<AstNode, AstNode | null>;
  /** Names that a closure, method, or loop binds, which may hold any value. */
  parameters: Set<string>;
  /** Every assignment of each variable name: its value node, or null for a declaration without one. */
  assignments: Map<string, Array<AstNode | null>>;
  /** Every reference to each variable name that reads it. */
  reads: Map<string, AstNode[]>;
  constructors: AstNode[];
  calls: AstNode[];
}

export function buildTree(root: AstNode): Tree {
  const tree: Tree = {
    parents: new Map(),
    parameters: new Set(),
    assignments: new Map(),
    reads: new Map(),
    constructors: [],
    calls: [],
  };
  const targets = new Set<AstNode>();
  const visit = (value: unknown, parent: AstNode | null): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (!isRecord(value)) return;
    if (!isAstNode(value)) {
      for (const child of Object.values(value)) visit(child, parent);
      return;
    }
    tree.parents.set(value, parent);
    const assigns =
      value.kind === "declaration" || (value.kind === "binary" && value.operator === "=");
    const target = assigns ? asNode(value.left) : null;
    const name = variableName(target);
    if (assigns && target !== null) targets.add(target);
    if (name !== null) {
      const right = asNode(value.right);
      const list = tree.assignments.get(name) ?? [];
      list.push(right === null || isEmptyExpression(right) ? null : right);
      tree.assignments.set(name, list);
    }
    if (value.kind === "constructorCall") tree.constructors.push(value);
    if (Array.isArray(value.parameters)) {
      for (const parameter of value.parameters)
        if (isRecord(parameter) && typeof parameter.name === "string")
          tree.parameters.add(parameter.name);
    }
    if (value.kind === "closure") tree.parameters.add("it");
    if (value.kind === "for" && typeof value.variable === "string")
      tree.parameters.add(value.variable);
    if (value.kind === "methodCall") tree.calls.push(value);
    if (value.kind === "variable" && !targets.has(value)) {
      const read = variableName(value);
      if (read !== null) tree.reads.set(read, [...(tree.reads.get(read) ?? []), value]);
    }
    for (const child of Object.values(value)) visit(child, value);
  };
  visit(root, null);
  return tree;
}

/** Whether a node is the value assigned to a variable. */
export function isAssigned(node: AstNode, tree: Tree): boolean {
  const parent = tree.parents.get(node) ?? null;
  return (
    parent !== null &&
    (parent.kind === "declaration" || (parent.kind === "binary" && parent.operator === "=")) &&
    asNode(parent.right) === node &&
    variableName(parent.left) !== null
  );
}

export interface Member {
  call: AstNode;
  name: string;
  arguments: AstNode[];
  property: boolean;
}

/** The method call or property access whose receiver a node is. */
export function memberOf(node: AstNode, tree: Tree): Member | null {
  const parent = tree.parents.get(node) ?? null;
  if (parent === null || asNode(parent.object) !== node) return null;
  if (parent.kind === "methodCall") {
    const name = constantString(parent.method);
    return name === null
      ? null
      : { call: parent, name, arguments: argumentsOf(parent), property: false };
  }
  if (parent.kind === "property") {
    const name = constantString(parent.property);
    return name === null ? null : { call: parent, name, arguments: [], property: true };
  }
  return null;
}

/** The call a node is an argument of, with its position. */
export function argumentOf(node: AstNode, tree: Tree): { call: AstNode; index: number } | null {
  const list = tree.parents.get(node) ?? null;
  if (list?.kind !== "arguments") return null;
  const call = tree.parents.get(list) ?? null;
  if (call === null || (call.kind !== "methodCall" && call.kind !== "constructorCall")) return null;
  const index = argumentsOf(call).indexOf(node);
  return index < 0 ? null : { call, index };
}

export function isWholeStatement(call: AstNode, tree: Tree): boolean {
  return tree.parents.get(call)?.kind === "expressionStatement";
}

export function argumentsOf(node: AstNode): AstNode[] {
  const list = asNode(node.arguments);
  return Array.isArray(list?.items) ? list.items.filter(isAstNode) : [];
}

/** `javax.imageio.ImageIO` for a property chain of names, or the name of a variable or class. */
export function dottedName(node: AstNode | null): string | null {
  if (node === null) return null;
  const name = variableName(node);
  if (name !== null) return name;
  if (node.kind === "classExpression" && typeof node.type === "string") return node.type;
  if (node.kind === "property") {
    const object = dottedName(asNode(node.object));
    const property = constantString(node.property);
    return object === null || property === null ? null : `${object}.${property}`;
  }
  return null;
}

export function isNullConstant(node: AstNode): boolean {
  return node.kind === "constant" && node.value === null;
}

export function isEmptyExpression(node: AstNode): boolean {
  return (
    node.kind === "unsupportedExpression" && String(node.groovyType).endsWith("EmptyExpression")
  );
}

export function asNode(value: unknown): AstNode | null {
  return isAstNode(value) ? value : null;
}
