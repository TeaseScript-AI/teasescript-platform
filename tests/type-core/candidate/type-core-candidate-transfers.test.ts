// The candidate route's transfers to another file (#2488's step 1c): each project of the row guard's transfer templates
// compiles on the route in the four held modes with today's runs, and its runs are the derived oracle's across files.

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { derive, syntaxOf } from "../../helpers/type-core-derived.js";
import { HELD_MODES } from "../../helpers/type-core-held-host.js";
import {
  derivedStores,
  planOfFile,
  plannedStores,
  recordOfFile,
  runGlobals,
} from "../../helpers/type-core-route.js";
import { evaluateProject } from "../../helpers/type-core/derived-transfers.js";
import { DOMAIN } from "../../helpers/type-core/row-guard-records.js";
import {
  ROW_HOSTS,
  ROW_TEMPLATES,
  type TemplateFile,
} from "../../helpers/type-core/row-templates.js";
import { OPTIONS } from "../../helpers/type-core/type-core-candidate-setup.js";

/**
 * The transfer projects (`ROW_TEMPLATES.gotoStatement`'s lists of files): by a quoted path, by `script("…")`, by
 * `script(hostValue)` over three files, conditionally, by a quoted glob of one file, each with a checked store of the
 * host global in every file; then
 * #2514's file starts, a nullable stored before a transfer of each of the two literal forms and a computed one, with a
 * variable of the same name used in the target.
 */
const PROJECTS = (ROW_TEMPLATES.gotoStatement ?? []).filter(
  (template): template is readonly TemplateFile[] => typeof template !== "string",
);
/** The projects whose every file holds a checked store (the first five). */
const CHECKED_IN_EVERY_FILE = 5;
/** The host values of the runs: the domain's, and the paths of the files a computed target may start. */
const HOSTS = [...DOMAIN, ...(ROW_HOSTS.gotoStatement ?? [])];

type Files = readonly { readonly path: string; readonly source: string }[];

/** A project as the oracle reads it: each file's source and its entries of the core's record, never the plan. */
function derivedProject(files: Files) {
  const request = coreRequest(files);
  assert.ok(request !== null, files[0]!.source);
  const record = compactAnalysis(request);
  return request.files.map((file) => {
    const syntax = syntaxOf(file.source);
    return { path: file.path, syntax, ...derive(syntax, recordOfFile(record, file.path)) };
  });
}

test("a transfer's runs enter today's files with fresh variables: the route's, today's and the oracle's across files agree", () => {
  assert.equal(PROJECTS.length, 8);
  for (const [at, files] of PROJECTS.entries()) {
    const name = files[0]!.source;
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, name);
    const project = derivedProject(files);
    for (const mode of HELD_MODES) {
      const where = `${name} [${mode.name}]`;
      const route = mode.run(() => compileProjectWithBackend(files, OPTIONS, CORE_BACKEND));
      assert.ok(route.plan !== null, where);
      // a nullable that crosses a file is no error: a target's variables are its own (#2514)
      assert.deepEqual(
        route.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        [],
        where,
      );
      for (const file of project) {
        const stores = plannedStores(planOfFile(route.plan, file.path));
        assert.deepEqual(stores, derivedStores(file.stores), `${where}: ${file.path}`);
        if (at < CHECKED_IN_EVERY_FILE) assert.ok(stores.length > 0, `${where}: ${file.path}`);
      }
      for (const hostValue of HOSTS) {
        const ran = runGlobals(route.plan, { hostValue });
        const label = `${where} with ${JSON.stringify(hostValue)}`;
        assert.deepEqual(ran, runGlobals(today.plan, { hostValue }), `${label}: today's`);
        assert.deepEqual(ran, evaluateProject(project, { hostValue }).run, `${label}: derived`);
      }
    }
  }
});

/** Three files beside `main.tease`, each saying its name. */
const NAMED: Files = ["part", "third", "fourth"].map((name) => ({
  path: `${name}.tease`,
  source: `say "${name}"\nexit\n`,
}));

test("the oracle across files predicts the route's runs: a path no text, a path no file has, a check inside the path", () => {
  const cases: readonly {
    readonly main: string;
    readonly hosts: readonly SerializableRuntimeValue[];
  }[] = [
    { main: "goto script(hostValue)\n", hosts: [2, "nowhere.tease", "part.tease"] },
    // (an index check inside the path: a non-whole index of unknown type fails with TSR024 on the route, the base's
    // declared run difference of `get`, V30 §16)
    {
      main: 'goto script(["part.tease", "third.tease"].get(hostValue, default: "fourth.tease"))\n',
      hosts: [0, 1, 5, null, "x", 2.5],
    },
  ];
  const failures: (string | null)[] = [];
  for (const { main, hosts } of cases) {
    const files = [{ path: "main.tease", source: main }, ...NAMED];
    const project = derivedProject(files);
    for (const mode of HELD_MODES) {
      const route = mode.run(() => compileProjectWithBackend(files, OPTIONS, CORE_BACKEND));
      assert.ok(route.plan !== null, `${main} [${mode.name}]`);
      for (const hostValue of hosts) {
        const inputs = { hostValue };
        const predicted = evaluateProject(project, inputs).run;
        assert.deepEqual(
          runGlobals(route.plan, inputs),
          predicted,
          `${main} ${JSON.stringify(hostValue)}`,
        );
        if (mode === HELD_MODES[0]) failures.push(predicted.failure);
      }
    }
  }
  // (the call `script(hostValue)`, then the statement; then the `get`'s index)
  assert.deepEqual(failures, [
    "TSR058@5:22",
    "TSR069@0:22",
    null,
    null,
    null,
    null,
    "TSR024@46:55",
    "TSR024@46:55",
    "TSR024@46:55",
  ]);
});

test("a path of a written type holding text and null: today's TSV043; the route transfers with text and stops null at the call", () => {
  const files = [
    { path: "main.tease", source: "let m: string? = hostValue\ngoto script(m)\nexit\n" },
    ...NAMED,
  ];
  const today = compileProject(files, OPTIONS);
  assert.equal(today.plan, null);
  assert.deepEqual(
    today.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map(({ code }) => code),
    ["TSV043"],
  );
  for (const mode of HELD_MODES) {
    const { plan } = mode.run(() => compileProjectWithBackend(files, OPTIONS, CORE_BACKEND));
    assert.ok(plan !== null, mode.name);
    // a text it takes starts its file; null fails at `script(m)` before any file starts; a number at the ingress
    assert.deepEqual(
      ["part.tease", null, 2].map((hostValue) => {
        const ran = runGlobals(plan, { hostValue });
        return `${ran.status} ${ran.failure} ${ran.said.map(({ text }) => text).join(",")}`;
      }),
      ["halted null part", "failed TSR058@32:41 ", "failed TSR058@17:26 "],
      mode.name,
    );
  }
});
