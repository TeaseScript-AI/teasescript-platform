# The type inference's accepted record

The accepted implementation rules of the V2 type inference (`src/type-inference/core`) that a builder must follow and
no user-facing document states. Each entry states the rule, why it was chosen over the alternative a reader would
expect, where it was decided, and what later changed it. A comment that needs a rule's reason links the entry by its
page and anchor; a comment that only restates a rule cites nothing.

- **Anchors:** each entry's heading is its anchor, `r4-N` for a revision (the number it had in the accepted record it
  came from) and `section-…` for a rule of the design's tables. A heading never changes and a number is never reused.
- **Authority:** an entry is canonical for its rule, overridden only within the exact scope of a later accepted ADR,
  V30 (`accepted-syntaxes-v30.md`), or a later entry here that names it.
- **Adding an entry:** the pull request that relies on a new rule adds it on its topic's page, in number order, with
  the same four parts, and adds its line to the index below. Entries are added without changing the existing ones; a
  change to a rule is a new entry that names the one it changes.

Each entry gives the rule; the reason; the source (the review round or ruling, the issue or pull request, the date);
and, where it applies, what superseded or bounded it.

## Pages

- [Admission](admission.md): how a place's type is decided from its stores: admission's tests, the decider,
  rejections, and ingress and boundary checks at stores.
- [Contract](contract.md): what a key's contract holds and how a read answers: value kinds, operations, projections,
  presence of properties, narrowing and guards.
- [Stops and finishing](stops-and-finishing.md): budget stops, what a stop forgets or keeps, settled and unsettled
  stops, the finishing read, marks after a stop and lost checks.
- [Sharing](sharing.md): work shared between copies and sources: alias classes, copies, joins and discovery keys.
- [Solver and work](solver-and-work.md): the solver's mechanics and charged work: demand, allowances, work units,
  growth products, indexes, determinism and order.
- [Oracles](oracles.md): the test oracles and evidence about the core: the stop oracle, the member-answer oracle and
  what a difference may be.

## Index

| entry | page | rule |
| --- | --- | --- |
| [section-2-f12](contract.md#section-2-f12) | contract | A read below an element step follows the literal's own structure only. |
| [section-3-2-guarded](contract.md#section-3-2-guarded) | contract | A guarded read's items are marked, so no consumer errs on them. |
| [section-5-a2](admission.md#section-5-a2) | admission | A field that exists only through whole copies. |
| [r4-15](sharing.md#r4-15) | sharing | One identity function for every entry path into the contract index. |
| [r4-17](sharing.md#r4-17) | sharing | Marks never change a literal's structural identity. |
| [r4-23](sharing.md#r4-23) | sharing | One mark holder per source and projection; the demand as the budget's unit. |
| [r4-44](solver-and-work.md#r4-44) | solver-and-work | A decision inside a component is made once, on its completed solve. |
| [r4-45](solver-and-work.md#r4-45) | solver-and-work | The two known products of W34's realization stay gated known limits (the owner's decision). |
| [r4-49](admission.md#r4-49) | admission | `A6-chain`, admission's passes × stores, stays a gated known limit (the owner's decision). |
| [r4-72](sharing.md#r4-72) | sharing | A copied binding's written domain is part of its value class. |
| [r4-83](solver-and-work.md#r4-83) | solver-and-work | Known cost limits need evidence; sharing defects still need repair. |
| [r4-85](sharing.md#r4-85) | sharing | Every value-side discovery uses one class key. |
| [r4-86](solver-and-work.md#r4-86) | solver-and-work | Diagnostics and owed checks are published in source order of their sites. |
| [r4-87](sharing.md#r4-87) | sharing | Every operation family the value side composes has a class rule. |
| [r4-135](stops-and-finishing.md#r4-135) | stops-and-finishing | No syntax decision at a stop before admission settled. |
| [r4-154](admission.md#r4-154) | admission | Rule A2 checks where a whole copy meets the place. |
| [r4-162](contract.md#r4-162) | contract | A site fact not proved gives words, never a code form. |
| [r4-164](sharing.md#r4-164) | sharing | Shared admission summaries wait for their query bound and their lifecycle contract. |
| [r4-165](oracles.md#r4-165) | oracles | The question-source guard checks named syntax, with review beyond it. |
| [r4-171](contract.md#r4-171) | contract | A type suggestion is a type at the type position. |
| [r4-180](stops-and-finishing.md#r4-180) | stops-and-finishing | A newly stopped decision restarts the pass. |
| [r4-182](oracles.md#r4-182) | oracles | The obligation guard accepts listed forms and reports every other named reference. |
| [r4-183](stops-and-finishing.md#r4-183) | stops-and-finishing | At most one restart per pass; a stopped key narrows under a type test. |
| [r4-185](oracles.md#r4-185) | oracles | Only the ring cut's case 5 admits an order-only difference. |
| [r4-196](solver-and-work.md#r4-196) | solver-and-work | A key family's lane is chosen once, from a frozen wrapper shape. |
| [r4-208](stops-and-finishing.md#r4-208) | stops-and-finishing | The finishing read's host frontier is bounded by construction. |
| [r4-215](contract.md#r4-215) | contract | An unrestricted written domain's `unknown` carries the opaque reason. |
| [r4-227](solver-and-work.md#r4-227) | solver-and-work | A layer demand has a replayable logical name. |
| [r4-245](solver-and-work.md#r4-245) | solver-and-work | An output-bound family may pay an attributed constant per real pair. |
| [r4-251](sharing.md#r4-251) | sharing | A deep read forwards through a singleton layer. |
| [r4-262](solver-and-work.md#r4-262) | solver-and-work | A forwarded read makes a path id only when a summary needs it. |
| [r4-277](contract.md#r4-277) | contract | A value's kinds keep their written spelling where one spelling covers them. |
| [r4-299](oracles.md#r4-299) | oracles | The combined-stop oracle proves open reads coarsely per unit and key. |
| [r4-322](oracles.md#r4-322) | oracles | A combined stop may label a key step more precisely than the demand-only reference (the owner's decision). |
| [r4-349](solver-and-work.md#r4-349) | solver-and-work | A structure built only for sharing is charged as shared work. |
| [r4-371](sharing.md#r4-371) | sharing | A group's fold is declined through a member's non-own read. |
| [r4-375](admission.md#r4-375) | admission | One solver-facing A4 service, shared by the solver and admission. |
