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
| [r4-8](sharing.md#r4-8) | sharing | A guarded copy keeps its source identity and carries its mark on the alias entry. |
| [r4-15](sharing.md#r4-15) | sharing | One identity function for every entry path into the contract index. |
| [r4-17](sharing.md#r4-17) | sharing | Marks never change a literal's structural identity. |
| [r4-18](sharing.md#r4-18) | sharing | A shared entry has one tested-path mark index, shared by reference. |
| [r4-20](sharing.md#r4-20) | sharing | Fill a mark index once per entry and contribution; memoise file returnability. |
| [r4-23](sharing.md#r4-23) | sharing | One mark holder per source and projection; the demand as the budget's unit. |
| [r4-26](solver-and-work.md#r4-26) | solver-and-work | Registration reachability and returnability share one least fixpoint. |
| [r4-38](sharing.md#r4-38) | sharing | Whole-copy mark realisation covers fan-out and interleaved stores. |
| [r4-44](solver-and-work.md#r4-44) | solver-and-work | A decision inside a component is made once, on its completed solve. |
| [r4-45](solver-and-work.md#r4-45) | solver-and-work | The two known products of W34's realization stay gated known limits (the owner's decision). |
| [r4-49](admission.md#r4-49) | admission | `A6-chain`, admission's passes × stores, stays a gated known limit (the owner's decision). |
| [r4-72](sharing.md#r4-72) | sharing | A copied binding's written domain is part of its value class. |
| [r4-83](solver-and-work.md#r4-83) | solver-and-work | Known cost limits need evidence; sharing defects still need repair. |
| [r4-85](sharing.md#r4-85) | sharing | Every value-side discovery uses one class key. |
| [r4-86](solver-and-work.md#r4-86) | solver-and-work | Diagnostics and owed checks are published in source order of their sites. |
| [r4-87](sharing.md#r4-87) | sharing | Every operation family the value side composes has a class rule. |
| [r4-106](stops-and-finishing.md#r4-106) | stops-and-finishing | A finished contract is a domain, not the read's own kinds. |
| [r4-113](stops-and-finishing.md#r4-113) | stops-and-finishing | A host read keeps its structural ingress even when the script writes into that global. |
| [r4-117](stops-and-finishing.md#r4-117) | stops-and-finishing | Rollback drops ingress memo; NarrowingIndex is lazy. |
| [r4-125](stops-and-finishing.md#r4-125) | stops-and-finishing | The fresh pass checks written stores through admission's own C1. |
| [r4-126](stops-and-finishing.md#r4-126) | stops-and-finishing | A boundary's expected domain uses the ordered finishing read. |
| [r4-129](contract.md#r4-129) | contract | A stored stable-path read takes its narrowing where it holds. |
| [r4-135](stops-and-finishing.md#r4-135) | stops-and-finishing | No syntax decision at a stop before admission settled. |
| [r4-152](stops-and-finishing.md#r4-152) | stops-and-finishing | One ordered source endpoint answers every direct or composed question. |
| [r4-154](admission.md#r4-154) | admission | Rule A2 checks where a whole copy meets the place. |
| [r4-162](contract.md#r4-162) | contract | A site fact not proved gives words, never a code form. |
| [r4-163](sharing.md#r4-163) | sharing | Choice cells share a class only through what they store. |
| [r4-164](sharing.md#r4-164) | sharing | Shared admission summaries wait for their query bound and their lifecycle contract. |
| [r4-165](oracles.md#r4-165) | oracles | The question-source guard checks named syntax, with review beyond it. |
| [r4-171](contract.md#r4-171) | contract | A type suggestion is a type at the type position. |
| [r4-176](sharing.md#r4-176) | sharing | Dormant meetings are owed only where a containing node differs. |
| [r4-177](admission.md#r4-177) | admission | Admission reuses proven conflict classes, written-type cursors and indexed paths. |
| [r4-178](admission.md#r4-178) | admission | Positioned-prefix proofs use the solver lifecycle and preserve the sharing seam. |
| [r4-180](stops-and-finishing.md#r4-180) | stops-and-finishing | A newly stopped decision restarts the pass. |
| [r4-181](admission.md#r4-181) | admission | A whole-copy ring uses one finite cut with distinct member ports. |
| [r4-182](oracles.md#r4-182) | oracles | The obligation guard accepts listed forms and reports every other named reference. |
| [r4-183](stops-and-finishing.md#r4-183) | stops-and-finishing | At most one restart per pass; a stopped key narrows under a type test. |
| [r4-185](oracles.md#r4-185) | oracles | Only the ring cut's case 5 admits an order-only difference. |
| [r4-187](solver-and-work.md#r4-187) | solver-and-work | Proof payloads follow the solver lifecycle beside their items. |
| [r4-190](sharing.md#r4-190) | sharing | Role summaries need a state bound, exact transfers and solver-owned invalidation. |
| [r4-191](solver-and-work.md#r4-191) | solver-and-work | A short semantic answer does not bound its internal support construction. |
| [r4-196](solver-and-work.md#r4-196) | solver-and-work | A key family's lane is chosen once, from a frozen wrapper shape. |
| [r4-197](admission.md#r4-197) | admission | Stored-value readers use ordered transfers from one recipe per task. |
| [r4-201](solver-and-work.md#r4-201) | solver-and-work | A literal contract at a path is one demand per literal and path. |
| [r4-202](admission.md#r4-202) | admission | A decider region holds paths as parent-linked step nodes. |
| [r4-204](solver-and-work.md#r4-204) | solver-and-work | Pass-local key cursors cross one charged conversion boundary. |
| [r4-208](stops-and-finishing.md#r4-208) | stops-and-finishing | The finishing read's host frontier is bounded by construction. |
| [r4-213](stops-and-finishing.md#r4-213) | stops-and-finishing | A finishing domain owns its boundary requests through its deferred warning. |
| [r4-215](contract.md#r4-215) | contract | An unrestricted written domain's `unknown` carries the opaque reason. |
| [r4-218](solver-and-work.md#r4-218) | solver-and-work | Cursor paths carry one canonical representation and one charged fact record. |
| [r4-219](solver-and-work.md#r4-219) | solver-and-work | Property-name traversal detects path-pumping feedback independently of key answers. |
| [r4-220](solver-and-work.md#r4-220) | solver-and-work | Admission growth repairs separate structure, support, deciders and sparse properties. |
| [r4-221](solver-and-work.md#r4-221) | solver-and-work | Operation/path proofs belong to the solver, with replayable pass-local descriptors. |
| [r4-226](stops-and-finishing.md#r4-226) | stops-and-finishing | An owned finishing-domain boundary is omitted with its warning. |
| [r4-227](solver-and-work.md#r4-227) | solver-and-work | A layer demand has a replayable logical name. |
| [r4-234](admission.md#r4-234) | admission | A preparation generator owns its dependency frame while it advances. |
| [r4-238](solver-and-work.md#r4-238) | solver-and-work | Preparation values are invalidated with the proofs of their inputs. |
| [r4-240](solver-and-work.md#r4-240) | solver-and-work | Preparation recipes live for a pass; derived values live only in solver proofs. |
| [r4-241](solver-and-work.md#r4-241) | solver-and-work | Retained inherited folds require completed current dependency certificates. |
| [r4-245](solver-and-work.md#r4-245) | solver-and-work | An output-bound family may pay an attributed constant per real pair. |
| [r4-249](contract.md#r4-249) | contract | A filtered property fold stays outside the ordinary complete memo. |
| [r4-251](sharing.md#r4-251) | sharing | A deep read forwards through a singleton layer. |
| [r4-257](solver-and-work.md#r4-257) | solver-and-work | An object `+` run builds its property index lazily on the third distinct name. |
| [r4-262](solver-and-work.md#r4-262) | solver-and-work | A forwarded read makes a path id only when a summary needs it. |
| [r4-271](stops-and-finishing.md#r4-271) | stops-and-finishing | A value with no holding place has one memoised node in the finishing walk. |
| [r4-277](contract.md#r4-277) | contract | A value's kinds keep their written spelling where one spelling covers them. |
| [r4-278](stops-and-finishing.md#r4-278) | stops-and-finishing | One immutable contract proof serves each canonical key and admission epoch. |
| [r4-283](solver-and-work.md#r4-283) | solver-and-work | Inline work uses its frame's explicit stack without creating a demand. |
| [r4-288](solver-and-work.md#r4-288) | solver-and-work | Question memory releases node-keyed memos while retaining whole-program memos. |
| [r4-298](solver-and-work.md#r4-298) | solver-and-work | Long-key reuse shares an immutable spine with separately owned facts. |
| [r4-299](oracles.md#r4-299) | oracles | The combined-stop oracle proves open reads coarsely per unit and key. |
| [r4-300](contract.md#r4-300) | contract | Canonical kind order exempts null, unknown and empty from spelling coverage. |
| [r4-303](stops-and-finishing.md#r4-303) | stops-and-finishing | Forget records live only while admission can still stop their owner. |
| [r4-312](stops-and-finishing.md#r4-312) | stops-and-finishing | Completion has one fresh admission pass over settled inputs, charged to the total. |
| [r4-316](sharing.md#r4-316) | sharing | A listing schedules only its effective sources in property search. |
| [r4-317](sharing.md#r4-317) | sharing | Share leaf walks and ordered unions while replaying each demand's debit. |
| [r4-322](oracles.md#r4-322) | oracles | A combined stop may label a key step more precisely than the demand-only reference (the owner's decision). |
| [r4-332](stops-and-finishing.md#r4-332) | stops-and-finishing | Combined stops retain demand-only obligations with identical domains. |
| [r4-336](admission.md#r4-336) | admission | Summarise written deciders only outside decisions, with forget epochs. |
| [r4-339](stops-and-finishing.md#r4-339) | stops-and-finishing | Completion publishes the natural C1 obligations only as store-part checks. |
| [r4-349](solver-and-work.md#r4-349) | solver-and-work | A structure built only for sharing is charged as shared work. |
| [r4-358](solver-and-work.md#r4-358) | solver-and-work | Contribution provenance is opt-in and filtered by the consumers' own predicates. |
| [r4-360](admission.md#r4-360) | admission | An admitted-structure certificate waits for its depth and noninterference proofs. |
| [r4-370](solver-and-work.md#r4-370) | solver-and-work | Published records serialize only on a complete site-and-rule sort tie. |
| [r4-371](sharing.md#r4-371) | sharing | A group's fold is declined through a member's non-own read. |
| [r4-375](admission.md#r4-375) | admission | One solver-facing A4 service, shared by the solver and admission. |
| [r4-377](admission.md#r4-377) | admission | Copy deciders use a grounded carried-domain proof on the shared selection service. |
| [r4-385](sharing.md#r4-385) | sharing | Projection cycles close through producer equations, never through equal answers. |
| [r4-386](contract.md#r4-386) | contract | Non-own object reads need a solver-managed objects query before fold integration. |
| [r4-387](stops-and-finishing.md#r4-387) | stops-and-finishing | Stop-loss repairs share one per-pass obligation registry on solver provenance. |
| [r4-389](stops-and-finishing.md#r4-389) | stops-and-finishing | Publication consumes qualified captures; marks invalidate only dependent proofs. |
| [r4-396](contract.md#r4-396) | contract | A pushed projection read solves a finite producer graph from empty sets. |
| [r4-403](contract.md#r4-403) | contract | Read the nearest narrowing at the read node and retain ingress provenance. |
| [r4-432](sharing.md#r4-432) | sharing | A pushed read carries compiled mark states rather than mark histories. |
| [r4-444](contract.md#r4-444) | contract | Route certificates prove producers conservatively and refuse unavailable arm evidence. |
| [r4-450](contract.md#r4-450) | contract | Read closed-object property descendants from holders and pay for indexing by saved folds. |
