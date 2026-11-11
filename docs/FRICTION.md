# Friction: what cost a wrong turn

Friction reports cover the problems nobody owns until they cost someone a wrong turn. Everyone reports them under
[Report what cost a wrong turn](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#report-what-cost-a-wrong-turn), and
the coordinator triages them ([`ORCHESTRATION.md`](ORCHESTRATION.md#structure-and-friction)). This page lists the
classes a line is tagged with and the owner of each. An owner is a role or a file, never a particular agent.

| Class | What it is, with an example | Owner |
| --- | --- | --- |
| misleading code | A name, type, comment or document that promises more than the code does, or something other than what it does ([Code that does not mislead](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-that-does-not-mislead)). | The owning module, fixed at the source. |
| structure | Code outside the module or folder its owner names, or a structure signal left unanswered ([Code structure](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-structure)). | The coordinator, for the whole. |
| tool contract | A tool, flag or default that silently does something other than what its caller set: a test runner's child-heap flag overriding `NODE_OPTIONS` and the job's memory bound. | Whoever changes the tool. Its header or README is the contract. |
| wasted compute | A run that could not change the result: hundreds of jobs each rebuilding the same tree, a check asking for more memory than any worker has, a retry with a setting that changes nothing. | Whoever submits the run. The queue's own behavior belongs to the agent environment's documentation. |
| author- or user-facing wording | A diagnostic, message, interface text or documentation sentence that tells its reader nothing: "because of line 2", pointing at the use itself. | The document that owns the text: [`TEASESCRIPT-REFERENCE.md`](TEASESCRIPT-REFERENCE.md) for the sentences authors read about the language, [`DIAGNOSTICS.md`](DIAGNOSTICS.md) for the diagnostic forms, and the UI guidance ([`ui/UI-DESIGN-AND-ENGINEERING.md`](ui/UI-DESIGN-AND-ENGINEERING.md), and [`ui/PLAYER-UI.md`](ui/PLAYER-UI.md) for the Player) for interface text. |
| test weaker than its name | A test or oracle that checks less than its title says. | The test's file, under [`TESTING.md`](TESTING.md). |
| unsourced status | A status with no source, or with a stale one: "CI running" for a pull request whose CI never started because it conflicted; a local ref fetched without `+`. | Whoever states it. A status names its run, job or SHA. |
| harness delivery and wake | A message, wake or turn end that did not arrive, or that ran empty: reports sent as a turn's final message that never reached the coordinator. | The agent environment's documentation. |
| a rule not where its reader looks | A rule recorded where the agent who must apply it does not read: a wait rule in the coordinators' guide but not in the builders' rules. | Whoever records the rule. It goes where its reader reads. |
| a rule not applied at its moment | A recorded rule that applies at a known moment (a merge, a READY, a check) but was not applied then: no notice to the other open pull requests when a merge moved their base. | Whoever owns the rule. The fix is a step in the routine or checklist that runs at that moment, with the inputs that step needs produced there (the open pull requests, at a merge). |
| an instruction that sets the wrong stop | A brief whose wording sets a stop or a limit its author did not mean: asking for "the top 10 findings" ended an audit that had 32 more. | The brief's author ([Briefs](ORCHESTRATION.md#briefs)). |
| durable state left local | A plan, script or record that a restart needs, kept only on one disk or in a scratch folder. | Whoever produces it; it is committed in the same turn. |
| environment parity | Workers, CI and a local checkout that differ in what a test needs: queue trees without `.git`, or a worker without a tool that CI has. | The agent environment's documentation, and [`TESTING.md`](TESTING.md) for what the suite needs. |
| orphan flake | An intermittent failure that no pull request caused, rediscovered by each pull request that meets it. | The test's file. It is filed once. |
| a budget blind to part of what it judges | A budget or measure that leaves out part of what it judges: a CI shard balance that counts one job's pre-test checks but not the other job's oracle step. | Whoever changes the budget's tool or the workflow it measures. |
| a number without its conditions | A measurement reported without what it depends on, and then compared with one that is not comparable: a test's time on one worker against its time on another. | Whoever reports it ([Measurement](ORCHESTRATION.md#measurement)). |

A line that fits no class is tagged `other` with a proposed class name. A proposed class that recurs is added here,
with its owner.

When lines keep returning to one subject, such as a tool, a document or a process, its owner gives it a one-page
contract if it has none. The contract states what the subject does, its defaults, and what it overrides or refuses.

A filed line becomes an issue with the `friction` label and the first line `Friction class: <class>`, then a line
`Files: <paths>` naming the files or folders it concerns, so a brief can list the open issues for the files a package
touches. The open backlog
per class is the open `friction` issues grouped by that first line. A line fixed in place needs no issue: its report is
its record.

## Priority

An open friction issue is either being built, or waits on an open issue or pull request named in its `Schedule:` line,
or is free; a coordinator starts no other builder while one of its issues is free: the coordinators' launch check
refuses the launch. The line is the newest one in the issue or its comments that begins `Schedule:`, and names the
track's coordinator:

- `Schedule: taken, <coordinator>, lane <name>`: it is being built. An open pull request that closes the issue counts
  the same without a line.
- `Schedule: after #N, <coordinator>`: it waits while a named issue or pull request is open, without a time limit, and
  is free the moment all of them are closed. The reason stands beside the line.
- `Schedule: free, <coordinator>`: nothing holds it, and that coordinator's next builder takes it. An issue without a
  line is free for every coordinator.

Reviews, running work and messages to running builders are never refused. Among free issues, the order is by what
deferring costs, not by date:

- **At once:** it blocks a lane or keeps wasting compute. Its owner fixes it now.
- **Next package:** it recurs, or a lane will soon change its code.
  - A fix in an open lane's own files is that lane's next item, or part of the pull request that touches the file when
    it is small.
  - A fix in files no open lane owns, or in tooling, is the coordinator's light-route pull request between packages,
    as a move is. A friction fix never waits behind a lane's queue.
- **Otherwise:** a single, cheap instance that no lane is near is free like any other. A scope cut's residual is left
  to an issue only when it cannot bite ([Design rounds](DEVELOPMENT-WORKFLOW.md#design-rounds)).

The `spare capacity` label changes none of this: a friction issue is built, waits or is free the same with or without
it. A fix in the repository never enters another lane's open pull request. A backward-compatible fix in the agent
environment may land at once, and every lane hears of it in the same turn.

## Known friction

Until an issue is fixed, each lane it affects is warned in one line, in its brief or its next regular message: the
issue, its class, and what to watch for. The workaround is in the issue. A friction that affects every lane goes into
the rules every builder reads.
