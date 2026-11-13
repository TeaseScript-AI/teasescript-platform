// The source-bundle artifact request's tests of a request: the command grammar, selectors, authorization, cache hits
// and misses, and redelivery. test-source-bundle-artifact-request.cjs runs them.

"use strict";

const assert = require("node:assert/strict");
const request = require("./source-bundle-artifact-request.cjs");

const {
  MAIN_SHA,
  PR_HEAD_SHA,
  PR_BASE_SHA,
  PR_MERGE_BASE_SHA,
  EXACT_SHA,
  DIGEST,
  REPOSITORY,
  httpError,
  makeCore,
  makeContext,
  makeGithub,
  artifactFixture,
  readyEntry,
  failedEntry,
  authoritativeRegistry,
  registryBlock,
  commandOptions,
} = require("./test-source-bundle-artifact-request-support.cjs");

const crypto = require("node:crypto");

async function testCommandGrammar() {
  assert.deepEqual(request.parseCommand("/artifact source main"), {
    selector: "main",
    selectorType: "main",
  });
  assert.deepEqual(request.parseCommand("/artifact source pr:225"), {
    selector: "pr:225",
    selectorType: "pr",
    pullNumber: 225,
  });
  assert.equal(request.parseCommand(`/artifact source sha:${EXACT_SHA}`).sourceSha, EXACT_SHA);
  for (const invalid of [
    "/artifact source pr:0",
    "/artifact source pr:01",
    `/artifact source pr:${"9".repeat(30)}`,
    `/artifact source sha:${"a".repeat(40).toUpperCase()}`,
    "/artifact source branch:main",
    "/artifact  source main",
    "/artifact source",
    " /artifact source main",
    "/artifact source main ",
    "/artifact source main\n",
  ]) {
    assert.throws(() => request.parseCommand(invalid), request.ArtifactRequestError);
  }
}

async function testCommandsOutsideMailboxCreateNothing() {
  const context = makeContext("/artifact source main", { issueNumber: 234 });
  const github = makeGithub(context);
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /only in issue #235/);
  assert.equal(github.state.createdComments, 0);
  assert.equal(github.state.selectorCalls, 0);
  assert.deepEqual(github.state.operations, []);
}

async function testSelectorResolutionAndMissOutputs() {
  const noPull = {
    pull_number: "",
    head_repository: "",
    head_ref: "",
    base_sha: "",
    merge_base_sha: "",
  };
  for (const [body, expected] of [
    [
      "/artifact source main",
      {
        selector: "main",
        selector_type: "main",
        source_sha: MAIN_SHA,
        source_repository: REPOSITORY,
        source_ref: "main",
        ...noPull,
      },
    ],
    [
      "/artifact source pr:225",
      {
        selector: "pr:225",
        selector_type: "pr",
        source_sha: PR_HEAD_SHA,
        source_repository: "Contributor/teasescript-platform",
        source_ref: "feature/source-bundle",
        pull_number: "225",
        head_repository: "Contributor/teasescript-platform",
        head_ref: "feature/source-bundle",
        base_sha: PR_BASE_SHA,
        merge_base_sha: PR_MERGE_BASE_SHA,
      },
    ],
    [
      `/artifact source sha:${EXACT_SHA}`,
      {
        selector: `sha:${EXACT_SHA}`,
        selector_type: "sha",
        source_sha: EXACT_SHA,
        source_repository: REPOSITORY,
        source_ref: EXACT_SHA,
        ...noPull,
      },
    ],
  ]) {
    const context = makeContext(body);
    const github = makeGithub(context);
    const core = makeCore();
    await request.resolveRequest({ github, context, core });
    assert.deepEqual(core.failures, []);
    assert.deepEqual(core.outputs, {
      resolved: "true",
      cache_hit: "false",
      request_comment_id: "501",
      request_author: "Dropje97",
      request_body_sha256: crypto.createHash("sha256").update(body).digest("hex"),
      ...expected,
    });
    assert.deepEqual(github.state.deletedCommentIds, []);
    assert.equal(github.state.createdComments, 0);
  }
}

async function testInvalidAndMissingSelectorsFailWithoutProduction() {
  for (const [body, overrides, pattern] of [
    ["/artifact source ref:main", {}, /Invalid command/],
    ["/artifact source pr:225", { missingPull: true }, /does not exist/],
    [`/artifact source sha:${EXACT_SHA}`, { missingCommit: true }, /does not exist/],
  ]) {
    const context = makeContext(body);
    const github = makeGithub(context, overrides);
    const core = makeCore();
    await request.resolveRequest({ github, context, core });
    assert.equal(core.failures.length, 1);
    const registryComment = github.state.comments.find(
      (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
    );
    assert.ok(registryComment);
    const entries = request.parseRegistryComment(registryComment.body);
    assert.equal(entries[0].state, "failed");
    assert.match(entries[0].reason, pattern);
    assert.equal(core.outputs.resolved, "false");
  }
}

async function testAuthorizationFailureIsRegisteredAndCleaned() {
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, { permission: "read" });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.deepEqual(github.state.permissionLookups, [
    { owner: "TeaseScript-AI", repo: "teasescript-platform", username: "Dropje97" },
  ]);
  assert.equal(github.state.selectorCalls, 0);
  assert.equal(core.outputs.resolved, "false");
  assert.equal(github.state.createdComments, 1);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  const registry = request.parseRegistryComment(github.state.comments.at(-1).body);
  assert.equal(registry[0].state, "failed");
  assert.match(registry[0].reason, /Write, Maintain, or Admin/);
}

async function testCacheHitCreatesOneRegistryAndCleansExactRequest() {
  const artifactId = 8101;
  const runId = 9101;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext("/artifact source main");
  const unrelated = { id: 777, body: "human discussion", user: { login: "Other", type: "User" } };
  const github = makeGithub(context, {
    comments: [unrelated],
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, "true");
  assert.deepEqual(github.state.operations, ["create-comment", "delete-comment"]);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  assert.ok(github.state.comments.includes(unrelated));
  const botComments = github.state.comments.filter(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  assert.equal(botComments.length, 1);
  const entries = request.parseRegistryComment(botComments[0].body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "ready");
  assert.deepEqual(entries[0].requestCommentIds, [501]);
  assert.equal(entries[0].artifactId, artifactId);
  const { file_name: fileName, ...download } = JSON.parse(
    registryBlock(botComments[0].body, "json"),
  );
  assert.deepEqual(download, { repo_full_name: REPOSITORY, artifact_id: artifactId });
  assert.match(fileName, /^[^/]+\.zip$/);
  assert.ok(fileName.includes(MAIN_SHA), fileName);
  const preparation = commandOptions(registryBlock(botComments[0].body, "shell"));
  assert.equal(
    preparation.executable,
    "/mnt/data/chatgpt-project-agent/bin/prepare-agent-workspace.sh",
  );
  const { "--output": workspace, ...verified } = preparation.options;
  assert.match(workspace, /^\/mnt\/data\/[^/]+$/);
  assert.deepEqual(verified, {
    "--artifact": `/mnt/data/${fileName}`,
    "--artifact-sha256": DIGEST,
    "--expected-repository": REPOSITORY,
    "--expected-head": MAIN_SHA,
  });
}

async function testCacheHitCleanupFailureIsNonFatal() {
  const artifactId = 8103;
  const runId = 9103;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
    deleteCommentError: httpError(500, "cleanup unavailable"),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, "true");
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /cleanup failed/);
  assert.deepEqual(github.state.deletedCommentIds, []);
  const registryComment = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  assert.equal(request.parseRegistryComment(registryComment.body)[0].state, "ready");
}

async function testForkPullRequestCacheHitPreservesExactPullIdentity() {
  const artifactId = 8102;
  const runId = 9102;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: PR_HEAD_SHA });
  fixture.run.event = "pull_request";
  fixture.run.head_repository = { id: 22002 };
  fixture.run.head_branch = "feature/source-bundle";
  fixture.run.head_sha = "f".repeat(40);
  fixture.run.pull_requests = [
    {
      base: { repo: { id: 1309933950 } },
      head: { repo: { id: 22002 }, ref: "feature/source-bundle", sha: PR_HEAD_SHA },
    },
  ];
  const context = makeContext("/artifact source pr:225");
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, "true");
  const entry = request.parseRegistryComment(
    github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body,
  )[0];
  assert.equal(entry.selector, "pr:225");
  assert.equal(entry.headRepository, "Contributor/teasescript-platform");
  assert.equal(entry.headRef, "feature/source-bundle");
  assert.equal(entry.baseSha, PR_BASE_SHA);
  assert.equal(entry.mergeBaseSha, PR_MERGE_BASE_SHA);
}

async function testStaleOrUntrustedIndexIsAConfirmedMiss() {
  const expired = artifactFixture({ artifactId: 8401, runId: 9401, sourceSha: MAIN_SHA });
  expired.artifact.expired = true;
  const untrusted = artifactFixture({ artifactId: 8402, runId: 9402, sourceSha: MAIN_SHA });
  untrusted.run.path = ".github/workflows/untrusted.yml";
  const wrongHead = artifactFixture({ artifactId: 8403, runId: 9403, sourceSha: MAIN_SHA });
  wrongHead.run.head_sha = EXACT_SHA;
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, {
    statuses: [
      { context: request.STATUS_CONTEXT, state: "success", target_url: expired.url },
      { context: request.STATUS_CONTEXT, state: "success", target_url: untrusted.url },
      { context: request.STATUS_CONTEXT, state: "success", target_url: wrongHead.url },
    ],
    artifacts: [
      [expired.artifact.id, expired.artifact],
      [untrusted.artifact.id, untrusted.artifact],
      [wrongHead.artifact.id, wrongHead.artifact],
    ],
    runs: [
      [expired.run.id, expired.run],
      [untrusted.run.id, untrusted.run],
      [wrongHead.run.id, wrongHead.run],
    ],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, "false");
  assert.equal(github.state.createdComments, 0);
}

async function testUnexpectedArtifactApiFailureIsNotTreatedAsMiss() {
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, {
    statuses: [
      {
        context: request.STATUS_CONTEXT,
        state: "success",
        target_url: `https://github.com/${REPOSITORY}/actions/runs/9501/artifacts/8501`,
      },
    ],
  });
  github.rest.actions.getArtifact = async () => {
    throw httpError(500, "artifact service unavailable");
  };
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  assert.equal(core.failures.length, 1);
  const registryComment = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  assert.match(
    request.parseRegistryComment(registryComment.body)[0].reason,
    /artifact service unavailable/,
  );
}

async function testMissingStatusRefIsAConfirmedMiss() {
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, { statusError: httpError(404, "status ref not found") });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, "false");
  assert.equal(github.state.createdComments, 0);
}

async function testDeletedRequestRedeliveryIsIdempotent() {
  const artifactId = 8111;
  const runId = 9111;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  await request.resolveRequest({ github, context, core: makeCore() });
  const firstBody = github.state.comments.at(-1).body;

  const retryCore = makeCore();
  await request.resolveRequest({ github, context, core: retryCore });
  assert.deepEqual(retryCore.failures, []);
  assert.equal(retryCore.outputs.cache_hit, "true");
  assert.equal(github.state.createdComments, 1);
  assert.equal(github.state.updatedComments, 0);
  assert.equal(github.state.comments.at(-1).body, firstBody);
}

async function testPrunedDeletedRequestRedeliveryIsANoop() {
  const context = makeContext("/artifact source main");
  const entries = Array.from({ length: request.REGISTRY_LIMIT }, (_, index) =>
    readyEntry({
      requestId: 600 + index,
      sourceSha: String(index + 1)
        .repeat(40)
        .slice(0, 40),
      artifactId: 8600 + index,
      runId: 9600 + index,
      updatedAt: `2026-08-04T10:${String(index).padStart(2, "0")}:00.000Z`,
    }),
  );
  const registry = authoritativeRegistry(entries);
  const github = makeGithub(context, { comments: [registry] });
  github.state.comments = github.state.comments.filter((comment) => comment.id !== 501);
  const before = registry.body;
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.resolved, "false");
  assert.equal(core.outputs.cache_hit, "false");
  assert.equal(registry.body, before);
  assert.deepEqual(github.state.operations, []);
}

async function testLiveTerminalRequestRedeliveryRetriesCleanupWithoutProduction() {
  for (const entry of [
    readyEntry({
      requestId: 501,
      artifactId: 8112,
      runId: 9112,
      updatedAt: "2026-08-04T10:00:00.000Z",
    }),
    failedEntry({ requestId: 501 }),
  ]) {
    const context = makeContext("/artifact source main");
    const registry = authoritativeRegistry([entry]);
    const github = makeGithub(context, { comments: [registry] });
    const before = registry.body;
    const core = makeCore();

    await request.resolveRequest({ github, context, core });

    assert.deepEqual(core.failures, []);
    assert.equal(core.outputs.resolved, "false");
    assert.equal(core.outputs.cache_hit, entry.state === "ready" ? "true" : "false");
    assert.equal(github.state.permissionCalls, 0);
    assert.equal(github.state.selectorCalls, 0);
    assert.deepEqual(github.state.deletedCommentIds, [501]);
    assert.equal(registry.body, before);
    assert.deepEqual(github.state.operations, ["delete-comment"]);
  }
}

module.exports = {
  testCommandGrammar,
  testCommandsOutsideMailboxCreateNothing,
  testSelectorResolutionAndMissOutputs,
  testInvalidAndMissingSelectorsFailWithoutProduction,
  testAuthorizationFailureIsRegisteredAndCleaned,
  testCacheHitCreatesOneRegistryAndCleansExactRequest,
  testCacheHitCleanupFailureIsNonFatal,
  testForkPullRequestCacheHitPreservesExactPullIdentity,
  testStaleOrUntrustedIndexIsAConfirmedMiss,
  testUnexpectedArtifactApiFailureIsNotTreatedAsMiss,
  testMissingStatusRefIsAConfirmedMiss,
  testDeletedRequestRedeliveryIsIdempotent,
  testPrunedDeletedRequestRedeliveryIsANoop,
  testLiveTerminalRequestRedeliveryRetriesCleanupWithoutProduction,
};
