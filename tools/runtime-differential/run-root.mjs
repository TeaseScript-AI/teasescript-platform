// One root's runner for the cross-process differential (docs/TESTING.md "Differential harness"), started by
// `tests/helpers/runtime-differential-remote.ts`:
//   node tools/runtime-differential/run-root.mjs REQUESTS REPLIES --root DIR --files FILE [--replace REL=FILE ...]
// It opens its two named pipes as its first statement, so that the launcher's opens return as soon as it has started
// and any later failure is a closed pipe, the side's harness failure. Then it loads the driver's engine-free side module
// from this checkout, installs 0a's guard (`tools/runtime-oracle/admission.mjs`), loads the root's own build through
// it, and answers one request line at a time with one reply line: a value, a classified side failure, or the driver's
// stop. `--replace` (tests only) loads FILE in place of the root's REL, as 0a's runner does.

import fs from "node:fs";

const requests = fs.openSync(process.argv[2], "r");
const replies = fs.openSync(process.argv[3], "w");

const { registerHooks } = await import("node:module");
const path = await import("node:path");
const { pathToFileURL } = await import("node:url");
const helpers = new URL("../../dist/tests/helpers/", import.meta.url);
const side = await import(new URL("runtime/runtime-differential-side.js", helpers).href);
const comparison = await import(new URL("runtime-state-comparison.js", helpers).href);
const { admitsUrl, inventory } = await import("../runtime-oracle/admission.mjs");
const { builtPath } = await import("../runtime-oracle/closure.mjs");

const options = { root: null, files: null, replace: new Map() };
for (let index = 4; index < process.argv.length; index += 2) {
  const [name, value] = [process.argv[index], process.argv[index + 1]];
  if (name === "--root") options.root = path.resolve(value);
  else if (name === "--files") options.files = value;
  else if (name === "--replace") {
    const [relative, file] = value.split("=");
    options.replace.set(relative, path.resolve(file));
  } else throw new Error(`unknown argument ${name}`);
}
if (options.root === null || options.files === null)
  throw new Error("--root and --files are required");

// 0a's guard: the root loads only Node built-ins, its own certified files and its locked packages.
const admitted = inventory(options.root, JSON.parse(fs.readFileSync(options.files, "utf8")));
const replacements = new Map(
  [...options.replace].map(([relative, file]) => [
    pathToFileURL(fs.realpathSync(path.join(options.root, relative))).href,
    pathToFileURL(file).href,
  ]),
);
const replacing = new Set(replacements.values());
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = replacements.get(resolved.url) ?? resolved.url;
    if (!replacing.has(url) && !admitsUrl(admitted, url))
      throw new Error(
        `runtime differential: '${specifier}' resolves outside the root's inventory (${url})`,
      );
    return { ...resolved, url };
  },
});
const load = (source) => import(pathToFileURL(path.join(options.root, builtPath(source))).href);
const index = await load("src/index.ts");
const compiler = await load("src/compiler.ts");
const backend = await load("src/type-inference/core/backend.ts");
const adapter = side.buildAdapter(options.root, { index, compiler, backend });

// A line's bytes are decoded only once it is complete, so a character split between reads stays whole.
let buffer = Buffer.alloc(0);
const chunk = Buffer.alloc(1 << 16);
function readLine() {
  const parts = [buffer];
  let length = buffer.length;
  let at = buffer.indexOf(0x0a);
  while (at < 0) {
    const read = fs.readSync(requests, chunk, 0, chunk.length, null);
    if (read === 0) return null;
    const found = chunk.subarray(0, read).indexOf(0x0a);
    if (found >= 0) at = length + found;
    parts.push(Buffer.from(chunk.subarray(0, read)));
    length += read;
  }
  const bytes = Buffer.concat(parts, length);
  buffer = bytes.subarray(at + 1);
  return bytes.toString("utf8", 0, at);
}

/** The value of a recipe (`tests/helpers/runtime-differential-remote.ts` `Recipe`), built here, in the root's process. */
function build(recipe) {
  const depth = recipe.depth ?? 1;
  if (recipe.builder.endsWith("At") && !(Number.isSafeInteger(depth) && depth >= 1))
    throw new Error(`${recipe.builder} needs a depth of at least 1`);
  const innermost = (value) => {
    let at = value;
    while (at.items?.[0]?.kind === "list") at = at.items[0];
    return at;
  };
  switch (recipe.builder) {
    case "deepList":
      return comparison.deepList(depth);
    case "deepSetChain":
      return comparison.deepSetChain(depth);
    case "wideSet":
      return comparison.wideSet(recipe.width ?? 3, recipe.duplicateAt);
    case "mixedNest":
      return comparison.mixedNest(depth);
    case "accessorAt": {
      const value = comparison.deepList(depth);
      Object.defineProperty(innermost(value).items, 0, { enumerable: true, get: () => 0 });
      return value;
    }
    case "cycleAt": {
      const value = comparison.deepList(depth);
      innermost(value).items[0] = value;
      return value;
    }
    case "holeAt": {
      const value = comparison.deepList(depth);
      innermost(value).items = new Array(2);
      return value;
    }
    case "prototypeAt": {
      const value = comparison.deepList(depth);
      const node = innermost(value);
      node.items[0] = Object.assign(Object.create({ inherited: true }), {
        kind: "list",
        items: [0],
      });
      return value;
    }
    case "nonFiniteAt": {
      const value = comparison.deepList(depth);
      innermost(value).items[0] = Number.NaN;
      return value;
    }
    case "plain":
      // JSON data only, parsed here; what JSON cannot carry has its own builder above.
      if (typeof recipe.text !== "string") throw new Error("plain needs a text");
      return JSON.parse(recipe.text);
    default:
      throw new Error(`unknown recipe builder ${recipe.builder}`);
  }
}

const planOf = (source, globals = []) => {
  const compiled = index.compileSource(source, { globals });
  if (compiled.plan === null) throw new Error(`the admission source does not compile: ${source}`);
  return compiled.plan;
};
const bindingIn = (snapshot, name) =>
  snapshot.frames.flatMap((frame) => frame.bindings).find((binding) => binding.name === name);

/**
 * Admits `recipe`'s value through `route`: what the root's public API accepted, or the error its admitting call threw.
 * Only that call is inside the catch: the envelope's preparation and its reading of the admitted value are the
 * harness's, and their failures escape, which ends this runner and is the caller's harness failure, never a rejection.
 */
function admit(recipe, route) {
  const value = build(recipe);
  let call;
  let read;
  if (route === "global") {
    const plan = planOf("let copy = hostValue\nexit\n", ["hostValue"]);
    call = () => index.createFreshRuntimeSession(plan, { seed: 1, globals: { hostValue: value } });
    read = (session) =>
      session.exportTrustedSnapshot().globals.find((binding) => binding.name === "hostValue").value;
  } else if (route === "storage") {
    const plan = planOf("exit\n");
    call = () =>
      index.createFreshRuntimeSession(plan, { seed: 1, scriptStorage: [{ key: "held", value }] });
    read = (session) =>
      session.exportTrustedSnapshot().scriptStorage.find((entry) => entry.key === "held").value;
  } else if (route === "checkpoint") {
    const session = index.createFreshRuntimeSession(planOf("let held = 0\nwait 1 ms\nexit\n"), {
      seed: 1,
    });
    session.run();
    const copy = JSON.parse(comparison.canonicalText(session.exportCheckpoint()));
    bindingIn(copy.snapshot, "held").value = value;
    call = () => index.restoreRuntimeSession(copy);
    read = (restored) => bindingIn(restored.exportTrustedSnapshot(), "held").value;
  } else throw new Error(`unknown admission route ${route}`);
  let admitted;
  try {
    admitted = call();
  } catch (error) {
    return {
      accepted: false,
      error: {
        name: String(error?.name ?? typeof error),
        code: error?.code ?? null,
        path: error?.path ?? null,
        info: error?.info ?? null,
        message: String(error?.message ?? error),
      },
    };
  }
  return { accepted: true, digest: comparison.canonicalDigest(read(admitted)) };
}

let attribution = null;
let port = null;
let sideName = null;
const records = new Set(["opening", "apply"]);

/** Answers one request: the port's value, or its stop or classified failure, as the in-process driver would raise. */
function answer(request) {
  const { op, stage, args } = request;
  if (op === "admit") return { value: admit(args.recipe, args.route) };
  if (op === "begin") {
    sideName = args.side;
    attribution = new side.Attribution();
    attribution.cursor.side = args.side;
    port = new side.LocalPort(attribution, args.side, adapter, {
      input: args.input,
      route: args.route,
      maxSteps: args.maxSteps,
      maxCuts: args.maxCuts,
      host: undefined,
    });
    return { value: null };
  }
  attribution.cursor.stage = stage;
  try {
    let value;
    if (op === "compile") value = port.compile();
    else if (op === "planDigest") value = port.planDigest();
    else if (op === "probe") value = port.probe();
    else if (op === "start") value = port.start() ?? null;
    else if (op === "opening") value = port.opening(args.run);
    else if (op === "next") value = port.next(args.run);
    else if (op === "apply") value = port.apply(args.run);
    else if (op === "capture") value = port.capture(args.state) ?? null;
    else if (op === "restore") value = port.restore(args.tail, args.cut);
    else if (op === "pending") value = port.pending();
    else throw new Error(`unknown runner operation ${op}`);
    if (records.has(op)) {
      const { record } = value;
      const { state, traces } = attribution.op(sideName, "write", () => side.write(record));
      value = { state, traces };
    }
    return { value };
  } catch (error) {
    if (error instanceof side.Stop)
      return { stop: { verdict: error.verdict, outcome: error.outcome } };
    const at =
      error instanceof side.CallbackFailure
        ? error.failure
        : {
            side: attribution.cursor.side,
            stage: attribution.cursor.stage,
            member: attribution.cursor.member,
            error,
          };
    return { failure: { side: at.side, outcome: side.classifiedFailure(at) } };
  }
}

for (;;) {
  const line = readLine();
  if (line === null) break;
  const request = JSON.parse(line);
  fs.writeSync(replies, `${comparison.canonicalText({ seq: request.seq, ...answer(request) })}\n`);
}
