import { smaller } from "../families/s8-stores.mjs";
import { observe } from "../adapters/compiler.mjs";
import { hash, requireInteger } from "./json.mjs";

const priorities = [
  "forbidden-input-rejected",
  "fitting-input-accepted",
  "complete-planned-type",
  "owned-stop-warning",
  "fault-site",
  "effect-prefix",
];
export function failureIdentity(result) {
  if (result.status !== "FAIL") return null;
  const property = priorities.find((p) =>
    result.failures.some((f) => f.property === p),
  );
  return property
    ? `${property}:${result.scope.relation}:${result.scope.phase}`
    : null;
}
/** Bounded semantic reduction, not a claim of a globally minimal program. */
export function shrink(api, config, { seed = 1442, maxAttempts = 12 } = {}) {
  requireInteger(maxAttempts, "maxAttempts", 1, 1000);
  const original = observe(api, config),
    identity = failureIdentity(original);
  if (!identity)
    throw new Error(
      "Shrinking requires a reproducible scoped FAIL, never ERROR/UNSUPPORTED",
    );
  let best = config,
    attempts = 0;
  const trace = [];
  const seen = new Set([config.case.id]);
  while (attempts < maxAttempts) {
    let reduced = false;
    for (const c of smaller(best.case, seed)) {
      if (seen.has(c.id) || attempts >= maxAttempts) continue;
      seen.add(c.id);
      attempts++;
      const candidate = {
        ...best,
        id: hash({ case: c.id, mode: best.mode, policy: best.policy }).slice(
          0,
          24,
        ),
        case: c,
      };
      const result = observe(api, candidate),
        kept = failureIdentity(result) === identity;
      trace.push({
        caseId: c.id,
        sourceLength: c.source.length,
        status: result.status,
        identity: failureIdentity(result),
        kept,
      });
      if (kept) {
        best = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) break;
  }
  const final = observe(api, best);
  if (failureIdentity(final) !== identity)
    throw new Error("Shrink result failed final reproduction");
  return {
    schemaVersion: 1,
    identity,
    attempts,
    trace,
    originalSource: config.case.source,
    source: best.case.source,
    configuration: best,
    final,
    limitation:
      "Local semantic reductions only; no arbitrary deletion, no global minimality claim.",
  };
}
