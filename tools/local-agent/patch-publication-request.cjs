'use strict';

module.exports = async function runPatchPublicationRequest({ github, context, core }) {
  const body = context.payload.comment.body.trim();
  const match = /^\/publish-patch ([A-Za-z0-9][A-Za-z0-9._\/-]{0,239}) ([0-9a-f]{64})$/.exec(body);
  if (!match) {
    core.setFailed('Use exactly: /publish-patch agent-patch-publication/<unique-id> <manifest-sha256>');
    return;
  }

  const transferBranch = match[1];
  const expectedManifestSha256 = match[2];
  if (
    !transferBranch.startsWith('agent-patch-publication/') ||
    transferBranch === 'agent-patch-publication/' ||
    transferBranch.includes('..') ||
    transferBranch.includes('//') ||
    transferBranch.endsWith('/')
  ) {
    core.setFailed('Invalid transfer branch name.');
    return;
  }

  if (!context.payload.issue.pull_request) {
    core.setFailed('Patch publication commands must be placed on a pull request.');
    return;
  }

  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner: context.repo.owner,
    repo: context.repo.repo,
    username: context.actor,
  });
  if (!['admin', 'maintain', 'write'].includes(permission.data.permission)) {
    core.setFailed('Patch publication requires repository write permission.');
    return;
  }

  const pull = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
  });
  if (pull.data.head.repo?.full_name !== context.payload.repository.full_name) {
    core.setFailed('Cross-repository pull-request heads are not supported.');
    return;
  }

  const transfer = await github.rest.git.getRef({
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: `heads/${transferBranch}`,
  });
  const expectedTransferSha = transfer.data.object.sha;
  if (
    transfer.data.object.type !== 'commit' ||
    !/^[0-9a-f]{40}$/.test(expectedTransferSha)
  ) {
    core.setFailed('Transfer branch must resolve to a commit SHA.');
    return;
  }

  const manifestResponse = await github.rest.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path: '.agent-patch-publication/manifest.json',
    ref: expectedTransferSha,
  });
  if (
    Array.isArray(manifestResponse.data) ||
    manifestResponse.data.type !== 'file' ||
    manifestResponse.data.encoding !== 'base64'
  ) {
    core.setFailed('Transfer manifest must be one regular file.');
    return;
  }
  const manifestBytes = Buffer.from(
    manifestResponse.data.content.replace(/\n/g, ''),
    'base64',
  );
  const actualManifestSha256 = require('crypto')
    .createHash('sha256')
    .update(manifestBytes)
    .digest('hex');
  if (actualManifestSha256 !== expectedManifestSha256) {
    core.setFailed(
      `Manifest SHA-256 mismatch: expected ${expectedManifestSha256}, found ${actualManifestSha256}`,
    );
    return;
  }
  let formatVersion;
  try {
    const manifestText = new (require('util').TextDecoder)(
      'utf-8',
      { fatal: true },
    ).decode(manifestBytes);
    formatVersion = JSON.parse(manifestText).formatVersion;
  } catch (error) {
    core.setFailed(`Transfer manifest is not valid UTF-8 JSON: ${error.message}`);
    return;
  }
  if (formatVersion !== 1 && formatVersion !== 2) {
    core.setFailed('Transfer manifest formatVersion must be the integer 1 or 2.');
    return;
  }

  core.setOutput('transfer_branch', transferBranch);
  core.setOutput('expected_transfer_sha', expectedTransferSha);
  core.setOutput('expected_manifest_sha256', expectedManifestSha256);
  core.setOutput('expected_target_branch', pull.data.head.ref);
  core.setOutput('format_version', String(formatVersion));
  core.setOutput('issue_number', String(context.issue.number));
  core.setOutput('comment_id', String(context.payload.comment.id));

};
