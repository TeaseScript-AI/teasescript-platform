import assert from "node:assert/strict";
import test from "node:test";

import { checkSiteKeys, siteKeyDiagnostics } from "./check-site-keys.mjs";
import { repositoryRoot } from "../files.mjs";

/** The lines the check reports in one scratch helper's `text`. */
const reported = (text) =>
  siteKeyDiagnostics([{ file: "tests/helpers/scratch.ts", text }]).map(({ line }) => line);

test("the shared oracles and runners key every site by its file too (#1700)", () => {
  assert.deepEqual(checkSiteKeys(repositoryRoot), []);
});

test("a map's or a set's key of a site's offsets without its file is refused, through its variable or function (#1700)", () => {
  // (Astra's B1 on #1690: a store's key of its kind and offset; the stop oracle's record before #1700, through its
  // function; a cycle guard's key, through its variable; a `+` of parts)
  assert.deepEqual(
    reported(
      [
        "out.set(`${instruction.kind}@${instruction.span.so}`, store);",
        "function recordOf(code: string, site: Span): string {",
        "  return `${code} ${site.start}:${site.end}`;",
        "}",
        "records.has(recordOf(d.code, d.site));",
        "function walk(seen: Set<string>) {",
        "  const key = `ingress:${owner.span.start.offset}`;",
        "  if (seen.has(key)) return;",
        "}",
        'joins.get(span.start.offset + "," + span.end.offset);',
      ].join("\n"),
    ),
    [1, 5, 8, 10],
  );
  // (with its file, a site's key, text that is no key, a key of no offset: none)
  assert.deepEqual(
    reported(
      [
        "out.set(`${storeFile(plan, index)}:${instruction.kind}@${instruction.span.so}`, store);",
        "seen.add(`${site.file}:${site.start}:${site.end}`);",
        "records.has(`${code} ${siteKey(site)}`);",
        "records.has(siteKey(site));",
        "problems.push(`${code} at ${site.start}:${site.end}`);",
        "names.add(`${place.label}.${path}`);",
        // (a variable of that name declared after the use, or in another block, is not the key)
        "{ const key = `${site.start}`; }",
        "seen.add(key);",
        // (a nearer binding of the name shadows the outer key: a parameter, one without an initializer; Codex r1's B1 on
        // #1705)
        "const id = `${site.start}`;",
        "function lookup(id: number) { return cache.has(id); }",
        "function later() { let id: number; id = 1; return cache.has(id); }",
      ].join("\n"),
    ),
    [],
  );
});
