// Compares a candidate pipeline with the runtime oracle's frozen one (docs/TESTING.md "Runtime pipeline oracle").
//
//   node tools/runtime-oracle/compare.mjs [--manifest FILE] [--from DIR] [--candidate DIR]
//       [--only A,B] [--details] [--replace-candidate REL=FILE] [--replace-oracle REL=FILE]
//
// First the oracle must reproduce the results its manifest pins; then the candidate (this checkout's build by default)
// must give the same result on every case and route. Prints one JSON report. Exit 0: reproduced and identical; 1: a
// difference; 2: the oracle cannot be used (manifest, root, tooling or Node do not match). `--replace-*` (tests only)
// loads FILE in place of a root's REL; a replaced oracle never counts as reproduced.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../benchmark-runtime.mjs";
import { closure } from "./closure.mjs";
import { checkout, checkoutHashes, defaultManifest, materialize, runRoot } from "./materialize.mjs";

const MISMATCHES_PER_KEY = 5;
const MISMATCHES = 50;

/** Up to `limit` paths where `left` and `right` differ, with both values. */
function differences(left, right, limit, at = "") {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  const objects = (value) => value !== null && typeof value === "object";
  if (!objects(left) || !objects(right) || Array.isArray(left) !== Array.isArray(right))
    return [{ path: at || "/", oracle: left, candidate: right }];
  const found = [];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  for (const key of keys) {
    for (const item of differences(left[key], right[key], limit - found.length, `${at}/${key}`))
      found.push(item);
    if (found.length >= limit) break;
  }
  return found;
}

/** The comparison report of `manifest` against `candidate`. */
export function compare({
  manifestFile = defaultManifest,
  from = null,
  candidate = checkout,
  replace = {},
  only = null,
  details = false,
} = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const casesFile = path.resolve(checkout, manifest.cases.file);
  const current = checkoutHashes(casesFile);
  for (const [kind, recorded, now] of [
    ["tooling", manifest.tooling, current.tooling],
    ["inputs", manifest.inputs, current.inputs],
    ["cases", { cases: manifest.cases.sha256 }, { cases: current.cases.sha256 }],
  ])
    if (canonicalJson(recorded) !== canonicalJson(now))
      throw new Error(`the oracle's ${kind} changed since the seal: seal again (docs/TESTING.md)`);
  const node = process.version.replace(/^v/u, "");
  if (node !== manifest.node)
    throw new Error(`Node ${node} runs this, the oracle is sealed for ${manifest.node}`);
  const oracleRoot = materialize(manifest, { from });
  const oracle = runRoot(
    oracleRoot,
    Object.keys(manifest.output),
    casesFile,
    replace.oracle ?? [],
    only,
  );
  // With `--only`, the sealed results of the cases it names.
  const sealed = Object.fromEntries(
    Object.entries(manifest.results).filter(
      ([key]) => only === null || only.includes(key.slice(0, key.lastIndexOf("/"))),
    ),
  );
  if (canonicalJson(oracle.formats) !== canonicalJson(manifest.formats))
    throw new Error(`the oracle's formats ${canonicalJson(oracle.formats)} are not the manifest's`);
  const reproduction = Object.keys({ ...sealed, ...oracle.digests })
    .filter((key) => sealed[key] !== oracle.digests[key])
    .map((key) => ({ key, sealed: sealed[key] ?? null, found: oracle.digests[key] ?? null }));
  const candidateRun = runRoot(
    candidate,
    Object.keys(closure(candidate, manifest.entries).output),
    casesFile,
    replace.candidate ?? [],
    only,
  );
  const mismatches = [];
  for (const key of Object.keys({ ...oracle.results, ...candidateRun.results })) {
    if (oracle.digests[key] === candidateRun.digests[key]) continue;
    const found = differences(oracle.results[key], candidateRun.results[key], MISMATCHES_PER_KEY);
    for (const item of found) mismatches.push({ key, ...item });
    if (mismatches.length >= MISMATCHES) break;
  }
  const classifications = {};
  for (const [key, value] of Object.entries(oracle.results))
    (classifications[value.classification] ??= []).push(key);
  return {
    seal: manifest.seal,
    commit: manifest.commit,
    reproduced: reproduction.length === 0 && !oracle.replaced,
    reproduction,
    identical: mismatches.length === 0,
    mismatches: mismatches.slice(0, MISMATCHES),
    count: Object.keys(oracle.results).length,
    classifications,
    ...(details ? { results: oracle.results } : {}),
  };
}

function parse(argv) {
  const options = { manifestFile: defaultManifest, from: null, candidate: checkout, replace: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--details") {
      options.details = true;
      continue;
    }
    const value = argv[(index += 1)];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--manifest") options.manifestFile = path.resolve(value);
    else if (name === "--from") options.from = value;
    else if (name === "--candidate") options.candidate = path.resolve(value);
    else if (name === "--only") options.only = value.split(",");
    else if (name === "--replace-candidate") (options.replace.candidate ??= []).push(value);
    else if (name === "--replace-oracle") (options.replace.oracle ??= []).push(value);
    else throw new Error(`unknown option ${name}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let report;
  try {
    report = compare(parse(process.argv.slice(2)));
  } catch (error) {
    console.error(`runtime oracle: ${error.message}`);
    process.exit(2);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.reproduced && report.identical ? 0 : 1);
}
