// The prototype emitter of the JavaScript-route study (research code, never merged; nothing in src/ imports it).
// It turns an instruction plan into the source of one JavaScript function body that builds the program: a script's
// variables become JavaScript variables, its loops and branches JavaScript's, its functions functions. It rebuilds that
// structure from the plan's jumps, which lowering emits in a few fixed shapes; a shape it does not know is refused
// (`Unsupported`), never guessed. Values are the native values of #2684; everything but the fast cases calls the
// runtime library (`runtime.mjs`), which calls today's helpers, so faults and messages stay today's.

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

export function emitProgram(plan) {
  if (plan.files.length !== 1) throw new Unsupported("a plan of more than one file");
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
    if (definition.handler !== null || definition.global || definition.selfHandle !== null)
      throw new Unsupported("a block, a global function or a function with a handle");
    if (definition.parameters.some((parameter) => parameter.hasDefault))
      throw new Unsupported("a default parameter");
  }
  const firstFunction = Math.min(plan.instructions.length, ...plan.functions.map((f) => f.entryInstruction));
  const functionEnds = plan.functions.map((f) => [f.entryInstruction, f.endInstruction]).sort((a, b) => a[0] - b[0]);
  let covered = firstFunction;
  for (const [start, end] of functionEnds) {
    if (start !== covered) throw new Unsupported("a root region that is not one range before the functions");
    covered = end;
  }
  if (covered !== plan.instructions.length) throw new Unsupported("instructions after the last function");

  // The root's first scope: module-level variables that every function sees.
  const rootScope = new Map();
  const root = emitRegion(0, firstFunction, null, []);
  const functions = plan.functions.map((definition) =>
    emitRegion(definition.entryInstruction, definition.endInstruction, definition, definition.parameters),
  );
  const lines = ['"use strict";', "const G = rt.globals;"];
  if (rootScope.size > 0) lines.push(`let ${[...rootScope.values()].join(", ")};`);
  for (const f of functions) lines.push(f);
  lines.push(root, "return main;");
  return { source: lines.join("\n"), constants: K, globals };

  function emitRegion(start, end, definition, parameters) {
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
          return `rt.prop(${object}, ${JSON.stringify(e.name)}, ${konst(e.span)})`;
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
        default:
          throw new Unsupported(`the expression kind '${e.kind}'`);
      }
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
      const positional = [];
      const named = [];
      e.arguments.forEach((argument, index) => {
        if (index === lazy) return;
        if (argument.kind === "positional") positional.push(own(argument.value));
        else named.push(`${JSON.stringify(argument.name)}: ${own(argument.value)}`);
      });
      // Arguments run in written order: a named one before a positional one keeps its place.
      const order = e.arguments.every((a, i) => i === lazy || a.kind === "positional" || e.arguments.slice(i + 1).every((b, j) => i + 1 + j === lazy || b.kind !== "positional"));
      if (!order) throw new Unsupported("a call with a named argument before a positional one");
      const r = x();
      const recv = x();
      const head = `(${recv} = ${receiver}, ${r} = rt.call(${konst(e)}, ${recv}, [${positional.join(", ")}], {${named.join(", ")}}, ${lazy !== -1}))`;
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

    function emitRange(pc, endAt) {
      while (pc < endAt) {
        const ins = plan.instructions[pc];
        switch (ins.kind) {
          case "jumpIfFalse": {
            const target = ins.target;
            if (target <= pc || target > endAt) throw new Unsupported(`a jump at ${pc} out of its region`);
            const last = plan.instructions[target - 1];
            let thenEnd = target;
            let elseEnd = null;
            if (last.kind === "jump" && last.target > target && last.target <= endAt) {
              thenEnd = target - 1;
              elseEnd = last.target;
            }
            const c = x();
            line(`${c} = ${expr(ins.condition)};`);
            line(`if (${c} !== true && ${c} !== false) throw rt.notBool(${konst(ins.condition)}, ${c});`);
            line(`if (${c}) {`);
            indent += 1;
            emitRange(pc + 1, thenEnd);
            indent -= 1;
            if (elseEnd !== null) {
              line("} else {");
              indent += 1;
              emitRange(target, elseEnd);
              indent -= 1;
            }
            line("}");
            pc = elseEnd ?? target;
            continue;
          }
          case "loopStart": {
            const endLoop = ins.target;
            if (endLoop <= pc || endLoop > endAt) throw new Unsupported("a loop that ends outside its region");
            const label = `L${ins.loopId}`;
            loops.set(ins.loopId, label);
            if (ins.loopKind === "while") {
              line(`${label}: while (true) {`);
              indent += 1;
              const c = x();
              line(`${c} = ${expr(ins.expression)};`);
              line(`if (${c} !== true) { if (${c} === false) break; throw rt.notBool(${konst(ins.expression)}, ${c}); }`);
              scopes.push(new Map());
            } else if (ins.loopKind === "for") {
              if (ins.valueVariable !== undefined) throw new Unsupported("a 'for' loop with a value variable");
              const s = x();
              const n = x();
              line(`${s} = ${expr(ins.expression)};`);
              line(`${n} = rt.forRange(${konst(ins)}, ${s});`);
              const i = `i${ins.loopId}_${pc}`;
              line(`${label}: for (let ${i} = 0, a${pc} = ${s}.start, n${pc} = ${n}; ${i} < n${pc}; ${i}++) {`);
              indent += 1;
              scopes.push(new Map());
              const v = declare(ins.variable);
              line(`let ${v.code} = a${pc} + ${i};`);
            } else throw new Unsupported(`a '${ins.loopKind}' loop`);
            emitRange(pc + 1, endLoop);
            scopes.pop();
            loops.delete(ins.loopId);
            indent -= 1;
            line("}");
            pc = endLoop;
            continue;
          }
          case "loopControl": {
            const label = loops.get(ins.loopId);
            if (label === undefined) throw new Unsupported("a break or continue outside its loop");
            line(`${ins.action === "break" ? "break" : "continue"} ${label};`);
            pc += 1;
            continue;
          }
          case "jump":
            throw new Unsupported(`a jump at ${pc} that is no else`);
          default:
            statement(ins, pc);
            pc += 1;
        }
      }
    }

    function statement(ins, pc) {
      switch (ins.kind) {
        case "declareSpeaker":
          line(`rt.declareSpeaker(${konst(ins)}, ${globalIndex(ins.name)});`);
          return;
        case "setDefaultSpeaker":
          line(`rt.setDefaultSpeaker(${JSON.stringify(ins.name)}, ${rawRead(ins.name)}, ${konst(ins.span)});`);
          return;
        case "enterScope":
          line("{");
          indent += 1;
          scopes.push(new Map());
          return;
        case "leaveScope":
          if (scopes.length === 1) throw new Unsupported("a scope left at the region's first scope");
          scopes.pop();
          indent -= 1;
          line("}");
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
          if (root.kind !== "identifier" || ins.expression.kind === "identifier")
            throw new Unsupported("a prepared reference that is not a place inside a variable");
          const placeLabel = label ? JSON.stringify([root.name, ...steps].join(".")) : "null";
          line(`${temp(ins.destinationTemporary)} = ${expr(ins.expression)}; rt.referenceLabels[${ins.destinationTemporary}] = ${placeLabel};`);
          return;
        }
        case "evaluate":
          line(`${expr(ins.expression)};`);
          return;
        case "storeTemporary": {
          if (ins.defaultTemporary !== undefined || ins.defaultOf !== undefined || ins.repair !== undefined)
            throw new Unsupported("a temporary that holds a default");
          let value = own(ins.value);
          if (ins.typeCheck !== undefined) value = typeChecked(value, ins.typeCheck, ins.value.span);
          if (ins.fallbackCheck !== undefined) value = `rt.fallbackCheck(${value}, ${konst(ins.fallbackCheck)}, ${konst(ins.value.span)})`;
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
          if (slots.includes(-1) || new Set(slots).size !== definition.parameters.length)
            throw new Unsupported("a call that does not supply every parameter");
          const args = ins.arguments.map((a) => {
            const v = x();
            line(`${v} = ${own(a.value)};`);
            return v;
          });
          ins.arguments.forEach((a, index) => {
            if (a.typeCheck !== undefined) line(`rt.typeCheck(${args[index]}, ${konst(a.typeCheck)}, ${konst(a.value.span)});`);
          });
          const ordered = definition.parameters.map((_, slot) => args[slots.indexOf(slot)]);
          line(`rt.enter(${konst(ins.span)}); ${temp(ins.destinationTemporary)} = f${ins.functionId}(${ordered.join(", ")}); rt.depth -= 1;`);
          return;
        }
        case "bindSuppliedParameter":
        case "beginFunctionDefaults":
        case "enterFunctionBody":
          return;
        case "prepareParameterDefault":
          if (ins.target !== pc + 1) throw new Unsupported("a parameter default");
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
          if (ins.textTemporary !== undefined || ins.destinationTemporary !== undefined)
            throw new Unsupported("a say with prepared text or a result");
          const parts = [
            `speakerValue: ${ins.speaker === null || ins.speakerTemporary !== undefined ? "undefined" : rawRead(ins.speaker)}`,
            `prepared: ${ins.speakerTemporary === undefined ? "undefined" : temp(ins.speakerTemporary)}`,
            `presentation: ${ins.presentation === null ? "undefined" : expr(ins.presentation)}`,
            `value: ${expr(ins.value)}`,
            `pacing: ${typeof ins.pacing === "object" ? expr(ins.pacing) : "undefined"}`,
          ];
          // The gate records where the say stands; inside a function this prototype knows only its own region's part.
          const place = `{ pc: ${pc}, ownerCallFrameId: null, scopeDepth: ${scopes.length}, loopDepth: ${openLoops()} }`;
          line(`if (rt.say(${konst(ins)}, () => ({ ${parts.join(", ")} }), ${place})) rt.waited();`);
          return;
        }
        case "exit":
          line(`rt.exit(${konst(ins.span)}, ${pc});`);
          return;
        case "end":
          line(`rt.end(${konst(ins.span)});`);
          return;
        default:
          throw new Unsupported(`the instruction '${ins.kind}'`);
      }
    }

    emitRange(start, end);
    const header = [];
    const locals = [...[...temps].map((id) => `t${id}`), ...Array.from({ length: scratch }, (_, i) => `x${i}`)];
    if (locals.length > 0) header.push(`  let ${locals.join(", ")};`);
    if (definition === null) return [`function main() {`, ...header, ...out, "}"].join("\n");
    return [`function f${definition.id}(${params.join(", ")}) {`, ...header, ...out, "  return null;", "}"].join("\n");
  }
}
