import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { configurations, validatePlan } from "./plan.mjs";
import { writeJson, hash } from "./json.mjs";
import { summarize, STATUSES } from "./status.mjs";
import { ProcessClient } from "./process-client.mjs";
import { verifyBuild } from "./build.mjs";
import { RULES, ruleControl, ruleHolds } from "./rules.mjs";

/** Each rule's control on this tree (`rules.mjs`), judged under its rule, with whether it shows the rule. */
async function controls(client, rules, remainingMs) {
  const result = [];
  for (const rule of rules) {
    const config = ruleControl(rule),
      row = await client.run(config, remainingMs);
    result.push({
      rule,
      holds: ruleHolds(rule, row),
      caseId: config.case.id,
      mode: config.mode.id,
      policy: config.policy,
      status: row.status,
      relation: row.scope?.relation ?? null,
      phase: row.scope?.phase ?? null,
      plannedType: row.plannedType ?? null,
    });
  }
  return result;
}

export async function runCampaign(plan, build, out, options = {}) {
  const commandStarted = performance.now();
  validatePlan(plan);
  const provenance = verifyBuild(build, options.allowRuntimeMismatch);
  const preflightMs = performance.now() - commandStarted;
  const configs = configurations(plan, options.shard),
    budget = options.deadlineMs ?? plan.deadlineMs,
    rules = plan.rules ?? [];
  const started = performance.now();
  const client = new ProcessClient(build, { timeoutMs: options.caseTimeoutMs ?? 15000 });
  mkdirSync(out, { recursive: false });
  writeJson(join(out, "plan.json"), plan);
  const jsonl = join(out, "results.jsonl"),
    rows = [];
  let cancelled = false,
    failures = 0,
    firstFailureMs = null;
  const interrupt = () => {
    cancelled = true;
    client.cancel();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let checked;
  try {
    checked = await controls(client, rules, budget);
    const metadata = {
      schemaVersion: 1,
      kind: "campaign",
      family: plan.family,
      planHash: plan.planHash,
      profile: plan.profile,
      seed: plan.seed,
      rules,
      controls: checked,
      provenance,
      shard: options.shard ?? { index: 0, total: 1 },
      expected: configs.length,
      coverage: plan.coverage,
      startedAt: new Date().toISOString(),
      runnerPolicy: {
        workers: 1,
        deadlineMs: budget,
        caseTimeoutMs: options.caseTimeoutMs ?? 15000,
        hardRssCap: "external scheduler only",
      },
    };
    writeJson(join(out, "metadata.json"), metadata);
    // (no row is judged by a rule this tree's compiler does not hold: the campaign stops before its first row)
    const failed = checked.find((x) => !x.holds);
    if (failed)
      throw new Error(
        `The plan names rule ${failed.rule}, ${RULES[failed.rule].title}, but its control on this tree (${provenance.commit ?? `tree ${provenance.tree}`}) does not show it: ${failed.caseId} (${failed.mode}, ${JSON.stringify(failed.policy)}) is ${failed.status}, its store ${failed.relation ?? "unjudged"} its stop (${failed.phase ?? "no phase"}), checked as ${failed.plannedType ?? "nothing"}. Plan without --rules ${failed.rule} for this tree.`,
      );
    writeFileSync(jsonl, "");
    for (const config of configs) {
      const remaining = budget - (performance.now() - started);
      let row;
      if (cancelled || remaining <= 0 || failures >= (options.stopAfterFailures ?? Infinity))
        row = client.errorRow(
          config,
          "NOT_RUN",
          cancelled
            ? "campaign-cancelled"
            : remaining <= 0
              ? "campaign-budget-exhausted"
              : "fail-fast-limit",
        );
      else row = await client.run(config, remaining);
      if (
        !STATUSES.includes(row.status) ||
        !Number.isInteger(row.executions) ||
        row.executions < 0 ||
        !Number.isInteger(row.assertions) ||
        row.assertions < 0 ||
        row.id !== config.id ||
        row.caseId !== config.case.id ||
        row.sourceHash !== config.case.sourceHash ||
        row.mode !== config.mode.id ||
        hash(row.policy) !== hash(config.policy)
      )
        row = client.errorRow(config, "ERROR", "Malformed worker result");
      if (row.status === "FAIL" && failures++ === 0) firstFailureMs = performance.now() - started;
      rows.push(row);
      appendFileSync(jsonl, `${JSON.stringify({ schemaVersion: 1, ...row })}\n`);
    }
  } finally {
    client.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  const summary = {
    schemaVersion: 1,
    ...summarize(rows, configs.length),
    planHash: plan.planHash,
    rules,
    controls: checked,
    buildCommit: provenance.commit,
    elapsedMs: performance.now() - started,
    preflightMs,
    commandWallMs: performance.now() - commandStarted,
    firstFailureId: rows.find((r) => r.status === "FAIL")?.id ?? null,
    firstFailureMs,
    adapterStartupsMs: client.startups,
    provenance,
    resultsHash: hash(rows),
    scopeNote:
      "PASS rows are scoped properties, never whole-compiler approval. OUT_OF_SCOPE and UNSUPPORTED are incomplete coverage.",
  };
  writeJson(join(out, "summary.json"), summary);
  writeFileSync(
    join(out, "summary.md"),
    `# ${plan.family}: ${summary.verdict}\n\nBuild: ${provenance.commit}\nRules: ${rules.join(", ") || "none"}\nNode: ${provenance.executionNode} (required ${provenance.requiredNode})\n\n${Object.entries(
      summary.counts,
    )
      .map(([k, v]) => `${k}: ${v}`)
      .join(
        "\n",
      )}\n\nRuntime executions: ${summary.actualRuntimeExecutions}\nAssertions: ${summary.assertions}\nElapsed ms: ${summary.elapsedMs.toFixed(1)}\n\n${summary.scopeNote}\n`,
  );
  return summary;
}
