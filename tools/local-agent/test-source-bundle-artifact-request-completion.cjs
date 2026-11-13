// The source-bundle artifact request's tests of completion: a command missing before the first terminal publication,
// the publication order, status and cleanup failures, a changed request, and sequential requests for one SHA.
// test-source-bundle-artifact-request.cjs runs them.

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
  httpError,
  makeCore,
  makeContext,
  makeGithub,
  addRequest,
  artifactFixture,
  inputFromCore,
  readyEntry,
  authoritativeRegistry,
} = require("./test-source-bundle-artifact-request-support.cjs");

async function testMissingCommandBeforeFirstTerminalPublicationFailsClosed() {
  const artifactId = 8113;
  const context = makeContext("/artifact source main", { runId: 9113 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  github.state.comments = github.state.comments.filter((comment) => comment.id !== 501);

  await assert.rejects(
    request.completeRequest({
      github,
      context,
      core,
      input: inputFromCore(core, context, artifactId, fixture.url),
    }),
    /comment not found/,
  );
  assert.equal(github.state.createdComments, 0);
  assert.equal(github.state.updatedComments, 0);
  assert.deepEqual(github.state.createdStatuses, []);
}

async function testCompletionPublishesRegistryThenCleanupThenStatus() {
  const artifactId = 8301;
  const context = makeContext("/artifact source pr:225", { runId: 9301 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: PR_HEAD_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  await request.completeRequest({
    github,
    context,
    core,
    input: inputFromCore(core, context, artifactId, fixture.url),
  });

  assert.deepEqual(github.state.operations, ["create-comment", "delete-comment", "create-status"]);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  assert.equal(github.state.createdStatuses.length, 1);
  const { description: _description, ...status } = github.state.createdStatuses[0];
  assert.deepEqual(status, {
    owner: "TeaseScript-AI",
    repo: "teasescript-platform",
    sha: PR_HEAD_SHA,
    state: "success",
    context: "source-bundle/artifact-v1",
    target_url: fixture.url,
  });
  const registryComment = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries[0].pullNumber, 225);
  assert.equal(entries[0].headRepository, "Contributor/teasescript-platform");
  assert.equal(entries[0].headRef, "feature/source-bundle");
  assert.equal(entries[0].baseSha, PR_BASE_SHA);
  assert.equal(entries[0].mergeBaseSha, PR_MERGE_BASE_SHA);
  assert.match(registryComment.body, new RegExp(`--expected-merge-base ${PR_MERGE_BASE_SHA}`));
}

async function testRegistryFailureCannotPublishStatusOrDeleteCommand() {
  const artifactId = 8311;
  const context = makeContext("/artifact source main", { runId: 9311 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    createCommentError: httpError(403, "registry write denied"),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  await assert.rejects(
    request.completeRequest({
      github,
      context,
      input: inputFromCore(core, context, artifactId, fixture.url),
    }),
    /registry write denied/,
  );
  assert.deepEqual(github.state.createdStatuses, []);
  assert.deepEqual(github.state.deletedCommentIds, []);
  assert.deepEqual(github.state.operations, []);
}

async function testStatusFailureReplacesCurrentRunReadyEntry() {
  const artifactId = 8321;
  const context = makeContext("/artifact source main", { runId: 9321 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    statusWriteError: httpError(403, "status write denied"),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  const oldStatus = {
    context: request.STATUS_CONTEXT,
    state: "success",
    target_url:
      "https://github.com/TeaseScript-AI/teasescript-platform/actions/runs/8000/artifacts/8001",
  };
  github.state.statuses.push(oldStatus);
  const input = inputFromCore(core, context, artifactId, fixture.url);

  await assert.rejects(
    request.completeRequest({ github, context, core, input }),
    /status write denied/,
  );
  const readyRegistry = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  assert.equal(request.parseRegistryComment(readyRegistry.body)[0].state, "ready");
  assert.deepEqual(github.state.deletedCommentIds, [501]);

  await request.reportProductionFailure({ github, context, core, input });
  const entries = request.parseRegistryComment(readyRegistry.body);
  assert.equal(entries[0].state, "failed");
  assert.equal(entries[0].requestCommentIds[0], 501);
  assert.match(entries[0].reason, /fixed-index publication failed/);
  assert.deepEqual(github.state.createdStatuses, []);
  assert.deepEqual(github.state.statuses, [oldStatus]);
}

async function testOlderReadyEntrySurvivesCurrentRunStatusFailure() {
  const artifactId = 8322;
  const context = makeContext("/artifact source main", { runId: 9322 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const older = readyEntry({
    requestId: 777,
    sourceSha: EXACT_SHA,
    artifactId: 7001,
    runId: 7002,
    updatedAt: "2026-08-04T09:00:00.000Z",
  });
  const registry = authoritativeRegistry([older]);
  const github = makeGithub(context, {
    comments: [registry],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    statusWriteError: httpError(403, "status write denied"),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  const input = inputFromCore(core, context, artifactId, fixture.url);
  await assert.rejects(
    request.completeRequest({ github, context, core, input }),
    /status write denied/,
  );
  await request.reportProductionFailure({ github, context, core, input });

  const entries = request.parseRegistryComment(registry.body);
  assert.equal(request.findRegistryEntry(entries, 501).state, "failed");
  assert.equal(request.findRegistryEntry(entries, 777).state, "ready");
  assert.equal(request.findRegistryEntry(entries, 777).producerRunId, 7002);
}

async function testCleanupFailureNeverOverwritesUsableReadyEntry() {
  const artifactId = 8331;
  const context = makeContext("/artifact source main", { runId: 9331 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    deleteCommentError: httpError(500, "cleanup unavailable"),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  const input = inputFromCore(core, context, artifactId, fixture.url);
  await request.completeRequest({ github, context, core, input });
  const entries = request.parseRegistryComment(
    github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "ready");
  assert.deepEqual(entries[0].requestCommentIds, [501]);
  assert.equal(entries[0].artifactId, artifactId);
  assert.equal(entries[0].producerRunId, context.runId);
  assert.equal(entries[0].artifactUrl, fixture.url);
  assert.deepEqual(github.state.deletedCommentIds, []);
  assert.equal(github.state.createdStatuses.length, 1);
  assert.equal(github.state.createdStatuses[0].state, "success");
  assert.equal(github.state.createdStatuses[0].sha, MAIN_SHA);
  assert.equal(github.state.createdStatuses[0].target_url, fixture.url);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /cleanup failed/);
}

async function testFailureEntryIsCompactBoundedAndCleaned() {
  const context = makeContext("/artifact source main");
  const apiMessage = `Permission service\r\n\tunavailable:   retry later\n${"upstream detail ".repeat(40)}`;
  const github = makeGithub(context, { permissionError: httpError(502, apiMessage) });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.deepEqual(github.state.operations, ["create-comment", "delete-comment"]);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  const registryComment = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries[0].state, "failed");
  assert.equal(entries[0].requestCommentIds[0], 501);
  assert.equal(entries[0].runUrl, `https://github.com/${REPOSITORY}/actions/runs/7001`);
  assert.ok(
    entries[0].reason.startsWith("Permission service unavailable: retry later upstream detail"),
  );
  assert.doesNotMatch(entries[0].reason, /[\r\n\t]| {2}/);
  // Truncated, whatever the limit: shorter than the message with only its whitespace compacted.
  assert.ok(entries[0].reason.length < apiMessage.replace(/\s+/g, " ").trim().length);
}

async function testChangedRequestCannotFinalizeOrDelete() {
  const artifactId = 8341;
  const context = makeContext("/artifact source main", { runId: 9341 });
  const fixture = artifactFixture({
    artifactId,
    runId: context.runId,
    sourceSha: MAIN_SHA,
    current: true,
  });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  github.state.comments[0].body = "/artifact source pr:225";

  await assert.rejects(
    request.completeRequest({
      github,
      context,
      input: inputFromCore(core, context, artifactId, fixture.url),
    }),
    /changed while the artifact request was running/,
  );
  assert.deepEqual(github.state.createdStatuses, []);
  assert.deepEqual(github.state.deletedCommentIds, []);
  assert.equal(github.state.createdComments, 0);
}

async function testSequentialSameShaRequestsReuseArtifactAndUpdateOneRegistry() {
  const artifactId = 8351;
  const runId = 9351;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext("/artifact source main");
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: "success", target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const firstCore = makeCore();
  await request.resolveRequest({ github, context, core: firstCore });
  addRequest(github, context, "/artifact source main", 502);
  const secondCore = makeCore();
  await request.resolveRequest({ github, context, core: secondCore });

  assert.equal(firstCore.outputs.cache_hit, "true");
  assert.equal(secondCore.outputs.cache_hit, "true");
  assert.equal(github.state.createdComments, 1);
  assert.equal(github.state.updatedComments, 1);
  assert.deepEqual(github.state.deletedCommentIds, [501, 502]);
  const registryComment = github.state.comments.find(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].requestCommentIds, [502, 501]);
  assert.equal(request.findRegistryEntry(entries, 501).artifactId, artifactId);
  assert.equal(request.findRegistryEntry(entries, 502).artifactId, artifactId);
}

module.exports = {
  testMissingCommandBeforeFirstTerminalPublicationFailsClosed,
  testCompletionPublishesRegistryThenCleanupThenStatus,
  testRegistryFailureCannotPublishStatusOrDeleteCommand,
  testStatusFailureReplacesCurrentRunReadyEntry,
  testOlderReadyEntrySurvivesCurrentRunStatusFailure,
  testCleanupFailureNeverOverwritesUsableReadyEntry,
  testFailureEntryIsCompactBoundedAndCleaned,
  testChangedRequestCannotFinalizeOrDelete,
  testSequentialSameShaRequestsReuseArtifactAndUpdateOneRegistry,
};
