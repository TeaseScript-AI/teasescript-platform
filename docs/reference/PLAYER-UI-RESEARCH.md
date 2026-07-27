# Browser-first player UI research

**Status:** Non-authoritative reference summary
**Related planning document:** [`PLAYER-UI-MOCKUPS.md`](../planning/PLAYER-UI-MOCKUPS.md)
**Storage note:** Raw third-party source files, screenshots, and the wider research archive remain outside this repository under [`DOCUMENTATION-OWNERSHIP.md`](../DOCUMENTATION-OWNERSHIP.md).

> This document summarizes the research used for issue #77. It informs the proposal but does not define architecture, syntax, APIs, runtime semantics, or product acceptance.

## 1. Research questions

The research examined:

- how a browser player should respond to arbitrary desktop window sizes;
- how media, transcript, choices, input, timers, and package-defined visuals can coexist;
- how long-session transcript scrolling should behave;
- how mobile safe areas, browser chrome, and software keyboards affect layout;
- how Standard UI can remain dependable while packages receive visual freedom;
- how developer preview controls can test the player without becoming normal player chrome.

## 2. Project sources

The proposal was checked against:

- [`README-FIRST.md`](../../README-FIRST.md);
- [`CURRENT-DESIGN.md`](../../CURRENT-DESIGN.md);
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md);
- [`docs/RUNTIME.md`](../RUNTIME.md);
- [`docs/SECURITY.md`](../SECURITY.md);
- [`docs/CODE-EDITOR.md`](../CODE-EDITOR.md);
- [ADR 0012](../decisions/0012-custom-view-capability.md);
- [ADR 0015](../decisions/0015-serializable-runtime-architecture.md);
- [ADR 0016](../decisions/0016-resumable-pending-action-runtime-contract.md);
- [ADR 0017](../decisions/0017-engine-primitives-and-standard-library-boundary.md);
- [`POC-PLAYER-001`](../planning/POC-TO-ALPHA-BACKLOG.md#poc-player-001--define-the-custom-view-contract).

These sources establish the cross-origin iframe direction, deterministic runtime ownership, typed pending-action boundary, and the separation between Standard UI and package presentation. They do not define the final player layout.

## 3. Capability reference

A supplied local LeadMe community HTML file was inspected as a capability reference. Useful structural patterns included:

```text
player
+-- topbar
+-- stage
    +-- media area
    +-- pane splitter
    +-- side/text panel
        +-- scrollable text area
        +-- fixed button area
+-- timer presentation
```

Retained ideas:

- one continuous player shell;
- a draggable separator;
- a scrollable transcript above fixed active controls;
- stacked and horizontal presentation possibilities;
- media fitting and circular timer presentation.

Not adopted:

- LeadMe runtime, script loaders, conversion logic, persistence, storage, or security architecture;
- any implication that its DOM names or CSS are TeaseScript contracts.

The third-party source file is not committed to this repository.

## 4. Responsive-layout findings

### 4.1 Arbitrary windows, not named desktop devices

Desktop users resize windows continuously. The default desktop player should therefore fill its actual iframe/container and reflow according to content pressure.

A “half-width desktop” is valuable as a test condition, but automatically applying an additional 50%-width simulation inside an already narrowed host causes an unnatural discontinuity.

Recommended distinction:

- `Auto`: continuous desktop sizing until a mobile boundary;
- `Half-width`: manual developer preview only;
- `Phone`: discrete simulation because touch, keyboard, safe areas, and portrait proportions differ materially.

### 4.2 Content-based constraints

The outer player should normally use the available width. Readability constraints belong on inner content:

- transcript rail capped in `rem`;
- message line length capped with `ch`;
- spacing using `rem` and container-relative `clamp()`;
- pane proportions using percentages;
- borders using logical CSS pixels.

### 4.3 Local responsiveness

Because the player lives in an iframe, local component behavior should follow the player/container size rather than assumptions about the parent page or physical monitor. Container queries are useful where supported. Ordinary media queries remain useful for the outer demo/host and fallbacks.

## 5. Mobile findings

### 5.1 Dynamic height

Mobile browser chrome and software keyboards can change available height. `100dvh` or a measured container is more appropriate than relying only on `100vh`.

### 5.2 Safe areas

Controls near edges should account for `env(safe-area-inset-*)`. Essential controls must not be placed beneath notches, rounded corners, or system UI.

### 5.3 Software keyboard

Baseline layout should work through normal viewport/container resizing:

- preserve the input draft;
- keep the focused field visible;
- consume existing phone height rather than lengthening the simulated phone;
- retain touch-safe target sizes;
- use the Virtual Keyboard API only as progressive enhancement.

### 5.4 Preview proportion

No universal phone ratio exists. A fixed logical preview canvas is useful for deterministic developer comparison, provided it scales uniformly and does not become unreadably small.

## 6. Transcript and scrolling findings

### 6.1 Chronology and provenance

One chronological stream is easier to understand than fixed speaker columns. Speaker identity should remain explicit text; color may supplement it.

Runtime/application/developer messages should stay outside conversation history.

### 6.2 Auto-scroll ownership

New content should auto-follow only when the reader is already near the latest content. When reading older history, the UI should preserve position and provide a Jump to latest affordance.

The affordance should:

- remain hidden for small, easily recoverable distances;
- appear only after meaningful manual scroll effort;
- be a compact overlay rather than consume transcript height;
- suppress transient flashing during programmatic smooth scrolling;
- remain readable over light and dark content.

### 6.3 Long messages

When one new message is taller than the transcript viewport, scrolling to the very end hides its beginning. Aligning the new message's top is more useful.

Future virtualization should not change chronological order, stable message identity, or speaker provenance.

## 7. Accessibility findings

The proposal uses WCAG 2.2 AA as a baseline and specifically considers:

- reflow without two-dimensional page scrolling;
- visible focus that is not obscured;
- target-size minimums, with larger targets for frequent controls;
- keyboard alternatives for dragging;
- source order matching visual order;
- tested `role="log"` behavior for sequential transcript updates;
- `role="status"` for concise advisory status;
- reduced motion and reduced transparency;
- timer milestone announcements instead of updates every second;
- color not being the sole indicator of identity or state.

## 8. Standard UI and package custom view

The research supports a bounded split:

- the package controls stage composition within allowed capabilities;
- Standard UI controls transcript, active interactions, runtime/application status, focus/accessibility, and platform overlays;
- the deterministic engine remains authoritative for action state and results;
- package DOM state alone cannot become canonical resumable state;
- the package cannot access the parent DOM, account cookies, or unrestricted networking.

The exact custom-view API, overlay-safe declaration, isolation model, and optional Shadow DOM policy remain open.

## 9. Research examples

[`player-ui-research-examples.html`](../planning/player-ui-mockups/player-ui-research-examples.html) contains executable, dependency-free examples for:

- stacked layout;
- transcript width and scrolling;
- timer presentation;
- mobile keyboard/safe-area pressure;
- Standard UI versus package custom-view responsibility.

It predates several later owner-reviewed changes. It is retained as a research companion, not as the current recommended player mockup.

## 10. External references

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [Understanding Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum)
- [Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- [WAI technique ARIA23: Using `role="log"`](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA23.html)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [MDN: CSS environment variables and safe-area insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env)
- [MDN: Dynamic viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#dynamic_viewport_units)
- [MDN: Virtual Keyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API)
- [MDN: Container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries)
- [web.dev: Responsive design](https://web.dev/learn/design/)
- [web.dev: PWA app design](https://web.dev/learn/pwa/app-design)
