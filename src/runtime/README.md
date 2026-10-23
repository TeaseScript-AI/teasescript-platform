# Runtime

The engine that runs a compiled instruction plan on explicit, serializable state. Start here:

- `session.ts`: the runtime session a host uses: it keeps the state private and offers the host operations.
- `engine.ts`: running instructions: `run`, `stepToEvent`, `executeInstruction`, and the exhaustive instruction
  dispatch.
- `evaluator.ts`: evaluating expressions: their order, the expression dispatch, and builtin calls.

Also at the top:

- `errors.ts`: runtime faults and failure messages.
- `events.ts`: the events an operation returns.
- `event-validation.ts`: checks an event a host kept.
- `warnings.ts`: the shape of a developer warning.
- `message-presentation.ts`: the presentation of a message or of the player's answer.

Folders:

- `instructions/`: each instruction family the engine dispatches to.
- `evaluation/`: each expression family the evaluator calls, and what the plan says about expressions.
- `actions/`: pending actions: their contracts, the action policy, the action families, and their validation.
- `operations/`: host operations on a session: completing actions, observing time, media reports, and more.
- `snapshot/`: the state model, building, copying and validating snapshots, checkpoints.
- `values/`: runtime values and the operations on them.
- `background/`: timers, media, and permanent buttons.
- `scopes/`: activations, the variables blocks share, and prepared references.
- `random/`: the generator and controlled randomness.
- `host-data/`: the player profile, the player's clock, script storage, and the file store.
- `debug/`: the debug trace, inspection, and the instruction trace.
