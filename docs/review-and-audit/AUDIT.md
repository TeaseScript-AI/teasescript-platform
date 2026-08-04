# Audit guidance candidate comparison

**Status:** Temporary pull-request comparison index. Neither candidate is
canonical or ready to merge.

Pull request #243 currently exposes two owner-working candidates for review:

- [`AUDIT-CANDIDATE-V9.md`](candidates/AUDIT-CANDIDATE-V9.md) is the longer,
  more explicit version produced during the owner discussion.
- [`AUDIT-CANDIDATE-V11.md`](candidates/AUDIT-CANDIDATE-V11.md) is the compacted
  version produced after comparing V9 and V10 for semantic loss.

Review both candidates against issue #237, the applicable owner decisions, and
the existing repository authority. The comparison should identify:

1. obligations or meaning present in V9 that V11 omits, weakens, or makes
   ambiguous;
2. duplication, boilerplate, unnecessary structure, or speculative policy in
   V9 that should not survive;
3. defects, missing requirements, or conflicts shared by both candidates; and
4. the smallest complete final content for `AUDIT.md`.

These candidate files are temporary review material on the draft branch. Before
merge, remove both candidate files and replace this index with one final
`AUDIT.md`. Do not route ordinary reviewers or auditors to either candidate as
canonical guidance.
