# Orchestration: rules of thumb for coordinators

Practice for a coordinator ([Roles](DEVELOPMENT-WORKFLOW.md#roles)) who starts without context. These are rules of
thumb, not requirements. The accepted workflow is [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md), which this
document does not repeat and which wins where the two differ. Practice specific to one machine or tool belongs in that
environment's documentation, and live state in the coordinators' repository.

## State

Keep a roster in the coordinators' repository: each lane, its current item and what it waits on, and one line per open
pull request listing each review round's findings by their nouns. On resume, read the roster and the latest log lines,
not the transcript, then re-establish each lane's state from GitHub before the next write, as `AGENTS.md` requires.

## Messages

Messages follow events, as [Builder messages and READY](DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready) describes
for the builder.

- One message carries one complete ruling.
- No duplicate summaries: once an event has been sent explicitly, the turn's final message is only the one-line status.
- When a builder's turn must end without an event, its final message is one `WAITING: <what>` line, and the
  coordinator takes no action on it. It is the harness's required final output, not a progress note.
- Do not wake an idle builder for something it need not act on now; put it in the next real message.
- A question a lane repeats after you answered means its turns predate the answer: steer the running turn once with
  the same ruling; never re-decide.

## Briefs

A brief is a file the assignment points to. What it asks for follows the workflow's requirements for
[the plan](DEVELOPMENT-WORKFLOW.md#the-plan), [READY](DEVELOPMENT-WORKFLOW.md#builder-messages-and-ready), and
[the final-review brief](DEVELOPMENT-WORKFLOW.md#the-final-review). A final-review brief is also bounded: named cases,
campaigns of a stated size, and evidence the reviewer samples rather than every run. The final reviewer's only write
stays one comment on the pull request.

## Pacing

- Start work once it is clear ([Normal flow](DEVELOPMENT-WORKFLOW.md#normal-flow)), and let running work finish. This
  is about load and pacing; a repair cycle that does not converge follows
  [Review convergence](DEVELOPMENT-WORKFLOW.md#review-convergence) instead.
- Correct course in small steps, not by abrupt stops or reversals. Stop running work only when continuing does real
  harm.
- A builder idle beyond its prompt-cache lifetime re-reads its context at full cost on the next wake. When that context
  is stale, restart it as a fresh agent from its plan instead: the plan file on the full route, or the pull-request
  description on the light route. A long-running lane that resumes correctly from its plan keeps its worktree and queue
  ownership.
- An observation is not an instruction: weigh it, or ask, before changing work because of it.

## Merge

Encode the [merge checklist](DEVELOPMENT-WORKFLOW.md#merge) as a script whose guards refuse: the records script
compiles, the evidence manifest verifies, the base is unchanged since READY, and the head is clean. Let it write the
records (the table row, the plan row, the tracker row) in the same step as the merge. Prepare those rows at READY, with
one placeholder for the final verdict.

## Parallel lanes

Lanes run in parallel unless they change the same functions. Items that change the same function run one after the
other: the second waits until the first has merged, then rebases onto the new base. Because the shared function
changed, that rebase changes the second item's delta, so its affected evidence reruns and its review rounds restart on
the changed part ([Pull requests and rebases](DEVELOPMENT-WORKFLOW.md#pull-requests-and-rebases)). This is not a stack
and not an identity rebase. While a pull request waits on a design round, its lane builds its next item.

## Cost

- Start research only with an early visible deliverable and a stop criterion.
- [Pre-research](DEVELOPMENT-WORKFLOW.md#the-plan) pays most when it can refute a construction before anything is built.

## Measurement

A conditional acceptance of a plan or ruling names the measurement that must confirm it, and the builder runs that
measurement before spending the full series. Measure instead of asserting, and when a measurement refutes your own
premise, correct it in the open.

## The owner

- Keep messages short, with the owner's action first.
- Never present your own conclusion as the owner's.
- Appearance and other product choices, and policy, are the owner's ([Roles](DEVELOPMENT-WORKFLOW.md#roles)).
- Show the exact wording of any persistent change.
- Put questions for the owner on the issue tracker.

## Between coordinators

- Agree the interfaces between your lanes and theirs explicitly.
- Tell the other coordinator when you change a file both of you depend on.
- The compute queue and the model budget are shared.
