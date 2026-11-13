"use strict";

const {
  testCommandGrammar,
  testCommandsOutsideMailboxCreateNothing,
  testSelectorResolutionAndMissOutputs,
  testInvalidAndMissingSelectorsFailWithoutProduction,
  testAuthorizationFailureIsRegisteredAndCleaned,
  testCacheHitCreatesOneRegistryAndCleansExactRequest,
  testCacheHitCleanupFailureIsNonFatal,
  testForkPullRequestCacheHitPreservesExactPullIdentity,
  testStaleOrUntrustedIndexIsAConfirmedMiss,
  testUnexpectedArtifactApiFailureIsNotTreatedAsMiss,
  testMissingStatusRefIsAConfirmedMiss,
  testDeletedRequestRedeliveryIsIdempotent,
  testPrunedDeletedRequestRedeliveryIsANoop,
  testLiveTerminalRequestRedeliveryRetriesCleanupWithoutProduction,
} = require("./test-source-bundle-artifact-request-requests.cjs");
const {
  testSpoofedRegistryCannotClaimAuthority,
  testRegistryEscapesUntrustedPullHeadRef,
  testDifferentResolvedIdentitiesDoNotDeduplicate,
  testRegistryPrunesExpiryOrdersNewestAndBoundsTen,
  testEquivalentArtifactRequestIdsAreGloballyBounded,
  testMultipleAuthoritativeRegistriesFailClosed,
} = require("./test-source-bundle-artifact-request-registry.cjs");
const {
  testMissingCommandBeforeFirstTerminalPublicationFailsClosed,
  testCompletionPublishesRegistryThenCleanupThenStatus,
  testRegistryFailureCannotPublishStatusOrDeleteCommand,
  testStatusFailureReplacesCurrentRunReadyEntry,
  testOlderReadyEntrySurvivesCurrentRunStatusFailure,
  testCleanupFailureNeverOverwritesUsableReadyEntry,
  testFailureEntryIsCompactBoundedAndCleaned,
  testChangedRequestCannotFinalizeOrDelete,
  testSequentialSameShaRequestsReuseArtifactAndUpdateOneRegistry,
} = require("./test-source-bundle-artifact-request-completion.cjs");

async function main() {
  await testCommandGrammar();
  await testCommandsOutsideMailboxCreateNothing();
  await testSelectorResolutionAndMissOutputs();
  await testInvalidAndMissingSelectorsFailWithoutProduction();
  await testAuthorizationFailureIsRegisteredAndCleaned();
  await testCacheHitCreatesOneRegistryAndCleansExactRequest();
  await testCacheHitCleanupFailureIsNonFatal();
  await testForkPullRequestCacheHitPreservesExactPullIdentity();
  await testStaleOrUntrustedIndexIsAConfirmedMiss();
  await testUnexpectedArtifactApiFailureIsNotTreatedAsMiss();
  await testMissingStatusRefIsAConfirmedMiss();
  await testDeletedRequestRedeliveryIsIdempotent();
  await testPrunedDeletedRequestRedeliveryIsANoop();
  await testLiveTerminalRequestRedeliveryRetriesCleanupWithoutProduction();
  await testMissingCommandBeforeFirstTerminalPublicationFailsClosed();
  await testSpoofedRegistryCannotClaimAuthority();
  await testRegistryEscapesUntrustedPullHeadRef();
  await testDifferentResolvedIdentitiesDoNotDeduplicate();
  await testRegistryPrunesExpiryOrdersNewestAndBoundsTen();
  await testEquivalentArtifactRequestIdsAreGloballyBounded();
  await testMultipleAuthoritativeRegistriesFailClosed();
  await testCompletionPublishesRegistryThenCleanupThenStatus();
  await testRegistryFailureCannotPublishStatusOrDeleteCommand();
  await testStatusFailureReplacesCurrentRunReadyEntry();
  await testOlderReadyEntrySurvivesCurrentRunStatusFailure();
  await testCleanupFailureNeverOverwritesUsableReadyEntry();
  await testFailureEntryIsCompactBoundedAndCleaned();
  await testChangedRequestCannotFinalizeOrDelete();
  await testSequentialSameShaRequestsReuseArtifactAndUpdateOneRegistry();
  console.log("test-source-bundle-artifact-request: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
