// The candidate route's transfers to another file (#2488's step 1c): each project of the row guard's transfer templates
// compiles on the route in the four held modes with today's runs, and its runs are the derived oracle's across files.

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../../src/compiler.js";
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
 * `script(hostValue)` over three files, conditionally, each with a checked store of the host global in every file; then
 * #2514's file starts, a nullable stored before a transfer of each of the two literal forms and a computed one, with a
 * variable of the same name used in the target.
 */
const PROJECTS = (ROW_TEMPLATES.gotoStatement ?? []).filter(
  (template): template is readonly TemplateFile[] => typeof template !== "string",
);
/** The projects whose every file holds a checked store (the first four). */
const CHECKED_IN_EVERY_FILE = 4;
/** The host values of the runs: the domain's, and the paths of the files a computed target may start. */
const HOSTS = [...DOMAIN, ...(ROW_HOSTS.gotoStatement ?? [])];

test("a transfer's runs enter today's files with fresh variables: the route's, today's and the oracle's across files agree", () => {
  assert.equal(PROJECTS.length, 7);
  for (const [at, files] of PROJECTS.entries()) {
    const name = files[0]!.source;
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, name);
    const request = coreRequest(files);
    assert.ok(request !== null, name);
    const record = compactAnalysis(request);
    // (the oracle reads each file's source and its entries of the core's record, never the plan)
    const project = request.files.map((file) => {
      const syntax = syntaxOf(file.source);
      return { path: file.path, syntax, ...derive(syntax, recordOfFile(record, file.path)) };
    });
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

test("the oracle across files fails a path that is no text at its call and a path no file has at the statement", () => {
  const files = [
    { path: "main.tease", source: "goto script(hostValue)\n" },
    { path: "part.tease", source: 'say "in part"\nexit\n' },
  ];
  const request = coreRequest(files);
  assert.ok(request !== null);
  const record = compactAnalysis(request);
  const project = request.files.map((file) => {
    const syntax = syntaxOf(file.source);
    return { path: file.path, syntax, ...derive(syntax, recordOfFile(record, file.path)) };
  });
  const route = compileProjectWithBackend(files, OPTIONS, CORE_BACKEND);
  assert.ok(route.plan !== null);
  const runs = [2, "nowhere.tease", "part.tease"].map((hostValue) => {
    const predicted = evaluateProject(project, { hostValue }).run;
    assert.deepEqual(runGlobals(route.plan!, { hostValue }), predicted, JSON.stringify(hostValue));
    return predicted.failure;
  });
  // (the call `script(hostValue)`, then the statement)
  assert.deepEqual(runs, ["TSR058@5:22", "TSR069@0:22", null]);
});
