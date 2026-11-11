# The type inference's accepted record

The accepted implementation rules of the V2 type inference (`src/type-inference/core`) that a builder must follow and
no user-facing document states. Each entry states the rule, why it was chosen over the alternative a reader would
expect, where it was decided, and what later changed it. A comment that needs a rule's reason links the entry by its
page and anchor; a comment that only restates a rule cites nothing.

- **Anchors:** each entry's heading is its anchor, `r4-N` for a revision (the number it had in the accepted record it
  came from) and `section-…` for a rule of the design's tables. A heading never changes and a number is never reused.
  `r4.N` in text outside these pages names the entry `r4-N`.
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

## Labels

The type core's comments carry labels from the port plan and the research design that preceded the core: a plan step
(`S8c`), a design document (`S6-CARRIERS`), or an id of the research table's rules, cells and work families (`C9`,
`F19a`, `W34`). Each label carried in a comment under `src/type-inference/core/` has one row here, and the citation
lint refuses a label without a row and a row no comment carries. An id after a review round, a pull request or a
reviewer ("Codex r2's B1", "#1422 B1", "the owner's reviewer's F1") is a review reference, not a label. A section number (`§3.2`,
`S3 §5`) is no label either; the bare `§N` row says what it points at.

| label | meaning |
| --- | --- |
| `PLAN` | the port plan for the new type core, a document outside the repository; its method-category extensibility rules and W34's work-product limits still apply |
| `G1` | production graph rules govern returnability, reachable registrations, and file-transfer targets ([r4-26](solver-and-work.md#r4-26)) |
| `G2` | preserve assignment targets in suggested fixes; never replace a store destination with a temporary value |
| `S2` | the port’s item and result shapes, including shared ingress cells in solver components |
| `G3` | admission’s shared-query work family for cursors, carrier transfers, and positioned proof frontiers ([r4-164](sharing.md#r4-164)) |
| `S3` | the port plan's S3 design, a document outside the repository; it defines the answer queries, surviving checks, discharge and budget fallback the core still follows |
| `S4` | a possible null requires a null check at each consumer; also, historical, the port plan's step S4, the first core build |
| `G5` | cut whole-copy cycles finitely with distinct member ports; separately, retain a written spelling covering every concrete kind ([r4-181](admission.md#r4-181)) |
| `S5` | historical port step introducing the candidate backend and its first integrated language slice |
| `S6` | the admission and boundary carrier design for shared transfers, landings, and source identities |
| `S6-CARRIERS` | the port plan's carrier design for step S6, a document outside the repository; it defines the operand roles, ingress identity, landings, alias classes and shared admission work the core still follows |
| `S6c` | the shared-source value work family using one sound class key across discovery paths ([r4-85](sharing.md#r4-85)) |
| `S7` | historical port step adding runtime support for the discharge map’s new checks |
| `S8` | the message and budget-fallback work family, including fresh finishing and warning-owned boundary requests ([r4-226](stops-and-finishing.md#r4-226)) |
| `S8c` | historical port step implementing number-to-integer checks and rounding advice |
| `S8d` | historical port step restoring existing fix sentences and reviewing their source-preserving forms |
| `S9b` | the port plan's step S9b, the consumer completion: surviving checks, signatures, storage and side outputs; its design is a document outside the repository |
| `checkpoint 9` | historical research checkpoint that established the coarse core’s design tables and port baseline |
| `S10` | the port work family implementing narrowing, preserving loops, and required-check route errors |
| `A1` | a written type decides the place’s domain and checks every store |
| `A2` | the earliest eligible contribution decides an unwritten place; conflicting whole copies are checked where they meet ([section-5-a2](admission.md#section-5-a2)) |
| `A3` | a settled single-family contract needs no admission scan |
| `A4` | a copy inherits its source’s written domain rather than its current value ([r4-375](admission.md#r4-375)) |
| `A5` | only stores whose source can offend the decided family become conflict candidates |
| `A6` | reject incompatible definite stores and repeat fresh admission passes until rejections stabilize ([r4-49](admission.md#r4-49)) |
| `A7` | possible conflicts warn; earlier copies use `later`; whole external-store boundaries cover descendants; unknown receivers owe member checks |
| `A8` | collection elements and dictionary values follow admission, retaining admitted nullability |
| `A9` | arguments, parameter-body stores, and returns must fit their written parameter or result type |
| `A59` | a fallback after a proved non-null value receives the never-null warning |
| `A68` | the same never-null decision marks the remaining otherwise fallbacks unreachable |
| `C1` | a store or copy must fit its destination’s written or decided type |
| `C2` | counts, range bounds, list positions, and taking limits require whole numbers |
| `C3` | conditions and logical operands require booleans |
| `C4` | arithmetic and ordering operands must match a supported runtime operator row |
| `C5` | member access checks receiver non-nullness, member suitability, and property presence |
| `C5a` | a member, index, or method receiver must not be null |
| `C5b` | a receiver’s kind must support the requested member or operation |
| `C5c` | a property read or store requires a property present on its receiver |
| `C6` | element selections require proven non-emptiness or an empty-collection runtime check |
| `C7` | arguments and returned values must fit written parameter and result types |
| `C8` | saved values must fit the storage key’s schema derived from its loads |
| `C9` | validate external data at its ingress store against the admitted type, or at its own read when no store brings it |
| `C10` | A fallback may be null; otherwise check the direct family, typed ingress’s expected type, or a directly receiving union |
| `C11` | interpolation requires showable values and showable list elements |
| `C12` | dictionary keys must be strings |
| `C13` | built-in signatures check receiver, argument, iterable, and content suitability with certainty |
| `F1` | declaration initializers contribute facts; inherited-field admission tracks named contents and finite copy-cycle landings; as "the owner's F1", the owner's review finding that a boundary check is owed where external data lands in an admitted place, read or not |
| `F1a` | a global default creates distinct startup and executable definitions |
| `F2` | written declarations fix contracts; admission indexes values’ and source keys’ own fields, elements, depths, and shared source identities |
| `F3` | as "the owner's F3", the owner's review finding that a fallback's default fits the expected type at every depth (ADR 0021 rules 1.2 and 7) |
| `F4` | an uncertain-receiver store contributes to the contract but never becomes an exact definition |
| `F5` | add and addAll contribute elements; an exact add also proves non-emptiness |
| `F5a` | a guaranteed loop ending in an unconditional add proves the collection non-empty afterward |
| `F6` | clear opens emptiness and removes exact elements while preserving the collection kind |
| `F7` | removals preserve possible element kinds, open emptiness, and return their operation-specific result |
| `F7a` | positional removals return possible elements and leave the collection possibly empty |
| `F8` | reordering preserves kind, elements, and emptiness but can invalidate path narrowings |
| `F9` | a copy takes the source snapshot while retaining any inherited written domain |
| `F10` | collection conversions and concatenation transfer element kinds and their specified emptiness |
| `F11` | combine stored and copied property facts with missing evidence; dispatch built-in names by receiver, keeping object selections opaque |
| `F12` | element projections follow literal structure; copied descendants take the contract answer ([section-2-f12](contract.md#section-2-f12)) |
| `F13` | stores and mutations through element steps are weak and never exact definitions |
| `F14` | built-in length reads produce integers on supported text and collection receivers |
| `F15` | member access on unknown data preserves its reasons and owes receiver and destination checks |
| `F16` | arithmetic and comparison results and obligations follow the runtime operator table |
| `F17a` | otherwise removes the left operand’s null and joins fallback kinds, retaining them even when the graph never evaluates the fallback |
| `F17b` | get returns possible elements unchanged, including null, alongside its default |
| `F18` | typed loads and parses validate against the receiving type or their typed default |
| `F19` | untyped external inputs produce external unknowns, retaining null when their default is null |
| `F19a` | access through speakers or handles is opaque and owes its own member check |
| `F20` | function results use the joined return contract, including null from value-less exits |
| `F21` | unwritten parameters use captured single-call arguments or conservative multi-call contracts |
| `F22` | written parameter types constrain every argument while preserving its evaluation snapshot |
| `F23` | returning a value stores it into the function’s result key |
| `F24` | stores reachable from callbacks count as handler stores |
| `F25` | built-in results follow declared kinds, with choice results derived from option values |
| `F26b` | interpolation returns text while checking showability and selected-list non-emptiness |
| `F27` | loop variables receive iterable snapshots: elements, dictionary keys and values, or range integers |
| `F27b` | dictionary loops bind string keys and, when requested, dictionary values |
| `F28` | explanations retain the earliest admitted writer per offending kind without discarding obligations |
| `X1` | the read and its reaching definition must both be live |
| `X2` | choose the nearest dominating definition over the key and its prefixes |
| `X3` | the nearest definition must be exact; never skip a weak definition for an earlier one |
| `X4` | definition and read must share their nearest dominating callable or entered-label boundary |
| `X5` | every loop enclosing the read must also enclose its definition |
| `X6` | no relevant own store or conservative call event may intervene after the definition |
| `X7` | exact reads require freedom from block execution and previously registered handler interference |
| `N1` | stable-path tests create narrowing definitions that filter kinds without proving collection non-emptiness |
| `N2` | the nearest valid dominating narrowing answers a read until relevant events invalidate it ([r4-403](contract.md#r4-403)) |
| `N3` | a route proof promotes an unchecked nullable or written-union use to an error ([r4-444](contract.md#r4-444)) |
| `N3a` | written-union offending members participate in the required-check route proof, as re-derived under AD-1 ([r4-444](contract.md#r4-444)) |
| `N5` | loop narrowings survive jointly preserving stores solved as one greatest fixpoint ([r4-129](contract.md#r4-129)) |
| `N8` | constants retain narrowing absent dependency changes; reference-member paths are never narrowed |
| `N9` | unsupported narrowing forms retain guarded warnings rather than inventing stronger proofs |
| `N10` | required-check errors identify the producer and missing test; failed narrowings name their invalidating event |
| `U4a` | stored selections take their element narrowing while emptiness remains a separate proof |
| `U5` | a lost narrowing names the failing event that prevented keeping its check ([r4-444](contract.md#r4-444)) |
| `H1` | a read before any handler registration can keep its exact answer |
| `H6` | registrations reached through file transfers propagate possible handler interference |
| `H9` | calling a helper that registers a handler counts as a registration in its caller |
| `L1` | without an entered label, label boundaries do not obstruct the exact path |
| `L5` | a label reached only by fall-through creates no exact-path boundary |
| `L6` | jumping to a later label does not revisit the code before it |
| `L10` | a call whose target cannot return leaves its continuation unreachable |
| `L11` | computed transfers target every candidate file; glob targets use the name pass’s picks |
| `L13` | stores reached through a called file’s onward transfer count against the original call |
| `O4` | historical name of the type-analysis initiative behind the coarse core |
| `O15` | block-local reads use the contract because handlers can run after intervening stores |
| `P3` | a present, dominating, unguarded single-kind contract can prove a read definite |
| `P7` | literal graph facts prove branch feasibility, loop entry, and selected literal elements |
| `W30` | the work family for long and/or test chains without repeated sibling-test scans |
| `W34` | the whole-copy chain and fan work family sharing source marks across demanded fields ([r4-38](sharing.md#r4-38)) |
| `W40` | the work family indexing tested paths by callable or file instead of scanning contributions |
| `B1` | per-demand and program work budgets defer unproved checks to runtime ([r4-23](sharing.md#r4-23)) |
| `B2` | rejected copies contribute no contents in the next pass, but retain their landings |
| `D1` | diagnostic sentences name the consumer, its context, the problem, and the fix; also, in the receiving checks, that a receiving check validates the full destination contract and only ancestor shapes (a review finding's id) |
| `D2` | diagnostic sites and names use the relevant expression’s source text |
| `D3` | each diagnostic rule keeps one code across error and warning severities |
| `D4` | exhaustion stops proving, preserves findings, and moves undecided checks to runtime |
| `R2` | each open landing record retains one earlier event per path text |
| `R3` | a covered listing is skipped at its taker’s order and invalidates older open records |
| `AD-1` | a proved unchecked nullable or written-union route makes the use a compile error ([r4-444](contract.md#r4-444)) |
| `AD-3` | intrinsic known-type errors remain errors in unreachable code, with flow facts conservatively dropped |
| `§N` | a section of the research design table (TABLE), or of the plan document the comment names, outside the repository and not resolvable from it; #2209 rewrites these |

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
| [r4-363](oracles.md#r4-363) | oracles | After a stop, a diagnostic's type-reading sentence parts may follow a proven type (the owner's decision). |
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
