// The artifact request registry: the one authenticated comment on the mailbox issue that lists recent requests, its
// entries' normal form and text, merging and bounding them, and reading and updating it. The trusted workflow loads it
// through source-bundle-artifact-request.cjs.

"use strict";

const {
  MAILBOX_ISSUE_NUMBER,
  REGISTRY_LIMIT,
  REGISTRY_MARKER,
  REGISTRY_STATE_PREFIX,
  FAILURE_REASON_LIMIT,
  RESULT_BOT_LOGIN,
  RESULT_BOT_ID,
  PREPARATION_HELPER,
  ArtifactRequestError,
  requireFullSha,
  normalizeDigest,
  normalizeTimestamp,
  normalizeRequestIds,
} = require("./source-bundle-artifact-request-shared.cjs");

function requestSuffix(requestCommentId) {
  if (!Number.isSafeInteger(requestCommentId) || requestCommentId <= 0) {
    throw new ArtifactRequestError("The result request-comment identity is invalid.");
  }
  return `request-${requestCommentId}`;
}

function artifactFileName(sourceSha, requestCommentId) {
  return `teasescript-source-${sourceSha}-${requestSuffix(requestCommentId)}.zip`;
}

function workspaceName(sourceSha, requestCommentId) {
  return `source-${sourceSha.slice(0, 12)}-${requestSuffix(requestCommentId)}`;
}

function formatDownloadArguments(result) {
  return {
    repo_full_name: result.repository,
    artifact_id: result.artifactId,
    file_name: artifactFileName(result.sourceSha, result.requestCommentIds[0]),
  };
}

function formatPreparationCommand(result) {
  const requestCommentId = result.requestCommentIds[0];
  const lines = [
    `${PREPARATION_HELPER} \\`,
    `  --artifact /mnt/data/${artifactFileName(result.sourceSha, requestCommentId)} \\`,
    `  --artifact-sha256 ${result.artifactDigest} \\`,
    `  --expected-repository ${result.repository} \\`,
    `  --expected-head ${result.sourceSha} \\`,
  ];
  if (result.mergeBaseSha) {
    lines.push(`  --expected-merge-base ${result.mergeBaseSha} \\`);
  }
  lines.push(`  --output /mnt/data/${workspaceName(result.sourceSha, requestCommentId)}`);
  return lines.join("\n");
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== "object" || !["ready", "failed"].includes(entry.state)) {
    throw new ArtifactRequestError(
      "The Artifact mailbox registry contained an invalid entry state.",
    );
  }
  const normalized = {
    state: entry.state,
    requestCommentIds: normalizeRequestIds(entry.requestCommentIds),
    selector: typeof entry.selector === "string" && entry.selector ? entry.selector : "unresolved",
    sourceSha: entry.sourceSha || null,
    updatedAt: normalizeTimestamp(entry.updatedAt, "A registry entry"),
  };

  if (entry.sourceSha !== null && entry.sourceSha !== undefined) {
    normalized.sourceSha = requireFullSha(entry.sourceSha, "A registry source identity");
  }

  if (entry.state === "failed") {
    normalized.reason = compactFailureReason(entry.reason || "Artifact request failed.");
    normalized.runUrl = typeof entry.runUrl === "string" ? entry.runUrl : "";
    return normalized;
  }

  const artifactId = Number(entry.artifactId);
  const producerRunId = Number(entry.producerRunId);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
    throw new ArtifactRequestError("A ready registry entry contained an invalid artifact ID.");
  }
  if (!Number.isSafeInteger(producerRunId) || producerRunId <= 0) {
    throw new ArtifactRequestError("A ready registry entry contained an invalid producer run ID.");
  }
  if (!normalized.sourceSha) {
    throw new ArtifactRequestError("A ready registry entry did not contain a resolved source SHA.");
  }

  Object.assign(normalized, {
    repository: entry.repository,
    sourceRepository: entry.sourceRepository,
    sourceRef: entry.sourceRef,
    pullNumber: entry.pullNumber || null,
    headRepository: entry.headRepository || null,
    headRef: entry.headRef || null,
    baseSha: entry.baseSha || null,
    mergeBaseSha: entry.mergeBaseSha || null,
    artifactId,
    artifactName: entry.artifactName,
    artifactDigest: normalizeDigest(entry.artifactDigest),
    producerRunId,
    artifactUrl: entry.artifactUrl,
    expiresAt: entry.expiresAt ? normalizeTimestamp(entry.expiresAt, "A registry expiry") : null,
  });
  if (
    !normalized.repository ||
    !normalized.sourceRepository ||
    !normalized.sourceRef ||
    !normalized.artifactUrl
  ) {
    throw new ArtifactRequestError("A ready registry entry was incomplete.");
  }
  if (normalized.pullNumber) {
    normalized.pullNumber = Number(normalized.pullNumber);
    if (!Number.isSafeInteger(normalized.pullNumber) || normalized.pullNumber <= 0) {
      throw new ArtifactRequestError(
        "A ready registry entry contained an invalid pull-request number.",
      );
    }
    normalized.baseSha = requireFullSha(normalized.baseSha, "A registry pull-request base");
    normalized.mergeBaseSha = requireFullSha(
      normalized.mergeBaseSha,
      "A registry pull-request merge base",
    );
    if (!normalized.headRepository || !normalized.headRef) {
      throw new ArtifactRequestError(
        "A ready registry entry contained an incomplete pull-request head identity.",
      );
    }
  }
  return normalized;
}

function encodeRegistryState(entries) {
  return Buffer.from(JSON.stringify({ entries }), "utf8").toString("base64url");
}

function parseRegistryComment(body) {
  if (
    typeof body !== "string" ||
    !body.startsWith(`${REGISTRY_MARKER}\n${REGISTRY_STATE_PREFIX}`)
  ) {
    throw new ArtifactRequestError("The Artifact mailbox registry marker was invalid.");
  }
  const stateLine = body.split("\n", 3)[1];
  if (!stateLine.endsWith(" -->")) {
    throw new ArtifactRequestError("The Artifact mailbox registry state marker was invalid.");
  }
  const encoded = stateLine.slice(REGISTRY_STATE_PREFIX.length, -4);
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ArtifactRequestError("The Artifact mailbox registry state could not be decoded.");
  }
  if (!decoded || !Array.isArray(decoded.entries)) {
    throw new ArtifactRequestError("The Artifact mailbox registry state was incomplete.");
  }
  return decoded.entries.map(normalizeRegistryEntry);
}

function compactFailureReason(value) {
  const compact = String(value || "Artifact request failed.")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= FAILURE_REASON_LIMIT) return compact;
  return `${compact.slice(0, FAILURE_REASON_LIMIT - 1)}…`;
}

function formatInlineCode(value) {
  const text = String(value);
  const runs = text.match(/`+/g) || [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function formatRegistryEntry(entry) {
  const resolved = entry.sourceSha || "unresolved";
  const lines = [
    `### \`${entry.selector}\` -> \`${resolved}\` · ${entry.state} · \`${entry.updatedAt}\``,
    "",
  ];
  if (entry.state === "failed") {
    lines.push(
      `\`request ${entry.requestCommentIds[0]}\` · run ${entry.runUrl || "unavailable"}`,
      "",
      `Reason: ${entry.reason}`,
    );
    return lines.join("\n");
  }

  lines.push(
    `\`requests ${entry.requestCommentIds.join(", ")}\` · \`artifact ${entry.artifactId}\` · \`run ${entry.producerRunId}\` · \`expires ${entry.expiresAt || "unavailable"}\``,
  );
  if (entry.pullNumber) {
    lines.push(
      `\`PR #${entry.pullNumber}\`` +
        ` · head ${formatInlineCode(`${entry.headRepository}:${entry.headRef}`)}` +
        ` · base ${formatInlineCode(entry.baseSha)}` +
        ` · merge-base ${formatInlineCode(entry.mergeBaseSha)}`,
    );
  }
  lines.push(
    "",
    "`GitHub.download_workflow_artifact`",
    "",
    "```json",
    JSON.stringify(formatDownloadArguments(entry)),
    "```",
    "",
    "```shell",
    formatPreparationCommand(entry),
    "```",
  );
  return lines.join("\n");
}

function formatRegistryComment(entries) {
  const normalized = entries.map(normalizeRegistryEntry);
  const lines = [
    REGISTRY_MARKER,
    `${REGISTRY_STATE_PREFIX}${encodeRegistryState(normalized)} -->`,
    "# Artifact mailbox registry",
    "",
    "Newest entries first. Match the exact `request <id>` or `requests <id, ...>` value.",
  ];
  for (const entry of normalized) {
    lines.push("", formatRegistryEntry(entry));
  }
  return lines.join("\n");
}

function isExpiredEntry(entry, nowMs) {
  return entry.state === "ready" && entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs;
}

function sameReadyArtifact(left, right) {
  return (
    left.state === "ready" &&
    right.state === "ready" &&
    left.sourceSha === right.sourceSha &&
    left.artifactId === right.artifactId &&
    left.artifactDigest === right.artifactDigest &&
    left.artifactUrl === right.artifactUrl
  );
}

function sameResolvedIdentity(left, right) {
  return (
    left.selector === right.selector &&
    left.sourceSha === right.sourceSha &&
    left.sourceRepository === right.sourceRepository &&
    left.sourceRef === right.sourceRef &&
    left.pullNumber === right.pullNumber &&
    left.headRepository === right.headRepository &&
    left.headRef === right.headRef &&
    left.baseSha === right.baseSha &&
    left.mergeBaseSha === right.mergeBaseSha
  );
}

function boundRegistryEntries(entries) {
  let remaining = REGISTRY_LIMIT;
  const bounded = [];
  for (const entry of entries) {
    if (remaining === 0) break;
    const requestCommentIds = entry.requestCommentIds.slice(0, remaining);
    if (requestCommentIds.length === 0) continue;
    bounded.push({ ...entry, requestCommentIds });
    remaining -= requestCommentIds.length;
  }
  return bounded;
}

function mergeRegistryEntries(existingEntries, incomingEntry, now = new Date()) {
  const nowMs = now.getTime();
  const incoming = normalizeRegistryEntry(incomingEntry);
  const incomingIds = new Set(incoming.requestCommentIds);
  const retained = existingEntries
    .map(normalizeRegistryEntry)
    .filter((entry) => !isExpiredEntry(entry, nowMs))
    .filter((entry) => !entry.requestCommentIds.some((id) => incomingIds.has(id)));

  if (incoming.state === "ready") {
    const equivalentIndex = retained.findIndex(
      (entry) => sameReadyArtifact(entry, incoming) && sameResolvedIdentity(entry, incoming),
    );
    if (equivalentIndex >= 0) {
      const equivalent = retained.splice(equivalentIndex, 1)[0];
      incoming.requestCommentIds = normalizeRequestIds([
        ...incoming.requestCommentIds,
        ...equivalent.requestCommentIds,
      ]);
    }
  }

  return boundRegistryEntries(
    [incoming, ...retained].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    ),
  );
}

async function listAllIssueComments(github, context, issueNumber) {
  return github.paginate(
    github.rest.issues.listComments,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      per_page: 100,
    },
    (response) => response.data,
  );
}

function hasExpectedResultAuthor(comment) {
  return (
    comment?.user?.login === RESULT_BOT_LOGIN &&
    comment.user.type === "Bot" &&
    comment.user.id === RESULT_BOT_ID
  );
}

function requireExpectedResultAuthor(comment) {
  if (!hasExpectedResultAuthor(comment)) {
    throw new ArtifactRequestError(
      `The registry comment was not authored by the expected ${RESULT_BOT_LOGIN} identity.`,
    );
  }
  return comment;
}

async function readRegistry({ github, context, issueNumber = MAILBOX_ISSUE_NUMBER }) {
  const comments = await listAllIssueComments(github, context, issueNumber);
  const matching = comments.filter(
    (comment) =>
      hasExpectedResultAuthor(comment) &&
      typeof comment.body === "string" &&
      comment.body.startsWith(REGISTRY_MARKER),
  );
  if (matching.length > 1) {
    throw new ArtifactRequestError(
      "More than one authoritative Artifact mailbox registry comment exists.",
    );
  }
  if (matching.length === 0) return { comment: null, entries: [] };
  return { comment: matching[0], entries: parseRegistryComment(matching[0].body) };
}

function findRegistryEntry(entries, requestCommentId) {
  return entries.find((entry) => entry.requestCommentIds.includes(requestCommentId)) || null;
}

async function upsertRegistryEntry({ github, context, entry }) {
  const registry = await readRegistry({ github, context });
  const entries = mergeRegistryEntries(registry.entries, entry);
  const body = formatRegistryComment(entries);
  let response;
  if (registry.comment) {
    response = await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: registry.comment.id,
      body,
    });
  } else {
    response = await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: MAILBOX_ISSUE_NUMBER,
      body,
    });
  }
  requireExpectedResultAuthor(response.data);
  const persistedEntries = parseRegistryComment(response.data.body);
  const persisted = findRegistryEntry(persistedEntries, entry.requestCommentIds[0]);
  if (!persisted || persisted.state !== entry.state) {
    throw new ArtifactRequestError(
      "The authoritative registry update did not preserve the request result.",
    );
  }
  return persisted;
}

module.exports = {
  formatPreparationCommand,
  parseRegistryComment,
  compactFailureReason,
  formatInlineCode,
  formatRegistryComment,
  mergeRegistryEntries,
  readRegistry,
  findRegistryEntry,
  upsertRegistryEntry,
};
