# LLM integration

LLMs may provide constrained dialogue or typed results while the deterministic TeaseScript engine remains authoritative. LLMs may not silently change canonical state, bypass rules, directly control the main site, or access the operating system and devices without validated engine capabilities.

Provider selection, local/cloud execution, context storage, vision evidence, tool permissions, retries, costs, moderation, and privacy remain later design work. LLM integration is not part of the current parser/runtime, control-flow, or user-function milestones.

## Accepted first Standard Library interaction boundary

ADR 0018 does not add LLM interpretation to the first deterministic interaction POC. `askText`, `askNumber`, `choose`, and `showButton` must first work through exact typed validation without an LLM dependency.

A later optional interpreter may receive only bounded structured context relevant to the active interaction, such as:

```text
requesting speaker
active question or recent relevant transcript
expected result type
allowed choice labels and visible texts
submitted player text
validation failure
```

For `choose`, the LLM may propose exactly one currently allowed label or visible option, or a typed `needsClarification` outcome. For `askNumber`, it may propose one finite number or `needsClarification`, for example when interpreting natural language such as “about twenty”. It may also generate speaker-styled clarification text through the normal validated chat-output path.

The deterministic engine remains authoritative:

- it validates the returned typed result against the active action;
- it accepts only an allowed choice or valid finite number;
- it keeps the interaction active when interpretation fails or clarification is needed;
- it derives canonical choice transcript text from the active action rather than trusting LLM-supplied display text;
- it does not let the LLM mutate variables, select an unavailable option, complete another action, bypass an unskippable gate, or cancel a mandatory interaction;
- it records canonical state changes only through normal action settlement and sequenced events.

The exact API, prompt assembly, recent-history selection, privacy rules, provider policy, retry behavior, and author-facing options remain deferred.
