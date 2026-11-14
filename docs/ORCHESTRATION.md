# Orchestration: rules of thumb for coordinators

Practice for a coordinator ([Roles](DEVELOPMENT-WORKFLOW.md#roles)) who starts without context. These are rules of
thumb, not requirements, except [Repository ownership](#repository-ownership), which records an owner's decision. The
accepted workflow is [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md), which this document does not repeat and which
wins where the two differ. Practice specific to one machine or tool belongs in that environment's documentation, and
live state in the coordinators' repository.

## State

Keep a roster in the coordinators' repository: each lane, its current item, what it waits on and the open
[friction](FRICTION.md#known-friction) issues that touch its files or tools, and one line per open pull request
listing each review round's findings by their nouns. On resume, read the roster and the latest log lines, not the
transcript, then re-establish each lane's state from GitHub before the next write, as `AGENTS.md` requires.
When a child's work is done, clean up after it as the agent environment's `/opt/agent-stack/ORCHESTRATION.md`
"Cleanup after a child" says; that section is the canonical text.

## Messages

Messages follow events, as [Builder messages and READY](DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready) describes
for the builder.

Each incoming message gets the same four questions, in this order, before anything else:

1. What does the lane need from you now, a ruling or a decision, and can you give it in this turn?
2. What will it need next that you can already see, such as a rebase rule once the main branch moved, the bar its
   measurement will be judged by, or the next round's scope? Send that now, with its conditions.
3. Which claim in it gates a write of yours, such as a verdict, "CI green" or "evidence complete"? Read that claim from
   its source.
4. Which rule or fact in it must reach other lanes?

Answer "nothing to do" only when all four are empty, and update the lane's line in the roster either way. Then check
the shape of the turn end: a turn that ends with open jobs names the wait that wakes it, and a READY names its head and
its evidence. A missing piece gets one line back, in the same turn.

- One message carries one complete ruling.
- Report each event once. Where the harness delivers a turn's final message to the coordinator, the report is that
  final message and nothing is sent besides it. Otherwise it is one sent message, and the final message is only the
  one-line status. Never both: two copies cost two writes, two wakes and two reads.
- When a builder's turn must end without an event, its final message is one `WAITING: <what>` line, and the
  coordinator takes no action on it. It is the harness's required final output, not a progress note.
- Do not wake an idle builder for something it need not act on now; put it in the next real message.
- A question a lane repeats after you answered means its turns predate the answer: steer the running turn once with
  the same ruling; never re-decide.
- When two of your rulings cross a lane's turns, the later one names what the earlier one said and what to undo, in
  one message.
- Relay a review verdict only after reading the review comment itself: a builder's summary of its own round omits the
  findings it has already repaired.
- A builder that waits on a job ends its turn with the wait that wakes it, never with the job alone. Treat a silent or
  empty completion as a harness event until the thread's own items show otherwise: verify it there, then wake the lane
  again with the job's state.

## Briefs

A brief is a file the assignment points to. What it asks for follows the workflow's requirements for
[the plan](DEVELOPMENT-WORKFLOW.md#the-plan), [READY](DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready), and
[the final-review brief](DEVELOPMENT-WORKFLOW.md#the-final-review).

- Ask for every finding within the scope, ranked, with a coverage statement of what was read in full, in part, or
  skipped. Never ask for a fixed number of findings ("the top 10"): the agent stops when it reaches it. Bound the cost
  by the scope and the job limits instead; a fixed number of cases to construct is a different thing and stays allowed.
- Before sending, read the brief as its receiver would. Would it stop early, miss part of the scope (the code, its
  documentation, similar names), or not know what "done" means? Fix the brief rather than following up.
- State the environment facts the builder will rely on: where its dependencies come from, which checks run locally and
  which elsewhere, and how to format. Point to the environment's documentation for the details. A builder then never
  works around a tool it only believed missing.
- Name the files the package will touch, the open `friction` issues in them, and the order against other open pull
  requests in the same files. The builder judges them at HEAD 0
  ([Code structure](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-structure)).
- A final-review brief is also bounded: named cases, campaigns of a stated size, and evidence the reviewer samples
  rather than every run. The final reviewer's only write stays one comment on the pull request.
- To complete a deliverable an agent left incomplete, continue that same session: it has read the material and knows
  its unreported candidates. A fresh session is for an independent check.
- A design-round record states every code fact as read, probed or unverified, and a conditional acceptance lists its
  conditions in the record itself.
- Research starts only with an early visible deliverable and a stop criterion. [Pre-research](DEVELOPMENT-WORKFLOW.md#the-plan)
  pays most when it can refute a construction before anything is built.

## Pacing

- Start work once it is clear ([Normal flow](DEVELOPMENT-WORKFLOW.md#normal-flow)), and let running work finish. This
  is about load and pacing; a repair cycle that does not converge follows
  [Review convergence](DEVELOPMENT-WORKFLOW.md#review-convergence) instead.
- Correct course in small steps, not by abrupt stops or reversals. Stop running work only when continuing does real
  harm.
- An agent idle beyond its prompt-cache lifetime re-reads its whole context at full cost on the next wake, and that
  cost grows with the thread. Keep a lane's agent warm or end it; never wake it cold. An agent whose message you just
  read is warm; otherwise judge warmth by the clock: the thread's last activity against the cache lifetime.
- New work for a lane whose agent is cold goes to a fresh agent, with a brief that points at the lane's plan record and
  its pull-request description. The lane keeps both current as it goes, so a restart needs nothing else. A lane that
  resumes correctly from them keeps its worktree and queue ownership.
- A lane that waits ends its turn with a wait no longer than the cache lifetime, and re-arms it inside the run, so it
  keeps itself warm.
- At each periodic check, read what each lane waits on from the roster ([State](#state)): the thread's last activity
  only tells you whether that line is stale. A lane that would go cold before the next check gets the ruling when it
  waits on you, or bounded preparatory work when it waits on another lane (its next item's plan, its description
  draft, a probe). A lane whose wait is armed gets nothing, and none gets an empty wake. Its wake signal for the real
  work stays the event it waits on, such as another lane's merge.
- When a reviewer finds a sibling in every part of a construction, the next step is your reassessment of the class, not
  another repair: a narrower claim stated truthfully beats a wider one that review keeps refuting.
- An observation is not an instruction: weigh it, or ask, before changing work because of it.

## Merge

Encode the [merge checklist](DEVELOPMENT-WORKFLOW.md#merge) as a script whose guards refuse: the records script
compiles with no placeholder left, the evidence manifest verifies, the base is unchanged since READY, the head is clean,
and the diff holds no generated file, debug line or secret. Let it write the records (the table row, the plan row, the
tracker row) in the same step as the merge. Prepare those rows before READY where the facts are known, with
placeholders the guards refuse to run with (the final head, the final verdict).

Evidence gathered at an earlier head carries to the final head only by a file-level diff that touches nothing the
result depends on, recorded with the evidence per result; otherwise it reruns.

## Parallel lanes

A lane owns a folder or a set of folders, and every file in them, plus one chain of plans; it is not an agent. One agent works in it at a time;
the agent is kept while the chain is open and released at its end. Lanes run in parallel unless they change the same
functions. Items that change the same function run one after the
other: the second waits until the first has merged, then rebases onto the new base. Because the shared function
changed, that rebase changes the second item's delta, so its affected evidence reruns and its review rounds restart on
the changed part ([Pull requests and rebases](DEVELOPMENT-WORKFLOW.md#pull-requests-and-rebases)). This is not a stack
and not an identity rebase. While a pull request waits on a design round, its lane builds its next item.

## Structure and friction

You own the structure of the whole: each pull request can be reasonable while the whole drifts. After each merged
package, or at each milestone, run `node tools/structure-report.mjs --json <file>` and compare it with the last report kept
in the evidence (`--compare`). Before each merge, read the pull request's file signals in the job summary of CI's
check-3 ([its structure step](TESTING.md#normal-and-diagnostic-verification)). When a signal shows a clear seam, plan the split or the folder move
as its own pull request, scheduled between packages. Before a package, the brief names the signals and friction issues in the files
it will touch, and HEAD 0 decides each ([Briefs](#briefs)); the check after the merge then finds only what the package
added.

Triage each [friction](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#report-what-cost-a-wrong-turn) line at the end of
the package it arrived in, or at once when it blocks a lane or keeps wasting compute. Triage comes first and decides
whether fixing the line is worth it: only a line that is worth fixing becomes an issue.

- **fixed:** the line is its record;
- **filed:** an issue, as [`FRICTION.md`](FRICTION.md) describes, with its `Schedule:` line;
- **a rule:** proposed like any other rule;
- **not planned:** the fix adds no value, or costs more than the problem does. The line gets no issue; its record says
  so, with the reason. An issue already open that is not worth fixing is closed at once as not planned, and its closing
  comment gives the reason and what would reopen it.

Friction may be reported often, and judging a line or an open issue not worth fixing is normal.

Your own wrong turns are lines too. Keep the triage with your state. At each structure check, add the friction
counts: lines per class since the last check, with their dispositions, and open issues per class with the age of the
oldest, against the last check's counts. No open issue waits to be promoted: [`FRICTION.md`](FRICTION.md#priority) says
when an issue is being built, waiting or free, and that a coordinator starts no other builder while one of its issues is
free.

Count the tax as well as the reports. Beside the structure report, count across the repository the lint disables,
`@ts-expect-error` and `@ts-ignore` directives, and skipped tests, and compare them with the last check. The number
rises visibly even when nobody reports it. A count that rises two packages running is a `tool contract` item.

## Facts that cross lanes

A measurement one lane makes that changes a rule another lane runs under (a runner's cap, a baseline's limit, a shared
source that stalls on the main branch) reaches every lane in the same turn, and the rule it corrects is corrected in the
shared rules file, not only in the lane's thread.

A new or changed rule reaches its readers in the turn it exists. It goes into the file they read, and to each lane it
affects as one message that names that lane's own instance. A rule you pass to another coordinator comes with the
sentence its builders will read.

## Measurement

A conditional acceptance of a plan or ruling names the measurement that must confirm it, and the builder runs that
measurement before spending the full series. Measure instead of asserting, and when a measurement refutes your own
premise, correct it in the open.

## The owner

- Keep messages short, with the owner's action first.
- Never present your own conclusion as the owner's.
- Appearance and other product choices, and policy, are the owner's ([Roles](DEVELOPMENT-WORKFLOW.md#roles)). A choice
  that keeps today's behavior is the coordinator's; a builder labelling it an owner decision is corrected, not
  forwarded.
- Development tooling and mechanical checks, and the procedures coordinators run with them (briefs, checklists,
  triage), are the coordinators' to decide (owner, 2026-11-07; `AGENTS.md`). Before one lands, get feedback from the
  other coordinator, if there is one, and from the builders who will use it, and weigh it critically. The owner wants
  them well built, worded so they are not misread, and neither too strict nor too loose, and to be told in plain
  words what each one changes. A disagreement between coordinators goes to the owner.
- Show the exact wording of any persistent change.
- Put questions for the owner on the issue tracker.

## Between coordinators

- Agree the interfaces between your lanes and theirs explicitly.
- Tell the other coordinator when you change a file both of you depend on.
- Say when a campaign of yours will take more than its share of the queue or the model budget, before it starts.
- A question to another coordinator carries your own answer, so the reply is a yes or a correction.

## Repository ownership

Owner's decision of 2026-11-09, agreed by both coordinators the same day. Rules and handoffs point here instead of
restating it. The owner decides what the product and the language are; ownership here is who schedules, builds and
reviews a file's structure and changes.

### The two scopes

- **The compiler coordinator owns the whole compiler:** parser, lexer, semantics, reachability, speaker flow,
  operation checks, lowering, the compiler entry point (`src/compiler.ts`), type inference, the V2 core and families,
  and the compiler's tests, helpers and fixtures (`tests/type-*`, `tests/helpers/type-core*`, `tests/fixtures/type-core/`,
  `tests/language-tooling/probe-tool.test.ts`, `tests/runtime/language/otherwise-fallback.test.ts`). Also
  `tools/oxlint/*`, `tools/probe.mjs`, the compiler-differential tool, the families runner (`tests/families/run.mjs`,
  `tests/families/stalls.mjs`, `tests/families/baselines.mjs`, the baseline store's format), and the two language
  specification documents (`docs/TEASESCRIPT-REFERENCE.md`, `docs/specifications/accepted-syntaxes-v30.md`): the compiler's
  canonical text; new syntax still needs the owner's acceptance.
- **The runtime and Playroom coordinator owns runtime, Playroom and everything general:** `src/runtime/`, `player/`, the
  bridge, their tests; `tools/` as repo-wide tooling (`check-changed`, `measure-test-files`, the costly table,
  `pin-suites.mjs`, `check-shas`, the test runners, the browser tools, `tools/local-agent/*`,
  `tools/chatgpt-project-agent/*`), where the compiler entries inside such a tool (the pin-suite list, the compiler's
  costly entries) are the compiler coordinator's; docs as a tree; examples; benchmarks; `playground/`; the central
  queue the families runner runs on; `package-lock.json`; and the top-level grouping of `tests/`, `src/` and `tools/`
  (see the folder-move refinement).

### The plan format and language tooling

- **`src/plan/` is the compiler coordinator's, whole** (`model.ts` and `validation/`), with the runtime and Playroom
  coordinator as required reviewer of every change. The format changes when the language changes, and model and
  validation change together then. The runtime's own boundaries (checkpoint, host, package data) stay the runtime and
  Playroom coordinator's. `tests/plan/instruction-plan-validation.test.ts` follows the folder.
- **Language and editor tooling is compiler side:** `src/language-tooling.ts`, its tests, and the editor adapters
  beside it. A grammar change breaks it, so the one who changes the grammar owns it.

### The rule for shared entries

A file under `src/` that parses, analyses, lowers or types the language is the compiler coordinator's.
`src/message-markup.ts` is the runtime and Playroom coordinator's: a value the runtime and the Playroom read, whose
persisted-tree validation is a runtime boundary. Feature suites that compile source and run the engine
(`compact-interactions`, `file-transfers`, `project-globals`, `regex`, `list-functions`, `value-check-forms`) are the
runtime and Playroom coordinator's while they are one file; when one is split at its families, the parsing half goes to
the compiler coordinator with the split.

### The folder-move refinement

The runtime and Playroom coordinator executes the top-level grouping moves of `tests/`, `src/` and `tools/` (the folder
plan, the test-runner change that lets `tests/` have one level of folders, the pure-move PRs decided by `git diff -M`,
tsc, `check:imports`, knip and equal test counts). The names and membership of the compiler's folders are the compiler
coordinator's. One folder plan, approved by both coordinators before its HEAD 0; the other coordinator is required
reviewer of the move PR.

### Instructions that steer agents

Skills, the reading route and process documents have no fixed owner. What changes how the owner works with agents, or
frustrates the owner when it goes wrong, is agreed with the owner first. What does not touch the owner, a coordinator
fixes when hitting the problem; when unsure, ask.

**Open:** `src/regex.ts` and `src/regex-engine.ts` have no single owner (shared by the compiler, validation and the
runtime per the docblock); noted 2026-11-09 at the regex test split, to be decided when a change to them needs an owner.
