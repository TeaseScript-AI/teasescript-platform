import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { hash } from "../lib/json.mjs";
import { typeSignature, expectedPlanType, fits } from "../lib/model.mjs";

/** Observation adapter only. Expected values/types come from the independent family. */
export async function loadCompiler(root) {
  const load = (p) => import(pathToFileURL(resolve(root, "dist", p)).href);
  const [
    analysis,
    answers,
    compiler,
    backend,
    budget,
    consumers,
    solver,
    sharing,
    program,
    route,
    validation,
  ] = await Promise.all([
    load("tests/helpers/type-core-analysis.js"),
    load("src/type-inference/core/answers.js"),
    load("src/compiler.js"),
    load("src/type-inference/core/backend.js"),
    load("src/type-inference/core/budget.js"),
    load("src/type-inference/core/consumers.js"),
    load("src/type-inference/core/solver.js"),
    load("src/type-inference/core/sharing.js"),
    load("src/type-inference/core/program.js"),
    load("tests/helpers/type-core-route.js"),
    load("src/plan/validation.js"),
  ]);
  const api = {
    ...analysis,
    ...answers,
    ...compiler,
    ...backend,
    ...budget,
    ...consumers,
    ...solver,
    ...sharing,
    ...program,
    ...route,
    ...validation,
  };
  for (const key of [
    "coreRequest",
    "analyseCore",
    "compileSourceWithBackend",
    "withTestDemandAllowance",
    "withTestAllowance",
    "withConsumerOrder",
    "withSolverSeam",
    "withoutSharing",
    "CoreProgram",
    "propertyStep",
    "runGlobals",
    "validateInstructionPlan",
  ])
    if (typeof api[key] !== "function") throw new Error(`Unsupported compiler adapter API: ${key}`);
  return api;
}
export function configured(api, mode, policy, call) {
  let fn = call;
  if (policy.kind !== "none") {
    const inner = fn;
    fn = () =>
      policy.kind === "demand"
        ? api.withTestDemandAllowance(policy.units, inner)
        : api.withTestAllowance(policy.units, inner);
  }
  if (mode.reverseConsumers) {
    const inner = fn;
    fn = () => api.withConsumerOrder((items) => [...items].reverse(), inner);
  }
  if (mode.reverseSolver) {
    const inner = fn;
    fn = () => api.withSolverSeam({ reverseWorklist: true }, inner);
  }
  if (!mode.sharing) {
    const inner = fn;
    fn = () => api.withoutSharing(inner);
  }
  return fn();
}
const prefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);
export function scopeOf(api, request, answer, c) {
  const p = new api.CoreProgram(request);
  const place = p.places.find(
    (x) => x.kind.kind === "binding" && x.kind.name === c.destination.binding,
  );
  if (!place) throw new Error(`Destination missing from compiler graph: ${c.destination.binding}`);
  const path = c.destination.path.map((x) =>
    typeof x === "string" ? x : api.propertyStep(x.property),
  );
  const decisions = answer.budget.decisions.filter((d) => d.place === place.id && d.stopped);
  const stopped = decisions.map((d) => d.path);
  const relation = stopped.some((x) => prefix(x, path))
    ? "at-or-below"
    : stopped.some((x) => prefix(path, x))
      ? "strictly-above"
      : "none";
  const unsettled = answer.budget.exhausted !== null && !answer.budget.settled;
  const reason =
    relation === "at-or-below"
      ? "exact-target-stop-1440"
      : unsettled && !c.destination.written
        ? "unsettled-inherited-domain-1252"
        : null;
  return {
    relation,
    phase: unsettled
      ? "unsettled"
      : decisions.length || answer.budget.exhausted
        ? "settled"
        : "unstopped",
    reason,
    stops: stopped,
    target: [
      place.label,
      ...c.destination.path.map((x) => (typeof x === "string" ? x : x.property)),
    ].join("."),
  };
}
export function storeInstruction(plan, c) {
  return plan.instructions.find(
    (x) =>
      ["assign", "declareBinding"].includes(x.kind) &&
      x.value?.span?.so === c.site.start &&
      x.value?.span?.eo === c.site.end,
  );
}
/** Check observable behavior; diagnostics/plan shape are not allowed to substitute for execution. */
export function judgeRuns(api, plan, c, { full = true } = {}) {
  const failures = [];
  let assertions = 0,
    executions = 0;
  const outcomes = [];
  const check = (ok, property, detail) => {
    assertions++;
    if (!ok) failures.push({ property, detail });
  };
  for (const input of c.inputs) {
    if (input.allowed !== fits(c.type, input.value))
      throw new Error("Generator expected-value inconsistency");
    const globals = { hostValue: structuredClone(input.value) },
      before = hash(globals);
    const r = api.runGlobals(plan, globals);
    executions++;
    const said = r.said.map((x) => x.text);
    check(hash(globals) === before, "input-unchanged", "The caller globals changed");
    if (input.allowed) {
      check(
        r.status === "halted" && r.failure === null,
        "fitting-input-accepted",
        JSON.stringify({ input: input.value, result: r }),
      );
      check(
        JSON.stringify(said) === JSON.stringify(["BEFORE", "AFTER"]),
        "effect-prefix",
        JSON.stringify(said),
      );
    } else if (full) {
      check(
        r.status === "failed" && r.failure !== null,
        "forbidden-input-rejected",
        JSON.stringify({ input: input.value, result: r }),
      );
      check(r.failure === `TSR058@${c.site.start}:${c.site.end}`, "fault-site", String(r.failure));
      check(
        JSON.stringify(said) === JSON.stringify(["BEFORE"]),
        "effect-prefix",
        JSON.stringify(said),
      );
    }
    outcomes.push({ allowed: input.allowed, inputHash: hash(input.value), ...r });
  }
  return { failures, assertions, executions, outcomes };
}
export function observe(api, config, { keepPlan = false } = {}) {
  const started = performance.now(),
    cpu = process.cpuUsage();
  const { case: c, mode, policy } = config;
  const request = api.coreRequest([{ path: "main.tease", source: c.source }], c.globals);
  if (!request) throw new Error(`Generated source does not parse/resolve: ${c.id}`);
  const a0 = performance.now();
  const answer = configured(api, mode, policy, () => api.analyseCore(request));
  const analysisMs = performance.now() - a0;
  const scope = scopeOf(api, request, answer, c);
  const marks = [...answer.diagnostics, ...answer.budget.deferred].filter(
    (d) =>
      d.class === "warning-runtime-check" &&
      d.provenance?.context === "budget" &&
      d.site?.start === c.site.start &&
      d.site?.end === c.site.end &&
      d.obligation?.target === scope.target,
  );
  const publication = {
    outcome: answer.outcome,
    diagnostics: answer.diagnostics,
    checks: answer.checks,
    deferred: answer.budget.deferred,
  };
  const metadata = {
    id: config.id,
    caseId: c.id,
    sourceHash: c.sourceHash,
    mode: mode.id,
    policy,
    scope,
    publicationHash: hash(publication),
    analysisWork: answer.budget.total,
    ownedMarks: marks.length,
  };
  const c0 = performance.now();
  let compiled;
  try {
    compiled = configured(api, mode, policy, () =>
      api.compileSourceWithBackend(c.source, { globals: c.globals }, api.CORE_BACKEND),
    );
  } catch (error) {
    if (error instanceof api.CandidateOutsideSlice)
      return {
        ...metadata,
        status: "UNSUPPORTED",
        reason: error.message,
        assertions: 0,
        executions: 0,
        metrics: {
          analysisMs,
          compileMs: performance.now() - c0,
          totalMs: performance.now() - started,
          workerPeakRssKiB: process.resourceUsage().maxRSS,
        },
      };
    throw error;
  }
  const compileMs = performance.now() - c0;
  const failures = [];
  let assertions = 0;
  const check = (ok, property, detail) => {
    assertions++;
    if (!ok) failures.push({ property, detail });
  };
  check(compiled.plan !== null, "fitting-source-compiles", JSON.stringify(compiled.diagnostics));
  if (!compiled.plan)
    return {
      ...metadata,
      status: "FAIL",
      failures,
      assertions,
      executions: 0,
      metrics: { analysisMs, compileMs, totalMs: performance.now() - started },
    };
  const valid = api.validateInstructionPlan(compiled.plan);
  if (!valid.valid) throw new Error(`Compiler emitted invalid plan: ${JSON.stringify(valid)}`);
  const store = storeInstruction(compiled.plan, c);
  const actualType = typeSignature(store?.typeCheck?.type);
  if (!scope.reason) {
    check(
      actualType === typeSignature(expectedPlanType(c.type)),
      "complete-planned-type",
      `${actualType} != ${typeSignature(expectedPlanType(c.type))}`,
    );
    if (scope.relation === "strictly-above")
      check(
        marks.length === 1,
        "owned-stop-warning",
        `${marks.length} marks at destination ${scope.target}`,
      );
  }
  const r0 = performance.now();
  const observed = judgeRuns(api, compiled.plan, c, { full: scope.reason === null });
  failures.push(...observed.failures);
  assertions += observed.assertions;
  const used = process.cpuUsage(cpu);
  return {
    ...metadata,
    status: failures.length ? "FAIL" : scope.reason ? "OUT_OF_SCOPE" : "PASS",
    reason: scope.reason,
    assertions,
    executions: observed.executions,
    failures,
    plannedType: actualType,
    planHash: hash(compiled.plan),
    outcomes: observed.outcomes,
    metrics: {
      analysisMs,
      compileMs,
      runtimeMs: performance.now() - r0,
      totalMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      workerPeakRssKiB: process.resourceUsage().maxRSS,
    },
    ...(keepPlan ? { plan: compiled.plan } : {}),
    ...(failures.length ? { reproduction: { case: c, mode, policy } } : {}),
  };
}
