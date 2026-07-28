# Player iframe UI design draft

**Status:** Proposed, non-authoritative planning document
**Related issue:** [#77 — Create player UI mockups for a practical browser playground](https://github.com/TeaseScript-AI/teasescript-platform/issues/77)
**Scope:** Standard player UI and the package custom-view region inside the future sandboxed player iframe
**Implementation status:** Documentation and executable mockups only

> This document records a practical player-UI direction for owner review. It does not define TeaseScript syntax, runtime-event schemas, Standard Library APIs, custom-view APIs, host messaging, persistence, sandbox flags, Content Security Policy, or a final design system.

## 1. Authority and source boundary

Accepted ADRs and current topic documents remain authoritative:

- [ADR 0012](../decisions/0012-custom-view-capability.md) accepts blocking and background custom-view capabilities with deterministic ownership, cleanup, and save/resume behavior, while final author syntax remains open.
- [ADR 0015](../decisions/0015-serializable-runtime-architecture.md) requires typed events and explicit JSON-safe runtime state; transcript DOM state is not canonical runtime state.
- [ADR 0016](../decisions/0016-resumable-pending-action-runtime-contract.md) defines the shared resumable model for waits, choices, input, buttons, timers, media completion, and future typed capabilities.
- [ADR 0017](../decisions/0017-engine-primitives-and-standard-library-boundary.md) keeps deterministic identity, validation, pending actions, time, checkpointing, and typed boundaries in the engine while allowing Standard UI policy and author-friendly composition above those primitives.
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), [`docs/RUNTIME.md`](../RUNTIME.md), [`docs/SECURITY.md`](../SECURITY.md), and [`docs/CODE-EDITOR.md`](../CODE-EDITOR.md) define current boundaries.
- [`POC-PLAYER-001`](POC-TO-ALPHA-BACKLOG.md#poc-player-001--define-the-custom-view-contract) remains design-required and unscheduled.

The adjacent HTML files are reviewable design assets. Their CSS variables, DOM structure, JavaScript, simulated actions, timer behavior, and responsive thresholds are not accepted production contracts.

## 2. Goal

Define a player-oriented browser shell that can present deterministic sessions containing:

- speaker dialogue and player responses;
- long chronological transcript history;
- media or package-defined custom views;
- blocking waits and visible timers;
- choices and text input;
- permanent/background actions;
- pause, restore, waiting, completion, and error states;
- temporary developer-preview controls.

The shell must remain practical in wide desktop windows, ordinary resizable desktop windows, narrow application windows, and phones.

## 3. Terminology

Two different viewport concepts must remain distinct:

- **Host viewport:** the real space supplied by the browser, website, editor, PWA window, fullscreen artifact viewer, or chat attachment renderer.
- **Preview viewport preset:** a developer tool that simulates a selected presentation such as `Wide desktop`, `Half-width`, or `Phone` inside the host viewport.

`Auto` should follow the host viewport continuously for desktop. It must not automatically narrow an already narrow desktop host again by switching to an internal half-width simulation. A discrete automatic switch is reasonable only at the mobile boundary. `Half-width` remains useful as a manual developer preset.

## 4. Compared directions

Issue #77 requires at least three meaningfully different directions.

### 4.1 Direction A — Stacked stage and conversation

```text
+--------------------------------------------------+
| Standard top bar                                 |
+--------------------------------------------------+
|                                                  |
|        media / package custom-view region        |
|        platform overlays and permanent actions   |
|                                                  |
+================ horizontal splitter =============+
| chronological transcript                         |
| speaker left                         player right |
+--------------------------------------------------+
| active choices or text input                     |
+--------------------------------------------------+
```

**Strengths**

- one mental model across desktop and phone;
- media retains the full container width;
- a readable transcript rail can be centered independently of pane width;
- the splitter directly expresses media-versus-conversation priority;
- active controls remain outside the scrollable transcript.

**Weaknesses**

- short landscape windows create vertical pressure;
- package controls near the lower stage edge need an overlay-safe rule;
- a large chat share can push stage overlays upward.

### 4.2 Direction B — Side-by-side media and conversation

```text
+--------------------------------------------------+
| Standard top bar                                 |
+--------------------------+-----------------------+
| media/custom view        | transcript            |
|                          |                       |
|                          | choices/input         |
+--------------------------+-----------------------+
```

**Strengths**

- media and conversation remain visible simultaneously;
- familiar on genuinely wide desktop layouts.

**Weaknesses**

- becomes cramped in half-width windows;
- long messages and choice labels receive poor line lengths;
- requires a second structural orientation and more resize logic;
- mobile must still switch to another layout.

### 4.3 Direction C — Media-first with transcript drawer or overlay

```text
+--------------------------------------------------+
| media/custom view                                |
|                                                  |
|                              timer               |
+--------------------------------------------------+
| compact current interaction                      |
+--------------------------------------------------+
| transcript drawer opened on demand               |
+--------------------------------------------------+
```

**Strengths**

- most immersive media presentation;
- appropriate for packages where visuals dominate.

**Weaknesses**

- hides conversational context;
- weak for long-running personalities and text-heavy roleplay;
- drawer focus, keyboard, history, and accessibility are harder;
- permanent transcript access becomes less predictable.

## 5. Recommended working direction

Use **Direction A: stacked stage and conversation** as the temporary playground/player-preview shell.

This is an owner-selected working direction for the mockup, not a final production design decision.

### 5.1 Base hierarchy

```text
Player iframe
+-- Standard top bar
+-- Stage
|   +-- package media/custom-view region
|   +-- platform overlay layer
|       +-- visible timer, when applicable
|       +-- permanent/background actions
+-- Horizontal splitter
+-- Conversation
    +-- chronological transcript
    +-- floating Jump to latest, when warranted
    +-- active choices or text input
+-- Developer-preview toolbar outside normal player chrome
```

### 5.2 Default proportions

- initial conversation share: approximately `34%` to `36%`;
- media-focused preset: approximately `28%` conversation;
- chat-focused preset: approximately `48%` conversation;
- both panes retain usable minimum heights;
- the splitter supports pointer drag, keyboard adjustment, and named presets.

The proportions are review values, not accepted runtime or theme tokens.

## 6. Responsive sizing model

### 6.1 Desktop is continuous

The desktop player uses the full available host/container width and changes continuously as that width changes. It should not jump from full-width desktop to a centered 50%-wide preview merely because the browser crosses a breakpoint.

`Half-width` is a manual developer test representing a browser occupying roughly half of a larger monitor. It is not an automatic nested layout mode.

### 6.2 Logical CSS units

CSS `px` is a logical CSS pixel, not necessarily one physical display pixel. Even so, use the unit that matches the design purpose:

| Purpose | Preferred unit |
|---|---|
| outer player/panes | `%`, logical sizing properties |
| readable transcript rail | `rem` |
| message line length | `%` combined with `ch` |
| responsive spacing | `rem` and `clamp(... cqw ...)` |
| pane proportions | percentages |
| borders/hairlines | CSS `px` |
| phone simulation | fixed logical canvas, uniformly scaled |

Proposed starting point:

```css
.player-demo {
  inline-size: 100%;
}

.chat-rail,
.interaction-rail {
  inline-size: min(100%, 48rem);
  margin-inline: auto;
}

.chat-rail {
  padding-inline: clamp(0.7rem, 2cqw, 1.5rem);
}

.message-block {
  max-inline-size: min(84%, 52ch);
}
```

`48rem` is approximately `768` CSS pixels at a `16px` root font size, but it scales with the user's root text size.

### 6.3 Phone preview

The developer preview uses a representative logical portrait canvas of **390 × 844 CSS pixels**. It is uniformly scaled inside the host viewport.

- opening the simulated software keyboard consumes space inside that logical phone;
- the phone aspect ratio must not change when the keyboard opens;
- a minimum readable preview scale is preferred over shrinking to a thumbnail;
- when a short host cannot fit the minimum readable scale, the preview area may scroll without making the whole document overflow.

This is a preview convention, not a production device requirement.

## 7. Standard top bar

### 7.1 Stable height

The top bar should not grow merely because the software keyboard is shown. Its size is based on the title, controls, and stable spacing.

The current mockup uses:

```css
.player-demo {
  --topbar-height: 3rem;
}

.player-topbar {
  block-size: var(--topbar-height);
  min-block-size: var(--topbar-height);
  padding-block: 0.375rem;
}
```

A `rem`-based height follows the user's text scaling while remaining stable across normal and keyboard states.

### 7.2 Proposed content

Persistent:

- session title;
- compact runtime status;
- pause/resume;
- overflow menu.

Conditional:

- package/author identity when space allows;
- fullscreen when appropriate.

Developer operations, checkpoint internals, instruction positions, and event diagnostics stay outside normal player chrome.

## 8. Stage and custom-view boundary

### 8.1 Responsibility split

**Package custom view may own:**

- images, video, canvas, animation, and package-specific controls;
- scene-specific visual composition;
- package presentation inside the allowed player region.

**Platform Standard UI owns:**

- session/top-bar controls;
- transcript semantics and speaker identification;
- active choices and input;
- visible runtime/application status;
- focus order and accessibility behavior;
- platform overlays such as an explicitly visible timer;
- player-level failure and recovery treatment.

The exact custom-view registration, update, close, result, handle, reconstruction, DOM/CSS isolation, and optional Shadow DOM contracts remain open under `POC-PLAYER-001`.

### 8.2 Overlay-safe behavior

Platform overlays must:

- remain legible over changing package media;
- avoid essential package controls;
- account for safe-area insets;
- disappear when inactive;
- not imply every timer is visible.

A later custom-view contract must define how a package communicates overlay-safe regions.

## 9. Timer presentation

The current mockup explores:

- numeric countdown plus circular progress;
- top-right stage placement;
- a larger timer on wide desktop, intermediate size in the manual half-width preset, and compact phone presentation;
- horizontal position presets for wide-desktop owner review;
- right-edge anchoring on compact layouts;
- a developer-only timer restart control.

These are presentation experiments. Visible/mystery policy, lifecycle, restart semantics, public handles, repetition, persistence, and author APIs remain open.

## 10. Permanent/background actions

ADR 0016 identifies background buttons as a future pending-action kind, but populated background actions are not implemented.

The mockup explores permanent actions that:

- remain inside the stage;
- align their right edge with the rendered timer;
- use a fixed preferred vertical position;
- are pushed upward only when the splitter would collide with them;
- retain touch-appropriate target sizes;
- use semi-transparent backgrounds so package content remains partly visible;
- remain keyboard accessible and clickable.

When space is contested, the action group may collapse to a compact summary such as `A · Lon… · C`. Expanding restores the directly clickable actions. The collapse behavior is a presentation proposal, not an accepted runtime lifecycle.

## 11. Transcript

### 11.1 One chronological stream

- non-player speakers align left;
- the human player aligns right;
- speaker identity remains written text;
- color is supplementary;
- narration may receive a distinct future treatment;
- runtime, restore, loading, developer, and error events do not masquerade as speaker messages.

### 11.2 Long text

- long words use safe wrapping;
- a newly appended message taller than the transcript viewport scrolls to the top of that message rather than its ending;
- future transcript virtualization must preserve chronological order, message identity, and speaker provenance.

### 11.3 Auto-scroll and Jump to latest

- when already near the bottom, new short content follows normally;
- when reading older history, the reader is not pulled away;
- programmatic smooth scrolling suppresses transient button flashes;
- `Jump to latest` is a compact floating overlay and consumes no transcript row;
- it appears only after a meaningful distance from the latest content, currently explored as `max(220px, 1.25 × transcript height)`;
- its low-opacity background, subtle border, text shadow, and small blur must remain readable over both light and dark content.

The exact threshold should be tuned through real wheel, trackpad, touch, and keyboard testing.

## 12. Active interaction area

Choices and text input remain below the scrollable transcript.

- choice labels wrap without horizontal page scrolling;
- frequent touch controls should prefer approximately `44 × 44` CSS pixels when practical;
- selection and disabled state are not communicated through opacity or color alone;
- text input uses a real labelled form control;
- the current draft survives ordinary pane resizing and keyboard changes;
- validation appears next to the active interaction rather than in the transcript;
- duplicate submission is disabled while a result is being accepted.

## 13. Theme and multiple speakers

The mockup uses bounded CSS custom properties rather than direct unrestricted package CSS.

Candidate layers:

| Layer | Examples |
|---|---|
| surfaces | page, stage, conversation, raised controls |
| text and borders | primary text, muted text, separators |
| interaction accents | focus, selected controls, primary action |
| participant identity | human player and per-speaker accents |
| semantic state | success, warning, error |

A future developer theme editor may preview and persist selected validated tokens. The platform must retain enforceable contrast, focus visibility, target size, and semantic-state meaning.

Every stable speaker may eventually provide presentation metadata such as an accent or portrait reference. Speaker names remain visible because color cannot be the only distinction.

## 14. Developer preview

The developer/editor preview should retain tools to:

- use continuous `Auto` sizing;
- manually select Wide desktop, Half-width, or Phone;
- simulate the software keyboard;
- select media/balanced/chat pane ratios;
- inspect timer placement;
- preview bounded theme and participant tokens;
- test choices and text input;
- test transcript scrolling and Jump to latest;
- inspect temporary permanent-action placement.

These tools are not ordinary end-user player chrome.

Runtime-oriented operations such as compile, run, step, restart, checkpoint, restore, diagnostics, event log, instruction plan, and runtime state remain developer tooling outside the conversation transcript.

## 15. Accessibility baseline

- target WCAG 2.2 AA;
- use semantic buttons and labelled form controls;
- keep focus visible and unobscured;
- provide keyboard alternatives for splitter dragging;
- preserve DOM/source order that matches visual order;
- test transcript updates with suitable `role="log"` semantics;
- use `role="status"` only for concise advisory application updates;
- do not announce a timer every second; announce meaningful milestones;
- respect reduced-motion and reduced-transparency preferences;
- retain touch-safe targets during keyboard pressure;
- test light/dark package content behind overlays.

## 16. Demo assets

```text
docs/planning/PLAYER-UI-MOCKUPS.md
docs/planning/player-ui-mockups/
  README.md
  player-ui-demo-recommended.html
  player-ui-research-examples.html
docs/reference/
  PLAYER-UI-RESEARCH.md
```

- `player-ui-demo-recommended.html` is the current owner-review mockup.
- `player-ui-research-examples.html` is an older, broader research companion and intentionally does not reflect every later owner-reviewed adjustment.
- `PLAYER-UI-RESEARCH.md` summarizes the browser/accessibility research and provenance.

GitHub does not execute arbitrary HTML in normal Markdown rendering. Download/open the HTML locally or use a local static server. Screenshots remain review artifacts and are intentionally excluded from this pull request.

## 17. Open questions

1. Which top-bar actions remain permanently visible?
2. How are narration, avatars, and portraits represented?
3. Which Standard UI tokens may packages preview and persist?
4. How are per-speaker presentation values stored and validated?
5. What number or shape of choices triggers another presentation?
6. How does a custom view declare overlay-safe regions?
7. What is the final timer visibility, mystery, restart, and lifecycle policy?
8. How many permanent actions remain directly visible before collapsing?
9. Does an action group collapse automatically, manually, or according to package metadata?
10. When is transcript virtualization required?
11. What exact DOM/CSS isolation and optional Shadow DOM policy is accepted?
12. How are focus and accessibility tested across package custom views?
13. What player state is shown during reconnect or checkpoint-storage failure?
14. Is pane ratio remembered globally, per device, per package, or not at all?
15. Is side-by-side retained as an optional user preference on very wide containers?
16. What production phone and landscape behavior replaces the preview simulation?

## 18. Explicit non-decisions

This document does not decide:

- production framework or component architecture;
- final branding;
- TeaseScript syntax or Standard Library APIs;
- custom-view API or TypeScript interfaces;
- host `postMessage` schema or capability negotiation;
- sandbox flags, CSP, or network policy;
- timer, input, choice, button, media, camera, or LLM contracts;
- transcript persistence or virtualization implementation;
- package theme permissions;
- final pause, restore, completion, cancellation, or error semantics;
- whether the current mockup CSS values become product defaults.

## 19. Verification performed on the mockup

The current HTML mockup has been browser-smoke-tested for:

- continuous desktop `Auto` behavior and a separate manual Half-width preset;
- mobile automatic selection at the current review boundary;
- stable top-bar height before and after the simulated keyboard opens;
- fixed phone aspect ratio and keyboard-internal resizing;
- working choices and text submission;
- long unbroken text wrapping;
- long-message top alignment;
- floating Jump to latest behavior;
- timer placement and timer restart;
- permanent-action alignment, collision movement, click behavior, and collapse/expand;
- theme-token preview;
- absence of browser JavaScript errors during the tested interactions.

This is mockup verification, not production cross-origin player E2E coverage.
