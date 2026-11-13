// The source-bundle artifact request's tests of the registry comment: spoofing, escaping, resolved identities, pruning
// and bounds, and more than one registry. test-source-bundle-artifact-request.cjs runs them.

"use strict";

const assert = require("node:assert/strict");
const request = require("./source-bundle-artifact-request.cjs");

const {
  MAIN_SHA,
  PR_HEAD_SHA,
  PR_BASE_SHA,
  PR_MERGE_BASE_SHA,
  EXACT_SHA,
  REPOSITORY,
  makeCore,
  makeContext,
  makeGithub,
  artifactFixture,
  readyEntry,
  authoritativeRegistry,
} = require("./test-source-bundle-artifact-request-support.cjs");

async function testSpoofedRegistryCannotClaimAuthority() {
  // The documented authoritative registry author is github-actions[bot] with user ID 41898282.
  const documentedBotId = 41898282;
  const artifactId = 8121;
  const runId = 9121;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext("/artifact source main");
  const spoofedBody = request.formatRegistryComment([
    readyEntry({
      requestId: 400,
      artifactId: 8120,
      runId: 9120,
      updatedAt: "2026-08-04T09:00:00.000Z",
    }),
  ]);
  const spoofs = [
    {
      id: 800,
      body: spoofedBody,
      user: { login: "unrelated-app[bot]", id: documentedBotId, type: "Bot" },
    },
    { id: 801, body: spoofedBody, user: { login: "github-actions[bot]", id: 99001, type: "Bot" } },
  ];
  const github = makeGithub(context, {
    comments: spoofs,
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(github.state.updatedComments, 0);
  for (const spoof of spoofs) assert.equal(spoof.body, spoofedBody);
  const authoritative = github.state.comments.filter(
    (comment) =>
      comment.user?.id === documentedBotId && comment.user?.login === "github-actions[bot]",
  );
  assert.equal(authoritative.length, 1);
  const entries = request.parseRegistryComment(authoritative[0].body);
  assert.deepEqual(
    entries.map((entry) => entry.requestCommentIds),
    [[501]],
  );
}

async function testRegistryEscapesUntrustedPullHeadRef() {
  const hostileRef = "feature/x``</code><b>pwn</b>`tail";
  const entry = readyEntry({
    requestId: 500,
    sourceSha: PR_HEAD_SHA,
    artifactId: 8199,
    runId: 9199,
    updatedAt: "2026-08-04T09:59:00.000Z",
  });
  Object.assign(entry, {
    selector: "pr:225",
    sourceRepository: "Contributor/teasescript-platform",
    sourceRef: hostileRef,
    pullNumber: 225,
    headRepository: "Contributor/teasescript-platform",
    headRef: hostileRef,
    baseSha: PR_BASE_SHA,
    mergeBaseSha: PR_MERGE_BASE_SHA,
  });

  const body = request.formatRegistryComment([entry]);
  // CommonMark code span: an opening run of N backticks closes at the next run of exactly N.
  const start = body.indexOf("Contributor/teasescript-platform:");
  const fence = body.slice(0, start).match(/`+$/)[0];
  const closing = new RegExp(`(?<!\`)${fence}(?!\`)`, "g");
  closing.lastIndex = start;
  const close = closing.exec(body);
  assert.ok(close, "head code span is closed");
  assert.equal(body.slice(start, close.index), `Contributor/teasescript-platform:${hostileRef}`);
  assert.deepEqual(request.parseRegistryComment(body), [entry]);
}

async function testDifferentResolvedIdentitiesDoNotDeduplicate() {
  const pull = readyEntry({
    requestId: 503,
    sourceSha: PR_HEAD_SHA,
    artifactId: 8202,
    runId: 9202,
    updatedAt: "2026-08-04T10:00:00.000Z",
  });
  Object.assign(pull, {
    selector: "pr:225",
    sourceRepository: "Contributor/teasescript-platform",
    sourceRef: "feature/source-bundle",
    pullNumber: 225,
    headRepository: "Contributor/teasescript-platform",
    headRef: "feature/source-bundle",
    baseSha: PR_BASE_SHA,
    mergeBaseSha: PR_MERGE_BASE_SHA,
  });
  const exact = {
    ...pull,
    requestCommentIds: [504],
    selector: `sha:${PR_HEAD_SHA}`,
    sourceRepository: REPOSITORY,
    sourceRef: PR_HEAD_SHA,
    pullNumber: null,
    headRepository: null,
    headRef: null,
    baseSha: null,
    mergeBaseSha: null,
    updatedAt: "2026-08-04T10:01:00.000Z",
  };

  const merged = request.mergeRegistryEntries([pull], exact, new Date("2026-08-04T10:02:00Z"));
  assert.equal(merged.length, 2);
  assert.equal(request.findRegistryEntry(merged, 503).pullNumber, 225);
  assert.equal(request.findRegistryEntry(merged, 503).mergeBaseSha, PR_MERGE_BASE_SHA);
  assert.equal(request.findRegistryEntry(merged, 504).pullNumber, null);

  // The same PR head and artifact after the base branch advanced; the merge base is unchanged.
  const advancedBase = {
    ...pull,
    requestCommentIds: [505],
    baseSha: "6".repeat(40),
    updatedAt: "2026-08-04T10:01:00.000Z",
  };
  const mergedBase = request.mergeRegistryEntries(
    [pull],
    advancedBase,
    new Date("2026-08-04T10:02:00Z"),
  );
  assert.equal(mergedBase.length, 2);
  assert.deepEqual(request.findRegistryEntry(mergedBase, 503), pull);
  assert.deepEqual(request.findRegistryEntry(mergedBase, 505), advancedBase);
}

async function testRegistryPrunesExpiryOrdersNewestAndBoundsTen() {
  const entries = [];
  for (let index = 0; index < 11; index += 1) {
    entries.push(
      readyEntry({
        requestId: 600 + index,
        sourceSha: String(index + 1)
          .repeat(40)
          .slice(0, 40),
        artifactId: 9000 + index,
        runId: 10000 + index,
        updatedAt: `2026-08-04T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
  }
  entries.push(
    readyEntry({
      requestId: 999,
      artifactId: 9999,
      runId: 10999,
      updatedAt: "2026-08-04T10:59:00.000Z",
      expiresAt: "2026-08-04T10:59:30.000Z",
    }),
  );
  const incoming = readyEntry({
    requestId: 700,
    artifactId: 9700,
    runId: 10700,
    updatedAt: "2026-08-04T11:00:00.000Z",
  });
  const merged = request.mergeRegistryEntries(entries, incoming, new Date("2026-08-04T11:00:00Z"));
  assert.equal(merged.length, 10);
  assert.deepEqual(
    merged.flatMap((entry) => entry.requestCommentIds),
    [700, 610, 609, 608, 607, 606, 605, 604, 603, 602],
  );
  assert.equal(merged[0].requestCommentIds[0], 700);
  assert.equal(request.findRegistryEntry(merged, 999), null);
  for (let index = 1; index < merged.length; index += 1) {
    assert.ok(Date.parse(merged[index - 1].updatedAt) >= Date.parse(merged[index].updatedAt));
  }
  assert.equal(
    merged.reduce((count, entry) => count + entry.requestCommentIds.length, 0),
    10,
  );
}

async function testEquivalentArtifactRequestIdsAreGloballyBounded() {
  // Requests 801-806 deduplicate into one artifact entry and 807-811 into another.
  let merged = [];
  for (let requestId = 801; requestId <= 811; requestId += 1) {
    const second = requestId > 806;
    const minute = String(requestId - 800).padStart(2, "0");
    merged = request.mergeRegistryEntries(
      merged,
      readyEntry({
        requestId,
        sourceSha: second ? EXACT_SHA : MAIN_SHA,
        artifactId: second ? 9801 : 9800,
        runId: second ? 10801 : 10800,
        updatedAt: `2026-08-04T10:${minute}:00.000Z`,
      }),
      new Date(`2026-08-04T10:${minute}:30Z`),
    );
  }
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.flatMap((entry) => entry.requestCommentIds),
    [811, 810, 809, 808, 807, 806, 805, 804, 803, 802],
  );
}

async function testMultipleAuthoritativeRegistriesFailClosed() {
  const context = makeContext("/artifact source main");
  const entry = readyEntry({
    requestId: 500,
    artifactId: 8500,
    runId: 9500,
    updatedAt: "2026-08-04T10:00:00.000Z",
  });
  const github = makeGithub(context, {
    comments: [authoritativeRegistry([entry], 900), authoritativeRegistry([entry], 901)],
  });
  await assert.rejects(request.readRegistry({ github, context }), /More than one authoritative/);
}

module.exports = {
  testSpoofedRegistryCannotClaimAuthority,
  testRegistryEscapesUntrustedPullHeadRef,
  testDifferentResolvedIdentitiesDoNotDeduplicate,
  testRegistryPrunesExpiryOrdersNewestAndBoundsTen,
  testEquivalentArtifactRequestIdsAreGloballyBounded,
  testMultipleAuthoritativeRegistriesFailClosed,
};
