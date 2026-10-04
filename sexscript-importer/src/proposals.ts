/**
 * Proposed TeaseScript language changes the importer can emit in a working syntax, to measure on the corpus whether
 * they resolve the problems they target (docs/PROPOSED-LANGUAGE-CHANGES.md). None of them is accepted TeaseScript;
 * output that uses one is an evaluation artifact, and the default conversion never does.
 */
export const PROPOSALS = ["dictionaries", "media-tags"] as const;

export type ProposalId = (typeof PROPOSALS)[number];

/** Capability name under which the report counts files that use a proposal. */
export function proposalCapability(proposal: ProposalId): string {
  return `proposed ${proposal}`;
}

/** Parses a comma-separated proposal list; an empty value selects every proposal. */
export function parseProposals(value: string): Set<ProposalId> {
  if (value === "") return new Set(PROPOSALS);
  const selected = new Set<ProposalId>();
  for (const name of value.split(",")) {
    const proposal = PROPOSALS.find((candidate) => candidate === name.trim());
    if (proposal === undefined) {
      throw new Error(`Unknown proposal "${name}"; expected one of ${PROPOSALS.join(", ")}.`);
    }
    selected.add(proposal);
  }
  return selected;
}
