// The source-bundle artifact request tests' support: fixed SHAs, a fake GitHub, core and context, and artifact and
// registry fixtures.

"use strict";

const assert = require("node:assert/strict");

const request = require("./source-bundle-artifact-request.cjs");

const MAIN_SHA = "1".repeat(40);
const PR_HEAD_SHA = "2".repeat(40);
const PR_BASE_SHA = "3".repeat(40);
const PR_MERGE_BASE_SHA = "4".repeat(40);
const EXACT_SHA = "5".repeat(40);
const DIGEST = "a".repeat(64);
const REPOSITORY = "TeaseScript-AI/teasescript-platform";
const MAILBOX = request.MAILBOX_ISSUE_NUMBER;
const RESULT_BOT_USER = { login: request.RESULT_BOT_LOGIN, id: request.RESULT_BOT_ID, type: "Bot" };

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeCore() {
  return {
    outputs: {},
    failures: [],
    warnings: [],
    setOutput(name, value) {
      this.outputs[name] = String(value);
    },
    setFailed(message) {
      this.failures.push(String(message));
    },
    warning(message) {
      this.warnings.push(String(message));
    },
  };
}

function makeContext(body, overrides = {}) {
  const author = overrides.author || "Dropje97";
  return {
    actor: overrides.actor || author,
    runId: overrides.runId || 7001,
    serverUrl: "https://github.com",
    repo: { owner: "TeaseScript-AI", repo: "teasescript-platform" },
    payload: {
      comment: { id: overrides.commentId || 501, body, user: { login: author } },
      issue: { number: overrides.issueNumber || MAILBOX },
    },
  };
}

function makeGithub(context, overrides = {}) {
  const requestComment = {
    id: context.payload.comment.id,
    body: context.payload.comment.body,
    user: { login: context.payload.comment.user.login, type: "User" },
  };
  const state = {
    comments: [requestComment, ...(overrides.comments || [])],
    createdStatuses: [],
    createdComments: 0,
    updatedComments: 0,
    deletedCommentIds: [],
    selectorCalls: 0,
    permissionCalls: 0,
    permissionLookups: [],
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
  state.statuses = statuses;

  const github = {
    state,
    async paginate(method, params, map) {
      return map(await method(params));
    },
    rest: {
      issues: {
        async getComment({ comment_id }) {
          const comment = state.comments.find((item) => item.id === comment_id);
          if (!comment) throw httpError(404, "comment not found");
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
          state.operations.push("create-comment");
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
          state.operations.push("update-comment");
          const comment = state.comments.find((item) => item.id === comment_id);
          if (!comment) throw httpError(404, "comment not found");
          comment.body = body;
          return { data: comment };
        },
        async deleteComment({ comment_id }) {
          if (state.deleteCommentError) throw state.deleteCommentError;
          const index = state.comments.findIndex((item) => item.id === comment_id);
          if (index < 0) throw httpError(404, "comment not found");
          state.comments.splice(index, 1);
          state.deletedCommentIds.push(comment_id);
          state.operations.push("delete-comment");
          return { status: 204 };
        },
      },
      repos: {
        async get() {
          state.selectorCalls += 1;
          return { data: { default_branch: "main" } };
        },
        async getCollaboratorPermissionLevel(input) {
          state.permissionCalls += 1;
          state.permissionLookups.push(input);
          if (overrides.permissionError) throw overrides.permissionError;
          return { data: { permission: overrides.permission || "write" } };
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
          state.operations.push("create-status");
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
          assert.equal(ref, "heads/main");
          return { data: { object: { type: "commit", sha: MAIN_SHA } } };
        },
        async getCommit({ commit_sha }) {
          state.selectorCalls += 1;
          if (overrides.missingCommit || commit_sha !== EXACT_SHA) {
            throw httpError(404, "commit not found");
          }
          return { data: { sha: commit_sha } };
        },
      },
      pulls: {
        async get({ pull_number }) {
          state.selectorCalls += 1;
          if (overrides.missingPull || pull_number !== 225) {
            throw httpError(404, "pull not found");
          }
          return {
            data: {
              head: {
                sha: PR_HEAD_SHA,
                ref: "feature/source-bundle",
                repo: { full_name: "Contributor/teasescript-platform" },
              },
              base: { sha: PR_BASE_SHA },
            },
          };
        },
      },
      actions: {
        async getArtifact({ artifact_id }) {
          const artifact = artifacts.get(artifact_id);
          if (!artifact) throw httpError(404, "artifact not found");
          return { data: artifact };
        },
        async getWorkflowRun({ run_id }) {
          const run = runs.get(run_id);
          if (!run) throw httpError(404, "run not found");
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
    user: { login: context.payload.comment.user.login, type: "User" },
  });
}

function artifactFixture({
  artifactId,
  runId,
  sourceSha,
  current = false,
  expiresAt = "2099-01-01T00:00:00Z",
}) {
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
      repository: { id: 1309933950, full_name: REPOSITORY },
      path: current
        ? ".github/workflows/patch-publication.yml"
        : ".github/workflows/source-bundle.yml",
      status: current ? "in_progress" : "completed",
      conclusion: current ? null : "success",
      event: current ? "issue_comment" : "push",
      head_sha: current ? "9".repeat(40) : sourceSha,
      head_branch: "main",
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
  expiresAt = "2099-01-01T00:00:00.000Z",
}) {
  return {
    state: "ready",
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

function failedEntry({ requestId, sourceSha = null, updatedAt = "2026-08-04T10:00:00.000Z" }) {
  return {
    state: "failed",
    requestCommentIds: [requestId],
    selector: sourceSha ? `sha:${sourceSha}` : "unresolved",
    sourceSha,
    updatedAt,
    reason: "Artifact request failed.",
    runUrl: "https://github.com/TeaseScript-AI/teasescript-platform/actions/runs/7001",
  };
}

function authoritativeRegistry(entries, id = 900) {
  return { id, body: request.formatRegistryComment(entries), user: { ...RESULT_BOT_USER } };
}

function registryBlock(body, language) {
  const match = new RegExp(`\`\`\`${language}\n([\\s\\S]*?)\n\`\`\``).exec(body);
  assert.ok(match, `registry body has no ${language} block`);
  return match[1];
}

function commandOptions(command) {
  const [executable, ...tokens] = command.replace(/\\\n/g, " ").trim().split(/\s+/);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    options[tokens[index]] = tokens[index + 1];
  }
  return { executable, options };
}

module.exports = {
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
  addRequest,
  artifactFixture,
  inputFromCore,
  readyEntry,
  failedEntry,
  authoritativeRegistry,
  registryBlock,
  commandOptions,
};
