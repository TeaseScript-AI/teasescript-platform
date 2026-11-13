"use strict";

const {
  ARTIFACT_KIND,
  STATUS_CONTEXT,
  MAILBOX_ISSUE_NUMBER,
  REGISTRY_LIMIT,
  REGISTRY_MARKER,
  DIGEST_PATTERN,
  ARTIFACT_ID_PATTERN,
  RESULT_BOT_LOGIN,
  RESULT_BOT_ID,
  ArtifactRequestError,
  requireFullSha,
  parseCommand,
  normalizeDigest,
  hashRequestBody,
} = require("./source-bundle-artifact-request-shared.cjs");
const {
  formatPreparationCommand,
  parseRegistryComment,
  compactFailureReason,
  formatInlineCode,
  formatRegistryComment,
  mergeRegistryEntries,
  readRegistry,
  findRegistryEntry,
  upsertRegistryEntry,
} = require("./source-bundle-artifact-request-registry.cjs");
const {
  parseArtifactTargetUrl,
  getLiveRequestComment,
  authorizeRequest,
  resolveSelector,
  verifyArtifactMetadata,
  findCachedArtifact,
} = require("./source-bundle-artifact-request-lookup.cjs");

function setIdentityOutputs(core, identity, request) {
  core.setOutput("resolved", "true");
  core.setOutput("cache_hit", "false");
  core.setOutput("request_comment_id", String(request.commentId));
  core.setOutput("request_author", request.author);
  core.setOutput("request_body_sha256", request.bodyHash);
  core.setOutput("selector", identity.selector);
  core.setOutput("selector_type", identity.selectorType);
  core.setOutput("source_sha", identity.sourceSha);
  core.setOutput("source_repository", identity.sourceRepository);
  core.setOutput("source_ref", identity.sourceRef);
  core.setOutput("pull_number", identity.pullNumber ? String(identity.pullNumber) : "");
  core.setOutput("head_repository", identity.headRepository || "");
  core.setOutput("head_ref", identity.headRef || "");
  core.setOutput("base_sha", identity.baseSha || "");
  core.setOutput("merge_base_sha", identity.mergeBaseSha || "");
}

function resultFromIdentity({
  context,
  request,
  identity,
  artifact,
  updatedAt = new Date().toISOString(),
}) {
  return {
    state: "ready",
    repository: `${context.repo.owner}/${context.repo.repo}`,
    requestCommentIds: [request.commentId],
    selector: identity.selector,
    sourceSha: identity.sourceSha,
    sourceRepository: identity.sourceRepository,
    sourceRef: identity.sourceRef,
    pullNumber: identity.pullNumber,
    headRepository: identity.headRepository,
    headRef: identity.headRef,
    baseSha: identity.baseSha,
    mergeBaseSha: identity.mergeBaseSha,
    updatedAt,
    ...artifact,
  };
}

function failureEntry({ context, requestCommentId, selector, sourceSha = null, message }) {
  return {
    state: "failed",
    requestCommentIds: [requestCommentId],
    selector: selector || "unresolved",
    sourceSha,
    updatedAt: new Date().toISOString(),
    reason: compactFailureReason(message),
    runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  };
}

async function registryEntryForRequest({ github, context, requestCommentId }) {
  const registry = await readRegistry({ github, context });
  return findRegistryEntry(registry.entries, requestCommentId);
}

async function cleanupRequestComment({ github, context, request }) {
  let live;
  try {
    live = await getLiveRequestComment({
      github,
      context,
      requestCommentId: request.commentId,
      expectedAuthor: request.author,
      expectedBodyHash: request.bodyHash,
    });
  } catch (error) {
    if (error.status === 404) {
      const persisted = await registryEntryForRequest({
        github,
        context,
        requestCommentId: request.commentId,
      });
      if (persisted) return false;
    }
    throw error;
  }
  if (live.id !== request.commentId) {
    throw new ArtifactRequestError("The cleanup target did not match the exact request comment.");
  }
  try {
    await github.rest.issues.deleteComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: request.commentId,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return true;
}

async function cleanupRequestCommentBestEffort({ github, context, request, core }) {
  try {
    return await cleanupRequestComment({ github, context, request });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core?.warning?.(`Artifact result is available, but request-comment cleanup failed: ${message}`);
    return false;
  }
}

async function publishFailure({ github, context, request, selector, sourceSha, message }) {
  return upsertRegistryEntry({
    github,
    context,
    entry: failureEntry({
      context,
      requestCommentId: request.commentId,
      selector,
      sourceSha,
      message,
    }),
  });
}

async function resolveRequest({ github, context, core }) {
  const eventComment = context.payload.comment;
  const eventIssue = context.payload.issue;
  const request = {
    commentId: Number(eventComment?.id),
    issueNumber: Number(eventIssue?.number),
    author: eventComment?.user?.login || "",
    body: eventComment?.body || "",
  };
  request.bodyHash = hashRequestBody(request.body);
  let selector = null;
  let sourceSha = null;

  try {
    if (
      !Number.isSafeInteger(request.commentId) ||
      !Number.isSafeInteger(request.issueNumber) ||
      !request.author
    ) {
      throw new ArtifactRequestError(
        "The issue-comment event did not contain a complete request identity.",
      );
    }
    if (request.issueNumber !== MAILBOX_ISSUE_NUMBER) {
      throw new ArtifactRequestError(
        `Artifact requests are accepted only in issue #${MAILBOX_ISSUE_NUMBER}.`,
      );
    }

    let liveComment;
    try {
      liveComment = await getLiveRequestComment({
        github,
        context,
        requestCommentId: request.commentId,
        expectedAuthor: request.author,
        expectedBodyHash: request.bodyHash,
      });
    } catch (error) {
      if (error.status === 404) {
        const persisted = await registryEntryForRequest({
          github,
          context,
          requestCommentId: request.commentId,
        });
        if (persisted) {
          core.setOutput("resolved", "false");
          core.setOutput("cache_hit", persisted.state === "ready" ? "true" : "false");
          return;
        }
        core.setOutput("resolved", "false");
        core.setOutput("cache_hit", "false");
        return;
      }
      throw error;
    }

    const persisted = await registryEntryForRequest({
      github,
      context,
      requestCommentId: request.commentId,
    });
    if (persisted) {
      core.setOutput("resolved", "false");
      core.setOutput("cache_hit", persisted.state === "ready" ? "true" : "false");
      await cleanupRequestCommentBestEffort({ github, context, request, core });
      return;
    }

    await authorizeRequest({ github, context, author: request.author });
    const parsed = parseCommand(liveComment.body);
    selector = parsed.selector;
    const identity = await resolveSelector({ github, context, parsed });
    sourceSha = identity.sourceSha;
    setIdentityOutputs(core, identity, request);

    const cached = await findCachedArtifact({ github, context, sourceSha: identity.sourceSha });
    if (cached) {
      core.setOutput("cache_hit", "true");
      await upsertRegistryEntry({
        github,
        context,
        entry: resultFromIdentity({ context, request, identity, artifact: cached }),
      });
      await cleanupRequestCommentBestEffort({ github, context, request, core });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput("resolved", "false");
    if (
      Number.isSafeInteger(request.commentId) &&
      Number.isSafeInteger(request.issueNumber) &&
      request.issueNumber === MAILBOX_ISSUE_NUMBER
    ) {
      try {
        const existing = await registryEntryForRequest({
          github,
          context,
          requestCommentId: request.commentId,
        });
        if (!existing) {
          await publishFailure({ github, context, request, selector, sourceSha, message });
        }
        await cleanupRequestComment({ github, context, request });
      } catch (publicationError) {
        const publicationMessage =
          publicationError instanceof Error ? publicationError.message : String(publicationError);
        core.setFailed(
          `${message} Result or cleanup publication also failed: ${publicationMessage}`,
        );
        return;
      }
    }
    core.setFailed(message);
  }
}

function identityFromInput(input) {
  const parsed = parseCommand(`/artifact source ${input.selector || ""}`);
  if (parsed.selectorType !== input.selectorType) {
    throw new ArtifactRequestError("The resolved selector type is inconsistent.");
  }

  const sourceSha = requireFullSha(input.sourceSha, "The resolved source");
  if (!input.sourceRepository || !input.sourceRef) {
    throw new ArtifactRequestError("The resolved source repository or ref is missing.");
  }

  if (parsed.selectorType === "sha" && parsed.sourceSha !== sourceSha) {
    throw new ArtifactRequestError("The exact selector no longer matches the resolved source SHA.");
  }

  if (parsed.selectorType === "pr") {
    const pullNumber = Number.parseInt(input.pullNumber, 10);
    if (
      pullNumber !== parsed.pullNumber ||
      !input.headRepository ||
      !input.headRef ||
      input.sourceRepository !== input.headRepository ||
      input.sourceRef !== input.headRef
    ) {
      throw new ArtifactRequestError("The resolved pull-request identity is inconsistent.");
    }
    return {
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      sourceSha,
      sourceRepository: input.sourceRepository,
      sourceRef: input.sourceRef,
      pullNumber,
      headRepository: input.headRepository,
      headRef: input.headRef,
      baseSha: requireFullSha(input.baseSha, "The resolved pull-request base"),
      mergeBaseSha: requireFullSha(input.mergeBaseSha, "The resolved pull-request merge base"),
    };
  }

  if (
    input.pullNumber ||
    input.headRepository ||
    input.headRef ||
    input.baseSha ||
    input.mergeBaseSha
  ) {
    throw new ArtifactRequestError("A non-PR selector contained pull-request identity fields.");
  }

  return {
    selector: parsed.selector,
    selectorType: parsed.selectorType,
    sourceSha,
    sourceRepository: input.sourceRepository,
    sourceRef: input.sourceRef,
    pullNumber: null,
    headRepository: null,
    headRef: null,
    baseSha: null,
    mergeBaseSha: null,
  };
}

function requestFromInput(input) {
  const commentId = Number.parseInt(input.requestCommentId, 10);
  const issueNumber = Number.parseInt(input.issueNumber, 10);
  if (!Number.isSafeInteger(commentId) || issueNumber !== MAILBOX_ISSUE_NUMBER) {
    throw new ArtifactRequestError(
      "The resolved request identity is invalid or outside the Artifact mailbox.",
    );
  }
  if (!DIGEST_PATTERN.test(input.requestBodySha256 || "")) {
    throw new ArtifactRequestError("The request body identity is invalid.");
  }
  if (!input.requestAuthor) {
    throw new ArtifactRequestError("The request author identity is invalid.");
  }
  return { commentId, issueNumber, author: input.requestAuthor, bodyHash: input.requestBodySha256 };
}

async function completeRequest({ github, context, core, input }) {
  const request = requestFromInput(input);
  const identity = identityFromInput(input);
  try {
    await getLiveRequestComment({
      github,
      context,
      requestCommentId: request.commentId,
      expectedAuthor: request.author,
      expectedBodyHash: request.bodyHash,
    });
  } catch (error) {
    if (error.status === 404) {
      const persisted = await registryEntryForRequest({
        github,
        context,
        requestCommentId: request.commentId,
      });
      if (persisted?.state === "ready") return;
    }
    throw error;
  }
  if (context.actor !== request.author) {
    throw new ArtifactRequestError(
      "The workflow actor no longer matches the request comment author.",
    );
  }

  const expectedArtifactId = Number.parseInt(input.artifactId, 10);
  if (
    !ARTIFACT_ID_PATTERN.test(input.artifactId || "") ||
    !Number.isSafeInteger(expectedArtifactId)
  ) {
    throw new ArtifactRequestError("The upload step did not return a valid artifact ID.");
  }

  const artifact = await verifyArtifactMetadata({
    github,
    context,
    sourceSha: identity.sourceSha,
    targetUrl: input.artifactUrl,
    expectedArtifactId,
    expectedDigest: input.artifactDigest,
    allowCurrentRun: true,
  });

  await upsertRegistryEntry({
    github,
    context,
    entry: resultFromIdentity({ context, request, identity, artifact }),
  });

  await cleanupRequestCommentBestEffort({ github, context, request, core });

  await github.rest.repos.createCommitStatus({
    owner: context.repo.owner,
    repo: context.repo.repo,
    sha: identity.sourceSha,
    state: "success",
    context: STATUS_CONTEXT,
    description: `artifact ${artifact.artifactId} sha256:${artifact.artifactDigest}`,
    target_url: artifact.artifactUrl,
  });
}

async function reportProductionFailure({ github, context, core, input }) {
  const request = requestFromInput(input);
  const existing = await registryEntryForRequest({
    github,
    context,
    requestCommentId: request.commentId,
  });
  if (existing) {
    if (existing.state === "ready" && existing.producerRunId === context.runId) {
      await publishFailure({
        github,
        context,
        request,
        selector: input.selector,
        sourceSha: input.sourceSha || null,
        message:
          "Source-bundle production or fixed-index publication failed. Inspect the linked workflow run for the exact failing step.",
      });
    }
    await cleanupRequestCommentBestEffort({ github, context, request, core });
    return;
  }

  try {
    await getLiveRequestComment({
      github,
      context,
      requestCommentId: request.commentId,
      expectedAuthor: request.author,
      expectedBodyHash: request.bodyHash,
    });
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }

  await publishFailure({
    github,
    context,
    request,
    selector: input.selector,
    sourceSha: input.sourceSha || null,
    message:
      "Source-bundle production or result publication failed. Inspect the linked workflow run for the exact failing step.",
  });
  await cleanupRequestCommentBestEffort({ github, context, request, core });
}

module.exports = {
  ARTIFACT_KIND,
  MAILBOX_ISSUE_NUMBER,
  REGISTRY_LIMIT,
  REGISTRY_MARKER,
  RESULT_BOT_ID,
  RESULT_BOT_LOGIN,
  STATUS_CONTEXT,
  ArtifactRequestError,
  cleanupRequestComment,
  compactFailureReason,
  completeRequest,
  findCachedArtifact,
  findRegistryEntry,
  formatInlineCode,
  formatPreparationCommand,
  formatRegistryComment,
  mergeRegistryEntries,
  normalizeDigest,
  parseArtifactTargetUrl,
  parseCommand,
  parseRegistryComment,
  readRegistry,
  reportProductionFailure,
  resolveRequest,
  resolveSelector,
  upsertRegistryEntry,
  verifyArtifactMetadata,
};
