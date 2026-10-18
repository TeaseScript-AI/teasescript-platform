# Actions

Pending actions: what a script waits for or keeps running, and how each kind behaves.

- `model.ts`: the serializable pending-action and settlement contracts.
- `interrupts.ts`: the action policy: what blocks and the host do about each kind of foreground action.
- `action-validation.ts`: restore validation of pending actions, settlements, pacing gates, and handoffs.
- `capture.ts`: what the host vouches for about captured media and stored files.
- `choice-options.ts`: the buttons of a prepared `askChoice`.
- `delay.ts`: the domain of a session time.
- `file-store.ts`: the calls that store, read, or hash files in the Player's file store.
- `form.ts`: `askForm`: its UI, state, updates, submission, and validation.
- `interaction.ts`: completing an interaction, and the button timeout and image request helpers.
- `lock.ts`: the calls that lock and open text and stored files.
- `pacing.ts`: the pacing of a message.
