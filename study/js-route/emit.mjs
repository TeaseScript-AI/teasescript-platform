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

/** Instruction kinds today's engine may leave waiting (an action with the host), besides a paced `say`. */
const WAITING_KINDS = new Set(["wait", "interaction", "capture", "fileStore", "lock", "storageWrite", "playMedia", "showImage"]);

/**
 * `resumable`: part C's way (2): every region that can reach a wait becomes resumable (a switch over its instructions,
 * its variables saved as plain data at a wait); everything else stays structured. Without it, a wait asks the session
 * (`rt.waited`), which way (1), replaying from the start, answers.
 */
export function emitProgram(plan, { resumable = false, runawayCheck = false, generators = false } = {}) {
  if (resumable && generators) throw new Error("study emitter: resumable or generators, not both");
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
    if (definition.handler !== null && resumable) throw new Unsupported(`a ${definition.handler} block (resumable form)`);
    if (definition.selfHandle !== null) throw new Unsupported("a media block with its own handle");
  }
  // Which instructions can wait, and which functions can: those that reach such an instruction or call one that can.
  const waitsHere = (ins) =>
    (ins.kind === "say" && ins.pacing !== "instant") || WAITING_KINDS.has(ins.kind);
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
  plan.files.forEach((file, index) => {
    if (file.labels.length > 0) throw new Unsupported("labels");
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
    if (vars.length > 0) lines.push(`let ${vars.join(", ")};`);
    lines.push(...functions, root);
    // The session starts at file 0's start (its speakers' and globals' start values); a goto enters a file at its entry.
    lines.push(`function${generators ? "*" : ""} enter${index}(resume, fromEntry) { rt.file = ${index};${vars.length > 0 ? ` if (resume === null) ${vars.join(" = ")} = undefined;` : ""} ${generators ? "yield* " : ""}file${index}(resume, fromEntry); }`);
    fileEntries.push(file.entryInstruction);
  });
  if (plan.functions.some((definition) => definition.handler === null && !emittedFunctions.has(definition.id)))
    throw new Unsupported("a function outside every file's functions");
  lines.push(`const FILES = [${plan.files.map((_, i) => `enter${i}`).join(", ")}];`);
  lines.push(
    `function${generators ? "*" : ""} main() {`,
    "  let file = rt.resuming ? rt.resumeFrames[0].file : 0;",
    "  let entered = false;",
    "  for (;;) {",
    `    try { ${generators ? "yield* " : ""}FILES[file](rt.resuming ? rt.resumeFrame() : null, entered); return; }`,
    "    catch (signal) { if (signal instanceof rt.Goto) { file = signal.file; entered = true; continue; } throw signal; }",
    "  }",
    "}",
    "return main;",
  );
  return { source: lines.join("\n"), constants: K, globals, fileEntries, canWait: [...canWait] };

  function emitRegion(start, end, definition, parameters, rootScope, fileIndex) {
    const out = [];
    const temps = new Set();
    let scratch = 0;
    const x = () => `x${scratch++}`;
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
      return `t${id}`;
    };
    const own = (e) => {
      const code = expr(e);
      if (isFresh(e)) return code;
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
          return `(${left}, ${b} = ${expr(e.right)}, typeof ${a} === "number" && typeof ${b} === "number" && (${r} = ${a} ${op} ${b}, ${r} - ${r} === 0) ? ${r} : ${checked}(${k}, ${a}, ${b}))`;
        }
        case "<":
        case "<=":
        case ">":
        case ">=":
          return `(${left}, ${b} = ${expr(e.right)}, typeof ${a} === "number" && typeof ${b} === "number" ? ${a} ${op} ${b} : ${checked}(${k}, ${a}, ${b}))`;
        case "==":
        case "!=": {
          const same = `((typeof ${a} !== "object" || ${a} === null) && (typeof ${b} !== "object" || ${b} === null) ? ${a} === ${b} : rt.eq(${a}, ${b}))`;
          return `(${left}, ${b} = ${expr(e.right)}, ${op === "==" ? same : `!${same}`})`;
        }
        case "and":
          return `(${left} === true ? (${b} = ${expr(e.right)}, typeof ${b} === "boolean" ? ${b} : ${checked}(${k}, ${a}, ${b})) : ${a} === false ? false : rt.throwIt(rt.notLogical(${k}, ${a})))`;
        case "or":
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
          return `rt.randRange(${konst(e)}, ${JSON.stringify(name)}, ${own(e.arguments[0].value)})`;
      }
      const receiver = callee.kind === "property" ? expr(callee.object) : "null";
      const args = [];
      e.arguments.forEach((argument, index) => {
        if (index !== lazy) args.push(own(argument.value));
      });
      // Without a lazy default, today's evaluator can run a call the native operations do not have.
      let synthetic = "null";
      if (lazy === -1) {
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
      return { code: js, fresh: true };
    }

    function openLoops() {
      let n = 0;
      for (const _ of loops) n += 1;
      return n;
    }

    /** The variables a resumable region saves at a wait: its own, its parameters, its file's for a root, temporaries. */
    function saved() {
      return [...params, ...hoisted, ...(isRoot ? [...rootScope.values()] : []), ...[...temps].map((id) => `t${id}`)];
    }
    function suspendHere(resumeAt) {
      return `{ pc = ${resumeAt}; rt.frames.push({ fn: "${fnName}", file: ${fileIndex}, pc: ${resumeAt}, v: [${"%SAVED%"}] }); throw rt.SUSPEND; }`;
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
        if (flat) line(`case ${pc}:`);
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
              line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
              line(`if (!${c}) { pc = ${ins.target}; continue D; }`);
              pc += 1;
              continue;
            }
            structured(() => {
              const c = x();
              line(`${c} = ${expr(ins.condition)};`);
              line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
              line(`if (${c}) {`);
              indent += 1;
              emitRange(pc + 1, shape.thenEnd);
              indent -= 1;
              if (shape.elseEnd !== null) {
                line("} else {");
                indent += 1;
                emitRange(shape.target, shape.elseEnd);
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
            } else line(`${ins.action === "break" ? "break" : "continue"} ${loop.label};`);
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

    function structuredLoop(ins, pc, endLoop) {
      const label = `L${ins.loopId}`;
      loops.set(ins.loopId, { label, flat: false });
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
        line(`if (${c} !== true) { if (${c} === false) break; throw rt.notBool(${konst(ins.expression)}, ${c}); }`);
        scopes.push(new Map());
      } else if (ins.loopKind === "for" && ins.expression.kind === "range" && ins.valueVariable === undefined) {
        // A range written in the loop: its whole-number bounds inline; anything else faults through today's checks.
        const e = ins.expression;
        const a = x();
        const b = x();
        line(`${a} = ${expr(e.start)}; ${b} = ${expr(e.end)};`);
        line(`if (!(Number.isSafeInteger(${a}) && Number.isSafeInteger(${b}) && Number.isSafeInteger(${b} - ${a}))) rt.forSource(${konst(ins)}, rt.range(${konst(e)}, ${a}, ${b}));`);
        const i = `i${pc}`;
        line(`${label}: for (let ${i} = 0, n${pc} = Math.max(0, ${b} - ${a}${e.inclusive ? " + 1" : ""}); ${i} < n${pc}; ${i}++) {`);
        indent += 1;
        if (tick) line(tick);
        scopes.push(new Map());
        const v = declare(ins.variable);
        line(`let ${v.code} = ${a} + ${i};`);
      } else if (ins.loopKind === "for") {
        const s = x();
        line(`${s} = rt.forSource(${konst(ins)}, ${expr(ins.expression)});`);
        const i = `i${pc}`;
        line(`${label}: for (let ${i} = 0, a${pc} = ${s}.start, n${pc} = ${s}.length, it${pc} = ${s}.items, vs${pc} = ${s}.values; ${i} < n${pc}; ${i}++) {`);
        indent += 1;
        if (tick) line(tick);
        scopes.push(new Map());
        const v = declare(ins.variable);
        line(`let ${v.code} = it${pc} === null ? a${pc} + ${i} : it${pc}[${i}];`);
        if (ins.valueVariable !== undefined) {
          const w = declare(ins.valueVariable);
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
      emitRange(pc + 1, endLoop);
      scopes.pop();
      loops.delete(ins.loopId);
      indent -= 1;
      line("}");
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
    function blockClosures(ins) {
      const ids = [ins.handlerFunctionId, ins.finishFunctionId, ...(ins.cues ?? []).map((cue) => cue.functionId)].filter((id) => typeof id === "number");
      if (ids.length === 0) return ins;
      const visible = new Map(rootScope);
      for (const scope of scopes) for (const [name, js] of scope) visible.set(name, js);
      for (const id of ids) {
        const block = plan.functions[id - 1];
        line(`rt.blocks.set(${id}, ${emitRegion(block.entryInstruction, block.endInstruction, block, [], visible, fileIndex)});`);
      }
      // The closures share the variables; today's engine records none (its scopes do not hold them).
      return { ...ins, captures: [] };
    }

    function statement(ins, pc) {
      switch (ins.kind) {
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
          if (root.kind !== "identifier")
            throw new Unsupported("a prepared reference that is not a place inside a variable");
          const placeLabel = label ? JSON.stringify([root.name, ...steps].join(".")) : "null";
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
          line(`} catch (signal) { if (signal === rt.SUSPEND) rt.frames.push({ fn: "${fnName}", file: ${fileIndex}, pc: ${pc}, v: [%SAVED%] }); throw signal; }`);
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
          line(`return ${typeChecked(own(ins.value), ins.typeCheck, ins.value.span)};`);
          return;
        case "returnVoid":
          line("return null;");
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
            line(`if (${said}) ${suspendHere(1e6 + pc)}`);
            line(`case ${1e6 + pc}:`);
          } else line(`if (${said}) ${WAIT};`);
          return;
        }
        case "exit":
          line(`rt.exit(${konst(ins.span)}, ${pc});`);
          return;
        case "end":
          line(`rt.end(${konst(ins.span)});`);
          return;
        case "goto":
          throw new Unsupported("goto a label");
        case "transfer":
          if (ins.mode !== undefined && ins.mode !== "goto") throw new Unsupported(`a file ${ins.mode}`);
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
        line(`if (${call}) ${suspendHere(1e6 + pc)}`);
        line(`case ${1e6 + pc}:`);
      } else line(`if (${call}) ${WAIT};`);
      for (const id of writes) line(`${temp(id)} = rt.takeTemporary(${id});`);
    }

    const entry = isRoot ? plan.files[fileIndex].entryInstruction : start;
    if (isRoot && entry !== start && !flatRegion) {
      line("if (!fromEntry) {");
      indent += 1;
      emitRange(start, entry);
      indent -= 1;
      line("}");
      emitRange(entry, end);
    } else emitRange(start, end);
    const header = [];
    const locals = [...[...temps].map((id) => `t${id}`), ...Array.from({ length: scratch }, (_, i) => `x${i}`), ...hoisted];
    if (locals.length > 0) header.push(`  let ${locals.join(", ")};`);
    if (!flatRegion) {
      if (definition === null) return [`function${generators ? "*" : ""} file${fileIndex}(resume, fromEntry) {`, ...header, ...out, "}"].join("\n");
      return [`function${star(definition.id)} f${definition.id}(${params.join(", ")}) {`, ...header, ...(tick ? [`  ${tick}`] : []), ...out, "  return null;", "}"].join("\n");
    }
    // A resumable region: its argument evaluation before a call that waits runs only on a fresh entry of that call.
    const savedList = saved().join(", ");
    const body = out.map((text) => text.replaceAll("%SAVED%", savedList));
    const signature = definition === null ? `function file${fileIndex}(resume, fromEntry) {` : `function f${definition.id}(resume${params.map((p) => `, ${p}`).join("")}) {`;
    return [
      signature,
      ...header,
      `  let pc = ${definition === null ? `fromEntry ? ${entry} : ${start}` : start};`,
      `  if (resume !== null) { pc = resume.pc; [${savedList}] = resume.v; }`,
      "  D: for (;;) switch (pc) {",
      ...body,
      definition === null ? "  default: throw new Error(`study: no resume point ${pc}`);" : "  return null;",
      "  }",
      "}",
    ].join("\n");
  }
}
