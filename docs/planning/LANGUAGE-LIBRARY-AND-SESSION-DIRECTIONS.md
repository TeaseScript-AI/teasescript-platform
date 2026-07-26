# Language, Standard Library, pacing, and session directions

**Status:** Owner-selected direction and deferred detailed design  
**Related:** Accepted ADR 0017, accepted ADR 0016  
**Implementation status:** Not implemented

This planning note records owner-selected product direction discussed around accepted ADR 0017. It does not change accepted V30 syntax or implemented runtime behavior, and its detailed API directions remain non-binding until separately accepted.

For text-output pacing and public timer API direction, this note supersedes the older corresponding sections in `PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`. Closed PRs #69 and #71 and closed issues #67 and #68 remain historical analysis only.

## Language design intent

The common TeaseScript path should use compact syntax, minimal boilerplate, and deterministic defaults. A non-professional author should not need to understand imports, pending-action state, player UI plumbing, or engine primitives to write an ordinary tease.

Advanced authors must still be able to use explicit parameters, normal function calls, TypeScript libraries, custom UI, and lower-level capabilities where supported. Advanced control extends the simple path instead of forcing every basic script to spell out advanced machinery.

Compact official syntax such as `say "..."` should remain available when it materially improves ordinary authoring and remains unambiguous. Internal lowering through the Standard Library does not require replacing easy syntax with mandatory parenthesized calls.

## Core and first Standard Library responsibilities

The engine core should retain only canonical deterministic building blocks:

- typed text output with validated target and stable provenance;
- generic typed foreground interactions and completion validation;
- foreground delay;
- background timed work and engine-managed lifecycle state;
- opaque references, action identities, deterministic time, events, checkpoint/restore, cleanup, and security validation.

A candidate first tested Standard Library slice should prioritize the ordinary chat and foreground-interaction path:

- `say` with smart-autoplay defaults and an explicit instant override;
- one-action acknowledgement/continue interaction;
- `askText`;
- `askNumber`;
- `choose`.

Image input remains later because camera/file permissions, preview, media ownership, and recovery add a separate capability surface. Background timer wrappers should follow the background timed-work contract rather than blocking the first text/input slice.

## Text-output provenance

The first core direction uses at least:

```text
text
target
speakerId
participantSpeakerIds
```

`participantSpeakerIds` is a unique collection. It records who is involved without assuming that one `conversationId` is sufficient for every group configuration. A separate conversation identity remains deferred because the same participants may have multiple distinct conversations.

Speaker colors, avatars, personality relationships, LLM prompts, memory, summaries, model selection, and context assembly remain outside the deterministic engine.

## Smart autoplay default

The default `say` direction is deterministic **smart autoplay**, not a mandatory continue click after every chat message.

Intended behavior:

1. `say` emits its message immediately and establishes a deterministic autoplay gate for later chat output;
2. unrelated non-blocking work may continue;
3. when execution reaches a blocking player interaction before another chat message, that interaction may consume the pending gate and appear immediately;
4. when execution reaches another chat message first, the later message waits for the autoplay gate;
5. ordinary chat does not require repetitive continue-button clicks.

This avoids speculative compiler lookahead across branches. The runtime reacts to the next action that actually executes.

An explicit `instant` override remains required. Exact autoplay duration, explicit autoplay behavior, option names, and any exact-duration override remain separate decisions.

## Explicit acknowledgement instead of manual pacing

A deliberate continue moment should be a separate one-action blocking interaction rather than the default `say` behavior or a vague `manual` chat mode.

Illustrative intent only:

```tease
say "Bring me the toy."
acknowledge("Ready")
```

The final name may be `confirm`, `continue`, `acknowledge`, or another concise form. It differs from a boolean question because it has one completion action rather than yes/no result values.

## Input accessibility labels

Every text field, number field, choice group, confirmation control, or custom interaction needs a programmatic accessible name for screen readers and assistive technology.

That accessible label:

- is not a second chat or transcript message;
- should normally be supplied automatically by the Standard Library/player UI;
- should have localized defaults based on interaction kind, such as “Answer”, “Number”, “Choose an option”, or “Continue”;
- may be overridden explicitly by advanced authors or custom UI libraries when necessary.

The exact API field remains open.

## Timed-work and timer handles

The next timer design starts from:

- one foreground delay primitive;
- one background timed-work primitive;
- explicit pause, resume, and stop semantics for active background timed work.

Visible countdowns, mystery presentation, repetition, persistence, restart-after-stop, and friendly author names belong above the primitives when possible.

Timer lifecycle operations should target an explicit timer handle. An omitted argument meaning “the only active timer” is not selected because branches, input, nested calls, and background handlers can make the active timer count runtime-dependent and ambiguous.

The public API should be handle-oriented. Whether it uses methods such as:

```tease
timer.pause()
timer.resume()
timer.stop()
```

or functions such as:

```tease
pauseTimer(timer)
resumeTimer(timer)
stopTimer(timer)
```

remains open and depends partly on the accepted type/library linkage model.

## Session pause and recovery

The default direction is exact checkpoint resume: an ordinary pause, reload, or reconnect resumes the same validated saved state rather than silently jumping backward.

The player-initiated pause policy for active local timers remains open. Freezing time is convenient but can weaken a timed challenge; continuing time can be unfair during genuine device or browser unavailability. Cheat-resistant long-running deadlines should use server-authoritative scheduling or another explicitly accepted time-integrity policy.

Author-defined recovery/resume points are an advanced future feature, not merely checkpoint labels. Rolling back must define the treatment of:

- variables, scopes, RNG, call/loop progress, and pending actions;
- transcript and player-view state;
- media and custom UI;
- completed timers or assignments;
- account writes, history, notifications, and other irreversible external effects.

A recovery design must prevent repeated irreversible effects and requires a separate ADR or planning decision.

## Library scopes and alternatives

The future library model has three author-facing scopes above the engine:

1. platform Standard Library, available by default;
2. explicitly imported published community libraries;
3. package-local libraries.

Advanced packages may later disable the default Standard Library prelude or explicitly map selected Standard Library-facing names to compatible alternatives. Replacement must be intentional and visible in package metadata; imports must not silently override unrelated functions.

The first linkage implementation should not require community-library-to-community-library dependencies. Later support requires exact version binding, cycle rejection, lock data, moderation rules, and no transitive capability escalation.

## Deferred detailed decisions

- exact core capability names and TypeScript interfaces;
- Standard Library linkage, generated metadata, packaging, default prelude, and version binding;
- exact smart-autoplay duration and gate-consumption rules;
- final acknowledgement API name;
- exact participant and optional conversation identity schema;
- generic typed-interaction schema and public wrappers;
- accessible-label API;
- timer handle representation and methods-versus-functions choice;
- pause/resume/stop/restart, repetition, persistence, and timer UI;
- player-initiated pause time policy;
- advanced recovery-point rollback semantics.
