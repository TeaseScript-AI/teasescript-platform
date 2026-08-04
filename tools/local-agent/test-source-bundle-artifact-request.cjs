'use strict';

const assert = require('node:assert/strict');

const request = require('./source-bundle-artifact-request.cjs');

const MAIN_SHA = '1'.repeat(40);
const PR_HEAD_SHA = '2'.repeat(40);
const PR_BASE_SHA = '3'.repeat(40);
const PR_MERGE_BASE_SHA = '4'.repeat(40);
const EXACT_SHA = '5'.repeat(40);
const DIGEST = 'a'.repeat(64);
const REPOSITORY = 'TeaseScript-AI/teasescript-platform';
const MAILBOX = request.MAILBOX_ISSUE_NUMBER;
const RESULT_BOT_USER = {
  login: request.RESULT_BOT_LOGIN,
  id: request.RESULT_BOT_ID,
  type: 'Bot',
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeCore() {
  return {
    outputs: {},
    failures: [],
    setOutput(name, value) {
      this.outputs[name] = String(value);
    },
    setFailed(message) {
      this.failures.push(String(message));
    },
  };
}

function makeContext(body, overrides = {}) {
  const author = overrides.author || 'Dropje97';
  return {
    actor: overrides.actor || author,
    runId: overrides.runId || 7001,
    serverUrl: 'https://github.com',
    repo: { owner: 'TeaseScript-AI', repo: 'teasescript-platform' },
    payload: {
      comment: {
        id: overrides.commentId || 501,
        body,
        user: { login: author },
      },
      issue: { number: overrides.issueNumber || MAILBOX },
    },
  };
}

function makeGithub(context, overrides = {}) {
  const requestComment = {
    id: context.payload.comment.id,
    body: context.payload.comment.body,
    user: { login: context.payload.comment.user.login, type: 'User' },
  };
  const state = {
    comments: [requestComment, ...(overrides.comments || [])],
    createdStatuses: [],
    createdComments: 0,
    updatedComments: 0,
    deletedCommentIds: [],
    selectorCalls: 0,
    permissionCalls: 0,
    operations: [],
    createCommentError: overrides.createCommentError || null,
    updateCommentError: overrides.updateCommentError || null,
    deleteCommentError: overrides.deleteCommentError || null,
    statusWriteError: overrides.statusWriteError || null,
  };
  let nextCommentId = 1000;

  const artifacts = new Map(overrides.artifacts || []);
  const runs = new Map(overrides.runs || []);
  const statuses = [...(overrides.statuses || [])];

  const github = {
    state,
    async paginate(method, params, map) {
      return map(await method(params));
    },
    rest: {
      issues: {
        async getComment({ comment_id }) {
          const comment = state.comments.find((item) => item.id === comment_id);
          if (!comment) throw httpError(404, 'comment not found');
          return { data: comment };
        },
        async listComments({ issue_number }) {
          assert.equal(issue_number, MAILBOX);
          return { data: [...state.comments] };
        },
        async createComment({ issue_number, body }) {
          assert.equal(issue_number, MAILBOX);
          if (state.createCommentError) throw state.createCommentError;
          state.createdComments += 1;
          state.operations.push('create-comment');
          const comment = {
            id: nextCommentId++,
            body,
            user: { ...(overrides.createdCommentUser || RESULT_BOT_USER) },
          };
          state.comments.push(comment);
          return { data: comment };
        },
        async updateComment({ comment_id, body }) {
          if (state.updateCommentError) throw state.updateCommentError;
          state.updatedComments += 1;
          state.operations.push('update-comment');
          const comment = state.comments.find((item) => item.id === comment_id);
          if (!comment) throw httpError(404, 'comment not found');
          comment.body = body;
          return { data: comment };
        },
        async deleteComment({ comment_id }) {
          if (state.deleteCommentError) throw state.deleteCommentError;
          const index = state.comments.findIndex((item) => item.id === comment_id);
          if (index < 0) throw httpError(404, 'comment not found');
          state.comments.splice(index, 1);
          state.deletedCommentIds.push(comment_id);
          state.operations.push('delete-comment');
          return { status: 204 };
        },
      },
      repos: {
        async get() {
          state.selectorCalls += 1;
          return { data: { default_branch: 'main' } };
        },
        async getCollaboratorPermissionLevel() {
          state.permissionCalls += 1;
          if (overrides.permissionError) throw overrides.permissionError;
          return { data: { permission: overrides.permission || 'write' } };
        },
        async compareCommitsWithBasehead({ basehead }) {
          state.selectorCalls += 1;
          assert.equal(basehead, `${PR_BASE_SHA}...${PR_HEAD_SHA}`);
          return { data: { merge_base_commit: { sha: PR_MERGE_BASE_SHA } } };
        },
        async getCombinedStatusForRef() {
          if (overrides.statusError) throw overrides.statusError;
          return { data: { statuses } };
        },
        async createCommitStatus(input) {
          if (state.statusWriteError) throw state.statusWriteError;
          state.createdStatuses.push(input);
          state.operations.push('create-status');
          statuses.unshift({
            context: input.context,
            state: input.state,
            target_url: input.target_url,
          });
          return { data: input };
        },
      },
      git: {
        async getRef({ ref }) {
          state.selectorCalls += 1;
          assert.equal(ref, 'heads/main');
          return { data: { object: { type: 'commit', sha: MAIN_SHA } } };
        },
        async getCommit({ commit_sha }) {
          state.selectorCalls += 1;
          if (overrides.missingCommit || commit_sha !== EXACT_SHA) {
            throw httpError(404, 'commit not found');
          }
          return { data: { sha: commit_sha } };
        },
      },
      pulls: {
        async get({ pull_number }) {
          state.selectorCalls += 1;
          if (overrides.missingPull || pull_number !== 225) {
            throw httpError(404, 'pull not found');
          }
          return {
            data: {
              head: {
                sha: PR_HEAD_SHA,
                ref: 'feature/source-bundle',
                repo: { full_name: 'Contributor/teasescript-platform' },
              },
              base: { sha: PR_BASE_SHA },
            },
          };
        },
      },
      actions: {
        async getArtifact({ artifact_id }) {
          const artifact = artifacts.get(artifact_id);
          if (!artifact) throw httpError(404, 'artifact not found');
          return { data: artifact };
        },
        async getWorkflowRun({ run_id }) {
          const run = runs.get(run_id);
          if (!run) throw httpError(404, 'run not found');
          return { data: run };
        },
      },
    },
  };

  return github;
}

function addRequest(github, context, body, commentId) {
  context.payload.comment.id = commentId;
  context.payload.comment.body = body;
  github.state.comments.push({
    id: commentId,
    body,
    user: { login: context.payload.comment.user.login, type: 'User' },
  });
}

function artifactFixture({ artifactId, runId, sourceSha, current = false, expiresAt = '2099-01-01T00:00:00Z' }) {
  return {
    artifact: {
      id: artifactId,
      name: `teasescript-source-${sourceSha}`,
      expired: false,
      expires_at: expiresAt,
      digest: `sha256:${DIGEST}`,
      workflow_run: { id: runId },
    },
    run: {
      id: runId,
      repository: {
        id: 1309933950,
        full_name: REPOSITORY,
      },
      path: current
        ? '.github/workflows/artifact-mailbox.yml'
        : '.github/workflows/source-bundle.yml',
      status: current ? 'in_progress' : 'completed',
      conclusion: current ? null : 'success',
      event: current ? 'issue_comment' : 'push',
      head_sha: current ? '9'.repeat(40) : sourceSha,
      head_branch: 'main',
      head_repository: { id: 1309933950 },
      pull_requests: [],
    },
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`,
  };
}

function inputFromCore(core, context, artifactId, artifactUrl) {
  return {
    requestCommentId: core.outputs.request_comment_id,
    requestAuthor: core.outputs.request_author,
    requestBodySha256: core.outputs.request_body_sha256,
    issueNumber: String(context.payload.issue.number),
    selector: core.outputs.selector,
    selectorType: core.outputs.selector_type,
    sourceSha: core.outputs.source_sha,
    sourceRepository: core.outputs.source_repository,
    sourceRef: core.outputs.source_ref,
    pullNumber: core.outputs.pull_number,
    headRepository: core.outputs.head_repository,
    headRef: core.outputs.head_ref,
    baseSha: core.outputs.base_sha,
    mergeBaseSha: core.outputs.merge_base_sha,
    artifactId: String(artifactId),
    artifactUrl,
    artifactDigest: DIGEST,
  };
}

function readyEntry({
  requestId,
  sourceSha = MAIN_SHA,
  artifactId,
  runId,
  updatedAt,
  expiresAt = '2099-01-01T00:00:00.000Z',
}) {
  return {
    state: 'ready',
    requestCommentIds: [requestId],
    selector: `sha:${sourceSha}`,
    sourceSha,
    updatedAt,
    repository: REPOSITORY,
    sourceRepository: REPOSITORY,
    sourceRef: sourceSha,
    pullNumber: null,
    headRepository: null,
    headRef: null,
    baseSha: null,
    mergeBaseSha: null,
    artifactId,
    artifactName: `teasescript-source-${sourceSha}`,
    artifactDigest: DIGEST,
    producerRunId: runId,
    artifactUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`,
    expiresAt,
  };
}

function authoritativeRegistry(entries, id = 900) {
  return {
    id,
    body: request.formatRegistryComment(entries),
    user: { ...RESULT_BOT_USER },
  };
}

async function testCommandGrammar() {
  assert.deepEqual(request.parseCommand('/artifact source main'), {
    selector: 'main',
    selectorType: 'main',
  });
  assert.deepEqual(request.parseCommand('/artifact source pr:225'), {
    selector: 'pr:225',
    selectorType: 'pr',
    pullNumber: 225,
  });
  assert.equal(request.parseCommand(`/artifact source sha:${EXACT_SHA}`).sourceSha, EXACT_SHA);
  for (const invalid of [
    '/artifact source pr:0',
    '/artifact source pr:01',
    `/artifact source pr:${'9'.repeat(30)}`,
    `/artifact source sha:${'a'.repeat(40).toUpperCase()}`,
    '/artifact source branch:main',
    '/artifact  source main',
    '/artifact source',
    ' /artifact source main',
    '/artifact source main ',
    '/artifact source main\n',
  ]) {
    assert.throws(() => request.parseCommand(invalid), request.ArtifactRequestError);
  }
}

async function testCommandsOutsideMailboxCreateNothing() {
  const context = makeContext('/artifact source main', { issueNumber: 234 });
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
  for (const [body, expected] of [
    ['/artifact source main', { sha: MAIN_SHA, type: 'main' }],
    ['/artifact source pr:225', { sha: PR_HEAD_SHA, type: 'pr' }],
    [`/artifact source sha:${EXACT_SHA}`, { sha: EXACT_SHA, type: 'sha' }],
  ]) {
    const context = makeContext(body);
    const github = makeGithub(context);
    const core = makeCore();
    await request.resolveRequest({ github, context, core });
    assert.deepEqual(core.failures, []);
    assert.equal(core.outputs.resolved, 'true');
    assert.equal(core.outputs.cache_hit, 'false');
    assert.equal(core.outputs.source_sha, expected.sha);
    assert.equal(core.outputs.selector_type, expected.type);
    assert.deepEqual(github.state.deletedCommentIds, []);
    assert.equal(github.state.createdComments, 0);
  }
}

async function testAuthorizationFailureIsRegisteredAndCleaned() {
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, { permission: 'read' });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.equal(github.state.createdComments, 1);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  const registry = request.parseRegistryComment(github.state.comments.at(-1).body);
  assert.equal(registry[0].state, 'failed');
  assert.match(registry[0].reason, /Write, Maintain, or Admin/);
}

async function testCacheHitCreatesOneRegistryAndCleansExactRequest() {
  const artifactId = 8101;
  const runId = 9101;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext('/artifact source main');
  const unrelated = { id: 777, body: 'human discussion', user: { login: 'Other', type: 'User' } };
  const github = makeGithub(context, {
    comments: [unrelated],
    statuses: [{ context: request.STATUS_CONTEXT, state: 'success', target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, 'true');
  assert.deepEqual(github.state.operations, ['create-comment', 'delete-comment']);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  assert.ok(github.state.comments.includes(unrelated));
  const botComments = github.state.comments.filter((comment) => comment.user?.login === request.RESULT_BOT_LOGIN);
  assert.equal(botComments.length, 1);
  const entries = request.parseRegistryComment(botComments[0].body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'ready');
  assert.deepEqual(entries[0].requestCommentIds, [501]);
  assert.equal(entries[0].artifactId, artifactId);
  assert.match(botComments[0].body, /"artifact_id":8101/);
  assert.match(botComments[0].body, /request-501\.zip/);
  assert.match(botComments[0].body, /prepare-agent-workspace\.sh/);
  assert.doesNotMatch(botComments[0].body, /## Artifact ready|Artifact URL:|Source repository:/);
}

async function testDeletedRequestRedeliveryIsIdempotent() {
  const artifactId = 8111;
  const runId = 9111;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: 'success', target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  await request.resolveRequest({ github, context, core: makeCore() });
  const firstBody = github.state.comments.at(-1).body;

  const retryCore = makeCore();
  await request.resolveRequest({ github, context, core: retryCore });
  assert.deepEqual(retryCore.failures, []);
  assert.equal(retryCore.outputs.cache_hit, 'true');
  assert.equal(github.state.createdComments, 1);
  assert.equal(github.state.updatedComments, 0);
  assert.equal(github.state.comments.at(-1).body, firstBody);
}

async function testSpoofedRegistryCannotClaimAuthority() {
  const artifactId = 8121;
  const runId = 9121;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext('/artifact source main');
  const spoof = {
    id: 800,
    body: `${request.REGISTRY_MARKER}\nspoofed`,
    user: { login: 'unrelated-app[bot]', id: 99001, type: 'Bot' },
  };
  const github = makeGithub(context, {
    comments: [spoof],
    statuses: [{ context: request.STATUS_CONTEXT, state: 'success', target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  await request.resolveRequest({ github, context, core: makeCore() });

  assert.equal(spoof.body, `${request.REGISTRY_MARKER}\nspoofed`);
  const authoritative = github.state.comments.filter(
    (comment) => comment.user?.login === request.RESULT_BOT_LOGIN,
  );
  assert.equal(authoritative.length, 1);
  assert.equal(authoritative[0].user.id, request.RESULT_BOT_ID);
}

async function testRegistryEscapesUntrustedPullHeadRef() {
  const entry = readyEntry({
    requestId: 500,
    sourceSha: PR_HEAD_SHA,
    artifactId: 8199,
    runId: 9199,
    updatedAt: '2026-08-04T09:59:00.000Z',
  });
  Object.assign(entry, {
    selector: 'pr:225',
    sourceRepository: 'Contributor/teasescript-platform',
    sourceRef: 'feature/x`</code><b>pwn</b>',
    pullNumber: 225,
    headRepository: 'Contributor/teasescript-platform',
    headRef: 'feature/x`</code><b>pwn</b>',
    baseSha: PR_BASE_SHA,
    mergeBaseSha: PR_MERGE_BASE_SHA,
  });

  const body = request.formatRegistryComment([entry]);
  assert.match(
    body,
    /head ``Contributor\/teasescript-platform:feature\/x`<\/code><b>pwn<\/b>``/,
  );
  assert.equal(
    request.formatInlineCode('feature/x`</code><b>pwn</b>'),
    '``feature/x`</code><b>pwn</b>``',
  );
}

async function testEquivalentArtifactsDeduplicateAndPreserveRequestIds() {
  const first = readyEntry({
    requestId: 501,
    artifactId: 8201,
    runId: 9201,
    updatedAt: '2026-08-04T10:00:00.000Z',
  });
  const second = {
    ...first,
    requestCommentIds: [502],
    selector: 'main',
    updatedAt: '2026-08-04T10:01:00.000Z',
  };
  const merged = request.mergeRegistryEntries([first], second, new Date('2026-08-04T10:02:00Z'));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].requestCommentIds, [502, 501]);
  const body = request.formatRegistryComment(merged);
  assert.match(body, /requests 502, 501/);
  assert.match(body, /`GitHub\.download_workflow_artifact`/);
  assert.equal((body.match(/^### /gm) || []).length, 1);
  assert.equal(request.findRegistryEntry(merged, 501).artifactId, 8201);
  assert.equal(request.findRegistryEntry(merged, 502).artifactId, 8201);
}

async function testSerializedDistinctUpdatesPreserveBothEntries() {
  const first = readyEntry({
    requestId: 511,
    sourceSha: MAIN_SHA,
    artifactId: 8211,
    runId: 9211,
    updatedAt: '2026-08-04T10:00:00.000Z',
  });
  const second = readyEntry({
    requestId: 512,
    sourceSha: EXACT_SHA,
    artifactId: 8212,
    runId: 9212,
    updatedAt: '2026-08-04T10:01:00.000Z',
  });
  const afterFirst = request.mergeRegistryEntries([], first, new Date('2026-08-04T10:00:30Z'));
  const afterSecond = request.mergeRegistryEntries(
    afterFirst,
    second,
    new Date('2026-08-04T10:01:30Z'),
  );

  assert.equal(afterSecond.length, 2);
  assert.equal(afterSecond[0].requestCommentIds[0], 512);
  assert.equal(afterSecond[1].requestCommentIds[0], 511);
  assert.equal(request.findRegistryEntry(afterSecond, 511).artifactId, 8211);
  assert.equal(request.findRegistryEntry(afterSecond, 512).artifactId, 8212);
}

async function testRegistryPrunesExpiryOrdersNewestAndBoundsTen() {
  const entries = [];
  for (let index = 0; index < 11; index += 1) {
    entries.push(readyEntry({
      requestId: 600 + index,
      sourceSha: String(index + 1).repeat(40).slice(0, 40),
      artifactId: 9000 + index,
      runId: 10000 + index,
      updatedAt: `2026-08-04T10:${String(index).padStart(2, '0')}:00.000Z`,
    }));
  }
  entries.push(readyEntry({
    requestId: 999,
    artifactId: 9999,
    runId: 10999,
    updatedAt: '2026-08-04T10:59:00.000Z',
    expiresAt: '2026-08-04T10:59:30.000Z',
  }));
  const incoming = readyEntry({
    requestId: 700,
    artifactId: 9700,
    runId: 10700,
    updatedAt: '2026-08-04T11:00:00.000Z',
  });
  const merged = request.mergeRegistryEntries(entries, incoming, new Date('2026-08-04T11:00:00Z'));
  assert.equal(merged.length, request.REGISTRY_LIMIT);
  assert.equal(merged[0].requestCommentIds[0], 700);
  assert.equal(request.findRegistryEntry(merged, 999), null);
  for (let index = 1; index < merged.length; index += 1) {
    assert.ok(Date.parse(merged[index - 1].updatedAt) >= Date.parse(merged[index].updatedAt));
  }
}

async function testMultipleAuthoritativeRegistriesFailClosed() {
  const context = makeContext('/artifact source main');
  const entry = readyEntry({
    requestId: 500,
    artifactId: 8500,
    runId: 9500,
    updatedAt: '2026-08-04T10:00:00.000Z',
  });
  const github = makeGithub(context, {
    comments: [authoritativeRegistry([entry], 900), authoritativeRegistry([entry], 901)],
  });
  await assert.rejects(
    request.readRegistry({ github, context }),
    /More than one authoritative/,
  );
}

async function testCompletionPublishesRegistryThenStatusThenCleanup() {
  const artifactId = 8301;
  const context = makeContext('/artifact source pr:225', { runId: 9301 });
  const fixture = artifactFixture({ artifactId, runId: context.runId, sourceSha: PR_HEAD_SHA, current: true });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  await request.completeRequest({
    github,
    context,
    input: inputFromCore(core, context, artifactId, fixture.url),
  });

  assert.deepEqual(github.state.operations, ['create-comment', 'create-status', 'delete-comment']);
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  assert.equal(github.state.createdStatuses.length, 1);
  const registryComment = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN);
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries[0].pullNumber, 225);
  assert.equal(entries[0].headRepository, 'Contributor/teasescript-platform');
  assert.equal(entries[0].headRef, 'feature/source-bundle');
  assert.equal(entries[0].baseSha, PR_BASE_SHA);
  assert.equal(entries[0].mergeBaseSha, PR_MERGE_BASE_SHA);
  assert.match(registryComment.body, new RegExp(`--expected-merge-base ${PR_MERGE_BASE_SHA}`));
}

async function testRegistryFailureCannotPublishStatusOrDeleteCommand() {
  const artifactId = 8311;
  const context = makeContext('/artifact source main', { runId: 9311 });
  const fixture = artifactFixture({ artifactId, runId: context.runId, sourceSha: MAIN_SHA, current: true });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    createCommentError: httpError(403, 'registry write denied'),
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

async function testStatusFailurePreservesReadyRegistryAndAllowsCleanup() {
  const artifactId = 8321;
  const context = makeContext('/artifact source main', { runId: 9321 });
  const fixture = artifactFixture({ artifactId, runId: context.runId, sourceSha: MAIN_SHA, current: true });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    statusWriteError: httpError(403, 'status write denied'),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  const input = inputFromCore(core, context, artifactId, fixture.url);
  await assert.rejects(request.completeRequest({ github, context, input }), /status write denied/);
  const readyBody = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body;
  assert.match(readyBody, /· ready ·/);
  assert.deepEqual(github.state.deletedCommentIds, []);

  await request.reportProductionFailure({ github, context, input });
  assert.deepEqual(github.state.deletedCommentIds, [501]);
  const after = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body;
  assert.equal(after, readyBody);
  assert.doesNotMatch(after, /· failed ·/);
}

async function testCleanupFailureNeverOverwritesUsableReadyEntry() {
  const artifactId = 8331;
  const context = makeContext('/artifact source main', { runId: 9331 });
  const fixture = artifactFixture({ artifactId, runId: context.runId, sourceSha: MAIN_SHA, current: true });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
    deleteCommentError: httpError(500, 'cleanup unavailable'),
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  const input = inputFromCore(core, context, artifactId, fixture.url);
  await assert.rejects(request.completeRequest({ github, context, input }), /cleanup unavailable/);
  const readyBody = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body;
  assert.match(readyBody, /· ready ·/);
  assert.equal(github.state.createdStatuses.length, 1);

  await assert.rejects(request.reportProductionFailure({ github, context, input }), /cleanup unavailable/);
  const after = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN).body;
  assert.equal(after, readyBody);
  assert.doesNotMatch(after, /· failed ·/);
}

async function testFailureEntryIsCompactBoundedAndCleaned() {
  const context = makeContext('/artifact source pr:0');
  const github = makeGithub(context);
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.deepEqual(github.state.operations, ['create-comment', 'delete-comment']);
  const registryComment = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN);
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries[0].state, 'failed');
  assert.equal(entries[0].requestCommentIds[0], 501);
  assert.ok(entries[0].reason.length <= 240);
  assert.doesNotMatch(registryComment.body, /full log|stack trace|No authoritative artifact result/);
  assert.equal(request.compactFailureReason(`a\n${'b'.repeat(500)}`).length, 240);
}

async function testChangedRequestCannotFinalizeOrDelete() {
  const artifactId = 8341;
  const context = makeContext('/artifact source main', { runId: 9341 });
  const fixture = artifactFixture({ artifactId, runId: context.runId, sourceSha: MAIN_SHA, current: true });
  const github = makeGithub(context, {
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[context.runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });
  github.state.comments[0].body = '/artifact source pr:225';

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
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, {
    statuses: [{ context: request.STATUS_CONTEXT, state: 'success', target_url: fixture.url }],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const firstCore = makeCore();
  await request.resolveRequest({ github, context, core: firstCore });
  addRequest(github, context, '/artifact source main', 502);
  const secondCore = makeCore();
  await request.resolveRequest({ github, context, core: secondCore });

  assert.equal(firstCore.outputs.cache_hit, 'true');
  assert.equal(secondCore.outputs.cache_hit, 'true');
  assert.equal(github.state.createdComments, 1);
  assert.equal(github.state.updatedComments, 1);
  assert.deepEqual(github.state.deletedCommentIds, [501, 502]);
  const registryComment = github.state.comments.find((comment) => comment.user?.login === request.RESULT_BOT_LOGIN);
  const entries = request.parseRegistryComment(registryComment.body);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].requestCommentIds, [502, 501]);
}

async function main() {
  await testCommandGrammar();
  await testCommandsOutsideMailboxCreateNothing();
  await testSelectorResolutionAndMissOutputs();
  await testAuthorizationFailureIsRegisteredAndCleaned();
  await testCacheHitCreatesOneRegistryAndCleansExactRequest();
  await testDeletedRequestRedeliveryIsIdempotent();
  await testSpoofedRegistryCannotClaimAuthority();
  await testRegistryEscapesUntrustedPullHeadRef();
  await testEquivalentArtifactsDeduplicateAndPreserveRequestIds();
  await testSerializedDistinctUpdatesPreserveBothEntries();
  await testRegistryPrunesExpiryOrdersNewestAndBoundsTen();
  await testMultipleAuthoritativeRegistriesFailClosed();
  await testCompletionPublishesRegistryThenStatusThenCleanup();
  await testRegistryFailureCannotPublishStatusOrDeleteCommand();
  await testStatusFailurePreservesReadyRegistryAndAllowsCleanup();
  await testCleanupFailureNeverOverwritesUsableReadyEntry();
  await testFailureEntryIsCompactBoundedAndCleaned();
  await testChangedRequestCannotFinalizeOrDelete();
  await testSequentialSameShaRequestsReuseArtifactAndUpdateOneRegistry();
  console.log('test-source-bundle-artifact-request: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
