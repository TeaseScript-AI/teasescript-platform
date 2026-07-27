# Language, Standard Library, pacing, and session directions

**Status:** Owner-selected direction; first Standard Library slice accepted by ADR 0018  
**Related:** Accepted ADR 0016, accepted ADR 0017, accepted ADR 0018  
**Implementation status:** Not implemented

This planning note records retained product direction around accepted ADRs 0017 and 0018. ADR 0018 is authoritative for the detailed first Standard Library POC contract. This file keeps adjacent timer, session, library-scope, typing-indicator, and recovery directions findable without redefining that accepted contract.

For text-output pacing and public timer API direction, this note supersedes the older corresponding sections in `PLAYER-CAMERA-MEDIA-AND-PACING-FOLLOW-UPS.md`. Closed PRs #69 and #71 and closed issues #67 and #68 remain historical analysis only.

## Language design intent

The common TeaseScript path should use compact syntax, minimal boilerplate, and deterministic defaults. A non-professional author should not need to understand imports, pending-action state, player UI plumbing, or engine primitives to write an ordinary tease.

Advanced authors must still be able to use explicit parameters, normal function calls, TypeScript libraries, custom UI, and lower-level capabilities where supported. Advanced control extends the simple path instead of forcing every basic script to spell out advanced machinery.

Compact official syntax such as `say "..."` should remain available when it materially improves ordinary authoring and remains unambiguous. Internal lowering through the Standard Library does not require replacing easy syntax with mandatory parenthesized calls.

## Core and first Standard Library responsibilities

The engine core retains canonical deterministic building blocks:

- typed text output with validated target and stable provenance;
- generic typed foreground interactions and completion validation;
- foreground delay;
- background timed work and engine-managed lifecycle state;
- opaque references, action identities, deterministic time, events, checkpoint/restore, cleanup, and security validation.

ADR 0018 accepts this first tested Standard Library sequence:

1. `showButton`, `askText`, `askNumber`, and `choose` on one generic typed foreground interaction;
2. `say` with deterministic smart-autoplay defaults, exact seconds, `0`, `instant`, and speaker-aware skip policy.

`wait` remains compiler/core-owned. Image input remains later because camera/file permissions, preview, media ownership, and recovery add a separate capability surface. Background timer wrappers should follow the background timed-work contract rather than blocking the first text/input slice.

## Standard Library availability and lowering

The first POC uses the Platform Standard Library as an automatic prelude. Selected names are direct, protected from ordinary script shadowing, and cannot be disabled or replaced in this slice.

The selected resumable behavior is fully lowered into the versioned instruction plan. A running or restored session keeps its original plan and captured pacing configuration and never resolves against an implicit latest Standard Library. No checkpoint migration or final package identity format is introduced.

Package-local and published community-library imports, namespaces, manifests, lockfiles, replacement mappings, and community-to-community dependencies remain later work.

## First-POC provenance

The first core direction uses:

```text
text or Standard UI payload
target
speakerId: optional
```

The first POC has one Standard chat target. `speakerId` records the stable requesting or speaking runtime speaker when one exists; narrator/system output does not invent a speaker.

A broader involved-speaker collection and separate `conversationId` remain deferred. Speaker colors, avatars, fonts, personality relationships, LLM prompts, memory, summaries, model selection, and context assembly remain outside the deterministic engine.

## Basic foreground interactions

The accepted interaction forms support optional `as speaker` provenance:

```tease
showButton as mistress "Ready"
let answer = askText as mistress "Type your answer"
let amount = askNumber as mistress "Enter a number"
let result = choose as mistress yes: "Yes", no: "No"
```

The optional text for `askText` and `askNumber` is Standard UI field text or a hint, not an automatic speaker transcript message. The question is normally emitted through a preceding `say`.

The four interactions are mandatory and non-cancellable. Invalid input leaves the same action active. `askText` returns normalized non-whitespace-only `string`; `askNumber` returns finite `number`; `choose` returns visible text, an identifier label, or a numeric label according to its accepted form; the first `showButton` slice has no useful return or timeout.

`askText` normalizes line endings but otherwise preserves text. `askNumber` trims and parses accepted TeaseScript number syntax while retaining the trimmed submitted form in the transcript. Canonical transcript text for choice and button controls is derived by the engine from the active action rather than accepted independently from the Player application.

Compact `choose` uses comma-separated options in one statement. Labelled and unlabelled options may not be mixed. Identifier and numeric labels are supported but may not be mixed in one choice. Labels must be unique. Duplicate visible text is rejected for unlabelled choices but permitted for uniquely labelled controls.

Interaction definitions and completions are bounded by shared versioned platform limits. ADR 0018 deliberately sets no separate per-field character limits. Concrete technical constants must be selected and tested during implementation; no data is silently truncated or partially accepted.

## Standard composer and choice presentation

The Standard Player application uses one composer, focused by default. Choice and button controls appear directly above it. Valid answers and control activations become player-authored transcript messages while the engine stores the typed result.

Choice buttons may occupy one or two rows. The Player application may use a dropdown when viewport, text, font, zoom, accessibility, or other layout constraints make buttons impractical. Exact breakpoints remain deferred.

Button versus dropdown is presentation state, not canonical runtime or checkpoint state. The same restored choice may render differently on another viewport without changing completion, transcript, or return semantics.

## Smart autoplay default

The default `say` behavior is deterministic smart autoplay, not a mandatory continue click after every chat message.

A fresh session captures non-negative safe-integer millisecond settings:

```text
baseDelayMs
delayPerWordMs
delayPerCharacterMs
```

with defaults:

```text
baseDelayMs = 1500
delayPerWordMs = 300
delayPerCharacterMs = 30
```

Duration is:

```text
baseDelayMs + max(
    wordCount * delayPerWordMs,
    visibleCharacterCount * delayPerCharacterMs
)
```

A present invalid setting causes a structured session-configuration error. Arithmetic and deadline construction are checked. There is no additional product reading-time cap, but ADR 0016 technical numeric and deadline limits apply. Account changes do not alter an active or restored session.

A positive gate is one ADR 0016 `chatPacingGate` action:

1. a normal `say` emits and creates a background pacing action;
2. unrelated non-blocking work may continue;
3. a later `say` is prepared once and moves the same gate, with the same identity and deadline, to the foreground slot;
4. `showButton`, `askText`, `askNumber`, or `choose` settles and consumes a background gate before appearing immediately;
5. `wait` does not consume the gate, although shared session-time advancement may expire it;
6. `0` and `instant` settle an earlier background gate, emit immediately, and create no new gate;
7. branches, calls, and loops depend only on the path actually executed; there is no compiler lookahead.

Time observations settle due actions by deadline then action ID. Every transition uses normal action IDs, `actionRequested`, `actionCompleted`, active-first lookup, bounded settlement replay, checkpoint state, and later continuation execution. No hidden pacing state machine is permitted.

## Skippable and unskippable output

A speaker may define `defaultSaySkippable` alongside presentation properties such as font, color, and avatar. This does not override the player's reading-speed settings.

Per message:

```tease
say as mistress unskippable "Read every word."
say as mistress skippable "You have seen this before."
```

No modifier uses the speaker default and otherwise platform default `true`.

A skippable gate may be completed by a primary click/tap anywhere in the player iframe viewport, including the background, or by Space while the focused composer is empty. Interactive controls have priority. Ordinary keys type in the focused composer; Space is ordinary input when text is already present. Skip completes only the pacing gate and never completes `wait`, cancels input, skips arbitrary instructions, or creates a player transcript message.

## Explicit acknowledgement instead of manual pacing

A deliberate continue moment is the separate mandatory `showButton` interaction rather than the default `say` behavior or a vague manual chat mode.

```tease
say as mistress "Tell me when you are ready."
showButton as mistress "Ready"
```

Activating the button adds its stored `Ready` label as a player transcript message and completes the pending interaction.

V30 timeout and elapsed-time return remain later `showButton` capability and are excluded from the first slice.

## Input accessibility labels

Every text field, number field, choice group, button, or custom interaction needs a programmatic accessible name for screen readers and assistive technology.

That accessible label:

- is not a second chat or transcript message;
- is normally derived by the Standard Library/Player application from visible control text or a localized default;
- remains required when an author supplies an empty visual hint;
- may later receive an explicit advanced author override;
- remains the responsibility of a custom UI replacement.

The exact advanced override field remains open.

## Deferred typing indicator

A future chat presentation version should support a deterministic speaker-aware typing indicator before message emission, for example “Mistress is typing…”.

That is a separate phase from the post-message reading gate. Its duration formula, author override, speaker defaults, checkpoint state, accessibility behavior, and interaction with `instant` and smart autoplay remain deferred. It must not be implemented as a hidden browser timeout or uncheckpointed visual effect.

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

Timer pause/resume is a script-visible lifecycle operation on a specific timer handle. It is distinct from developer-mode runtime Pause.

## Session pause and recovery

The default direction is exact checkpoint resume: an ordinary reload or reconnect resumes the same validated saved state rather than silently jumping backward.

The normal Player application has no player-facing pause button. TeaseScript gains no author-facing session-pause command through ADR 0018. Developer mode may provide Run, Step, Pause, checkpoint, restore, and debugger controls.

Browser unavailability, reload, reconnect, device sleep, visibility changes, and clock integrity still require a policy for local timed work. That lifecycle policy is not a player command. Cheat-resistant long-running deadlines should use server-authoritative scheduling or another explicitly accepted time-integrity policy.

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

ADR 0018 resolves the detailed first-slice contract. Remaining directions include:

- exact core TypeScript capability names and internal instruction layouts;
- final package-library linkage, generated metadata transport, packaging, versioning, and migration;
- concrete shared platform limit constants for interactions and host messages;
- advanced parenthesized interaction forms and validation options;
- detailed interaction result objects and their selecting option name;
- `showButton` timeout and elapsed-time return;
- exact dynamic choice-layout breakpoints and measurement algorithm;
- exact advanced accessibility override field;
- typing-indicator formula and syntax;
- constrained LLM interpretation implementation and author-facing options;
- broader text targets, involved-speaker collections, and conversation identity;
- timer handle representation and methods-versus-functions choice;
- timer pause/resume/stop/restart, repetition, persistence, and timer UI;
- browser-unavailability and reconnect time-integrity policy;
- advanced recovery-point rollback semantics.

A player-facing session-pause command is not an open decision. It is excluded by ADR 0018; developer pause remains tooling.
