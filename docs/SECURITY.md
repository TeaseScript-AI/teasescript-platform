# Security boundaries

- Run the complete player and package code in a sandboxed cross-origin iframe, preferably on a separate player origin.
- Keep main-site cookies host-only and unavailable to the player.
- Validate every parent/player message, checkpoint, package manifest, server response, and future integration result.
- Bound external instruction-plan, runtime-snapshot, checkpoint, and serializable-value validation to a nesting depth of `128` and `100,000` visited values. Reject over-limit input as malformed before recursive cloning, freezing, state construction, execution, event emission, or RNG consumption.
- Package code has no unrestricted external network access; published media uses platform-managed storage/CDN.
- Future external APIs use platform-managed typed integrations.
- LLM output is untrusted input and may not directly rewrite canonical state or bypass deterministic rules.

Exact iframe sandbox flags, CSP, message schemas, capability negotiation, signing, and moderation workflows remain to be specified.
