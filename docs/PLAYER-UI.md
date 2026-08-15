# Player UI engineering guide

- **Status:** Current Player presentation engineering guidance.
- **Use when:** modifying Player layout, responsive behavior, controls, media presentation, or visual effects.
- **Does not define:** the runtime/Player protocol, cross-origin host contract, package capabilities, exact visual
  design, or TeaseScript semantics.

This guide distils recurring Player POC failures into maintenance rules. Cross-component contracts remain with their
controlling architecture, runtime, security, and ADR sources; exact implementation remains in `player/`.

## Failure patterns to prevent

| Observed failure | Underlying mistake | Durable response |
| --- | --- | --- |
| Media gained an inset only at some widths. | More than one layer owned media width/height. | Keep one source of truth for geometry; responsive/effects should not restate it without a real state change. |
| Collapsing the right side moved conversation content or lost controls. | Background track, content reserve, and foreground controls were treated as one thing. | Model those responsibilities separately. |
| The mobile left drawer gained a title-sized gap or hid unrelated controls. | Overlay placement was tied to normal Grid placement and sibling visibility. | Make the drawer a true overlay over the complete Player; covering a sibling is not deleting it. |
| Scrollbars overlapped content or changed control width. | Scroll space was treated as incidental padding. | Give scroll containers deliberate gutter behavior where width stability matters. |
| A tapped phone button stayed in its hover style. | Desktop hover assumptions were applied to touch. | Gate hover to hover-capable fine pointers; use `:active` for touch and `:focus-visible` for keyboard. |
| A JavaScript pointer-release fix broke desktop interaction without fixing the phone. | CSS input-state behavior was patched at the wrong abstraction. | Prefer capability-aware CSS; fix the state owner instead of clearing symptoms. |
| Hover movement exposed 1 px seams. | A decorative effect changed shared-edge geometry. | Prefer paint-only feedback when movement is not semantically required. |
| Visual experiments accumulated duplicate component rules. | A temporary override layer became a second implementation. | Use experiment layers temporarily; integrate accepted styling into the normal owner and remove the duplicate layer. |

## Engineering guardrails

### One owner for layout geometry

Grid tracks, reserved widths, margins, media bounds, title clearance, and scroll-region geometry belong in
layout/responsive CSS. Effects should be paint-only: colour, opacity, shadow, outline, mask, and similar properties.
Cascade layers make ownership visible, but do not prevent conflicting declarations; do not rely on layer order as a
substitute for one authoritative geometry definition.

### Separate visual presence from interaction state

An overlay is not the same as removing a component. Keep the right Grid track, conversation reserve, and foreground
controls conceptually separate. On mobile, the left drawer should overlay rather than push the center layout. Its scrim
should catch outside input without click-through, while unrelated controls remain present underneath.

Keep `auto` responsive defaults distinct from explicit user choices. Resizing or changing orientation should not
silently turn a manual open/closed or docked/overlay choice back into `auto` unless that behavior is deliberately
changed. State transitions should remain explicit and testable rather than inferred from computed widths or visibility.

### Keep media independent from demo markup and chrome

The media surface fills its assigned media area. `contain`/`cover` belongs to the presented media. Ambient/vignette
effects should attach to the media container so real image, video, canvas, or package media can replace demo content
without changing the effect model. Low-height title treatment may overlay media visually, but should not invent a second
media geometry.

### Keep ordinary content data-driven

Messages and normal actions remain data rendered by shared code. Adding an ordinary action should not require a new
hand-written HTML/CSS block. Keep panel transitions pure, rendering focused on presentation, and browser bootstrap
focused on DOM/event wiring. Add abstractions only for a concrete repeated responsibility.

## Change and verification discipline

Before editing, identify the owning module/layer and the invariants that must remain unchanged. If a fix needs another
selector assigning the same property for the same state, first ask whether the existing owner is wrong rather than
stacking another override.

For layout, responsive, or interaction changes, verify the current breakpoint exactly and immediately on both sides,
portrait and landscape, a low-height viewport, and representative phone and desktop sizes. Exercise automatic and
manual panel states, toggles across resize/orientation changes, mobile drawer inside/outside input, Escape/focus,
touch press feedback, media bounds, transcript/composer reserve, textarea growth, scrollbar placement, and safe-area
insets when affected.

For visual-only work, assert that key layout rectangles are unchanged. Reproduce a reported bug and inspect computed
layout/state before assigning a cause from a screenshot. For touch-specific behavior, real-device verification is
preferred when emulation cannot reproduce the report.

If several consecutive fixes add special cases around the same invariant, stop patching and reassess the ownership or
state model. A focused consolidation can be safer than another override.

## Boundary against accidental policy

Current breakpoint values, colours, demo media, Visual Lab controls, and presentation-only types are implementation
details, not product/runtime contracts merely because they appear in the POC. This guide preserves engineering lessons;
it should not turn historical fixes or temporary UI choices into unrelated architecture or dependency requirements.
