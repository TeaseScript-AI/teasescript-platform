'use strict';

module.exports = async function cleanupPatchPublicationComment({ github, context, core, process }) {
  const commentId = Number(process.env.COMMENT_ID);
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const expectedCommand = `/publish-patch ${process.env.TRANSFER_BRANCH} ${process.env.EXPECTED_MANIFEST_SHA256}`;
  if (!Number.isSafeInteger(commentId) || !Number.isSafeInteger(issueNumber)) {
    core.setOutput('cleanup_status', 'failed');
    core.setFailed('Validated publication comment identity is missing.');
    return;
  }
  if (
    context.payload.issue?.number !== issueNumber ||
    context.payload.comment?.id !== commentId ||
    context.payload.comment?.body?.trim() !== expectedCommand ||
    !context.payload.issue?.pull_request
  ) {
    core.setOutput('cleanup_status', 'failed');
    core.setFailed('Publication command event identity no longer matches the validated request.');
    return;
  }

  let comment;
  try {
    comment = await github.rest.issues.getComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: commentId,
    });
  } catch (error) {
    if (error.status === 404) {
      core.setOutput('cleanup_status', 'already_absent');
      core.notice('Publication command comment was already absent.');
      return;
    }
    core.setOutput('cleanup_status', 'failed');
    throw error;
  }

  if (
    comment.data.id !== commentId ||
    comment.data.issue_url !== context.payload.issue.url ||
    comment.data.body.trim() !== expectedCommand
  ) {
    core.setOutput('cleanup_status', 'preserved_changed');
    core.warning('Publication command comment changed after validation and was preserved.');
    return;
  }

  let deletion;
  try {
    deletion = await github.rest.issues.deleteComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: commentId,
    });
  } catch (error) {
    if (error.status === 404) {
      core.setOutput('cleanup_status', 'already_absent');
      core.notice('Publication command comment became absent before deletion completed.');
      return;
    }
    core.setOutput('cleanup_status', 'failed');
    throw error;
  }
  if (deletion.status !== 204) {
    core.setOutput('cleanup_status', 'failed');
    core.setFailed(`Publication command deletion returned HTTP ${deletion.status}.`);
    return;
  }
  core.setOutput('cleanup_status', 'removed');
  core.notice('The exact accepted publication command was removed.');

};
