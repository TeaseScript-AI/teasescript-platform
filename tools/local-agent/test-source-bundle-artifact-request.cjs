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
      issue: { number: overrides.issueNumber || 228 },
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
    selectorCalls: 0,
    permissionCalls: 0,
  };
  let nextCommentId = 1000;

  const artifacts = new Map(overrides.artifacts || []);
  const runs = new Map(overrides.runs || []);
  const statuses = overrides.statuses || [];

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
        async listComments() {
          return { data: [...state.comments] };
        },
        async createComment({ body }) {
          state.createdComments += 1;
          const comment = {
            id: nextCommentId++,
            body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          };
          state.comments.push(comment);
          return { data: comment };
        },
        async updateComment({ comment_id, body }) {
          state.updatedComments += 1;
          const comment = state.comments.find((item) => item.id === comment_id);
          if (!comment) throw httpError(404, 'comment not found');
          comment.body = body;
          return { data: comment };
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
          state.createdStatuses.push(input);
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

function artifactFixture({ artifactId, runId, sourceSha, current = false }) {
  return {
    artifact: {
      id: artifactId,
      name: `teasescript-source-${sourceSha}`,
      expired: false,
      expires_at: '2099-01-01T00:00:00Z',
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
        ? '.github/workflows/source-bundle-artifact-request.yml'
        : '.github/workflows/source-bundle.yml',
      status: current ? 'in_progress' : 'completed',
      conclusion: current ? null : 'success',
      event: current ? 'issue_comment' : 'push',
      head_sha: current ? '9'.repeat(40) : sourceSha,
      head_branch: current ? 'main' : 'main',
      head_repository: { id: 1309933950 },
      pull_requests: [],
    },
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/artifacts/${artifactId}`,
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
  assert.equal(
    request.parseCommand(`/artifact source sha:${EXACT_SHA}`).sourceSha,
    EXACT_SHA,
  );
  for (const invalid of [
    '/artifact source pr:0',
    '/artifact source pr:01',
    `/artifact source pr:${'9'.repeat(30)}`,
    `/artifact source sha:${'a'.repeat(40).toUpperCase()}`,
    '/artifact source branch:main',
    '/artifact  source main',
    '/artifact source',
  ]) {
    assert.throws(() => request.parseCommand(invalid), request.ArtifactRequestError);
  }
}

async function testMainResolution() {
  const context = makeContext('/artifact source main');
  const github = makeGithub(context);
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.resolved, 'true');
  assert.equal(core.outputs.cache_hit, 'false');
  assert.equal(core.outputs.source_sha, MAIN_SHA);
  assert.equal(core.outputs.source_repository, REPOSITORY);
  assert.equal(core.outputs.source_ref, 'main');
  assert.equal(github.state.createdComments, 0);
}

async function testPullResolution() {
  const context = makeContext('/artifact source pr:225');
  const github = makeGithub(context);
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.source_sha, PR_HEAD_SHA);
  assert.equal(core.outputs.source_repository, 'Contributor/teasescript-platform');
  assert.equal(core.outputs.source_ref, 'feature/source-bundle');
  assert.equal(core.outputs.pull_number, '225');
  assert.equal(core.outputs.base_sha, PR_BASE_SHA);
  assert.equal(core.outputs.merge_base_sha, PR_MERGE_BASE_SHA);
}

async function testExactShaResolution() {
  const context = makeContext(`/artifact source sha:${EXACT_SHA}`);
  const github = makeGithub(context);
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.source_sha, EXACT_SHA);
  assert.equal(core.outputs.source_ref, EXACT_SHA);
}

async function testInvalidAndMissingRequests() {
  const invalidContext = makeContext('/artifact source ref:main');
  const invalidGithub = makeGithub(invalidContext);
  const invalidCore = makeCore();
  await request.resolveRequest({ github: invalidGithub, context: invalidContext, core: invalidCore });
  assert.equal(invalidCore.failures.length, 1);
  assert.match(invalidGithub.state.comments.at(-1).body, /Invalid command/);
  assert.equal(invalidGithub.state.selectorCalls, 0);

  const missingPullContext = makeContext('/artifact source pr:225');
  const missingPullGithub = makeGithub(missingPullContext, { missingPull: true });
  const missingPullCore = makeCore();
  await request.resolveRequest({
    github: missingPullGithub,
    context: missingPullContext,
    core: missingPullCore,
  });
  assert.equal(missingPullCore.failures.length, 1);
  assert.match(missingPullGithub.state.comments.at(-1).body, /does not exist/);

  const missingShaContext = makeContext(`/artifact source sha:${EXACT_SHA}`);
  const missingShaGithub = makeGithub(missingShaContext, { missingCommit: true });
  const missingShaCore = makeCore();
  await request.resolveRequest({ github: missingShaGithub, context: missingShaContext, core: missingShaCore });
  assert.equal(missingShaCore.failures.length, 1);
  assert.match(missingShaGithub.state.comments.at(-1).body, /does not exist/);
}

async function testAuthorizationRejection() {
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, { permission: 'read' });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.match(github.state.comments.at(-1).body, /Write, Maintain, or Admin/);
  assert.equal(github.state.selectorCalls, 0);
}

async function testCacheHitAndDuplicateDelivery() {
  const artifactId = 8101;
  const runId = 9101;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: MAIN_SHA });
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, {
    statuses: [
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: fixture.url,
      },
    ],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });

  const firstCore = makeCore();
  await request.resolveRequest({ github, context, core: firstCore });
  assert.equal(firstCore.outputs.cache_hit, 'true');
  assert.equal(github.state.createdComments, 1);
  assert.match(github.state.comments.at(-1).body, /## Artifact ready/);
  assert.ok(github.state.comments.at(-1).body.includes(`Artifact ID: \`${artifactId}\``));
  assert.match(github.state.comments.at(-1).body, /prepare-agent-workspace\.sh/);
  assert.match(github.state.comments.at(-1).body, /GitHub\.download_workflow_artifact/);
  assert.match(github.state.comments.at(-1).body, /"artifact_id": 8101/);

  const secondCore = makeCore();
  await request.resolveRequest({ github, context, core: secondCore });
  assert.equal(secondCore.outputs.cache_hit, 'true');
  assert.equal(github.state.createdComments, 1);
  assert.equal(github.state.updatedComments, 1);
  assert.equal(
    github.state.comments.filter((comment) => comment.user.type === 'Bot').length,
    1,
  );
}

async function testForkPullRequestCacheHitUsesPullHeadIdentity() {
  const artifactId = 8151;
  const runId = 9151;
  const fixture = artifactFixture({ artifactId, runId, sourceSha: PR_HEAD_SHA });
  fixture.run.event = 'pull_request';
  fixture.run.head_repository = { id: 22002 };
  fixture.run.head_branch = 'feature/source-bundle';
  fixture.run.head_sha = 'f'.repeat(40);
  fixture.run.pull_requests = [
    {
      base: { repo: { id: 1309933950 } },
      head: {
        repo: { id: 22002 },
        ref: 'feature/source-bundle',
        sha: PR_HEAD_SHA,
      },
    },
  ];
  const context = makeContext('/artifact source pr:225');
  const github = makeGithub(context, {
    statuses: [
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: fixture.url,
      },
    ],
    artifacts: [[artifactId, fixture.artifact]],
    runs: [[runId, fixture.run]],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, 'true');
  const body = github.state.comments.at(-1).body;
  assert.match(body, /Requested: `pr:225`/);
  assert.match(body, /PR head: `Contributor\/teasescript-platform:feature\/source-bundle`/);
}

async function testStaleOrUntrustedIndexBecomesCacheMiss() {
  const expiredArtifactId = 8401;
  const expiredRunId = 9401;
  const expired = artifactFixture({
    artifactId: expiredArtifactId,
    runId: expiredRunId,
    sourceSha: MAIN_SHA,
  });
  expired.artifact.expired = true;

  const untrustedArtifactId = 8402;
  const untrustedRunId = 9402;
  const untrusted = artifactFixture({
    artifactId: untrustedArtifactId,
    runId: untrustedRunId,
    sourceSha: MAIN_SHA,
  });
  untrusted.run.path = '.github/workflows/untrusted.yml';

  const wrongHeadArtifactId = 8403;
  const wrongHeadRunId = 9403;
  const wrongHead = artifactFixture({
    artifactId: wrongHeadArtifactId,
    runId: wrongHeadRunId,
    sourceSha: MAIN_SHA,
  });
  wrongHead.run.head_sha = EXACT_SHA;

  const context = makeContext('/artifact source main');
  const github = makeGithub(context, {
    statuses: [
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: `https://github.com/${REPOSITORY}/actions/runs/9999/artifacts/9999`,
      },
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: expired.url,
      },
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: untrusted.url,
      },
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: wrongHead.url,
      },
    ],
    artifacts: [
      [expiredArtifactId, expired.artifact],
      [untrustedArtifactId, untrusted.artifact],
      [wrongHeadArtifactId, wrongHead.artifact],
    ],
    runs: [
      [expiredRunId, expired.run],
      [untrustedRunId, untrusted.run],
      [wrongHeadRunId, wrongHead.run],
    ],
  });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, 'false');
  assert.equal(github.state.createdComments, 0);
}

async function testUnexpectedArtifactApiFailureIsNotTreatedAsMiss() {
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, {
    statuses: [
      {
        context: request.STATUS_CONTEXT,
        state: 'success',
        target_url: `https://github.com/${REPOSITORY}/actions/runs/9501/artifacts/8501`,
      },
    ],
  });
  github.rest.actions.getArtifact = async () => {
    throw httpError(500, 'artifact service unavailable');
  };
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.equal(core.failures.length, 1);
  assert.match(github.state.comments.at(-1).body, /artifact service unavailable/);
}

async function testMissingStatusRefIsACacheMiss() {
  const context = makeContext('/artifact source main');
  const github = makeGithub(context, { statusError: httpError(404, 'status ref not found') });
  const core = makeCore();
  await request.resolveRequest({ github, context, core });

  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, 'false');
  assert.equal(github.state.createdComments, 0);
}

async function testCompletionPublishesFixedStatusAndExactResult() {
  const artifactId = 8201;
  const context = makeContext('/artifact source pr:225', { runId: 9201 });
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
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.cache_hit, 'false');

  await request.completeRequest({
    github,
    context,
    input: {
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
      artifactUrl: fixture.url,
      artifactDigest: DIGEST,
    },
  });

  assert.equal(github.state.createdStatuses.length, 1);
  assert.deepEqual(github.state.createdStatuses[0], {
    owner: 'TeaseScript-AI',
    repo: 'teasescript-platform',
    sha: PR_HEAD_SHA,
    state: 'success',
    context: request.STATUS_CONTEXT,
    description: `artifact ${artifactId} sha256:${DIGEST}`,
    target_url: fixture.url,
  });
  const resultBody = github.state.comments.at(-1).body;
  assert.match(resultBody, /Requested: `pr:225`/);
  assert.ok(resultBody.includes(`PR merge-base SHA: \`${PR_MERGE_BASE_SHA}\``));
  assert.match(resultBody, new RegExp(`--expected-merge-base ${PR_MERGE_BASE_SHA}`));
  assert.match(resultBody, new RegExp(`"artifact_id": ${artifactId}`));
  assert.ok(resultBody.includes(`SHA-256: \`${DIGEST}\``));
  assert.match(
    resultBody,
    /teasescript-agent-bootstrap-linux-x64\/bin\/prepare-agent-workspace\.sh/,
  );
  assert.equal(github.state.permissionCalls, 1);
}

async function testChangedRequestCannotFinalize() {
  const artifactId = 8301;
  const context = makeContext('/artifact source main', { runId: 9301 });
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
  github.state.comments[0].body = '/artifact source pr:225';

  await assert.rejects(
    request.completeRequest({
      github,
      context,
      input: {
        requestCommentId: core.outputs.request_comment_id,
        requestAuthor: core.outputs.request_author,
        requestBodySha256: core.outputs.request_body_sha256,
        issueNumber: String(context.payload.issue.number),
        selector: core.outputs.selector,
        selectorType: core.outputs.selector_type,
        sourceSha: core.outputs.source_sha,
        sourceRepository: core.outputs.source_repository,
        sourceRef: core.outputs.source_ref,
        pullNumber: '',
        headRepository: '',
        headRef: '',
        baseSha: '',
        mergeBaseSha: '',
        artifactId: String(artifactId),
        artifactUrl: fixture.url,
        artifactDigest: DIGEST,
      },
    }),
    /changed while the artifact request was running/,
  );
  assert.equal(github.state.createdStatuses.length, 0);
}

async function main() {
  await testCommandGrammar();
  await testMainResolution();
  await testPullResolution();
  await testExactShaResolution();
  await testInvalidAndMissingRequests();
  await testAuthorizationRejection();
  await testCacheHitAndDuplicateDelivery();
  await testForkPullRequestCacheHitUsesPullHeadIdentity();
  await testStaleOrUntrustedIndexBecomesCacheMiss();
  await testUnexpectedArtifactApiFailureIsNotTreatedAsMiss();
  await testMissingStatusRefIsACacheMiss();
  await testCompletionPublishesFixedStatusAndExactResult();
  await testChangedRequestCannotFinalize();
  console.log('test-source-bundle-artifact-request: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});