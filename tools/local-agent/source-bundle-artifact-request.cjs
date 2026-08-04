'use strict';

const crypto = require('node:crypto');

const ARTIFACT_KIND = 'source';
const STATUS_CONTEXT = 'source-bundle/artifact-v1';
const MAILBOX_ISSUE_NUMBER = 235;
const REGISTRY_VERSION = 1;
const REGISTRY_LIMIT = 10;
const REGISTRY_MARKER = `<!-- source-bundle-artifact-registry:v${REGISTRY_VERSION} -->`;
const REGISTRY_STATE_PREFIX = `<!-- source-bundle-artifact-registry-state:v${REGISTRY_VERSION}:`;
const FAILURE_REASON_LIMIT = 240;
const COMMAND_PATTERN = /^\/artifact source (main|pr:[1-9][0-9]*|sha:[0-9a-f]{40})$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_ID_PATTERN = /^[1-9][0-9]*$/;
const ALLOWED_PERMISSIONS = new Set(['write', 'admin']);
const RESULT_BOT_LOGIN = 'github-actions[bot]';
const RESULT_BOT_ID = 41898282;
const PREPARATION_HELPER =
  '/mnt/data/teasescript-agent-bootstrap-linux-x64/bin/prepare-agent-workspace.sh';
const TRUSTED_PRODUCER_PATHS = new Set([
  '.github/workflows/source-bundle.yml',
  '.github/workflows/source-bundle-request-processor.yml',
  '.github/workflows/source-bundle-artifact-request.yml',
]);

class ArtifactRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactRequestError';
  }
}

function requireFullSha(value, label) {
  if (!FULL_SHA_PATTERN.test(value || '')) {
    throw new ArtifactRequestError(`${label} did not resolve to a full lowercase commit SHA.`);
  }
  return value;
}

function parseCommand(body) {
  const normalized = typeof body === 'string' ? body : '';
  const match = COMMAND_PATTERN.exec(normalized);
  if (!match) {
    throw new ArtifactRequestError(
      'Invalid command. Use exactly `/artifact source main`, `/artifact source pr:<number>`, or `/artifact source sha:<full-40-character-sha>`.',
    );
  }

  const selector = match[1];
  if (selector === 'main') {
    return { selector, selectorType: 'main' };
  }
  if (selector.startsWith('pr:')) {
    const pullNumber = Number.parseInt(selector.slice(3), 10);
    if (!Number.isSafeInteger(pullNumber)) {
      throw new ArtifactRequestError('The pull-request number is outside the supported integer range.');
    }
    return {
      selector,
      selectorType: 'pr',
      pullNumber,
    };
  }
  return {
    selector,
    selectorType: 'sha',
    sourceSha: selector.slice(4),
  };
}

function normalizeDigest(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (DIGEST_PATTERN.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('sha256:') && DIGEST_PATTERN.test(normalized.slice(7))) {
    return normalized.slice(7);
  }
  throw new ArtifactRequestError('Artifact metadata did not contain a valid SHA-256 digest.');
}

function hashRequestBody(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArtifactTargetUrl(targetUrl, context) {
  const expectedPrefix = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const pattern = new RegExp(
    `^${escapeRegExp(expectedPrefix)}/actions/runs/([1-9][0-9]*)/artifacts/([1-9][0-9]*)$`,
  );
  const match = pattern.exec(targetUrl || '');
  if (!match) {
    throw new ArtifactRequestError('The fixed source-bundle status did not point to an exact repository artifact URL.');
  }
  const runId = Number.parseInt(match[1], 10);
  const artifactId = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(artifactId)) {
    throw new ArtifactRequestError('The indexed artifact URL contains an unsupported numeric identity.');
  }
  return { runId, artifactId };
}

function verifyAutomaticProducerSource(run, repositoryId, sourceSha) {
  if (run.event === 'push') {
    if (
      run.head_repository?.id !== repositoryId ||
      run.head_sha !== sourceSha
    ) {
      throw new ArtifactRequestError('The automatic push producer did not match the indexed source SHA.');
    }
    return;
  }

  if (run.event === 'pull_request') {
    const matchingPulls = (run.pull_requests || []).filter(
      (pull) =>
        pull.base?.repo?.id === repositoryId &&
        run.head_repository?.id === pull.head?.repo?.id &&
        run.head_branch === pull.head?.ref &&
        pull.head?.sha === sourceSha,
    );
    if (matchingPulls.length === 0) {
      throw new ArtifactRequestError('The automatic pull-request producer did not match the indexed source SHA.');
    }
    return;
  }

  throw new ArtifactRequestError('The automatic Source-bundle producer event was not supported.');
}

function requestSuffix(requestCommentId) {
  if (!Number.isSafeInteger(requestCommentId) || requestCommentId <= 0) {
    throw new ArtifactRequestError('The result request-comment identity is invalid.');
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
  return lines.join('\n');
}

function normalizeTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ArtifactRequestError(`${label} did not contain a valid UTC timestamp.`);
  }
  return new Date(value).toISOString();
}

function normalizeRequestIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArtifactRequestError('A registry entry did not contain a request-comment identity.');
  }
  const ids = [];
  for (const item of value) {
    const id = Number(item);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ArtifactRequestError('A registry entry contained an invalid request-comment identity.');
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || !['ready', 'failed'].includes(entry.state)) {
    throw new ArtifactRequestError('The Artifact mailbox registry contained an invalid entry state.');
  }
  const normalized = {
    state: entry.state,
    requestCommentIds: normalizeRequestIds(entry.requestCommentIds),
    selector: typeof entry.selector === 'string' && entry.selector ? entry.selector : 'unresolved',
    sourceSha: entry.sourceSha || null,
    updatedAt: normalizeTimestamp(entry.updatedAt, 'A registry entry'),
  };

  if (entry.sourceSha !== null && entry.sourceSha !== undefined) {
    normalized.sourceSha = requireFullSha(entry.sourceSha, 'A registry source identity');
  }

  if (entry.state === 'failed') {
    normalized.reason = compactFailureReason(entry.reason || 'Artifact request failed.');
    normalized.runUrl = typeof entry.runUrl === 'string' ? entry.runUrl : '';
    return normalized;
  }

  const artifactId = Number(entry.artifactId);
  const producerRunId = Number(entry.producerRunId);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
    throw new ArtifactRequestError('A ready registry entry contained an invalid artifact ID.');
  }
  if (!Number.isSafeInteger(producerRunId) || producerRunId <= 0) {
    throw new ArtifactRequestError('A ready registry entry contained an invalid producer run ID.');
  }
  if (!normalized.sourceSha) {
    throw new ArtifactRequestError('A ready registry entry did not contain a resolved source SHA.');
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
    expiresAt: entry.expiresAt ? normalizeTimestamp(entry.expiresAt, 'A registry expiry') : null,
  });
  if (!normalized.repository || !normalized.sourceRepository || !normalized.sourceRef || !normalized.artifactUrl) {
    throw new ArtifactRequestError('A ready registry entry was incomplete.');
  }
  if (normalized.pullNumber) {
    normalized.pullNumber = Number(normalized.pullNumber);
    if (!Number.isSafeInteger(normalized.pullNumber) || normalized.pullNumber <= 0) {
      throw new ArtifactRequestError('A ready registry entry contained an invalid pull-request number.');
    }
    normalized.baseSha = requireFullSha(normalized.baseSha, 'A registry pull-request base');
    normalized.mergeBaseSha = requireFullSha(normalized.mergeBaseSha, 'A registry pull-request merge base');
    if (!normalized.headRepository || !normalized.headRef) {
      throw new ArtifactRequestError('A ready registry entry contained an incomplete pull-request head identity.');
    }
  }
  return normalized;
}

function encodeRegistryState(entries) {
  return Buffer.from(JSON.stringify({ entries }), 'utf8').toString('base64url');
}

function parseRegistryComment(body) {
  if (typeof body !== 'string' || !body.startsWith(`${REGISTRY_MARKER}\n${REGISTRY_STATE_PREFIX}`)) {
    throw new ArtifactRequestError('The Artifact mailbox registry marker was invalid.');
  }
  const stateLine = body.split('\n', 3)[1];
  if (!stateLine.endsWith(' -->')) {
    throw new ArtifactRequestError('The Artifact mailbox registry state marker was invalid.');
  }
  const encoded = stateLine.slice(REGISTRY_STATE_PREFIX.length, -4);
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ArtifactRequestError('The Artifact mailbox registry state could not be decoded.');
  }
  if (!decoded || !Array.isArray(decoded.entries)) {
    throw new ArtifactRequestError('The Artifact mailbox registry state was incomplete.');
  }
  return decoded.entries.map(normalizeRegistryEntry);
}

function compactFailureReason(value) {
  const compact = String(value || 'Artifact request failed.')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= FAILURE_REASON_LIMIT) return compact;
  return `${compact.slice(0, FAILURE_REASON_LIMIT - 1)}…`;
}

function formatRegistryEntry(entry) {
  const resolved = entry.sourceSha || 'unresolved';
  const lines = [
    `### \`${entry.selector}\` -> \`${resolved}\` · ${entry.state} · \`${entry.updatedAt}\``,
    '',
  ];
  if (entry.state === 'failed') {
    lines.push(
      `\`request ${entry.requestCommentIds[0]}\` · run ${entry.runUrl || 'unavailable'}`,
      '',
      `Reason: ${entry.reason}`,
    );
    return lines.join('\n');
  }

  lines.push(
    `\`requests ${entry.requestCommentIds.join(', ')}\` · \`artifact ${entry.artifactId}\` · \`run ${entry.producerRunId}\` · \`expires ${entry.expiresAt || 'unavailable'}\``,
  );
  if (entry.pullNumber) {
    lines.push(
      `\`PR #${entry.pullNumber}\` · \`head ${entry.headRepository}:${entry.headRef}\` · \`base ${entry.baseSha}\` · \`merge-base ${entry.mergeBaseSha}\``,
    );
  }
  lines.push(
    '',
    '`GitHub.download_workflow_artifact`',
    '',
    '```json',
    JSON.stringify(formatDownloadArguments(entry)),
    '```',
    '',
    '```shell',
    formatPreparationCommand(entry),
    '```',
  );
  return lines.join('\n');
}

function formatRegistryComment(entries) {
  const normalized = entries.map(normalizeRegistryEntry);
  const lines = [
    REGISTRY_MARKER,
    `${REGISTRY_STATE_PREFIX}${encodeRegistryState(normalized)} -->`,
    '# Artifact mailbox registry',
    '',
    'Newest entries first. Match the exact `request <id>` or `requests <id, ...>` value.',
  ];
  for (const entry of normalized) {
    lines.push('', formatRegistryEntry(entry));
  }
  return lines.join('\n');
}

function isExpiredEntry(entry, nowMs) {
  return entry.state === 'ready' && entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs;
}

function sameReadyArtifact(left, right) {
  return (
    left.state === 'ready' &&
    right.state === 'ready' &&
    left.sourceSha === right.sourceSha &&
    left.artifactId === right.artifactId &&
    left.artifactDigest === right.artifactDigest &&
    left.artifactUrl === right.artifactUrl
  );
}

function mergeRegistryEntries(existingEntries, incomingEntry, now = new Date()) {
  const nowMs = now.getTime();
  const incoming = normalizeRegistryEntry(incomingEntry);
  const incomingIds = new Set(incoming.requestCommentIds);
  const retained = existingEntries
    .map(normalizeRegistryEntry)
    .filter((entry) => !isExpiredEntry(entry, nowMs))
    .filter((entry) => !entry.requestCommentIds.some((id) => incomingIds.has(id)));

  if (incoming.state === 'ready') {
    const equivalentIndex = retained.findIndex((entry) => sameReadyArtifact(entry, incoming));
    if (equivalentIndex >= 0) {
      const equivalent = retained.splice(equivalentIndex, 1)[0];
      incoming.requestCommentIds = normalizeRequestIds([
        ...incoming.requestCommentIds,
        ...equivalent.requestCommentIds,
      ]);
    }
  }

  return [incoming, ...retained]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, REGISTRY_LIMIT);
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
    comment.user.type === 'Bot' &&
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
      typeof comment.body === 'string' &&
      comment.body.startsWith(REGISTRY_MARKER),
  );
  if (matching.length > 1) {
    throw new ArtifactRequestError('More than one authoritative Artifact mailbox registry comment exists.');
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
    throw new ArtifactRequestError('The authoritative registry update did not preserve the request result.');
  }
  return persisted;
}

async function getLiveRequestComment({ github, context, requestCommentId, expectedAuthor, expectedBodyHash }) {
  const response = await github.rest.issues.getComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    comment_id: requestCommentId,
  });
  const comment = response.data;
  if (comment.id !== requestCommentId || comment.user?.login !== expectedAuthor) {
    throw new ArtifactRequestError('The request comment identity no longer matches the triggering event.');
  }
  if (hashRequestBody(comment.body || '') !== expectedBodyHash) {
    throw new ArtifactRequestError('The request comment changed while the artifact request was running.');
  }
  return comment;
}

async function authorizeRequest({ github, context, author }) {
  if (context.actor !== author) {
    throw new ArtifactRequestError('The workflow actor does not match the request comment author.');
  }
  const response = await github.rest.repos.getCollaboratorPermissionLevel({
    owner: context.repo.owner,
    repo: context.repo.repo,
    username: author,
  });
  const permission = response.data.permission;
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    throw new ArtifactRequestError('Artifact regeneration requires Write, Maintain, or Admin repository access.');
  }
  return permission;
}

async function resolveSelector({ github, context, parsed }) {
  const repositoryName = `${context.repo.owner}/${context.repo.repo}`;

  if (parsed.selectorType === 'main') {
    const repository = await github.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
    });
    const defaultBranch = repository.data.default_branch;
    const reference = await github.rest.git.getRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `heads/${defaultBranch}`,
    });
    if (reference.data.object.type !== 'commit') {
      throw new ArtifactRequestError('The default branch did not resolve to a commit.');
    }
    const sourceSha = requireFullSha(reference.data.object.sha, 'The default branch');
    return {
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      sourceSha,
      sourceRepository: repositoryName,
      sourceRef: defaultBranch,
      pullNumber: null,
      headRepository: null,
      headRef: null,
      baseSha: null,
      mergeBaseSha: null,
    };
  }

  if (parsed.selectorType === 'pr') {
    let pull;
    try {
      pull = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: parsed.pullNumber,
      });
    } catch (error) {
      if (error.status === 404) {
        throw new ArtifactRequestError(`Pull request #${parsed.pullNumber} does not exist.`);
      }
      throw error;
    }

    const sourceSha = requireFullSha(pull.data.head.sha, 'The pull-request head');
    const baseSha = requireFullSha(pull.data.base.sha, 'The pull-request base');
    const headRepository = pull.data.head.repo?.full_name;
    const headRef = pull.data.head.ref;
    if (!headRepository || !headRef) {
      throw new ArtifactRequestError('The pull-request head repository or ref is unavailable.');
    }

    const comparison = await github.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${baseSha}...${sourceSha}`,
    });
    const mergeBaseSha = requireFullSha(
      comparison.data.merge_base_commit?.sha,
      'The pull-request merge base',
    );

    return {
      selector: parsed.selector,
      selectorType: parsed.selectorType,
      sourceSha,
      sourceRepository: headRepository,
      sourceRef: headRef,
      pullNumber: parsed.pullNumber,
      headRepository,
      headRef,
      baseSha,
      mergeBaseSha,
    };
  }

  const sourceSha = requireFullSha(parsed.sourceSha, 'The exact selector');
  try {
    const commit = await github.rest.git.getCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: sourceSha,
    });
    if (commit.data.sha !== sourceSha) {
      throw new ArtifactRequestError('The exact commit selector did not resolve identically.');
    }
  } catch (error) {
    if (error.status === 404) {
      throw new ArtifactRequestError(`Commit ${sourceSha} does not exist in this repository.`);
    }
    throw error;
  }

  return {
    selector: parsed.selector,
    selectorType: parsed.selectorType,
    sourceSha,
    sourceRepository: repositoryName,
    sourceRef: sourceSha,
    pullNumber: null,
    headRepository: null,
    headRef: null,
    baseSha: null,
    mergeBaseSha: null,
  };
}

async function getCombinedStatuses(github, context, sourceSha) {
  const statuses = [];
  for (let page = 1; page <= 10; page += 1) {
    let response;
    try {
      response = await github.rest.repos.getCombinedStatusForRef({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: sourceSha,
        per_page: 100,
        page,
      });
    } catch (error) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }
    const pageStatuses = response.data.statuses || [];
    statuses.push(...pageStatuses);
    if (pageStatuses.length < 100) {
      break;
    }
  }
  return statuses;
}

async function verifyArtifactMetadata({
  github,
  context,
  sourceSha,
  targetUrl,
  expectedArtifactId = null,
  expectedDigest = null,
  allowCurrentRun = false,
}) {
  const parsedTarget = parseArtifactTargetUrl(targetUrl, context);
  if (expectedArtifactId !== null && parsedTarget.artifactId !== expectedArtifactId) {
    throw new ArtifactRequestError('The artifact URL did not contain the expected artifact ID.');
  }

  const artifactResponse = await github.rest.actions.getArtifact({
    owner: context.repo.owner,
    repo: context.repo.repo,
    artifact_id: parsedTarget.artifactId,
  });
  const artifact = artifactResponse.data;
  const expectedName = `teasescript-source-${sourceSha}`;
  if (artifact.id !== parsedTarget.artifactId || artifact.name !== expectedName) {
    throw new ArtifactRequestError('Artifact metadata did not match the requested source identity.');
  }
  if (artifact.expired === true) {
    throw new ArtifactRequestError('The indexed source artifact has expired.');
  }
  const expiresAt = artifact.expires_at || null;
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new ArtifactRequestError('The indexed source artifact is no longer within its retention window.');
    }
  }

  const artifactDigest = normalizeDigest(artifact.digest);
  if (expectedDigest !== null && artifactDigest !== normalizeDigest(expectedDigest)) {
    throw new ArtifactRequestError('Artifact API metadata did not match the upload digest.');
  }
  if (artifact.workflow_run?.id !== parsedTarget.runId) {
    throw new ArtifactRequestError('Artifact metadata did not match the producer run in the indexed URL.');
  }

  const runResponse = await github.rest.actions.getWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: parsedTarget.runId,
  });
  const run = runResponse.data;
  if (run.id !== parsedTarget.runId || run.repository?.full_name !== `${context.repo.owner}/${context.repo.repo}`) {
    throw new ArtifactRequestError('The artifact producer run did not belong to this repository.');
  }
  if (!TRUSTED_PRODUCER_PATHS.has(run.path)) {
    throw new ArtifactRequestError('The artifact producer workflow is not a trusted Source-bundle producer.');
  }
  if (run.path === '.github/workflows/source-bundle.yml') {
    verifyAutomaticProducerSource(run, run.repository.id, sourceSha);
  }
  const currentRunAllowed =
    allowCurrentRun &&
    run.id === context.runId &&
    run.path === '.github/workflows/source-bundle-artifact-request.yml' &&
    ['queued', 'in_progress'].includes(run.status);
  if (!currentRunAllowed && !(run.status === 'completed' && run.conclusion === 'success')) {
    throw new ArtifactRequestError('The artifact producer workflow has not completed successfully.');
  }

  return {
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDigest,
    producerRunId: run.id,
    artifactUrl: targetUrl,
    expiresAt,
  };
}

async function findCachedArtifact({ github, context, sourceSha }) {
  const statuses = await getCombinedStatuses(github, context, sourceSha);
  const candidates = statuses.filter(
    (status) => status.context === STATUS_CONTEXT && status.state === 'success',
  );

  for (const status of candidates) {
    try {
      return await verifyArtifactMetadata({
        github,
        context,
        sourceSha,
        targetUrl: status.target_url,
      });
    } catch (error) {
      if (error.status === 404 || error instanceof ArtifactRequestError) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function setIdentityOutputs(core, identity, request) {
  core.setOutput('resolved', 'true');
  core.setOutput('cache_hit', 'false');
  core.setOutput('request_comment_id', String(request.commentId));
  core.setOutput('request_author', request.author);
  core.setOutput('request_body_sha256', request.bodyHash);
  core.setOutput('selector', identity.selector);
  core.setOutput('selector_type', identity.selectorType);
  core.setOutput('source_sha', identity.sourceSha);
  core.setOutput('source_repository', identity.sourceRepository);
  core.setOutput('source_ref', identity.sourceRef);
  core.setOutput('pull_number', identity.pullNumber ? String(identity.pullNumber) : '');
  core.setOutput('head_repository', identity.headRepository || '');
  core.setOutput('head_ref', identity.headRef || '');
  core.setOutput('base_sha', identity.baseSha || '');
  core.setOutput('merge_base_sha', identity.mergeBaseSha || '');
}

function resultFromIdentity({ context, request, identity, artifact, updatedAt = new Date().toISOString() }) {
  return {
    state: 'ready',
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
    state: 'failed',
    requestCommentIds: [requestCommentId],
    selector: selector || 'unresolved',
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
    throw new ArtifactRequestError('The cleanup target did not match the exact request comment.');
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
    author: eventComment?.user?.login || '',
    body: eventComment?.body || '',
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
      throw new ArtifactRequestError('The issue-comment event did not contain a complete request identity.');
    }
    if (request.issueNumber !== MAILBOX_ISSUE_NUMBER) {
      throw new ArtifactRequestError(`Artifact requests are accepted only in issue #${MAILBOX_ISSUE_NUMBER}.`);
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
          core.setOutput('resolved', 'false');
          core.setOutput('cache_hit', persisted.state === 'ready' ? 'true' : 'false');
          return;
        }
      }
      throw error;
    }

    await authorizeRequest({ github, context, author: request.author });
    const parsed = parseCommand(liveComment.body);
    selector = parsed.selector;
    const identity = await resolveSelector({ github, context, parsed });
    sourceSha = identity.sourceSha;
    setIdentityOutputs(core, identity, request);

    const cached = await findCachedArtifact({ github, context, sourceSha: identity.sourceSha });
    if (cached) {
      core.setOutput('cache_hit', 'true');
      await upsertRegistryEntry({
        github,
        context,
        entry: resultFromIdentity({ context, request, identity, artifact: cached }),
      });
      await cleanupRequestComment({ github, context, request });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('resolved', 'false');
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
          await publishFailure({
            github,
            context,
            request,
            selector,
            sourceSha,
            message,
          });
        }
        await cleanupRequestComment({ github, context, request });
      } catch (publicationError) {
        const publicationMessage = publicationError instanceof Error
          ? publicationError.message
          : String(publicationError);
        core.setFailed(`${message} Result or cleanup publication also failed: ${publicationMessage}`);
        return;
      }
    }
    core.setFailed(message);
  }
}

function identityFromInput(input) {
  const parsed = parseCommand(`/artifact source ${input.selector || ''}`);
  if (parsed.selectorType !== input.selectorType) {
    throw new ArtifactRequestError('The resolved selector type is inconsistent.');
  }

  const sourceSha = requireFullSha(input.sourceSha, 'The resolved source');
  if (!input.sourceRepository || !input.sourceRef) {
    throw new ArtifactRequestError('The resolved source repository or ref is missing.');
  }

  if (parsed.selectorType === 'sha' && parsed.sourceSha !== sourceSha) {
    throw new ArtifactRequestError('The exact selector no longer matches the resolved source SHA.');
  }

  if (parsed.selectorType === 'pr') {
    const pullNumber = Number.parseInt(input.pullNumber, 10);
    if (
      pullNumber !== parsed.pullNumber ||
      !input.headRepository ||
      !input.headRef ||
      input.sourceRepository !== input.headRepository ||
      input.sourceRef !== input.headRef
    ) {
      throw new ArtifactRequestError('The resolved pull-request identity is inconsistent.');
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
      baseSha: requireFullSha(input.baseSha, 'The resolved pull-request base'),
      mergeBaseSha: requireFullSha(input.mergeBaseSha, 'The resolved pull-request merge base'),
    };
  }

  if (
    input.pullNumber ||
    input.headRepository ||
    input.headRef ||
    input.baseSha ||
    input.mergeBaseSha
  ) {
    throw new ArtifactRequestError('A non-PR selector contained pull-request identity fields.');
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
    throw new ArtifactRequestError('The resolved request identity is invalid or outside the Artifact mailbox.');
  }
  if (!DIGEST_PATTERN.test(input.requestBodySha256 || '')) {
    throw new ArtifactRequestError('The request body identity is invalid.');
  }
  if (!input.requestAuthor) {
    throw new ArtifactRequestError('The request author identity is invalid.');
  }
  return {
    commentId,
    issueNumber,
    author: input.requestAuthor,
    bodyHash: input.requestBodySha256,
  };
}

async function completeRequest({ github, context, input }) {
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
      if (persisted?.state === 'ready') return;
    }
    throw error;
  }
  if (context.actor !== request.author) {
    throw new ArtifactRequestError('The workflow actor no longer matches the request comment author.');
  }

  const expectedArtifactId = Number.parseInt(input.artifactId, 10);
  if (!ARTIFACT_ID_PATTERN.test(input.artifactId || '') || !Number.isSafeInteger(expectedArtifactId)) {
    throw new ArtifactRequestError('The upload step did not return a valid artifact ID.');
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

  await github.rest.repos.createCommitStatus({
    owner: context.repo.owner,
    repo: context.repo.repo,
    sha: identity.sourceSha,
    state: 'success',
    context: STATUS_CONTEXT,
    description: `artifact ${artifact.artifactId} sha256:${artifact.artifactDigest}`,
    target_url: artifact.artifactUrl,
  });

  await cleanupRequestComment({ github, context, request });
}

async function reportProductionFailure({ github, context, input }) {
  const request = requestFromInput(input);
  const existing = await registryEntryForRequest({
    github,
    context,
    requestCommentId: request.commentId,
  });
  if (existing) {
    await cleanupRequestComment({ github, context, request });
    return;
  }

  await getLiveRequestComment({
    github,
    context,
    requestCommentId: request.commentId,
    expectedAuthor: request.author,
    expectedBodyHash: request.bodyHash,
  });

  await publishFailure({
    github,
    context,
    request,
    selector: input.selector,
    sourceSha: input.sourceSha || null,
    message: 'Source-bundle production or result publication failed. Inspect the linked workflow run for the exact failing step.',
  });
  await cleanupRequestComment({ github, context, request });
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
