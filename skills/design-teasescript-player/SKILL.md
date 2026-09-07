---
name: design-teasescript-player
description: >-
  Design or substantially redesign the TeaseScript Standard Player presentation. Use for Phase 2 comparison branches
  and other broad Player UI work involving composition, visual hierarchy, typography/color, responsive behavior,
  secondary tools/controls, and iterative browser visual QA. Preserve current repository authority and runtime/state
  ownership. Do not use for narrow visual bug fixes, backend work, or non-visual Player changes.
---
# Design TeaseScript Player

Create a coherent Player presentation system, not a decorated version of the current DOM.

## Establish authority and freedom

Follow the repository start route and assigned issue first. For broad Player design work, read the complete current
`docs/ui/PLAYER-UI.md`, `docs/ui/UI-DESIGN-AND-ENGINEERING.md`, relevant accepted decisions selected by
`README-FIRST.md`, `docs/TESTING.md`, and `player/README.md`.

Treat repository authority and explicit Owner-approved assignment criteria as the contract. Treat this skill as a design
process, never as a competing specification. Current implementation details and fixtures are evidence unless adopted by
controlling sources.

Before editing, create a compact temporary constraint ledger with four groups:

1. non-negotiable behavior, capability, accessibility, architecture, and ownership constraints;
2. assignment-specific experience intent;
3. presentation decisions that remain genuinely open;
4. unresolved product or architecture decisions that require escalation rather than invention.

Do not ask the Owner to choose routine design axes that are already open. Make those decisions yourself and express them
through the candidate. Escalate only a real unresolved product/architecture choice, conflicting authority, or an
explicitly required Owner decision.

## Observe the shared baseline before redesigning it

Run the maintained Player before choosing a new direction. Inspect representative normal and constrained states in the
browser. Use current development tools when they reveal layout, overflow, state, or pressure behavior.

Record only what matters to the redesign:

- which current behaviors/capabilities must survive because authority requires them;
- which current presentation choices work well enough to preserve or learn from;
- which hierarchy, composition, density, responsiveness, or interaction problems create design opportunity;
- which observations are implementation artifacts rather than requirements.

Do not turn baseline geometry, selectors, fixture values, or styling into constraints merely because they are visible.

## Form a design thesis before coding

Write a short temporary design thesis that answers:

- What should actual Player use prioritize and feel like?
- Which one or two structural ideas make this candidate meaningfully different?
- What is the intended hierarchy between the primary experience and secondary chrome?
- How should that hierarchy transform under width, height, keyboard, safe-area, fullscreen, and secondary-panel
  pressure?
- What makes the candidate specific to TeaseScript's real interaction/content model rather than a generic app with new
  labels?

When the assigned brief explicitly fixes a visual direction, follow it unless it conflicts with higher authority. When
visual direction is open, derive it from the product, content, interaction model, and assignment intent rather than
selecting a prepackaged style, palette, type pairing, generated design preset, or another candidate branch.

For a substantial redesign, consider at least two materially different structural approaches before committing. Compare
them against the constraint ledger and choose deliberately. Do not build permanent variants only to prove exploration;
use Visual Lab for a small unresolved comparison only when live Owner comparison is genuinely useful.

## Design a state system, not one screenshot

Derive a coverage set from the assigned issue and current Player contract before deep styling. Include every required
surface plus the states and constraint combinations that can materially change composition or usability. Exercise
pressure cases such as variable/empty content, active interactions, repeated controls, transcript/history pressure,
secondary panels, narrow/short geometry, software keyboard, fullscreen, safe areas, and development-tool access when
applicable to the current assignment.

Design from usable-space and content constraints rather than device names or exact comparison screenshot dimensions.
Equivalent constrained geometry should converge on equivalent layout reasoning even when one viewport is a phone and
another is a narrow desktop window.

For each materially different composition, be able to explain:

- what has priority and why;
- what reserves space, overlays, collapses, scrolls, or moves behind progressive disclosure;
- which region owns each scroll axis and interaction layer;
- how focus, touch, pointer, keyboard, dismissal, and disabled/active states remain understandable;
- how real variable content behaves beyond the default demo fixture.

## Implement through existing ownership boundaries

Preserve the runtime, state, transcript, scrolling, and checkpoint owners selected by current repository authority. Do
not reproduce their semantics in presentation code to make a design idea easier.

Use the current frontend foundation and dependency rules. Use existing accessible primitives where they simplify real
semantics, focus, dismissal, or positioning. Do not make the Player a stock component-library skin or add a second UI,
positioning, routing, state, or scrolling stack without a separately justified requirement.

Keep geometry ownership legible. Prefer one coherent layout rule over accumulated breakpoint exceptions, JavaScript
measurements, or selector overrides. Use Visual Lab for development tuning/temporary comparisons rather than hidden
product state. Use Layout Debug or direct browser measurement when geometry, occlusion, viewport, or overflow ownership
matters instead of guessing from appearance.

Do not invent controls, device states, connectivity indicators, content semantics, Player features, or runtime
capabilities for visual richness. Use real domain structure as design material.

## Establish one intentional visual language

Choose typography, palette, surfaces, spacing, shape language, borders/elevation, icon treatment, and motion as one
system. Each visible choice should support hierarchy, interaction, content, or identity.

Do not replace one generic design bundle with another. Test whether the candidate remains coherent and recognizable when
optional decoration and effects are stripped away. Distinctiveness should survive because composition, hierarchy,
typography, surfaces, and interaction language are deliberate and product-specific.

Make the hierarchy declared by the current assignment and Player contract visually obvious. Keep secondary capabilities
usable without letting their chrome dominate merely because they contain many controls.

Use motion to explain state or causality. Respect reduced motion and visible keyboard focus. Do not add a visual device
only because it conventionally signals polish; it should perform a real hierarchy, interaction, content, or identity
job.

## Iterate from rendered evidence

A substantial redesign is not complete when code compiles or DOM assertions pass. Use the real Player in interactive
browser tooling and revise from rendered evidence.

For each major pass:

1. Render the primary composition and representative responsive/pressure states from the coverage set.
2. Inspect the interface visually; capture screenshots when reliable capture is available.
3. Measure with Layout Debug/browser tools when geometry, occlusion, scroll, or viewport behavior is uncertain.
4. Critique the result against the design thesis, constraint ledger, and complete-state coverage.
5. Revise the design and rerender affected states plus their immediate responsive/interaction neighbors.

Run at least two deliberate visual review passes for a substantial redesign: one after the first coherent implementation
and one after revisions. Continue while material visual or interaction findings remain.

Critique at least these dimensions:

- **Hierarchy:** does the intended primary experience read immediately?
- **Composition:** does secondary chrome consume or obscure disproportionate space?
- **Responsive system:** does the design transform coherently instead of falling into emergency patches?
- **Density/readability:** do pressure states remain usable rather than merely fitting?
- **Interaction:** are focus, touch, pointer, keyboard, dismissal, disabled, busy, selected, and active states
  legible?
- **Content resilience:** do long labels, empty/changing content, authored colors, repeated items, and variable text
  fit?
- **Visual coherence:** do type, color, surfaces, shape, iconography, and motion remain one language across states?
- **Product specificity:** could the visible system be transplanted unchanged to an unrelated generic application?
- **Restraint:** what can be removed without losing information, identity, or usability?

Do not diagnose a visual defect from a screenshot alone when measurement or state inspection can establish the cause.
If browser evidence required by the assignment or repository workflow is unavailable, report the exact limitation and
follow the repository's blocked-evidence path. Do not present source review, DOM assertions, or green tests as
equivalent visual verification.

## Protect independent comparison branches

When the assignment is an independent design branch, do not inspect, copy, cherry-pick, summarize, or use the competing
candidate's code, screenshots, design notes, reviews, or PR discussion as design input. Shared canonical sources, Owner
feedback intentionally supplied to both branches, the common starting tree, and this process skill are valid inputs.

Unless the assigned task explicitly requires one, do not load an external style catalogue or generated design system as
the creative starting point. Targeted external guidance may inform a concrete unresolved design/accessibility question,
but it remains non-authoritative and must not replace repository contracts or the candidate's own reasoning.

## Finish as a comparison-quality candidate

Before handoff:

- run the configured repository checks, focused Player tests, Player browser smoke, and `git diff --check`;
- inspect the complete diff for accidental semantics changes, duplicate ownership, stale experiments, and unjustified
  dependencies;
- confirm required capabilities and development tools remain reachable in representative states;
- remove losing temporary variants/controls that no longer serve an active comparison;
- perform a final browser review after the last visible change.

Summarize the handoff around the design thesis, fundamental structural/hierarchy decisions, responsive/interaction
decisions, meaningful trade-offs or unresolved visual questions, verification, and representative visual evidence.
Separate fundamental design decisions from easy tuning values; do not sell a minor size, spacing, or color adjustment as
the candidate's central idea.
