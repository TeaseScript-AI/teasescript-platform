import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryHash, verifyBuild } from "../lib/build.mjs";
import { readJson, writeJson } from "../lib/json.mjs";
import { dimensions, interactionGroups } from "../families/s8-stores.mjs";
function built(visit) {
  const dir = mkdtempSync(join(tmpdir(), "family-build-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/x.js"), "export const value = 1;");
    writeJson(join(dir, "package.json"), { engines: { node: process.versions.node } });
    writeJson(join(dir, "pilot-build.json"), {
      schemaVersion: 1,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      distHash: directoryHash(join(dir, "dist")),
    });
    visit(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("compiled content tampering invalidates seal", () =>
  built((dir) => {
    assert.equal(verifyBuild(dir).runtimeMatches, true);
    writeFileSync(join(dir, "dist/x.js"), "changed");
    assert.throws(() => verifyBuild(dir), /seal/);
  }));
test("an exact tree is supported without inventing a commit", () =>
  built((dir) => {
    const path = join(dir, "pilot-build.json"),
      s = readJson(path);
    s.commit = null;
    writeJson(path, s);
    assert.equal(verifyBuild(dir).commit, null);
  }));
test("runtime mismatch requires explicit compatibility opt-in", () =>
  built((dir) => {
    writeJson(join(dir, "package.json"), { engines: { node: "0.0.0" } });
    assert.throws(() => verifyBuild(dir), /Compiler needs/);
    assert.equal(verifyBuild(dir, true).acceptanceEnvironment, "compatibility-only");
  }));
test("manifest dimensions agree with executable family", () => {
  const m = readJson(new URL("../families/s8-stores.manifest.json", import.meta.url));
  assert.deepEqual(m.dimensions, dimensions);
  assert.deepEqual(m.interactions, interactionGroups);
  assert.equal(m.externalHoldouts.imported, false);
});
