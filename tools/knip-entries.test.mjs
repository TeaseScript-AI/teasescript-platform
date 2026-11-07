import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Knip cannot follow the Player test loader (`tests/helpers/player-modules.ts`), so `knip.json` lists the modules that
// `player/vue/vite.test-modules.config.ts` bundles for it as entries. Without its entry, a module's exports that only
// tests use read as unused. The check does not resolve knip's configuration: it accepts only a convention under which
// `npm run knip` (knip's default mode) certainly counts every bundled module as an entry. Each module's literal path is
// in the top-level `entry`, `entry` negates nothing, and `knip.json` sets no key outside `KNOWN_KEYS`. So using a glob
// instead of a bundled module's literal entry, adding any entry negation, or setting another key such as `workspaces`
// requires changing this check.

/** The `knip.json` keys known to leave the top-level `entry` list as `npm run knip` uses it. */
const KNOWN_KEYS = new Set(["$schema", "entry", "project", "ignoreDependencies", "include"]);

/** Why `config` falls outside the convention for `modules`, one sentence per breach; none when it is inside. */
function conventionBreaches(config, modules) {
  const breaches = [];
  const unknown = Object.keys(config).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0)
    breaches.push(
      `knip.json sets ${unknown.join(", ")}, which this check does not know: change this check first`,
    );
  const { entry } = config;
  if (!Array.isArray(entry))
    return [...breaches, "knip.json's entry is not a list: change this check first"];
  const negated = entry.filter((pattern) => pattern.startsWith("!"));
  if (negated.length > 0)
    breaches.push(`knip.json's entries negate ${negated.join(", ")}: change this check first`);
  const missing = modules.filter((module) => !entry.includes(module));
  if (missing.length > 0)
    breaches.push(`knip.json's entries lack ${missing.join(", ")}: list each module literally`);
  return breaches;
}

test("knip.json lists every module of the Player test bundle within the convention this check accepts", async () => {
  const { default: config } = await import("../player/vue/vite.test-modules.config.ts");
  const modules = Object.values(config.build.rolldownOptions.input);
  assert.ok(modules.length > 0, "the Player test bundle lists no modules");
  const knip = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
  assert.deepEqual(conventionBreaches(knip, modules), []);
});

// The family's axes, declared once; each value says whether the convention accepts it.
const MODULE = "player/a.ts";
const KEYS = {
  "known keys only": [{}, true],
  workspaces: [{ workspaces: { ".": { entry: ["src/index.ts"] } } }, false],
  ignoreWorkspaces: [{ ignoreWorkspaces: ["player"] }, false],
  includeEntryExports: [{ includeEntryExports: true }, false],
  "an unknown key": [{ entries: [MODULE] }, false],
};
const ENTRIES = {
  literal: [[MODULE], true],
  "literal and a glob": [[MODULE, "player/**/*.ts"], true],
  missing: [[], false],
  "a ./ prefix": [[`./${MODULE}`], false],
  "a production suffix": [[`${MODULE}!`], false],
  "a glob instead": [["player/*.ts"], false],
  "literal and a negation": [[MODULE, `!${MODULE}`], false],
  "literal and a production negation": [[MODULE, `!${MODULE}!`], false],
  "not a list": [MODULE, false],
};

test("the convention accepts a configuration only when its keys and its entries both keep the module literal", () => {
  const names = [];
  for (const [keys, [extra, keysAccepted]] of Object.entries(KEYS))
    for (const [entries, [entry, entriesAccepted]] of Object.entries(ENTRIES)) {
      const name = `${keys} × ${entries}`;
      names.push(name);
      const config = { $schema: "", entry, project: ["player/**/*.ts"], ...extra };
      const breaches = conventionBreaches(config, [MODULE]);
      assert.equal(
        breaches.length === 0,
        keysAccepted && entriesAccepted,
        `${name}: ${breaches.join("; ")}`,
      );
    }
  // Every value of each axis meets every value of the other.
  for (const keys of Object.keys(KEYS))
    for (const entries of Object.keys(ENTRIES))
      assert.ok(names.includes(`${keys} × ${entries}`), `${keys} × ${entries} is covered`);
});
