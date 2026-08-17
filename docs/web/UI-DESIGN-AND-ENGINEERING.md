# UI design and engineering guide

- **Status:** Current cross-surface UI engineering and design guidance.
- **Use when:** modifying the Player, host-site UI, editor/simulator UI, responsive layouts, controls, media
  presentation, or visual styling.
- **Does not define:** product features, runtime/host protocols, trust boundaries, exact visual design, framework
  choice, or TeaseScript semantics.

This guide distils recurring Player POC failures and visual-design research into reusable maintenance guidance. Specific
Player incidents remain useful evidence, but the durable rules are intentionally phrased for any current or future UI
surface. Architecture, security, runtime, and product contracts remain with their controlling sources.

## Durable lessons from observed failures

| Observed failure | General mistake | Reusable response |
| --- | --- | --- |
| Media gained an inset only at some widths. | More than one rule owned the same geometry for the same state. | Keep one authoritative geometry definition per state; responsive rules change it only for a real responsive state change. |
| Collapsing a side region moved unrelated content or lost controls. | Visual background, layout reservation, foreground content, and interaction were treated as one responsibility. | Model those responsibilities separately so changing one does not implicitly remove or reposition the others. |
| An overlay gained a title-sized gap or hid unrelated controls. | Overlay placement was coupled to normal-flow/Grid placement and sibling visibility. | Treat overlays as an independent presentation mode over the intended containing area; covering a sibling is not deleting it. |
| Scrollbars overlapped content or changed usable control width. | Scroll space was treated as incidental padding. | Give scroll containers deliberate overflow and gutter behavior where stable geometry matters. |
| A tapped phone button remained in its hover appearance. | Desktop pointer assumptions were applied to touch. | Gate hover to hover-capable pointers; use `:active` for press feedback and `:focus-visible` for keyboard focus. |
| A JavaScript pointer-release workaround broke desktop behavior without fixing touch. | A CSS/input-capability problem was patched at the symptom layer. | Fix the owning abstraction first; avoid cross-input JavaScript state unless the interaction genuinely requires it. |
| Hover movement exposed 1 px seams. | Decorative feedback changed shared-edge geometry. | Prefer paint-only feedback when movement is not semantically required. |
| Visual experiments accumulated duplicate component rules. | A temporary override layer became a second implementation. | Use experiment layers temporarily; integrate accepted styling into the normal owner and remove duplicate overrides. |
| A default accent differed between CSS and runtime/demo data. | The same default was owned in multiple layers with implicit precedence. | Keep one authoritative default or an explicit override contract; do not duplicate moving defaults across CSS and data. |
| A texture/effect covered controls or visually recreated a collapsed surface. | Decoration was scoped as a structural layer instead of to the intended surface. | Clip decoration to its owner, keep it input-neutral, and do not use effects to recreate layout or hidden regions. |

## Engineering guardrails

### Keep one owner for geometry

Grid tracks, reserved space, margins, media/content bounds, title clearance, safe-area accommodation, and scroll-region
geometry need an identifiable owner. A cascade layer can make responsibility visible, but layer order does not prevent
conflicting declarations. If two selectors assign the same geometric property for the same state, first ask whether one
owner is wrong rather than adding another override.

Responsive CSS should describe actual layout or interaction changes, not restate base geometry merely because a
breakpoint exists. Visual effects should normally remain paint-only: colour, opacity, shadow, outline, mask, filter,
and similar properties that do not alter neighbouring layout.

### Separate presence, reservation, content, and interaction

For any docked, collapsible, floating, or overlay region, keep these concepts distinct:

- the visual surface or background;
- the space the surrounding layout reserves for it;
- the foreground controls/content that remain usable;
- the interaction layer that receives or blocks pointer/keyboard input.

A change to one responsibility must not silently change the others. This applies equally to left/right sidebars, mobile
drawers, floating tools, menus, dialogs, notification panels, media controls, and future host-site surfaces.

Keep automatic responsive defaults separate from explicit user choices. Resizing or changing orientation should not
silently erase a manual open/closed, docked/overlay, expanded/collapsed, or similar state unless that behavior is a
deliberate product decision. State transitions should be explicit and testable rather than inferred from computed
widths or visibility.

### Keep defaults and visual roles explicit

Theme defaults, component defaults, semantic state colours, and content/person/package accents should have clear
ownership. Avoid defining the same moving default in CSS and JavaScript/data unless one intentionally overrides the
other and that precedence is explicit. Local identity styling should not silently repaint unrelated application chrome.

### Build colour systems from semantic roles

A coherent palette is not a list of nearby hex values assigned component by component. Start from a small tonal system
and map it to semantic roles. A useful general model separates:

- application/canvas and subtle structural backgrounds;
- component backgrounds for default, hover, and pressed/selected states;
- passive, interactive, and strong/focus borders;
- solid accent fills and their interaction states; and
- lower- and higher-emphasis text.

Do not copy external palette values mechanically. TeaseScript uses the shared twelve-step role-band structure below,
but the actual palette values remain project-owned. Use semantic aliases in components rather than coupling them to raw
colour values or assuming every step must have a distinct token. A neutral control
should normally progress through neutral default/hover/pressed colours; an accent control should progress through its
accent family. Do not turn every neutral hover or press into the brand/accent colour merely to make interaction visible.
Focus is a separate state and must remain explicit without changing geometry.

Keep the structural surface vocabulary as small as the hierarchy permits. Near-identical tints with no distinct role add
visual noise and make nesting harder to read; consolidate them and use borders, shadow, or restrained elevation when
depth is the real need. Do not flatten genuinely different roles merely to minimize the colour count. The Player POC,
for example, exposed this failure when transcript, chrome, raised components, top bar, and input accumulated several
very similar warm near-whites despite representing fewer meaningful levels.

Judge tonal spacing perceptually rather than from hexadecimal or RGB distance alone. OKLCH/Oklab comparisons can help
spot duplicate or uneven steps, and use accessibility contrast checks for readable text and controls. Perceptual
colour-distance numbers are diagnostics, not project thresholds unless a controlling requirement accepts one.

Keep application chrome separate from content-driven identity. Speaker/avatar/package accents, media-derived ambience,
and similar content colours may be supplied dynamically and must not silently become fixed application accent tokens.
Responsive layouts may change composition, but the same semantic role should normally retain the same colour across
breakpoints. Inverse foreground text is a text role, not another surface level; disabled controls likewise need a
recognizable neutral state rather than a new decorative palette branch.

#### Theme-ready token convention

Use CSS `oklch()` as the canonical representation for application palette primitives. Keep those primitives in one
theme-owning location, then map them to semantic component tokens; component CSS consumes only the semantic tokens.
A future light or dark theme changes the semantic mappings rather than rewriting component rules. This convention does
not apply to technical mask colours or content-driven media, speaker, and package colours, which retain their separate
ownership.

Use the Radix twelve-step role-band model as the default palette structure for TeaseScript web surfaces without taking a
Radix dependency: steps 1–2 are backgrounds, 3–5 component states, 6–8 borders, 9–10 solid accent, and 11–12 text.
The values are project-owned; do not copy Radix palette values mechanically and do not invent intermediate values solely
to fill all twelve positions. A maintained surface specification owns its exact approved palette. For the current
Player palette, see [`PLAYER-UI.md`](PLAYER-UI.md).

### Shared control baseline

New TeaseScript web surfaces should start from the same restrained control vocabulary instead of inventing unrelated
button styles per page. Treat this as the default baseline, not a requirement to force unlike controls into one shape:

- use a `1px` neutral border and moderate, consistent non-pill rounding for ordinary controls; compact icon/tool
  controls use a `6px` radius as the shared baseline, while input/container and primary-button corners normally stay in
  the `7–8px` range;
- ordinary controls are flat by default rather than relying on shadows for affordance;
- use the neutral state progression `border-subtle` -> `border-interactive` on hover -> `border-strong` while pressed;
- use the solid accent family for primary actions, with separate solid hover and pressed roles;
- use a `2px` accent focus outline with `1px` visible separation from the control as the shared keyboard-focus baseline;
- keep hover and pressed feedback paint-only unless movement or geometry change communicates real interaction semantics;
- deviate when the component, workflow, accessibility requirement, or surrounding composition gives a concrete reason,
  rather than creating a second local default by accident.

Individual product surfaces may compose the shared roles differently where their content and hierarchy require it. Exact
product-surface widths, heights, spacing, layout geometry, and palette values remain owned by the maintained
specification for that surface unless this shared baseline deliberately adopts them.

### Match interaction feedback to input capability

Do not assume hover exists because desktop emulation exposes a pointer. Use capability-aware CSS for hover, touch press,
and keyboard focus. Avoid removing focus merely to make pointer visuals look cleaner. Temporary overlays or scrims must
prevent click-through when they intentionally intercept outside input.

When a bug appears only on a real phone or another input class, treat that environment as evidence rather than forcing
desktop emulation to reproduce it. Prefer the simplest input-specific rule that preserves the other input modes.

### Keep content independent from demo markup and decorative chrome

Stable UI behavior should attach to durable containers and data, not to placeholder/demo elements. Media presentation,
visual effects, loading states, and controls should continue to work when real image, video, canvas, custom package UI,
or host-site content replaces a demo surface. Decorative pseudo-elements and effects should be clipped to the surface
they decorate, remain input-neutral unless interaction is their purpose, and never substitute for hidden layout.

Repeated content such as messages, actions, navigation items, settings, and catalog/forum results should normally be
data rendered by shared code. Adding one ordinary item should not require copying a bespoke HTML/CSS/JavaScript block.
Add abstraction only when a repeated responsibility is concrete; do not build a generic component system in advance of
real consumers.

### Treat browser edges as layout inputs, not patches

Viewport height, orientation, safe areas, scrollbars, soft keyboards, and low-height windows can change usable space
without changing the conceptual UI. Account for them in the owning layout/responsive layer. Avoid JavaScript layout
measurement when modern CSS can express the same invariant more directly and reliably.

### Size responsive layouts from constraints

Base layout decisions on usable viewport/container geometry and content needs rather than hard device categories. Phone,
tablet, laptop, desktop, TV, and ultrawide shapes are useful test cases, but they should not become separate modes when
the same constraints produce the same layout. CSS `orientation` describes whether the viewport is wider than it is tall;
it does not require or imply a physical orientation sensor.

Use each browser layout mechanism for the problem it solves:

- use `clamp()` when the layout stays the same and a size should vary smoothly within useful bounds;
- use media queries when viewport geometry or input capability requires a real layout/interaction change;
- use container queries when a component should change presentation according to the space that component itself gets;
- use intrinsic/content sizing when content should influence preferred size, while still applying explicit minimum and
  maximum constraints.

Protect a useful minimum for primary content before secondary panels consume additional space. Extra room may expose
more useful information simultaneously, but should not be consumed merely because it exists. Content-aware sizing must
also account for wrapping: one long wrappable line should not force an otherwise unnecessary wide panel, while genuinely
wide or dense content should not be squeezed into avoidable vertical overflow. Prefer CSS layout, wrapping, and
intrinsic sizing before adding JavaScript measurement or width-allocation logic.

## Design quality and avoiding generic "AI slop"

"AI slop" is informal design criticism, not a formal defect class. A gradient, rounded card, system font, or centred
layout is not bad by itself. The recognisable problem is a bundle of unexamined defaults: interchangeable purple/blue
gradients, glass surfaces, soft cards, centred hero rhythms, generic icon grids, ubiquitous bounce/translate hover,
and typography/palette choices that could belong to any unrelated product.

The durable lesson is not to ban those ingredients. It is to make visible design decisions intentionally and as a
coherent system.

### Prefer a chosen visual system over generic defaults

- **Palette:** use a small role-based tonal system for backgrounds, component states, borders, solid accents, and text.
  Keep semantic and content-driven colours separate; use the product accent with restraint.
- **Typography:** use type roles deliberately. A system font is acceptable when it serves the product; an untouched
  fashionable default everywhere is not a substitute for typographic hierarchy or identity.
- **Surfaces:** define a small surface vocabulary. Avoid "glass everywhere", universal glow, and identical soft-shadow
  cards unless those treatments serve a concrete hierarchy or interaction purpose.
- **Layout rhythm:** derive composition from the task and information hierarchy. Do not default every screen to centred
  headings followed by equal-width card grids.
- **Shape language:** keep radii, borders, shadows, dividers, and control shapes coherent. Distinctiveness comes more
  from a consistent vocabulary than from adding more decoration.
- **Iconography and imagery:** use a consistent icon system and domain-relevant media, motifs, or illustrations. Generic
  placeholder art and mixed icon styles quickly erase product identity.
- **Motion:** use motion to communicate state, hierarchy, or causality. Avoid movement on every hover merely to signal
  that a component is interactive.
- **Domain specificity:** let real product structure create character. Tease/player controls, community/catalog content,
  authoring workflows, BDSM/toy/media motifs where appropriate, and other genuine domain details are stronger identity
  signals than generic decorative novelty.

A coherent design system should make different product surfaces feel related without forcing every surface into the
same composition. Consistency in spacing, type, components, interaction feedback, and visual language supports both
recognition and maintainability; controlled variation is useful when the content or workflow genuinely differs.

### Anti-slop review questions

Before accepting a visual change, ask:

- Could this styling be transplanted onto an unrelated generic SaaS product with almost no change?
- Are several visible decisions merely common AI-builder defaults rather than choices connected to this product?
- Can the palette, typography, surface treatment, layout rhythm, imagery, and motion each be explained by the content or
  interaction they support?
- Is the accent doing real hierarchy/identity work, or simply washing every surface in the same colour?
- Are repeated cards/components required by the information model, or are they present because a card grid was the
  easiest default?
- Would the design still have a recognisable identity if decorative gradients, glows, and stock placeholder art were
  removed?
- Do accessibility, readable hierarchy, and interaction clarity remain stronger constraints than novelty?

These questions are a critique aid, not a scoring formula. Do not replace one fashionable default with a different
fashionable default merely to appear distinctive.

## Change and verification discipline

Before editing, identify the owning module/layer and the invariants that must remain unchanged. For responsive or
interaction changes, exercise the current breakpoint and immediately adjacent widths, portrait and landscape,
low-height windows, representative phone and desktop sizes, automatic and manual panel states, resize/orientation
changes, outside/inside overlay input, keyboard focus, touch press feedback, scroll placement, and safe-area behavior
when relevant.

For visual-only work, compare key layout rectangles before and after the change so decoration does not silently alter
geometry. Reproduce a reported bug and inspect computed layout/state before assigning a cause from a screenshot. For
touch-specific behavior, prefer a real-device check when emulation cannot reproduce the report.

When several consecutive fixes add special cases around the same invariant, stop patching and reassess ownership or the
state model. A focused consolidation is usually safer than another override. Temporary experimental styling should be
removed or folded into its real owner once the direction is accepted.

## Boundary against accidental policy

Current breakpoints, colours, fonts, demo media, control labels, component shapes, framework choices, and POC-only types
remain implementation details unless another controlling source accepts them as product requirements. For example,
`PLAYER-UI.md` intentionally promotes selected current Player values into that surface's maintained contract. The
anti-slop section is design-review guidance, not a prohibition on gradients, glass, cards, rounded corners, common
fonts, dark mode, or any other individual technique.

This guide records reusable UI maintenance experience. It must not override architecture, security, runtime, package,
accessibility, product, or host/player protocol decisions owned elsewhere.
