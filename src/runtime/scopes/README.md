# Scopes

Where variables live: activations, the variables blocks share, and prepared references to variables.

- `activations.ts`: activations: each entry into a file has a root scope of its own.
- `activation-validation.ts`: restore validation of activations.
- `captures.ts`: the variables a timer, media, or button block shares with the code that created it.
- `capture-validation.ts`: restore validation of those shared variables.
- `prepared-references.ts`: prepared references: encoding, resolving, detaching, and rebasing them.
