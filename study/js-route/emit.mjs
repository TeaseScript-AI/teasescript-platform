// The prototype emitter of the JavaScript-route study (research code, never merged; nothing in src/ imports it).
// It turns an instruction plan into the source of one JavaScript function body that builds the program: a script's
// variables become JavaScript variables, its loops and branches JavaScript's, its functions functions. It rebuilds that
// structure from the plan's jumps, which lowering emits in a few fixed shapes; a shape it does not know is refused
// (`Unsupported`), never guessed. Values are the native values of #2684; everything but the fast cases calls the
// runtime library (`runtime.mjs`), which calls today's helpers, so faults and messages stay today's.

import { conditionalExpressionPlanChildren, expressionPlanChildren } from "../../dist/src/plan/expression-children.js";

const childrenOf = expressionPlanChildren;
const conditionalChildren = (e) => conditionalExpressionPlanChildren(e);

/** A copy of `node` with each object `map` holds replaced by its value; parts not in `map` are copied as they are. */
function substitute(node, map) {
  if (map.has(node)) return map.get(node);
  if (Array.isArray(node)) return node.map((item) => substitute(item, map));
  if (node !== null && typeof node === "object")
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substitute(value, map)]));
  return node;
}

/** A property store's target whose object is temporary 1e9, for today's engine on the evaluated object. */
function propertyTarget(target) {
  return { ...target, object: { kind: "temporary", temporaryId: 1e9, span: target.object.span } };
}

/** Whether an expression reads nothing of the program: no names, calls, temporaries, references, loads or queries. */
function closed(node) {
  if (Array.isArray(node)) return node.every(closed);
  if (node === null || typeof node !== "object") return true;
  if (["identifier", "call", "temporary", "preparedReference", "storageLoad", "tagQuery"].includes(node.kind)) return false;
  return Object.values(node).every(closed);
}

/** Instruction fields that hold no expression to evaluate: spans, types and checks. */
const NOT_EXPRESSIONS = new Set(["span", "type", "typeCheck", "fallbackCheck", "expected", "partChecks"]);

export class Unsupported extends Error {
  constructor(what) {
    super(`study emitter: ${what}`);
    this.name = "Unsupported";
  }
}

/** Kinds whose value is new, so a store keeps it without a copy (as the native engine's `isFreshValue`). */
function isFresh(e) {
  switch (e.kind) {
    case "literal":
    case "list":
    case "object":
    case "template":
    case "unary":
    case "range":
    case "unit":
      return true;
    case "binary":
      return e.operator !== "otherwise";
    case "group":
      return isFresh(e.expression);
    default:
      return false;
  }
}

/** Whether an expression may change a value in place or call (`mayChangeValue`'s conservative stand-in). */
function mayChange(e) {
  if (e === null || typeof e !== "object") return false;
  if (e.kind === "call") return true;
  for (const value of Object.values(e)) {
    if (Array.isArray(value)) {
      if (value.some((item) => typeof item === "object" && item !== null && mayChange(item.value ?? item)))
        return true;
    } else if (typeof value === "object" && value !== null && value.kind !== undefined && mayChange(value)) return true;
  }
  return false;
}

const SAFE = /[^A-Za-z0-9_]/g;

/** Expression kinds, for finding an instruction's operands. */
const EXPRESSION_KINDS = new Set(["literal", "regex", "duration", "calendarDuration", "identifier", "debugMode",
  "playerProfileField", "list", "object", "set", "dict", "group", "template", "property", "index", "call", "unary",
  "unit", "angleUnit", "binary", "range", "temporary", "preparedReference", "storageLoad", "tagQuery", "typeTest"]);

/** A loop body longer than this many instructions is outlined even without an inner loop. */
const OUTLINE_LENGTH = 50;
/** A loop body that holds a loop is outlined from this many instructions (a small nest stays in one function). */
const OUTLINE_WITH_LOOP = 30;
/** A structured sequence longer than this many instructions is cut into functions between its constructs. */
const CHUNK_LENGTH = 50;
/** Instruction kinds today's engine may leave waiting (an action with the host), besides a paced `say`. */
const WAITING_KINDS = new Set(["wait", "interaction", "capture", "fileStore", "lock", "storageWrite", "playMedia", "showImage"]);

/** Kinds that become JavaScript control flow or bookkeeping, where Debug does not stop (part F's probe compares the rest). */
export const STOP_EXCLUDED = new Set(["jump", "jumpIfFalse", "loopStart", "loopControl", "enterScope", "leaveScope",
  "prepareParameterDefault", "beginFunctionDefaults", "enterFunctionBody", "clearTemporaries", "clearTemporary",
  "bindSuppliedParameter", "bindDefaultParameter", "validateAssignmentTarget", "validateCallReceiver"]);

/**
 * `resumable`: part C's way (2): every region that can reach a wait becomes resumable (a switch over its instructions,
 * its variables saved as plain data at a wait); everything else stays structured. Without it, a wait asks the session
 * (`rt.waited`), which way (1), replaying from the start, answers.
 */
export function emitProgram(plan, { resumable = false, runawayCheck = false, generators = false, facts = null, stops = false } = {}) {
  // `facts`: the type analysis's `facts().values` (the typed probe, ruling 3): a plan expression finds its type by its
  // span and the AST kind it was lowered from; a guard is dropped where the types make it unneeded. `typeStats` counts
  // the sites that asked and those that found a type.
  const typeStats = { asked: new Set(), found: new Set(), missing: [] };
  const types = new Map();
  if (facts !== null)
    for (const fact of facts) {
      const key = `${fact.site.file}:${fact.site.start}:${fact.site.end}:${fact.kind}`;
      types.set(key, types.has(key) && types.get(key) !== fact.type ? "?ambiguous" : fact.type);
    }
  const AST_KIND = { identifier: "identifier", index: "indexExpression", call: "callExpression", binary: "binaryExpression",
    unary: "unaryExpression", property: "propertyAccessExpression", range: "rangeExpression", list: "listLiteral" };
  const typeOf = (e) => {
    if (facts === null) return undefined;
    const kind = e.kind === "literal"
      ? { number: "numberLiteral", boolean: "booleanLiteral", string: "stringLiteral" }[typeof e.value] ?? (e.value === null ? "nullLiteral" : null)
      : AST_KIND[e.kind];
    if (kind === undefined || kind === null) return undefined;
    const site = `0:${e.span.so}:${e.span.eo}:${kind}`;
    typeStats.asked.add(site);
    const found = types.get(site);
    if (found === undefined || found === "?ambiguous" || found === "unknown" || found.startsWith("?") || found.includes("!")) {
      if (typeStats.missing.length < 40 && !typeStats.missing.some((m) => m.startsWith(site))) typeStats.missing.push(`${site} ${e.kind}@${e.span.sl}:${e.span.sc} ${found ?? "none"}`);
      return undefined;
    }
    typeStats.found.add(site);
    return found;
  };
  const numeric = (e) => { const t = typeOf(e); return t === "integer" || t === "number"; };
  const primitive = (e) => { const t = typeOf(e); return t === "integer" || t === "number" || t === "string" || t === "boolean"; };
  const isBool = (e) => typeOf(e) === "boolean";
  const isList = (e) => typeOf(e)?.startsWith("list<") === true;
  if (resumable && generators) throw new Error("study emitter: resumable or generators, not both");
  // `stops` (part F): Debug's stop at a statement is a resume point, so every function becomes a generator.
  if (stops && !generators) throw new Error("study emitter: stops need the generator form");
  // `generators`: part C's third form: a function that can wait is a JavaScript generator that yields at a wait, kept
  // alive between drives (`GeneratorSession`); file regions are generators too. Elsewhere the code is as without it.
  const WAIT = generators ? "yield* rt.waitHere()" : "rt.waited()";
  const star = (id) => (generators && canWait.has(id) ? "*" : "");
  // Point 5's second way: a counter at every loop round and call; when it runs out the runtime looks at the clock.
  const tick = runawayCheck ? "if (--rt.fuel === 0) rt.refuel(); " : "";
  const K = [];
  const konst = (value) => {
    let index = K.indexOf(value);
    if (index < 0) index = K.push(value) - 1;
    return `K[${index}]`;
  };
  const globals = new Map();
  const globalIndex = (name) => {
    if (!globals.has(name)) globals.set(name, globals.size);
    return globals.get(name);
  };
  const speakerTemps = new Set(
    plan.instructions.flatMap((i) => (i.kind === "prepareSayContextualSpeaker" ? [i.destinationTemporary] : [])),
  );
  let names = 0;
  const jsName = (name) => `v${names++}_${name.replace(SAFE, "_")}`;
  for (const definition of plan.functions) {
    if (definition.selfHandle !== null) throw new Unsupported("a media block with its own handle");
  }
  // Which instructions can wait, and which functions can: those that reach such an instruction or call one that can.
  const waitsHere = (ins) =>
    stops || (ins.kind === "say" && ins.pacing !== "instant") || WAITING_KINDS.has(ins.kind) || (ins.kind === "transfer" && ins.mode === "call");
  const canWait = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const definition of plan.functions) {
      if (canWait.has(definition.id)) continue;
      for (let pc = definition.entryInstruction; pc < definition.endInstruction; pc += 1) {
        const ins = plan.instructions[pc];
        if (waitsHere(ins) || (ins.kind === "callFunction" && canWait.has(ins.functionId))) {
          canWait.add(definition.id);
          changed = true;
          break;
        }
      }
    }
  }
  const waitsAt = (pc) => {
    const ins = plan.instructions[pc];
    return waitsHere(ins) || (ins.kind === "callFunction" && canWait.has(ins.functionId));
  };
  const rangeWaits = (from, to) => {
    if (!resumable) return false;
    for (let pc = from; pc < to; pc += 1) if (waitsAt(pc)) return true;
    return false;
  };
  const lines = ['"use strict";', "const G = rt.globals;"];
  const fileEntries = [];
  const emittedFunctions = new Set();
  /** The resumable form's blocks, by function ID: their module-level function and registration. */
  const moduleBlocks = new Map();
  plan.files.forEach((file, index) => {
    // The file's top-level variables: module-level, so that its functions see them; a goto to the file clears them.
    const rootScope = new Map();
    const root = emitRegion(file.startInstruction, file.rootEndInstruction, null, [], rootScope, index);
    const functions = plan.functions
      // Blocks are emitted where the instruction that creates them stands (`blockClosures`).
      .filter((definition) => definition.handler === null && definition.entryInstruction >= file.rootEndInstruction && definition.entryInstruction < file.endInstruction)
      // A global function sees the project's globals, not its file's top-level variables (ADR 0022 §3).
      .map((definition) => {
        emittedFunctions.add(definition.id);
        return emitRegion(definition.entryInstruction, definition.endInstruction, definition, definition.parameters, definition.global ? new Map() : rootScope, index);
      });
    const vars = [...rootScope.values()];
    if (vars.length > 0) lines.push(`var ${vars.join(", ")};`);
    lines.push(...functions, root, ...moduleBlocks.values());
    moduleBlocks.clear();
    // An activation of the file from instruction `at`: its start (the session's first file: its speakers' and globals'
    // start values), its entry (a goto or call), or a label (a goto inside the file, which keeps its variables). A call
    // gives back the variables of an activation further out (a file called again while it runs below).
    const fileVars = vars.join(", ");
    lines.push(
      `function${generators ? "*" : ""} enter${index}(resume, at, called) {`,
      `  rt.file = ${index}; const depth = rt.depth;${vars.length > 0 ? ` const outer = called ? [${fileVars}] : null; if (resume === null) ${vars.join(" = ")} = undefined;` : ""}`,
      "  try {",
      `    for (;;) { try { ${generators ? "yield* " : ""}file${index}(resume, at); return; } catch (signal) { if (!(signal instanceof rt.Goto && signal.label)) throw signal; resume = null; at = signal.pc; rt.depth = depth; rt.file = ${index}; } }`,
      `  } finally { ${vars.length > 0 ? `if (called) [${fileVars}] = outer;` : ""} }`,
      "}",
    );
    fileEntries.push(file.entryInstruction);
  });
  if (plan.functions.some((definition) => definition.handler === null && !emittedFunctions.has(definition.id)))
    throw new Unsupported("a function outside every file's functions");
  lines.push(`const FILES = [${plan.files.map((_, i) => `enter${i}`).join(", ")}];`);
  lines.push(
    `function${generators ? "*" : ""} main() {`,
    "  let file = rt.resuming ? rt.resumeFrames[0].file : 0;",
    `  let at = ${plan.files[0].startInstruction};`,
    "  for (;;) {",
    `    try { ${generators ? "yield* " : ""}FILES[file](rt.resuming ? rt.resumeFrame() : null, at, false); return; }`,
    "    catch (signal) { if (!(signal instanceof rt.Goto) || signal.label) throw signal; file = signal.file; at = signal.pc; rt.depth = 0; }",
    "  }",
    "}",
    "return main;",
  );
  return { source: lines.join("\n"), constants: K, globals, fileEntries, canWait: [...canWait], typeStats: { asked: typeStats.asked.size, found: typeStats.found.size, missing: typeStats.missing } };

  function emitRegion(start, end, definition, parameters, rootScope, fileIndex) {
    const out = [];
    const temps = new Set();
    // Scratch variables are expression-local: reused from x0 at every instruction, declared per JavaScript function
    // (the region's, or an outlined loop body's) up to the most any instruction needed.
    let scratch = 0;
    let scratchMax = 0;
    const x = () => {
      const name = `x${scratch++}`;
      if (scratch > scratchMax) scratchMax = scratch;
      return name;
    };
    /**
     * Outlined loop bodies (a loop body that holds a loop becomes its own function, so that the hot inner loops sit in
     * functions small enough for the optimizer): the stack of bodies being emitted, and each temporary's uses by body.
     */
    const bodies = [];
    let bodyCount = 0;
    const tempUses = new Map();
    const bodyParents = new Map();
    let usesRV = false;
    /** The region's function as a chunk's home: the variables its chunks declare for it. */
    const regionChunks = { lets: [] };
    let indent = 1;
    const line = (text) => out.push(`${"  ".repeat(indent)}${text}`);
    const scopes = [new Map()];
    const loops = new Map();
    const params = parameters.map((parameter) => {
      const name = jsName(parameter.name);
      scopes[0].set(parameter.name, name);
      return name;
    });
    const isRoot = definition === null;
    const flatRegion = rangeWaits(start, end);
    /** Whether emission is at the region's switch level (only in a resumable region), where a wait may stand. */
    let flat = flatRegion;
    /** Variables of a resumable region, declared at its top, saved at a wait. */
    const hoisted = [];
    const fnName = isRoot ? `file${fileIndex}` : `f${definition.id}`;
    // Only a generator may yield; a wait elsewhere (an instant say, which never waits) keeps the replay call.
    const regionYields = generators && (isRoot || canWait.has(definition.id));
    const WAIT_HERE_REGION = regionYields ? WAIT : "rt.waited()";

    const resolve = (name) => {
      for (let depth = scopes.length - 1; depth >= 0; depth -= 1) {
        const found = scopes[depth].get(name);
        if (found !== undefined) return { kind: "local", code: found };
      }
      if (!isRoot) {
        const found = rootScope.get(name);
        if (found !== undefined) return { kind: "root", code: found, name };
      }
      return { kind: "global", code: `G[${globalIndex(name)}]`, name };
    };
    const read = (name) => {
      if (name === "speaker") throw new Unsupported("a read of 'speaker'");
      const at = resolve(name);
      if (at.kind === "local") return at.code;
      return `(${at.code} !== undefined ? ${at.code} : rt.unset(${JSON.stringify(name)}))`;
    };
    const rawRead = (name) => resolve(name).code;
    const temp = (id) => {
      temps.add(id);
      const where = bodies.length === 0 ? "root" : bodies.at(-1).key;
      if (!tempUses.has(id)) tempUses.set(id, new Set());
      tempUses.get(id).add(where);
      return `t${id}`;
    };
    const own = (e) => {
      const code = expr(e);
      if (isFresh(e) || primitive(e)) return code;
      const v = x();
      return `(${v} = ${code}, typeof ${v} === "object" && ${v} !== null ? rt.copy(${v}) : ${v})`;
    };

    function expr(e) {
      switch (e.kind) {
        case "literal":
          return Object.is(e.value, -0) ? "-0" : JSON.stringify(e.value);
        case "group":
          return expr(e.expression);
        case "identifier":
          return read(e.name);
        case "temporary":
          if (speakerTemps.has(e.temporaryId)) {
            const v = x();
            return `((${v} = ${temp(e.temporaryId)}) !== null ? ${v} : rt.failNoSpeaker(${konst(e.span)}))`;
          }
          return temp(e.temporaryId);
        case "preparedReference":
          return temp(e.temporaryId);
        case "list":
          return `[${e.elements.map(own).join(", ")}]`;
        case "object":
          return `rt.object([${e.properties.map((p) => `${JSON.stringify(p.name)}, ${own(p.value)}`).join(", ")}])`;
        case "template": {
          let code = '""';
          for (const part of e.parts) {
            if (part.kind === "text") code = `rt.text(${code}, ${JSON.stringify(part.value)}, ${konst(e.span)})`;
            else code = `rt.interp(${code}, ${expr(part.expression)}, ${konst(part.expression)}, ${konst(e.span)})`;
          }
          return code;
        }
        case "property": {
          const o = x();
          const object = expr(e.object);
          if (e.name === "length")
            return `(${o} = ${object}, Array.isArray(${o}) ? ${o}.length : rt.prop(${o}, "length", ${konst(e.span)}))`;
          return `rt.prop(${object}, ${JSON.stringify(e.name)}, ${konst(e.span)}, ${konst({ ...e, object: { kind: "temporary", temporaryId: 1e9, span: e.object.span } })})`;
        }
        case "index": {
          const o = x();
          const i = x();
          if (isList(e.object) && typeOf(e.index) === "integer")
            return `(${o} = ${expr(e.object)}, ${i} = ${expr(e.index)}, (${i} >>> 0) === ${i} && ${i} < ${o}.length ? ${o}[${i}] : rt.index(${konst(e)}, ${o}, ${i}))`;
          return `(${o} = ${expr(e.object)}, Array.isArray(${o}) || rt.indexable(${konst(e.object)}, ${o}, ${konst(e.span)}), ${i} = ${expr(e.index)}, Array.isArray(${o}) && (${i} >>> 0) === ${i} && ${i} < ${o}.length ? ${o}[${i}] : rt.index(${konst(e)}, ${o}, ${i}))`;
        }
        case "unary": {
          const v = x();
          if (e.operator === "not")
            return `(${v} = ${expr(e.operand)}, typeof ${v} === "boolean" ? !${v} : rt.unary(${konst(e)}, ${v}))`;
          if (e.operator === "-")
            return `(${v} = ${expr(e.operand)}, typeof ${v} === "number" ? -${v} : rt.unary(${konst(e)}, ${v}))`;
          return `rt.unary(${konst(e)}, ${expr(e.operand)})`;
        }
        case "binary":
          return binary(e);
        case "range":
          return `rt.range(${konst(e)}, ${expr(e.start)}, ${expr(e.end)})`;
        case "unit":
          return `rt.unit(${konst(e)}, ${expr(e.operand)})`;
        case "call":
          return call(e);
        case "dict":
        case "set":
        case "regex":
        case "duration":
        case "calendarDuration":
        case "angleUnit":
        case "typeTest":
        case "tagQuery":
        case "debugMode":
        case "playerProfileField":
          return bridged(e);
        case "storageLoad": {
          if (e.default === null || closed(e.default)) return bridged(e);
          // A default that reads the program runs only when the load needs it: the load without it first, then the
          // load again with the default's value (a load reads; doing it twice changes nothing).
          const key = x();
          const pair = x();
          const keyTemp = { kind: "temporary", temporaryId: 1e9, span: e.key.span };
          const without = konst({ ...e, key: keyTemp, default: null });
          const withValue = konst({ ...e, key: keyTemp, default: { kind: "temporary", temporaryId: 1e9 + 1, span: e.default.span } });
          return `(${key} = ${expr(e.key)}, ${pair} = rt.withoutDefault(${without}, [${key}]), ${pair}[1] ? rt.bridge(${withValue}, [${key}, ${expr(e.default)}], -1) : ${pair}[0])`;
        }
        default:
          throw new Unsupported(`the expression kind '${e.kind}'`);
      }
    }

    /** The synthetic expression and evaluated parts of `e` for today's evaluator, as `rt.bridge` takes them. */
    function bridgedParts(e) {
      const children = childrenOf(e);
      const map = new Map(children.map((child, index) => [child, { kind: "temporary", temporaryId: 1e9 + index, span: child.span }]));
      return `${konst(substitute(e, map))}, [${children.map((child) => expr(child)).join(", ")}]`;
    }

    /** Today's evaluator for `e`, over its parts evaluated here in order (`rt.bridge`). */
    function bridged(e) {
      // A part that runs only on some ways (a load's default) stays in the expression for today's evaluator, which
      // can do so only when the part reads nothing of the program (a literal, say).
      const conditional = conditionalChildren(e);
      if (conditional.some((child) => !closed(child))) throw new Unsupported(`a ${e.kind} with a part that runs only on some ways and reads the program`);
      const children = childrenOf(e).filter((child) => !conditional.includes(child));
      const map = new Map(children.map((child, index) => [child, { kind: "temporary", temporaryId: 1e9 + index, span: child.span }]));
      const values = children.map((child) => (e.kind === "dict" || e.kind === "set" ? own(child) : expr(child)));
      return `rt.bridge(${konst(substitute(e, map))}, [${values.join(", ")}], -1)`;
    }

    function binary(e) {
      const a = x();
      const b = x();
      const op = e.operator;
      const k = konst(e);
      const copyLeft =
        (op === "==" || op === "!=" || e.left.kind === "preparedReference") && !isFresh(e.left) && mayChange(e.right);
      const left = copyLeft
        ? `(${a} = ${expr(e.left)}, ${a} = typeof ${a} === "object" && ${a} !== null ? rt.copy(${a}) : ${a})`
        : `(${a} = ${expr(e.left)})`;
      const checked = e.fallbackCheck !== undefined ? "rt.binChecked" : "rt.bin";
      switch (op) {
        case "+":
        case "-":
        case "*":
        case "/":
        case "%": {
          const r = x();
          if (numeric(e.left) && numeric(e.right))
            return `(${left}, ${b} = ${expr(e.right)}, (${r} = ${a} ${op} ${b}, ${r} - ${r} === 0) ? ${r} : ${checked}(${k}, ${a}, ${b}))`;
          return `(${left}, ${b} = ${expr(e.right)}, typeof ${a} === "number" && typeof ${b} === "number" && (${r} = ${a} ${op} ${b}, ${r} - ${r} === 0) ? ${r} : ${checked}(${k}, ${a}, ${b}))`;
        }
        case "<":
        case "<=":
        case ">":
        case ">=":
          if (numeric(e.left) && numeric(e.right)) return `(${left}, ${b} = ${expr(e.right)}, ${a} ${op} ${b})`;
          return `(${left}, ${b} = ${expr(e.right)}, typeof ${a} === "number" && typeof ${b} === "number" ? ${a} ${op} ${b} : ${checked}(${k}, ${a}, ${b}))`;
        case "==":
        case "!=": {
          if (primitive(e.left) && primitive(e.right)) return `(${left}, ${b} = ${expr(e.right)}, ${a} ${op === "==" ? "===" : "!=="} ${b})`;
          const same = `((typeof ${a} !== "object" || ${a} === null) && (typeof ${b} !== "object" || ${b} === null) ? ${a} === ${b} : rt.eq(${a}, ${b}))`;
          return `(${left}, ${b} = ${expr(e.right)}, ${op === "==" ? same : `!${same}`})`;
        }
        case "and":
          if (isBool(e.left) && isBool(e.right)) return `(${left} ? ${expr(e.right)} : false)`;
          return `(${left} === true ? (${b} = ${expr(e.right)}, typeof ${b} === "boolean" ? ${b} : ${checked}(${k}, ${a}, ${b})) : ${a} === false ? false : rt.throwIt(rt.notLogical(${k}, ${a})))`;
        case "or":
          if (isBool(e.left) && isBool(e.right)) return `(${left} ? true : ${expr(e.right)})`;
          return `(${left} === false ? (${b} = ${expr(e.right)}, typeof ${b} === "boolean" ? ${b} : ${checked}(${k}, ${a}, ${b})) : ${a} === true ? true : rt.throwIt(rt.notLogical(${k}, ${a})))`;
        case "otherwise":
          return `(${left} !== null ? ${a} : ${checked}(${k}, ${a}, ${expr(e.right)}))`;
        default:
          return `(${left}, ${checked}(${k}, ${a}, ${expr(e.right)}))`;
      }
    }

    function call(e) {
      const callee = e.callee;
      const lazy = lazyIndex(e);
      if (callee.kind === "identifier" && lazy === -1) {
        const name = callee.name;
        if (
          (name === "randomInteger" || name === "randomInt") &&
          e.arguments.length === 1 &&
          e.arguments[0].kind === "positional"
        )
        {
          const range = e.arguments[0].value;
          // A range written in the call: its bounds go to the draw directly (no range value is made).
          if (range.kind === "range") {
            const a = x();
            const b = x();
            return `(${a} = ${expr(range.start)}, ${b} = ${expr(range.end)}, rt.randInt(${konst(e)}, ${JSON.stringify(name)}, ${konst(range)}, ${a}, ${b}))`;
          }
          return `rt.randRange(${konst(e)}, ${JSON.stringify(name)}, ${own(range)})`;
        }
      }
      const receiver = callee.kind === "property" ? expr(callee.object) : "null";
      const args = [];
      e.arguments.forEach((argument, index) => {
        if (index !== lazy) args.push(own(argument.value));
      });
      // Today's evaluator can run a call the native operations do not have (with a lazy default only a collection
      // method, whose default the program runs: `rt.call`).
      let synthetic = "null";
      {
        const map = new Map();
        let slot = 0;
        if (callee.kind === "property") map.set(callee.object, { kind: "temporary", temporaryId: 1e9 + slot++, span: callee.object.span });
        for (const argument of e.arguments) map.set(argument.value, { kind: "temporary", temporaryId: 1e9 + slot++, span: argument.value.span });
        synthetic = konst(substitute(e, map));
      }
      const r = x();
      const head = `(${r} = rt.call(${konst(e)}, ${synthetic}, ${receiver}, [${args.join(", ")}], ${lazy}))`;
      if (lazy === -1) return `(${head}, ${r} === rt.NEEDS ? rt.throwIt(new Error("study: a call that needs a default it does not have")) : ${r})`;
      const fallback = e.arguments[lazy].value;
      return `(${head}, ${r} === rt.NEEDS ? rt.acceptDefault(${konst(e)}, ${own(fallback)}, ${konst(fallback.span)}) : ${r})`;
    }

    function lazyIndex(e) {
      return e.arguments.findIndex((a) => a.kind === "named" && a.name === "default");
    }

    function typeChecked(code, check, span) {
      return check === undefined ? code : `rt.typeCheck(${code}, ${konst(check)}, ${konst(span)})`;
    }

    function declare(name) {
      if (flat && !(isRoot && scopes.length === 1)) {
        const scope = scopes.at(-1);
        if (scope.has(name)) throw new Unsupported("a name declared twice in one scope");
        const js = jsName(name);
        scope.set(name, js);
        hoisted.push(js);
        return { code: js, fresh: false };
      }
      if (isRoot && scopes.length === 1) {
        const js = jsName(name);
        if (scopes[0].has(name)) throw new Unsupported("a top-level variable declared again (goto)");
        scopes[0].set(name, js);
        rootScope.set(name, js);
        return { code: js, fresh: false };
      }
      const scope = scopes.at(-1);
      if (scope.has(name)) throw new Unsupported("a name declared twice in one scope");
      const js = jsName(name);
      scope.set(name, js);
      // Declared at the level a chunk was cut at: the function that holds the chunks declares it, so later chunks see it.
      const top = bodies.at(-1);
      if (top !== undefined && top.ownLoop === null && top.cutDepth === scopes.length) {
        top.home.lets.push(js);
        return { code: js, fresh: false };
      }
      return { code: js, fresh: true };
    }

    function openLoops() {
      let n = 0;
      for (const _ of loops) n += 1;
      return n;
    }

    /** The variables a resumable region saves at a wait: its own, its parameters, its file's for a root, temporaries. */
    /** Set at the region's end: the temporaries declared in the region's own function (not in an outlined body). */
    let regionTempNames = null;
    function saved() {
      return [...params, ...hoisted, ...(isRoot ? [...rootScope.values()] : []), ...(regionTempNames ?? [...temps].map((id) => `t${id}`))];
    }
    /** A block that waits while this wait stands saves this frame outside its own: the closure pushes it. */
    function afterWait(resumeAt) {
      return `rt.afterWait(() => SAVE(${resumeAt}))`;
    }
    function suspendHere(resumeAt) {
      return `{ pc = ${resumeAt}; SAVE(${resumeAt}); throw rt.SUSPEND; }`;
    }

    /** The end of an `if` at `pc` and its else's end (or null), as lowering lays them out. */
    function ifShape(pc, endAt) {
      const ins = plan.instructions[pc];
      const target = ins.target;
      if (target <= pc || target > endAt) throw new Unsupported(`a jump at ${pc} out of its region`);
      const last = plan.instructions[target - 1];
      if (last.kind === "jump" && last.target > target && last.target <= endAt)
        return { thenEnd: target - 1, target, elseEnd: last.target };
      return { thenEnd: target, target, elseEnd: null };
    }

    function emitRange(pc, endAt) {
      while (pc < endAt) {
        const ins = plan.instructions[pc];
        scratch = 0;
        if (flat) line(`case ${pc}:`);
        if (stops && !STOP_EXCLUDED.has(ins.kind)) line(`${(bodies.length > 0 ? bodies.at(-1).yields : regionYields) ? "yield* rt.stop" : "rt.stopMissed"}(${pc});`);
        switch (ins.kind) {
          case "prepareParameterDefault": {
            // A parameter the call did not supply arrives as `undefined`; its default's instructions run then.
            if (ins.target !== pc + 1) {
              const p = params[ins.parameterIndex];
              if (flat && rangeWaits(pc + 1, ins.target)) {
                line(`if (${p} !== undefined) { pc = ${ins.target}; continue D; }`);
                pc += 1;
                continue;
              }
              const target = ins.target;
              structured(() => {
                line(`if (${p} === undefined) {`);
                indent += 1;
                emitRange(pc + 1, target);
                indent -= 1;
                line("}");
              });
              pc = target;
              continue;
            }
            pc += 1;
            continue;
          }
          case "jumpIfFalse": {
            const shape = ifShape(pc, endAt);
            const after = shape.elseEnd ?? shape.target;
            if (flat && rangeWaits(pc + 1, after)) {
              const c = x();
              line(`${c} = ${expr(ins.condition)};`);
              if (!isBool(ins.condition)) line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
              line(`if (!${c}) { pc = ${ins.target}; continue D; }`);
              pc += 1;
              continue;
            }
            structured(() => {
              const c = x();
              line(`${c} = ${expr(ins.condition)};`);
              if (!isBool(ins.condition)) line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
              line(`if (${c}) {`);
              indent += 1;
              emitChunked(pc + 1, shape.thenEnd);
              indent -= 1;
              if (shape.elseEnd !== null) {
                line("} else {");
                indent += 1;
                emitChunked(shape.target, shape.elseEnd);
                indent -= 1;
              }
              line("}");
            });
            pc = after;
            continue;
          }
          case "loopStart": {
            const endLoop = ins.target;
            if (endLoop <= pc || endLoop > endAt) throw new Unsupported("a loop that ends outside its region");
            // A round starts at the loop's continue target: before `loopStart` when its condition needs instructions
            // (an ask, a call), which every round runs again.
            const roundStart = ins.continueTarget ?? pc;
            if (flat && rangeWaits(Math.min(roundStart, pc + 1), endLoop)) {
              flatLoopHead(ins, pc);
              pc += 1;
              continue;
            }
            structured(() => structuredLoop(ins, pc, endLoop));
            pc = endLoop;
            continue;
          }
          case "loopControl": {
            const loop = loops.get(ins.loopId);
            if (loop === undefined) throw new Unsupported("a break or continue outside its loop");
            if (loop.flat) {
              if (ins.action === "break") line(`${loop.run} = false;`);
              line(`pc = ${ins.target}; continue D;`);
              if (flat && ins.action === "continue" && plan.instructions[pc + 1] !== undefined && ins.target === loop.head && pc + 1 === loop.end) {
                // The round's end: the loop's own end follows.
                loops.delete(ins.loopId);
                scopes.pop();
              }
            } else loopControl(ins.action, ins.loopId);
            pc += 1;
            continue;
          }
          case "jump":
            if (flat) {
              line(`pc = ${ins.target}; continue D;`);
              pc += 1;
              continue;
            }
            throw new Unsupported(`a jump at ${pc} that is no else`);
          default:
            statement(ins, pc);
            pc += 1;
        }
      }
    }

    /** Emits `body` as structured JavaScript, also inside a resumable region (where it holds no wait). */
    function structured(body) {
      const was = flat;
      flat = false;
      body();
      flat = was;
    }

    /** `break`/`continue` of a loop, also from an outlined body whose loop it is or that lies inside it. */
    function loopControl(action, loopId) {
      const loop = loops.get(loopId);
      if (loop.depth === bodies.length) return line(`${action} ${loop.label};`);
      const body = bodies.at(-1);
      if (loopId === body.ownLoop) return line(`return ${action === "continue" ? 0 : 1};`);
      const key = `${action}:${loopId}`;
      if (!body.codes.has(key)) body.codes.set(key, { code: 2 + body.codes.size, action, loopId });
      line(`return ${body.codes.get(key).code};`);
    }
    /** A return of the region's function, also from an outlined body (the value waits in `RV`). */
    function returnWith(value) {
      if (bodies.length === 0) return line(`return ${value};`);
      usesRV = true;
      bodies.at(-1).returns = true;
      line(`{ RV = ${value}; return -1; }`);
    }
    /** The wait code where emission stands: an outlined body yields when it is a generator, else as its region. */
    function waitHere() {
      if (bodies.length > 0) return bodies.at(-1).yields ? WAIT : "rt.waited()";
      return WAIT_HERE_REGION;
    }
    function containsLoop(from, to) {
      for (let at = from; at < to; at += 1) if (plan.instructions[at].kind === "loopStart") return true;
      return false;
    }
    function containsWait(from, to) {
      for (let at = from; at < to; at += 1) if (waitsAt(at)) return true;
      return false;
    }

    function structuredLoop(ins, pc, endLoop) {
      const label = `L${ins.loopId}`;
      loops.set(ins.loopId, { label, flat: false, depth: bodies.length });
      const roundVars = [];
      const roundStart = ins.continueTarget ?? pc;
      if (roundStart < pc && ins.loopKind !== "while") throw new Unsupported(`a '${ins.loopKind}' loop whose rounds start before it`);
      if (ins.loopKind === "while") {
        // The condition's instructions ran once before the loop; each later round runs them again.
        const again = roundStart < pc ? `r${pc}` : null;
        if (again !== null) line(`let ${again} = false;`);
        line(`${label}: while (true) {`);
        indent += 1;
        if (tick) line(tick);
        if (again !== null) {
          line(`if (${again}) {`);
          indent += 1;
          emitRange(roundStart, pc);
          indent -= 1;
          line(`}`);
          line(`${again} = true;`);
        }
        const c = x();
        line(`${c} = ${expr(ins.expression)};`);
        line(isBool(ins.expression) ? `if (!${c}) break;` : `if (${c} !== true) { if (${c} === false) break; throw rt.notBool(${konst(ins.expression)}, ${c}); }`);
        scopes.push(new Map());
      } else if (ins.loopKind === "for" && ins.expression.kind === "range" && ins.valueVariable === undefined) {
        // A range written in the loop: its whole-number bounds inline; anything else faults through today's checks.
        const e = ins.expression;
        const a = x();
        const b = x();
        line(`${a} = ${expr(e.start)}; ${b} = ${expr(e.end)};`);
        line(`if (!(Number.isSafeInteger(${a}) && Number.isSafeInteger(${b}) && Number.isSafeInteger(${b} - ${a}))) rt.forSource(${konst(ins)}, rt.range(${konst(e)}, ${a}, ${b}));`);
        const i = `i${pc}`;
        line(`${label}: for (let ${i} = 0, a${pc} = ${a}, n${pc} = Math.max(0, ${b} - ${a}${e.inclusive ? " + 1" : ""}); ${i} < n${pc}; ${i}++) {`);
        indent += 1;
        if (tick) line(tick);
        scopes.push(new Map());
        const v = declare(ins.variable);
        roundVars.push(v.code);
        line(`let ${v.code} = a${pc} + ${i};`);
      } else if (ins.loopKind === "for") {
        const s = x();
        line(`${s} = rt.forSource(${konst(ins)}, ${expr(ins.expression)});`);
        const i = `i${pc}`;
        line(`${label}: for (let ${i} = 0, a${pc} = ${s}.start, n${pc} = ${s}.length, it${pc} = ${s}.items, vs${pc} = ${s}.values; ${i} < n${pc}; ${i}++) {`);
        indent += 1;
        if (tick) line(tick);
        scopes.push(new Map());
        const v = declare(ins.variable);
        roundVars.push(v.code);
        line(`let ${v.code} = it${pc} === null ? a${pc} + ${i} : it${pc}[${i}];`);
        if (ins.valueVariable !== undefined) {
          const w = declare(ins.valueVariable);
          roundVars.push(w.code);
          const c = x();
          line(`let ${w.code} = (${c} = vs${pc}[${i}], typeof ${c} === "object" && ${c} !== null ? rt.copy(${c}) : ${c});`);
        }
      } else if (ins.loopKind === "repeat") {
        const n = x();
        line(`${n} = rt.repeatCount(${konst(ins.expression)}, ${expr(ins.expression)});`);
        line(`${label}: for (let r${pc} = ${n}; r${pc} > 0; r${pc}--) {`);
        indent += 1;
        if (tick) line(tick);
        scopes.push(new Map());
      } else throw new Unsupported(`a '${ins.loopKind}' loop`);
      // A body that holds a loop, or a long one, is outlined; in the generator form a body that waits is a generator.
      if (!flatRegion && ((containsLoop(pc + 1, endLoop) && endLoop - pc > OUTLINE_WITH_LOOP) || endLoop - pc > OUTLINE_LENGTH))
        outlinedBody(ins, pc, endLoop, roundVars, regionYields && containsWait(pc + 1, endLoop));
      else emitRange(pc + 1, endLoop);
      scopes.pop();
      loops.delete(ins.loopId);
      indent -= 1;
      line("}");
    }

    /**
     * The body of loop `ins` as a function defined before the loop and called each round with the round's variables;
     * it returns 0 (next round), 1 (break), -1 (a return, its value in RV) or a code for a break or continue of an outer
     * loop, which the call site carries out.
     */
    /**
     * Emits [from, to) as a function of its own (a loop body: `ownLoop` and the round's variables as parameters; a
     * chunk of a long sequence: neither) and returns its text and what its call site must carry out: 0 (go on), 1
     * (break of its own loop), -1 (a return, its value in RV) or a code for a break or continue of an outer loop.
     */
    function outlineFunction(from, to, ownLoop, params, yields, emitBody = null) {
      const key = `${ownLoop === null ? "k" : "b"}${from}_${bodyCount++}`;
      bodyParents.set(key, bodies.length === 0 ? "root" : bodies.at(-1).key);
      // A chunk's home: the function whose sequence it was cut from, which declares the chunk level's variables.
      const body = { key, ownLoop, codes: new Map(), returns: false, yields, lets: [], home: bodies.at(-1) ?? regionChunks, cutDepth: scopes.length };
      const outer = out.splice(0);
      const savedScratch = scratch;
      const savedMax = scratchMax;
      const savedIndent = indent;
      scratch = 0;
      scratchMax = 0;
      indent = 1;
      bodies.push(body);
      // A loop body may itself be long and is cut; a chunk emits its own short items.
      if (emitBody !== null) emitBody();
      else if (ownLoop === null) emitRange(from, to);
      else emitChunked(from, to);
      bodies.pop();
      const inner = out.splice(0);
      const bodyScratch = scratchMax;
      scratch = savedScratch;
      scratchMax = savedMax;
      indent = savedIndent;
      out.push(...outer);
      const locals = [...body.lets, ...Array.from({ length: bodyScratch }, (_, i) => `x${i}`), `%TEMPS_${key}%`];
      // `var`: every name is unique and declared at the function's top, so a closure's read needs no TDZ check.
      const fn = [`function${yields ? "*" : ""} ${key}(${params.join(", ")}) {`, `  var ${locals.join(", ")};`, ...inner, "  return 0;", "}"];
      return { key, body, fn };
    }

    /** The call of an outlined function and what its result asks of the call site. */
    function callOutlined({ key, body }, args, ownLabel) {
      const c = `c_${key}`;
      line(`const ${c} = ${body.yields ? "yield* " : ""}${key}(${args.join(", ")});`);
      if (ownLabel === null && body.codes.size === 0 && !body.returns) return;
      line(`if (${c} !== 0) {`);
      indent += 1;
      if (ownLabel !== null) line(`if (${c} === 1) break ${ownLabel};`);
      for (const { code, action, loopId } of body.codes.values()) {
        line(`if (${c} === ${code}) {`);
        indent += 1;
        loopControl(action, loopId);
        indent -= 1;
        line("}");
      }
      if (body.returns) {
        line(`if (${c} === -1) {`);
        indent += 1;
        if (bodies.length === 0) line("return RV;");
        else {
          bodies.at(-1).returns = true;
          line("return -1;");
        }
        indent -= 1;
        line("}");
      }
      indent -= 1;
      line("}");
    }

    function outlinedBody(ins, pc, endLoop, roundVars, yields) {
      const outlined = outlineFunction(pc + 1, endLoop, ins.loopId, roundVars, yields);
      // Before the loop's header: the header began where the loop's first line was written.
      const headerAt = out.findLastIndex((text) => text.trimStart().startsWith(`L${ins.loopId}:`));
      const prefix = "  ".repeat(indent - 1);
      out.splice(headerAt, 0, ...outlined.fn.map((text) => prefix + text));
      callOutlined(outlined, roundVars, `L${ins.loopId}`);
    }

    /** Where the construct at `pc` ends at this level: an `if` with its else, a loop, a block, a skipped default. */
    function constructEnd(pc, to) {
      const ins = plan.instructions[pc];
      if (ins.kind === "jumpIfFalse") {
        const shape = ifShape(pc, to);
        return shape.elseEnd ?? shape.target;
      }
      if (ins.kind === "loopStart") return ins.target;
      if (ins.kind === "prepareParameterDefault" && ins.target > pc + 1) return ins.target;
      if (ins.kind === "enterScope") {
        let depth = 0;
        for (let at = pc; at < to; at += 1) {
          const kind = plan.instructions[at].kind;
          if (kind === "enterScope") depth += 1;
          else if (kind === "leaveScope" && --depth === 0) return at + 1;
        }
      }
      return pc + 1;
    }

    /**
     * Structured code for [from, to); a sequence longer than CHUNK_LENGTH instructions is cut between its constructs
     * into functions of their own (a construct longer than that is cut inside: a block's contents, an `if`'s branches,
     * a loop's body). The variables a chunk declares at the level where it was cut are declared in the enclosing
     * function, so the next chunks see them.
     */
    function emitChunked(from, to) {
      // Not in a resumable region: its structured parts may hold a flat loop's `continue D`, which no nested function sees.
      if (flat || flatRegion || to - from <= CHUNK_LENGTH) return emitRange(from, to);
      emitItems(itemsOf(from, to));
    }

    /** The constructs of [from, to) as items: each with its plan range and how it is emitted. */
    function itemsOf(from, to) {
      const items = [];
      for (let at = from; at < to; ) {
        const next = Math.max(at + 1, constructEnd(at, to));
        const a = at;
        items.push({ from: a, to: next, emit: () => emitRange(a, next), long: () => emitLong(a, next) });
        at = next;
      }
      return items;
    }

    /**
     * A construct longer than a chunk: a block's contents are cut inside its scope; an `if` whose else holds another
     * `if` (an else-if chain, as a `switch` is lowered) becomes a labelled block of guarded cases at one level, so its
     * cases can be cut into chunks; any other `if` cuts its branches.
     */
    function emitLong(a, b) {
      const ins = plan.instructions[a];
      if (ins.kind === "enterScope" && b - a > 2) {
        statement(ins, a);
        emitChunked(a + 1, b - 1);
        statement(plan.instructions[b - 1], b - 1);
        return;
      }
      if (ins.kind === "jumpIfFalse" && ifShape(a, b).elseEnd !== null) return emitChain(a, b);
      emitRange(a, b);
    }

    let chainCount = 0;
    function emitChain(a, b) {
      const id = `chain${chainCount++}`;
      const label = `C${a}`;
      loops.set(id, { label, flat: false, depth: bodies.length });
      const items = [];
      let pc = a;
      let end = b;
      for (;;) {
        const shape = ifShape(pc, end);
        const condPc = pc;
        // The case: its condition, then its body, then out of the chain.
        items.push({
          from: condPc,
          to: shape.target,
          size: shape.thenEnd - condPc,
          emit: () => {
            const ins = plan.instructions[condPc];
            const c = x();
            line(`${c} = ${expr(ins.condition)};`);
            if (!isBool(ins.condition)) line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
            line(`if (${c}) {`);
            indent += 1;
            emitChunked(condPc + 1, shape.thenEnd);
            loopControl("break", id);
            indent -= 1;
            line("}");
          },
        });
        if (shape.elseEnd === null) break;
        // The else: its constructs at this level; a last `if` continues the chain.
        const rest = itemsOf(shape.target, shape.elseEnd);
        const last = rest.at(-1);
        const continues = last !== undefined && plan.instructions[last.from].kind === "jumpIfFalse" && last.to === shape.elseEnd;
        items.push(...(continues ? rest.slice(0, -1) : rest));
        if (!continues) break;
        pc = last.from;
        end = shape.elseEnd;
      }
      line(`${label}: {`);
      indent += 1;
      emitItems(items);
      indent -= 1;
      line("}");
      loops.delete(id);
    }

    /** Items in order: short ones gathered into chunk functions of about CHUNK_LENGTH instructions, long ones cut. */
    function emitItems(items) {
      let group = [];
      let size = 0;
      const flush = () => {
        if (group.length === 0) return;
        const members = group;
        const [a, b] = [members[0].from, members.at(-1).to];
        if (size <= 2) members.forEach((item) => item.emit());
        else {
          const outlined = outlineFunction(a, b, null, [], regionYields && containsWait(a, b), () => members.forEach((item) => item.emit()));
          for (const text of outlined.fn) line(text);
          callOutlined(outlined, [], null);
        }
        group = [];
        size = 0;
      };
      for (const item of items) {
        const itemSize = item.size ?? item.to - item.from;
        if (itemSize > CHUNK_LENGTH && item.long !== undefined) {
          flush();
          item.long();
          continue;
        }
        group.push(item);
        size += itemSize;
        if (size >= CHUNK_LENGTH) flush();
      }
      flush();
    }

    /**
     * A loop that holds a wait, in a resumable region: its round starts at `case pc`, its state is the region's
     * (`run` while it runs, its position), so a round resumes where it waited.
     */
    function flatLoopHead(ins, pc) {
      const run = `run${pc}`;
      hoisted.push(run);
      loops.set(ins.loopId, { flat: true, run, head: pc, end: ins.target });
      const exit = `{ ${run} = false; pc = ${ins.target}; continue D; }`;
      if (tick) line(tick);
      if (ins.loopKind === "while") {
        const c = x();
        line(`${c} = ${expr(ins.expression)};`);
        line(`if (${c} !== true) { if (${c} === false) ${exit} throw rt.notBool(${konst(ins.expression)}, ${c}); }`);
        line(`${run} = true;`);
        scopes.push(new Map());
      } else if (ins.loopKind === "for") {
        const [i, a, n, it, vs] = [`i${pc}`, `a${pc}`, `n${pc}`, `it${pc}`, `vs${pc}`];
        hoisted.push(i, a, n, it, vs);
        const s = x();
        line(`if (${run} !== true) { ${s} = rt.forSource(${konst(ins)}, ${expr(ins.expression)}); ${run} = true; ${i} = 0; ${a} = ${s}.start; ${n} = ${s}.length; ${it} = ${s}.items; ${vs} = ${s}.values; }`);
        line(`if (${i} >= ${n}) ${exit}`);
        scopes.push(new Map());
        const v = declare(ins.variable);
        line(`${v.code} = ${it} === null ? ${a} + ${i} : ${it}[${i}];`);
        if (ins.valueVariable !== undefined) {
          const w = declare(ins.valueVariable);
          const c = x();
          line(`${w.code} = (${c} = ${vs}[${i}], typeof ${c} === "object" && ${c} !== null ? rt.copy(${c}) : ${c});`);
        }
        line(`${i} += 1;`);
      } else if (ins.loopKind === "repeat") {
        const r = `r${pc}`;
        hoisted.push(r);
        line(`if (${run} !== true) { ${r} = rt.repeatCount(${konst(ins.expression)}, ${expr(ins.expression)}); ${run} = true; }`);
        line(`if (${r} <= 0) ${exit}`);
        line(`${r} -= 1;`);
        scopes.push(new Map());
      } else throw new Unsupported(`a '${ins.loopKind}' loop`);
    }

    /**
     * The blocks an instruction creates, each as a closure over the variables visible where it stands, so that they
     * share them (ADR 0024); the runtime runs one when today's engine dispatches it at a wait (`rt.runBlocks`).
     */
    function rawGlobal(name) {
      return `G[${globalIndex(name)}]`;
    }

    function blockClosures(ins) {
      const ids = [ins.handlerFunctionId, ins.finishFunctionId, ...(ins.cues ?? []).map((cue) => cue.functionId)].filter((id) => typeof id === "number");
      if (ids.length === 0) return ins;
      const visible = new Map(rootScope);
      for (const scope of scopes) for (const [name, js] of scope) visible.set(name, js);
      for (const id of ids) {
        const block = plan.functions[id - 1];
        if (resumable) {
          // A save holds no closure: a block is a module function over its file's variables, registered at load.
          if (ins.captures.length > 0) throw new Unsupported("a block that shares a function's variables (resumable form)");
          if (!moduleBlocks.has(id))
            moduleBlocks.set(id, `${emitRegion(block.entryInstruction, block.endInstruction, block, [], rootScope, fileIndex)}\nrt.blocks.set(${id}, f${id});`);
          continue;
        }
        line(`rt.blocks.set(${id}, ${emitRegion(block.entryInstruction, block.endInstruction, block, [], visible, fileIndex)});`);
      }
      // The closures share the variables; today's engine records none (its scopes do not hold them).
      return { ...ins, captures: [] };
    }

    /**
     * `call` of a file: today's engine opens the file call; the program runs the file's activation until its `end`,
     * following the gotos to other files it makes (each replaces the called activation). A resumable region resumes the
     * activation from the next saved frame.
     */
    function callFile(ins, pc) {
      if ("value" in ins.destination) throw new Unsupported("a call of a computed file");
      const [d, f, a, r] = [x(), x(), x(), x()];
      const enter = generators ? "yield* " : "";
      line(`${d} = rt.depth;`);
      if (resumable) line(`if (rt.resuming) { ${f} = rt.resumeFrames[0].file; ${a} = 0; ${r} = rt.resumeFrame(); } else { ${f} = rt.callFile(${konst(ins)}, ${pc}); ${a} = rt.fileEntries[${f}]; ${r} = null; }`);
      else line(`${f} = rt.callFile(${konst(ins)}, ${pc}); ${a} = rt.fileEntries[${f}]; ${r} = null;`);
      line(`rt.depth += 1;`);
      const onSuspend = resumable ? ` if (signal === rt.SUSPEND) SAVE(${pc});` : "";
      line(`for (;;) { try { ${enter}FILES[${f}](${r}, ${a}, true); break; } catch (signal) { if (signal === rt.END) break; if (signal instanceof rt.Goto && !signal.label) { ${f} = signal.file; ${a} = signal.pc; ${r} = null; rt.depth = ${d} + 1; continue; }${onSuspend} throw signal; } }`);
      line(`rt.depth = ${d}; rt.file = ${fileIndex};`);
    }

    function statement(ins, pc) {
      switch (ins.kind) {
        case "declareGlobal":
          // The global's value lives in the program (G); the state gets its start value too, as today's engine keeps it.
          line(`${rawGlobal(ins.name)} = rt.declareGlobal(${konst(ins)}, ${typeChecked(own(ins.value), ins.typeCheck, ins.value.span)});`);
          return;
        case "startTimer":
        case "showPermanentButton":
        case "playMedia":
          bridgeInstruction(blockClosures(ins), pc, "rt.instruction");
          return;
        case "declareSpeaker":
          line(`rt.declareSpeaker(${konst(ins)}, ${globalIndex(ins.name)});`);
          return;
        case "setDefaultSpeaker":
          line(`rt.setDefaultSpeaker(${JSON.stringify(ins.name)}, ${rawRead(ins.name)}, ${konst(ins.span)});`);
          return;
        case "enterScope":
          if (!flat) {
            line("{");
            indent += 1;
          }
          scopes.push(new Map());
          return;
        case "leaveScope":
          if (scopes.length === 1) throw new Unsupported("a scope left at the region's first scope");
          scopes.pop();
          if (!flat) {
            indent -= 1;
            line("}");
          }
          return;
        case "declareBinding": {
          if (ins.partChecks !== undefined) throw new Unsupported("part checks");
          const value = typeChecked(own(ins.value), ins.typeCheck, ins.value.span);
          const v = declare(ins.name);
          line(`${v.fresh ? "let " : ""}${v.code} = ${value};`);
          return;
        }
        case "validateAssignmentTarget": {
          const t = ins.target;
          if (t.kind === "identifier") return;
          if (t.kind === "property") {
            line(`rt.checkPropertyStore(${konst(propertyTarget(t))}, ${expr(t.object)});`);
            return;
          }
          if (t.kind !== "index") throw new Unsupported(`a store into a ${t.kind}`);
          const o = x();
          const i = x();
          line(`${o} = ${expr(t.object)}; ${i} = ${expr(t.index)};`);
          line(`if (!(Array.isArray(${o}) && (${i} >>> 0) === ${i} && ${i} < ${o}.length)) rt.checkIndexStore(${konst(t)}, ${o}, ${i});`);
          return;
        }
        case "assign": {
          if (ins.partChecks !== undefined) throw new Unsupported("part checks");
          const t = ins.target;
          const value = typeChecked(own(ins.value), ins.typeCheck, ins.value.span);
          if (t.kind === "identifier") {
            const at = resolve(t.name);
            if (at.kind !== "local") {
              const v = x();
              line(`${v} = ${value};`);
              line(`if (${at.code} === undefined) rt.unset(${JSON.stringify(t.name)});`);
              line(`${at.code} = ${v};`);
            } else line(`${at.code} = ${value};`);
            return;
          }
          if (t.kind === "property") {
            const v = x();
            line(`${v} = ${value};`);
            line(`rt.storeProperty(${konst(propertyTarget(t))}, ${expr(t.object)}, ${v}, ${ins.requireExisting === true});`);
            return;
          }
          if (t.kind !== "index") throw new Unsupported(`a store into a ${t.kind}`);
          const v = x();
          const o = x();
          const i = x();
          line(`${v} = ${value}; ${o} = ${expr(t.object)}; ${i} = ${expr(t.index)};`);
          line(`if (Array.isArray(${o}) && (${i} >>> 0) === ${i} && ${i} < ${o}.length) ${o}[${i}] = ${v}; else rt.storeIndex(${konst(t)}, ${o}, ${i}, ${v});`);
          return;
        }
        case "prepareReference": {
          let root = ins.expression;
          let label = true;
          const steps = [];
          while (root.kind === "index" || root.kind === "group" || root.kind === "property") {
            if (root.kind === "index") label = false;
            if (root.kind === "property") steps.unshift(root.name);
            root = root.kind === "group" ? root.expression : root.object;
          }
          // A place inside a variable, or inside a value no variable holds (a literal, a temporary): the temporary holds
          // the container either way; only a variable's place has a label.
          const placeLabel = label && root.kind === "identifier" ? JSON.stringify([root.name, ...steps].join(".")) : "null";
          line(`${temp(ins.destinationTemporary)} = ${expr(ins.expression)}; rt.referenceLabels[${ins.destinationTemporary}] = ${placeLabel};`);
          return;
        }
        case "evaluate":
          line(`${expr(ins.expression)};`);
          return;
        case "storeTemporary": {
          if (ins.repair !== undefined) throw new Unsupported("a temporary that holds a repaired record");
          if (ins.defaultTemporary !== undefined) {
            // The call or load without its default, by today's evaluator; the next instructions run the default if needed.
            const pair = x();
            line(`${pair} = rt.withoutDefault(${bridgedParts(ins.value)});`);
            line(`${temp(ins.temporaryId)} = ${pair}[0]; ${temp(ins.defaultTemporary)} = ${pair}[1];`);
            return;
          }
          let value = own(ins.value);
          if (ins.defaultOf !== undefined) value = `rt.acceptDefaultOf(${konst(ins)}, ${value})`;
          if (ins.defaultOf === undefined && ins.typeCheck !== undefined) value = typeChecked(value, ins.typeCheck, ins.value.span);
          if (ins.defaultOf === undefined && ins.fallbackCheck !== undefined) value = `rt.fallbackCheck(${value}, ${konst(ins.fallbackCheck)}, ${konst(ins.value.span)})`;
          const t = temp(ins.temporaryId);
          line(`${t} = ${value};`);
          if (ins.expectBoolean)
            line(`if (typeof ${t} !== "boolean") throw rt.notLoweredLogical(${ins.temporaryId}, ${konst(ins.value)}, ${t});`);
          return;
        }
        case "clearTemporary":
        case "clearTemporaries":
          return;
        case "callFunction": {
          const definition = plan.functions[ins.functionId - 1];
          if (ins.returnInstruction !== pc + 1) throw new Unsupported("a call that returns elsewhere");
          const slots = ins.arguments.map((a) => definition.parameters.findIndex((p) => p.name === a.parameterName));
          if (slots.includes(-1) || new Set(slots).size !== slots.length)
            throw new Unsupported("a call whose arguments do not match the parameters");
          const resumes = resumable && canWait.has(ins.functionId);
          if (resumes) {
            line("if (!rt.resuming) {");
            indent += 1;
          }
          const args = ins.arguments.map((a) => {
            const v = x();
            line(`${v} = ${own(a.value)};`);
            return v;
          });
          ins.arguments.forEach((a, index) => {
            if (a.typeCheck !== undefined) line(`rt.typeCheck(${args[index]}, ${konst(a.typeCheck)}, ${konst(a.value.span)});`);
          });
          if (resumes) {
            indent -= 1;
            line("}");
          }
          const ordered = definition.parameters.map((_, slot) => args[slots.indexOf(slot)] ?? "undefined");
          if (!resumes) {
            line(`rt.enter(${konst(ins.span)}); ${temp(ins.destinationTemporary)} = ${star(ins.functionId) ? "yield* " : ""}f${ins.functionId}(${ordered.join(", ")}); rt.depth -= 1;`);
            return;
          }
          // A call of a function that can wait: on resume its frame comes back to it; at its wait this frame is saved.
          line(`try {`);
          line(`  if (rt.resuming) { rt.depth += 1; ${temp(ins.destinationTemporary)} = f${ins.functionId}(rt.resumeFrame()); }`);
          line(`  else { rt.enter(${konst(ins.span)}); ${temp(ins.destinationTemporary)} = f${ins.functionId}(null${ordered.map((a) => `, ${a}`).join("")}); }`);
          line(`} catch (signal) { if (signal === rt.SUSPEND) SAVE(${pc}); throw signal; }`);
          line(`rt.depth -= 1;`);
          return;
        }
        case "bindSuppliedParameter":
        case "beginFunctionDefaults":
        case "enterFunctionBody":
          return;
        case "bindDefaultParameter":
          line(`${params[ins.parameterIndex]} = ${typeChecked(own(ins.value), ins.typeCheck, ins.value.span)};`);
          return;
        case "returnValue":
          returnWith(typeChecked(own(ins.value), ins.typeCheck, ins.value.span));
          return;
        case "returnVoid":
          returnWith("null");
          return;
        case "prepareSaySpeaker":
          line(`${temp(ins.destinationTemporary)} = rt.prepareSaySpeaker(${konst(ins)}, ${ins.speaker === null ? "undefined" : rawRead(ins.speaker)});`);
          return;
        case "prepareSayContextualSpeaker":
          line(`${temp(ins.destinationTemporary)} = rt.contextualSpeaker(${konst(ins)}, ${temp(ins.speakerTemporary)});`);
          return;
        case "say": {
          const parts = [
            `text: ${ins.textTemporary === undefined ? "undefined" : temp(ins.textTemporary)}`,
            `speakerValue: ${ins.speaker === null || ins.speakerTemporary !== undefined ? "undefined" : rawRead(ins.speaker)}`,
            `prepared: ${ins.speakerTemporary === undefined ? "undefined" : temp(ins.speakerTemporary)}`,
            `presentation: ${ins.presentation === null ? "undefined" : expr(ins.presentation)}`,
            `value: ${expr(ins.value)}`,
            `pacing: ${typeof ins.pacing === "object" ? expr(ins.pacing) : "undefined"}`,
          ];
          // The gate records where the say stands; inside a function this prototype knows only its own region's part.
          const place = `{ pc: ${pc}, ownerCallFrameId: null, scopeDepth: ${scopes.length}, loopDepth: ${openLoops()} }`;
          let said = `rt.say(${konst(ins)}, () => ({ ${parts.join(", ")} }), ${place})`;
          if (ins.destinationTemporary !== undefined) {
            const w = x();
            line(`${w} = ${said}; ${temp(ins.destinationTemporary)} = rt.messageHandle;`);
            said = w;
          }
          if (flat) {
            // A wait: catch-up and the blocks due run (`rt.afterWait`); still waiting, the program saves here. A
            // resume comes back to the same check, so a block due while it waits runs from the save too.
            line(`${said};`);
            line(`case ${1e6 + pc}:`);
            line(`if (${afterWait(1e6 + pc)}) ${suspendHere(1e6 + pc)}`);
          } else line(`if (${said}) ${waitHere()};`);
          return;
        }
        case "exit":
          line(`rt.exit(${konst(ins.span)}, ${pc});`);
          return;
        case "end":
          // Today's engine returns from the file call (or faults without one); the program unwinds to the call.
          line(`rt.end(${konst(ins)}, ${pc});`);
          return;
        case "goto":
          bridgeInstruction(ins, pc, "rt.gotoLabel");
          return;
        case "transfer":
          if (ins.mode === "call") return callFile(ins, pc);
          bridgeInstruction(ins, pc, "rt.transfer");
          return;
        default:
          bridgeInstruction(ins, pc, "rt.instruction");
      }
    }

    /**
     * An instruction the emitter does not write itself: its operands are evaluated here in field order and today's
     * engine executes it on the session's state (`rt.instruction`); the temporaries it reads go to the state first,
     * those it writes come back after it, past its wait when it waits.
     */
    function bridgeInstruction(ins, pc, via) {
      const operands = [];
      const map = new Map();
      const find = (node) => {
        if (Array.isArray(node)) return node.forEach(find);
        if (node === null || typeof node !== "object") return;
        if (typeof node.kind === "string" && EXPRESSION_KINDS.has(node.kind) && node !== ins && node.span !== undefined) {
          map.set(node, { kind: "temporary", temporaryId: 1e9 + operands.length, span: node.span });
          operands.push(node);
          return;
        }
        // Type plans (no span) are no expressions, though some share a kind's name (an object or dict type).
        for (const [key, value] of Object.entries(node)) if (!NOT_EXPRESSIONS.has(key)) find(value);
      };
      find(ins);
      const reads = [];
      const writes = [];
      for (const [key, value] of Object.entries(ins)) {
        if (typeof value !== "number" || !/Temporary$/.test(key)) continue;
        (/^destination|^default/.test(key) ? writes : reads).push(value);
      }
      // The temporaries an interaction's parts read (its label, hint, options...), at any depth outside expressions.
      const nested = (node, top) => {
        if (Array.isArray(node)) return node.forEach((item) => nested(item, false));
        if (node === null || typeof node !== "object" || (EXPRESSION_KINDS.has(node.kind) && node.span !== undefined)) return;
        for (const [key, value] of Object.entries(node)) {
          if (!top && typeof value === "number" && /Temporary$/.test(key)) reads.push(value);
          else if (key === "temporaryIds" && Array.isArray(value)) reads.push(...value);
          else if (typeof value === "object") nested(value, false);
        }
      };
      nested(ins, true);
      const values = operands.map((operand) => expr(operand));
      const sources = reads.map((id) => `${id}, ${temp(id)}`);
      const call = `${via}(${konst(substitute(ins, map))}, ${pc}, [${values.join(", ")}], [${sources.join(", ")}])`;
      if (flat) {
        line(`${call};`);
        line(`case ${1e6 + pc}:`);
        line(`if (${afterWait(1e6 + pc)}) ${suspendHere(1e6 + pc)}`);
      } else line(`if (${call}) ${waitHere()};`);
      for (const id of writes) line(`${temp(id)} = rt.takeTemporary(${id});`);
    }

    const entry = isRoot ? plan.files[fileIndex].entryInstruction : start;
    // A file's places of entry: its start, its entry and its labels; each part runs when the activation starts at or
    // before it. A resumable region jumps there instead (its switch has a case at each).
    const entries = isRoot ? [...new Set([start, entry, ...plan.files[fileIndex].labels.map((label) => label.instruction)])].filter((at) => at >= start && at < end).sort((a, b) => a - b) : [start];
    if (entries.length > 1 && !flatRegion)
      entries.forEach((from, k) => {
        line(`if (at <= ${from}) {`);
        indent += 1;
        emitChunked(from, entries[k + 1] ?? end);
        indent -= 1;
        line("}");
      });
    else emitChunked(start, end);
    // Each temporary is declared in the innermost function (region or outlined body) that holds all its uses.
    const ancestors = (key) => { const chain = [key]; while (chain.at(-1) !== "root") chain.push(bodyParents.get(chain.at(-1))); return chain; };
    const bodyTemps = new Map();
    const regionTemps = [];
    for (const id of temps) {
      const uses = [...(tempUses.get(id) ?? ["root"])];
      let common = ancestors(uses[0]);
      for (const use of uses.slice(1)) { const chain = new Set(ancestors(use)); common = common.filter((k) => chain.has(k)); }
      const home = common[0];
      if (home === "root") regionTemps.push(`t${id}`);
      else { if (!bodyTemps.has(home)) bodyTemps.set(home, []); bodyTemps.get(home).push(`t${id}`); }
    }
    for (let i = 0; i < out.length; i += 1)
      if (out[i].includes("%TEMPS_"))
        out[i] = out[i].replace(/(, )?%TEMPS_(\w+)%/g, (_, comma, key) => { const list = bodyTemps.get(key) ?? []; return list.length === 0 ? "" : `${comma ?? ""}${list.join(", ")}`; }).replace("var ;", "");
    regionTempNames = regionTemps;
    const header = [];
    const locals = [...regionChunks.lets, ...regionTemps, ...Array.from({ length: scratchMax }, (_, i) => `x${i}`), ...hoisted, ...(usesRV ? ["RV"] : [])];
    if (locals.length > 0) header.push(`  var ${locals.join(", ")};`);
    if (!flatRegion) {
      if (definition === null) return [`function${generators ? "*" : ""} file${fileIndex}(resume, at) {`, ...header, ...out, "}"].join("\n");
      return [`function${star(definition.id)} f${definition.id}(${params.join(", ")}) {`, ...header, ...(tick ? [`  ${tick}`] : []), ...out, "  return null;", "}"].join("\n");
    }
    // A resumable region: its argument evaluation before a call that waits runs only on a fresh entry of that call.
    const savedList = saved().join(", ");
    const signature = definition === null ? `function file${fileIndex}(resume, at) {` : `function f${definition.id}(resume${params.map((p) => `, ${p}`).join("")}) {`;
    return [
      signature,
      ...header,
      `  let pc = ${definition === null ? "at" : start};`,
      `  if (resume !== null) { pc = resume.pc; [${savedList}] = resume.v; }`,
      // One list of the saved variables per region, not one per wait: it was most of a large program's text.
      `  const SAVE = (at) => rt.frames.push({ fn: "${fnName}", file: ${fileIndex}, pc: at, v: [${savedList}] });`,
      "  D: for (;;) switch (pc) {",
      ...out,
      definition === null ? "  default: throw new Error(`study: no resume point ${pc}`);" : "  return null;",
      "  }",
      "}",
    ].join("\n");
  }
}
