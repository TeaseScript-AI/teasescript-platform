# Player UI follow-ups

- **Status:** Active, non-implemented planning for the Standard Player presentation.
- **Current state:** See [`PHASE-STATUS.md`](../../PHASE-STATUS.md) and [`player/README.md`](../../player/README.md).
- **Boundaries:** This file does not define runtime/host protocols, package custom-view APIs, or accepted TeaseScript
  semantics. General cross-surface UI rules remain in [`UI-DESIGN-AND-ENGINEERING.md`](../UI-DESIGN-AND-ENGINEERING.md).

## Open Player follow-ups

- [ ] **Choose persistence behavior.** Decide which Player UI preferences survive reload/session changes and whether the
  tool layout is restored automatically, explicitly saved, or both. Candidate preferences include tool columns, panel
  state, media fit, and user-facing text/display preferences; inclusion is not yet decided.
- [ ] **Validate tool sizing against real content and tall portrait layouts.** The POC now uses bounded intrinsic column
  sizing, one shared horizontal strip, and a 1:1 media growth cap where the current docked baseline can satisfy it. Decide
  whether tall portrait shapes that already start below 1:1 should switch the left/right regions to overlays or use
  another constraint-driven presentation before this becomes production behavior.
- [ ] **Implement smart transcript following.** Follow new messages while the user is at the latest content; stop
  pulling the view down when the user scrolls back, and provide an explicit way to return to the latest message.
- [ ] **Add a layout debug mode.** Make development-only inspection of important Grid/container geometry, active layout
  conditions, overlays, safe areas, and measured available space easy enough to diagnose viewport-specific failures.
- [ ] **Complete reduced-motion/accessibility handling.** Preserve the existing `prefers-reduced-motion` direction and
  evaluate the remaining Player-specific needs for readable scaling, contrast, control sizing, and browser accessibility
  behavior as real interactions replace demo presentation.
- [ ] **Define status/notification presentation.** Provide temporary Player status such as saved/paused/error/assignment
  updates without forcing every status into the transcript or allowing transient chrome to disturb primary layout.
- [ ] **Resolve the Standard UI/custom UI boundary.** Decide which Player shell responsibilities stay platform-owned and
  which presentation a package custom view may replace or style. Keep lifecycle, state, isolation, and API contracts in
  the roadmap's custom-view work rather than duplicating that design here.

Older exploratory Player ideas are not automatically part of this list. Add them only after the Owner selects them for
active planning or implementation.
