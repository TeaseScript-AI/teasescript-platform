// The source-bundle artifact request's shared parts: its constants and error, and parsing a command, a full SHA, a
// digest, a timestamp and request ids. The trusted workflow loads it through source-bundle-artifact-request.cjs.

"use strict";

const crypto = require("node:crypto");

const ARTIFACT_KIND = "source";
const STATUS_CONTEXT = "source-bundle/artifact-v1";
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
const ALLOWED_PERMISSIONS = new Set(["write", "admin"]);
const RESULT_BOT_LOGIN = "github-actions[bot]";
const RESULT_BOT_ID = 41898282;
const PREPARATION_HELPER = "/mnt/data/chatgpt-project-agent/bin/prepare-agent-workspace.sh";
const TRUSTED_PRODUCER_PATHS = new Set([
  ".github/workflows/source-bundle.yml",
  ".github/workflows/artifact-mailbox-worker.yml",
  ".github/workflows/patch-publication.yml",
]);

class ArtifactRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactRequestError";
  }
}

function requireFullSha(value, label) {
  if (!FULL_SHA_PATTERN.test(value || "")) {
    throw new ArtifactRequestError(`${label} did not resolve to a full lowercase commit SHA.`);
  }
  return value;
}

function parseCommand(body) {
  const normalized = typeof body === "string" ? body : "";
  const match = COMMAND_PATTERN.exec(normalized);
  if (!match) {
    throw new ArtifactRequestError(
      "Invalid command. Use exactly `/artifact source main`, `/artifact source pr:<number>`, or `/artifact source sha:<full-40-character-sha>`.",
    );
  }

  const selector = match[1];
  if (selector === "main") {
    return { selector, selectorType: "main" };
  }
  if (selector.startsWith("pr:")) {
    const pullNumber = Number.parseInt(selector.slice(3), 10);
    if (!Number.isSafeInteger(pullNumber)) {
      throw new ArtifactRequestError(
        "The pull-request number is outside the supported integer range.",
      );
    }
    return { selector, selectorType: "pr", pullNumber };
  }
  return { selector, selectorType: "sha", sourceSha: selector.slice(4) };
}

function normalizeDigest(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (DIGEST_PATTERN.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith("sha256:") && DIGEST_PATTERN.test(normalized.slice(7))) {
    return normalized.slice(7);
  }
  throw new ArtifactRequestError("Artifact metadata did not contain a valid SHA-256 digest.");
}

function hashRequestBody(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ArtifactRequestError(`${label} did not contain a valid UTC timestamp.`);
  }
  return new Date(value).toISOString();
}

function normalizeRequestIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArtifactRequestError("A registry entry did not contain a request-comment identity.");
  }
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const id = Number(item);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ArtifactRequestError(
        "A registry entry contained an invalid request-comment identity.",
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

module.exports = {
  ARTIFACT_KIND,
  STATUS_CONTEXT,
  MAILBOX_ISSUE_NUMBER,
  REGISTRY_LIMIT,
  REGISTRY_MARKER,
  REGISTRY_STATE_PREFIX,
  FAILURE_REASON_LIMIT,
  DIGEST_PATTERN,
  ARTIFACT_ID_PATTERN,
  ALLOWED_PERMISSIONS,
  RESULT_BOT_LOGIN,
  RESULT_BOT_ID,
  PREPARATION_HELPER,
  TRUSTED_PRODUCER_PATHS,
  ArtifactRequestError,
  requireFullSha,
  parseCommand,
  normalizeDigest,
  hashRequestBody,
  normalizeTimestamp,
  normalizeRequestIds,
};
