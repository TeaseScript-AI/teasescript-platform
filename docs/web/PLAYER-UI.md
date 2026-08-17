# Standard Player UI specification

- **Status:** Provisional maintained specification for the current Standard Player presentation.
- **Purpose:** Define the Player's observable layout, responsive behavior, interaction presentation, visual states, and
  current light theme independently of the HTML/CSS/JavaScript implementation.
- **Not an ADR:** Accepted ADRs and accepted specifications remain higher authority for architecture, runtime semantics,
  interaction semantics, isolation, and persistence.
- **Implementation state:** The production-oriented Player presentation POC exists under `player/`, but runtime/host
  integration is incomplete. This specification deliberately records accepted upstream behavior that the Standard Player
  must present even when the current POC does not yet wire that behavior end to end.

A competent implementation should be able to reproduce the maintained Standard Player from this document plus the
accepted platform/runtime contracts without copying the existing source. A review agent should likewise be able to use
this document as the observable UI contract instead of treating current selectors, DOM structure, or CSS techniques as
requirements.

## Authority and scope

The most relevant higher-authority sources are:

- [ADR 0001](../decisions/0001-browser-first.md): browser-first UI and responsive PWA direction;
- [ADR 0012](../decisions/0012-custom-view-capability.md): accepted blocking/background custom-view capability;
- [ADR 0016](../decisions/0016-resumable-pending-action-runtime-contract.md): foreground versus background pending
  actions and reconstruction from canonical state;
- [ADR 0018](../decisions/0018-first-standard-library-poc-contract.md): Standard chat composer, foreground controls,
  transcript completion behavior, pacing skip input, and accessibility requirements;
- [accepted V30 syntax](../specifications/accepted-syntaxes-v30.md): accepted permanent-button, media, speaker colour,
  font, avatar, and other capability semantics;
- [ARCHITECTURE.md](../ARCHITECTURE.md), [RUNTIME.md](../RUNTIME.md), [SECURITY.md](../SECURITY.md), and
  [DATA-AND-API.md](../DATA-AND-API.md): Player/runtime/host ownership and isolation boundaries.

This document owns the maintained **Standard Player presentation**: what surfaces exist, where they appear, how they
respond to viewport constraints and user panel choices, and how Standard controls look and behave. It does not define
TeaseScript syntax, action settlement, host message schemas, package permissions, persistence formats, or custom-view
lifecycle.

General reusable web engineering and visual-design guidance lives in
[UI-DESIGN-AND-ENGINEERING.md](UI-DESIGN-AND-ENGINEERING.md). That guide informs implementation quality but does not
replace the Player-specific contract here.

## Current maturity boundary

The current Player POC is a presentation implementation, not a completed production Player. In particular:

- its transcript, timer, background controls, tools, and media currently consume demo presentation data;
- its composer renders the maintained shell but does not yet submit runtime interactions;
- ADR 0018 foreground controls are accepted behavior but are not yet rendered by the current demo presentation path;
- host/iframe messaging, checkpoint persistence acknowledgement, restore/reconnect, and package capability negotiation
  are not defined here;
- smart transcript following, final preference persistence, tall-portrait panel policy, transient status/notification
  presentation, theme precedence, and final package-customization limits remain open decisions;
- the current Visual Lab and Scene tools, placeholder avatar letters, demo action labels, and random local demo media
  are fixtures rather than Standard Player product content.

A missing POC integration is not permission to contradict a higher-authority accepted interaction or runtime contract.
Conversely, a current demo detail is not a product requirement unless this specification adopts it.

## Surface hierarchy

The Standard Player fills the available Player viewport and uses the following structural presentation regions. Some
may collapse, overlay, or appear only while an interaction requires them:

```text
+-----------------------------------------------------------------------+
| title / Player chrome                                                 |
+----------------------+--------------------------------+---------------+
|                      |                                | timer +       |
| tools                | media                          | background    |
|                      |                                | controls      |
|                      +--------------------------------+ / status      |
|                      | transcript                     |               |
|                      +--------------------------------+               |
|                      | foreground controls when any  |               |
|                      | composer                       |               |
+----------------------+--------------------------------+---------------+
```

The diagram describes relationships, not DOM nesting or a required CSS layout mechanism.

### Visual hierarchy

- **Canvas surface:** transcript and composer-area background.
- **Chrome surface:** title bar and opaque docked side regions.
- **Component surface:** tool columns, input/control surfaces, timer, and ordinary buttons.
- **Media surface:** visually separate content region; media may be full-bleed to device edges while Player chrome
  respects safe areas.
- **Content identity:** speaker, package, and media-derived colours are separate from application chrome tokens.

The title, tools, right rail, transcript, composer, and media are structural peers. Hiding a panel background, changing
reservation, or switching a region to overlay mode must not implicitly delete unrelated controls.

## Responsive modes

Responsive behavior is constraint-driven, with three current threshold conditions that have distinct purposes.

| Condition | Purpose | Maintained behavior |
| --- | --- | --- |
| width `>= 761px` | Wide composition | Side regions may reserve space; automatic tools are open and automatic right rail is docked. |
| width `<= 760px` | Narrow composition | Left tools become an overlay drawer; the right region reserves no main Grid track and floats/overlays according to orientation. |
| width `<= 480px` | Compact control geometry | Reduces selected insets/control sizes only; it does **not** introduce another docking model. |
| height `<= 600px` | Low-height composition | Title becomes an overlay and the circular timer compacts into the title-height strip. This condition is independent of width. |

The 760/761 transition intentionally changes composition without causing the timer, background-control buttons, or
right-panel toggle to jump merely because that width boundary was crossed. The 480px threshold owns genuinely compact
phone control geometry instead.

Manual panel state and responsive defaults are separate. Resizing/orientation changes do not erase an explicit user
choice; only `auto` adapts to the current width class.

## Global geometry and overflow

The current maintained Player uses these major geometry values because they define the composition rather than an
incidental implementation technique:

| Item | Current contract |
| --- | --- |
| Player viewport | full viewport width and `100dvh`; the document itself does not become the normal scroll owner |
| normal title bar | `52px` plus top safe-area inset |
| normal media row | `62dvh` |
| low-height media row | `64dvh` |
| baseline left tools width | `clamp(190px, 15vw, 250px)` before content-driven growth |
| right controls width | `clamp(150px, 18vw, 190px)` |
| readable conversation maximum | `900px` |
| conversation minimum protected from tool growth | `380px` |
| normal conversation side gap | `18px` before safe-area contribution |
| narrow tools drawer | `min(300px, 100vw - 120px)`, deliberately leaving outside space for dismissal |

Safe-area insets affect Player chrome and controls. Media remains allowed to occupy the full visual media region rather
than gaining the same safe-area inset by default.

Scrolling is owned locally:

- the transcript owns vertical conversation scrolling;
- the tool strip owns horizontal scrolling across tool columns;
- each tool-column body owns its own vertical scrolling;
- the right background-control/status list owns vertical scrolling;
- a growing composer input may own its own vertical scrolling once it reaches its height limit;
- the Player shell itself does not normally scroll.

Nested content should not create a second scrollbar for the same axis/responsibility.

### Typography and visible control geometry

PR #318 intentionally preserves the current Player typography and control geometry. The following visible values are
therefore part of the provisional reconstruction baseline; local padding and one-off decorative offsets remain
implementation details unless specified elsewhere.

| Element | Current Player baseline |
| --- | --- |
| UI font stack | `"Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| title | `14px`, weight `700` |
| speaker name | `9px`, weight `700`, line-height `1.2` |
| speaker message | `12px`, line-height `1.25`; package speaker font may replace the UI font |
| player-authored message | `13px`; otherwise follows transcript message rhythm |
| normal composer text / Send | `11px`; Send weight `700` |
| narrow composer text | `10px`; Send remains `11px` |
| normal timer | `18px`, weight `700`, tabular numerals |
| compact-width timer (`<= 480px`) | `15px` unless low-height mode also applies |
| low-height timer (`<= 600px` high) | `12px` |
| background control label | `12px`, weight `600`, line-height `1.2` |
| global icon control | `34px` square, `6px` corner radius |
| tool strip / column | `8px` strip gap; wide minimum `204px`, or `212px` when alone; maximum `min(22rem, 72vw)`; narrow floor `180px`; column radius `8px` |
| tool-column header | minimum `44px` high; selector/add/close controls are `30px` high; add/close are `30px` square; controls use `6px` radius |
| wide integrated composer shell | minimum `50px` high, `8px` corner radius; input minimum `38px`; Send `38px` high with `7px` radius |
| narrow composer controls | input and Send `42px` minimum/high respectively, each `7px` radius |
| right background control | maximum `156px` wide, `6px` radius; normal minimum height is `max(44px, clamp(42px, 3.2vmin, 60px))`, compact-width minimum is `42px` |

Tool-column header and body use one continuous `surface-component` background. The header separator does not introduce
a second chrome-colour band; selector/add/close controls provide the header's raised hierarchy.

These values define the current Player appearance. The cross-surface web guide deliberately adopts the current
`1px`-border, moderate-radius, focus-outline, and interaction-state vocabulary as the shared starting baseline for other
TeaseScript web surfaces. Player-specific widths, heights, spacing, and layout measurements remain owned here rather
than becoming universal component dimensions.

## Title and global panel controls

The normal title bar uses the chrome surface and visually spans the Player width. It contains:

- the left tools toggle;
- the Player title area;
- reserved room for global title controls as the product grows.

The current POC title text is `TeaseScript Player`; the future source of title text is not yet a host/package contract.

The title controls remain above ordinary Player content. The tools toggle exposes the effective open/closed state to
assistive technology as an expanded/collapsed control. In low-height mode the title's structural row collapses to zero
and the title controls overlay the media region instead. The title background becomes transparent and the visible title
text/control surfaces remain legible as raised component surfaces.

## Left tools area

### Panel state

The left tools area has three presentation states:

- `auto`: open/reserved on wide layouts and closed on narrow layouts;
- `open`: explicit user-open state;
- `closed`: explicit user-closed state.

The tools toggle changes `auto` to the opposite of the current responsive default and thereafter toggles explicit
`open`/`closed`. An explicit state survives width/orientation changes.

On wide layouts, an open tools area reserves horizontal space. On narrow layouts, opening tools creates an opaque
chrome-surface drawer below the title instead of shrinking the main Player content.

### Narrow drawer behavior

The narrow drawer:

- uses the current drawer-width constraint in the geometry table;
- remains opaque; underlying media/transcript content must not visually bleed through it;
- leaves a visible outside area covered by a scrim;
- intercepts outside pointer input so clicks do not pass through to underlying Player controls;
- closes when the scrim is activated;
- closes on `Escape` and returns keyboard focus to the tools toggle;
- remains below the title controls in z-order so the title controls stay usable.

### Tool columns

The tools area supports user-created independent columns. Each column contains exactly one fixed header row with:

1. a tool selector;
2. a local `+` control that appends another blank column;
3. a close control.

The selected tool's body occupies the remaining column height and owns vertical overflow. The tool name is not repeated
as another body heading merely because it already appears in the selector.

Columns may:

- select different tools independently;
- show the same tool in more than one column;
- be added from the `+` control in any existing column;
- be closed independently, including closing the last column.

When no columns remain, the tools region may show an empty state. Opening an empty tools region creates one blank column
so the user has an immediate selector instead of an unusable empty drawer.

The complete strip owns horizontal overflow. Adding a column scrolls the strip toward the new end; rerendering existing
columns preserves the previous horizontal position as far as the new scroll range permits. Columns use the maintained
geometry above; in the narrow drawer they expand to the available drawer content width subject to the documented floor.
These dimensions are part of the current multi-column presentation, not a package API.

### Wide sizing constraint

Wide tool-panel growth responds to user-created columns rather than claiming a fixed percentage of extra viewport
space. Growth is capped so the primary middle region preserves the stricter of:

- enough width to avoid shrinking the current media row below a 1:1 width/height boundary when the baseline can satisfy
  that boundary; and
- the `380px` minimum conversation/composer width, plus any right-overlay reservation applicable to that composition.

Tall portrait layouts that already begin below the 1:1 boundary currently preserve that baseline instead of shrinking
media further. Whether such shapes should move side regions to overlays or use another constraint remains open and is
not decided by this document.

The current `Visual Lab` and `Scene` registry is demo content, not the Standard Player tool API.

## Media presentation

The media region is a dedicated structural surface above the transcript in the main content column.

Current Player presentation invariants:

- media content may shrink to the allocated media region before object fitting is applied;
- image/video-like content is centered within the region;
- the current demo image uses `contain`, keeping the complete image visible;
- no duplicate fit label, filename caption, or scene-information overlay is placed over the media merely because that
  information exists elsewhere;
- decorative ambience/vignette layers, when used, are clipped to the media region and do not receive pointer input;
- accepted future image/video/canvas/custom package rendering should be able to replace demo media without changing the
  surrounding Player geometry.

The demo `contain` choice is the current Player presentation, not a final media API or user-preference contract. Media
fit persistence and broader media ownership remain open elsewhere.

## Transcript

The Standard Player has one visible conversation transcript in the current design. It remains visible during foreground
interactions.

The transcript:

- uses the canvas surface;
- is centered within the actual middle content region rather than the full viewport;
- has a readable width capped at `900px`;
- owns vertical scrolling and contains overscroll;
- uses a subtle `28px` top fade so content enters beneath the media boundary without a hard visual cut;
- hides the visible scrollbar on narrow layouts while retaining scroll behavior.

Current message presentation distinguishes package/speaker output from player-authored messages:

- speaker messages align to the normal reading side with a `30px` circular avatar/presentation marker, speaker name,
  `2px` speaker-coloured rule with `12px` text inset, and speaker-selected font;
- player-authored messages align to the opposite side and are constrained to `72%` of the conversation width with a
  `560px` maximum;
- speaker/package accent and font values are content presentation, not application palette roles.

The POC currently renders letter glyphs as avatar fixtures. Accepted V30 permits speaker avatar image references; the
fixture glyphs are not the final avatar contract.

ADR 0018 owns canonical transcript effects of foreground completion: valid text/number answers and choice/button
activations become player-authored transcript messages according to its normalization and visible-text rules. Invalid
attempts do not create canonical transcript output.

Smart transcript following is not yet accepted here. In particular, do not infer a contract that every new message
must forcibly scroll the user to the bottom; the follow/return-to-latest behavior remains open.

## Composer and foreground interactions

The Standard chat composer is fixed at the bottom of the conversation area and uses the same `900px` readable maximum as
the transcript.

### Normal-height wide presentation

The composer is one integrated component surface containing:

- the expanding answer/input field; and
- the primary `Send` control.

The surrounding composer shell owns the ordinary border, hover/pressed border feedback, focus-visible outline, disabled
surface, and moderate rounding. The input itself is visually integrated into that shell rather than appearing as a
second bordered box.

The input expands with content and then becomes internally scrollable. Its current maximum is the smaller of six line
heights and `20dvh`. The maintained current placeholder is `Type your response…`; the primary action is labelled `Send`.

### Narrow presentation

At `<= 760px`, the composer remains in the integrated bottom footer position, but the text input and `Send` control are
separate visible component surfaces on the canvas instead of one shared desktop shell. This is an intentional mobile
presentation difference, not an accidental border override.

### Foreground control slot

ADR 0018 fixes the Standard foreground-interaction relationship even though the current demo is not runtime-wired:

- the transcript remains visible;
- the existing composer becomes the answer field;
- ordinary free-chat submission is blocked while the mandatory foreground interaction is active;
- `choose` and `showButton` controls appear immediately above the composer;
- the answer field receives focus by default;
- choice presentation may use one or two rows of buttons or a dropdown when available space, text length, font metrics,
  zoom, accessibility settings, or similar constraints make buttons impractical;
- button-versus-dropdown presentation is Player UI state, not canonical runtime/checkpoint state.

Exact choice-row/dropdown measurement rules remain unresolved and are not invented here.

## Right timer and background rail

The right region is a dedicated Standard Player rail for the visible timer and long-lived background controls/status.
It is not another tool column.

### Timer

In normal-height layouts the timer is circular, uses tabular numeric text, and has an external circular progress ring.
The current timer diameter is `clamp(72px, calc(32px + 6vmin), 86px)`. The progress ring uses the package accent for the
completed/progress portion and the normal border family for the remainder.

At `<= 600px` viewport height, the timer compacts to a `34px` circle inside the title-height strip. The progress ring
remains present; low-height mode does not replace the timer with plain text.

Visible timer text presents non-negative whole seconds as `m:ss`, with a two-digit seconds field. The progress ring
shows elapsed fraction (`1 - remaining / total`), clamped to the valid range; the current presentation rounds that ring
percentage to a whole percent. Actual POC timer values are demo data. Which runtime timer/resource owns this visible
timer and final visible-timer API semantics remain outside this presentation specification.

### Background rail content

Two kinds of content are expected in this rail:

1. **background controls** — long-lived interactions that remain available while normal script execution continues,
   such as an accepted V30 permanent button (`Mercy`, `Edge`, etc.); and
2. **status items** — non-interactive information using the same rail vocabulary, such as progress `3 / 10`.

Accepted V30 permanent buttons provide the current semantic basis for background controls. When such a control is
activated, the accepted behavior temporarily removes it while its handler runs; after a normal function handler it
returns unless the script removed it, while other accepted handler outcomes follow the V30 runtime semantics. Status
items are an owner-selected Player presentation direction; their runtime/Standard-Library API is not yet defined. An
informational item must not be exposed as an interactive button merely because it shares visual geometry with one.

Background controls/status items are vertically stacked and the rail owns their vertical overflow. Long labels wrap
inside the rail rather than widening it. Background controls use the maintained visible geometry in the component table
above.

### Right background mode

The right region has `auto`, `docked`, and `overlay` presentation modes. A compact toggle at the upper-right of the
timer cluster changes the **rail background mode**, not whether the timer/background content exists. Its pressed state
represents the effective docked-background state for assistive technology.

- `auto` is docked on wide layouts and overlay on narrow layouts.
- activating the toggle from `auto` selects the opposite of the current responsive default; after that it toggles the
  explicit `docked`/`overlay` modes;
- `docked` shows the chrome-surface rail background;
- `overlay` removes that structural rail background and lets timer/control surfaces float over the underlying visual
  region;
- explicit `docked`/`overlay` state survives resize/orientation changes.

On wide layouts, switching the right background to overlay deliberately keeps the same right-side layout reservation so
transcript/composer geometry does not recenter. Media may extend behind the floating right controls.

On narrow portrait layouts, the right controls occupy the media region and reserve no transcript/composer width. On
narrow landscape layouts, the controls may span the full Player height and the transcript/composer reserve the right
controls width so readable content is not hidden beneath them.

When the rail background is absent, timer and ordinary background-control surfaces use a `60%` component-surface mix
with transparency. Hover and pressed control fills use the corresponding hover/pressed semantic colour at the same
`60%` treatment.

## Interaction states and input methods

### Neutral controls

Ordinary neutral controls use the shared web control progression:

1. default: component surface with `border-subtle`;
2. hover: `border-interactive` plus component-hover fill;
3. pressed/active: `border-strong` plus component-pressed fill;
4. keyboard focus: `2px` accent focus outline with `1px` separation, without geometry shift;
5. disabled: dedicated disabled surface/border/text roles and non-interactive cursor behavior.

`border-strong` is a pressed/strong state, not the ordinary resting border.

### Primary controls

The current primary `Send` control uses the solid accent family for default, hover, and pressed states with inverse
text.

### Input capability

- hover styling applies only when the input device reports hover capability with a fine pointer;
- touch/coarse-pointer activation uses pressed/active feedback rather than depending on hover;
- compact buttons suppress the browser tap highlight and use manipulation-oriented touch behavior;
- keyboard focus remains visible through `:focus-visible`-equivalent behavior;
- reduced-motion preference effectively removes current control-transition and message-entry animation duration.

An actual interactive control takes precedence over the ADR 0018 click/tap/Space pacing-skip gesture. Activating a
button, field, selector, or other control must not also complete a viewport-wide pacing gate.

## Z-order, overlays, and click-through

The maintained relative stacking order is:

1. title/global controls;
2. open narrow tools drawer;
3. drawer scrim;
4. title structural background;
5. right timer/background-control region;
6. ordinary content surfaces.

Exact numeric z-index values are implementation detail; the relative behavior above is contractual.

The drawer scrim intentionally intercepts outside pointer activation. Decorative media effects are pointer-neutral.
Floating right controls remain interactive even when their structural background is absent. Overlay presentation must
not create click-through into a covered control where the overlay visibly owns that input area.

## Current light theme

The Standard Player currently has one approved light theme. Application palette primitives are represented canonically
in OKLCH and mapped to semantic roles before components consume them. The sRGB values below are references for tools and
review, not a second colour authority.

| Semantic role | Canonical OKLCH | sRGB reference |
| --- | --- | --- |
| surface-base | `oklch(95.839% 0.01306 71.33)` | `#F7F0E8` |
| surface-chrome | `oklch(97.586% 0.01130 71.90)` | `#FCF6EF` |
| surface-component | `oklch(99.199% 0.00734 80.72)` | `#FFFCF7` |
| component-hover | `oklch(95.449% 0.01618 64.67)` | `#F8EEE5` |
| component-pressed | `oklch(92.481% 0.02213 58.77)` | `#F2E3D8` |
| border-subtle | `oklch(84.246% 0.02905 65.71)` | `#D9C8B8` |
| border-interactive | `oklch(78.050% 0.03740 56.32)` | `#CBB2A1` |
| border-strong | `oklch(68.851% 0.04826 51.55)` | `#B49380` |
| text-primary | `oklch(30.838% 0.01712 35.72)` | `#382D2A` |
| text-muted | `oklch(52.649% 0.02679 41.27)` | `#79665F` |
| accent-focus | `oklch(64.182% 0.19236 10.29)` | `#E84C71` |
| accent-solid | `oklch(59.208% 0.19138 11.08)` | `#D63B61` |
| accent-solid-hover | `oklch(56.375% 0.18326 11.66)` | `#C93659` |
| accent-solid-pressed | `oklch(52.588% 0.17301 12.20)` | `#B82F4F` |
| disabled-bg | `oklch(93.009% 0.01361 60.56)` | `#EFE6DF` |
| disabled-border | `oklch(86.370% 0.02252 58.74)` | `#DECFC4` |
| disabled-text | `oklch(58.486% 0.02603 41.30)` | `#8A7770` |

Structural shadow uses the primary-text hue at `8%` alpha; the drawer scrim uses it at `18%` alpha. Inverse text is
white. These are semantic support roles rather than extra surface levels.

The palette follows the project-owned Radix-inspired twelve-step role-band convention described in the web UI guide;
there is no Radix runtime or CSS dependency.

### Colour ownership boundary

The application palette does **not** own:

- speaker/person colours;
- speaker fonts and avatars;
- package-selected accent/identity colours;
- media-derived ambience;
- technical mask colours.

Those values may vary with content without repainting unrelated Standard Player chrome. The current package accent is
used by the timer progress ring and selected package-accent presentation seams.

## Package customization and theming boundary

The provisional product direction is that packages/developers may select the base colour of both foreground controls
and long-lived background controls. The current POC has not implemented that author-facing capability yet. Its exact
TeaseScript/Standard-Library API, accepted colour forms, generated interaction-state colours, text-colour choice, and
accessibility fallback behavior remain open.

The following related direction is also intentionally **not finalized** and must not be implemented as if this document
had chosen an API or precedence rule:

- package/developer-selected Player theme versus user-selected theme versus platform default;
- future dark-theme semantic mappings;
- developer-selected speaker/text colours interacting with user-selected backgrounds;
- automatic derivation of hover/pressed/disabled states from a custom control colour;
- accessibility/contrast correction when a package colour would make text or controls unreadable;
- which Standard Player visual properties packages may customize without replacing Standard UI;
- persistence and scope of user Player preferences.

The intended design constraint is that package customization must not make Standard Player controls or text unreadable,
but the exact precedence, transformation, fallback, warning, and author-override policies remain open. See
[OPEN-DECISIONS.md](../OPEN-DECISIONS.md).

Custom package views remain governed by ADR 0012 and the later custom-view contract. This specification describes the
platform Standard Player; it does not grant custom code access to parent DOM, host cookies, or unrestricted network
capabilities.

## Accessibility invariants

Higher-authority ADR 0018 requires a programmatic accessible name for every Standard UI text field, number field, choice
group, and button. The Player must preserve that requirement regardless of visible hint text or package styling.

Additional maintained presentation invariants:

- keyboard focus is visibly distinguishable and does not rely on hover;
- touch interaction does not depend on hover state;
- drawer dismissal is available through outside activation and `Escape`;
- actual controls take precedence over viewport pacing-skip gestures;
- disabled controls remain visually distinguishable from enabled quiet states;
- reduced-motion preference suppresses current decorative motion without changing layout or interaction semantics;
- status-only right-rail items use non-interactive semantics rather than masquerading as buttons;
- package/theme colours must ultimately preserve readable Standard Player content, although the exact enforcement policy
  remains open.

Broader contrast thresholds, text scaling policy, package-colour correction, and final custom-view accessibility
responsibility remain controlled by accepted accessibility requirements plus the unresolved decisions; do not invent
numeric thresholds here without an accepted source.

## Open decisions

Unresolved Player product/design choices are owned by [OPEN-DECISIONS.md](../OPEN-DECISIONS.md). This specification
marks affected behavior as open at the point where it matters, rather than maintaining a second checklist here. An open
question is not permission for an implementation to choose a durable project policy silently; a POC may use a local
reversible presentation choice only while it remains identified as provisional.

## Non-contract implementation details

An equivalent implementation may freely change:

- DOM nesting, element IDs/classes, CSS selectors, Grid/Flex choice, cascade layers, JavaScript helper structure, or
  module/file names;
- whether a geometry invariant is expressed with Grid, Flexbox, intrinsic sizing, container queries, or another
  browser-native mechanism;
- internal presentation data types and demo bootstrap seams;
- exact local measurement code used to obtain intrinsic tool-strip preference, provided the observable sizing contract
  is preserved;
- fixture tool names/content, placeholder messages, demo timer values, local media-discovery endpoint, and demo action
  labels.

Do not preserve an implementation technique merely because the current POC uses it. Preserve the observable behavior,
authoritative upstream semantics, and explicitly recorded geometry/state/theme contracts instead.
