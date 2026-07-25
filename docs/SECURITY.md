# Security boundaries

- Run the complete player and package code in a sandboxed cross-origin iframe, preferably on a separate player origin.
- Keep main-site cookies host-only and unavailable to the player.
- Validate every parent/player message, checkpoint, package manifest, server response, and future integration result.
- Capture external instruction-plan, runtime-snapshot, checkpoint, globals, and serializable-value data into one stable plain-data graph bounded to a nesting depth of `128` and `100,000` visited values. Reject accessors, trap failures, cycles, unsupported prototypes, and over-limit input before recursive validation, cloning, freezing, state construction, execution, event emission, or RNG consumption.
- Keep serializable-set validation and reconstruction linear while preserving insertion order, scalar equality, and the canonical array representation.
- Package code has no unrestricted external network access; published media uses platform-managed storage/CDN.
- Future external APIs use platform-managed typed integrations.
- LLM output is untrusted input and may not directly rewrite canonical state or bypass deterministic rules.

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, and moderation workflows remain to be specified.
