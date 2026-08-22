# Standard Player UI specification

- **Status:** Provisional maintained normative specification for the intended Standard Player presentation.
- **Purpose:** Define what the Standard Player should present when completed: observable layout, responsive behavior,
  interaction presentation, visual states, and the approved light-theme baseline, independently of the current
  HTML/CSS/JavaScript implementation.
- **Authority:** Accepted ADRs and accepted specifications remain higher authority for the exact architecture, runtime,
  language, isolation, and persistence scope they decide. The temporary [Upstream contract integration](#upstream-contract-integration)
  section below records Owner-decided Player behavior that still needs synchronization into those upstream contracts.
- **Implementation state:** The production-oriented Player presentation POC exists under `player/`, but runtime/host
  integration is incomplete and several visual measurements remain deliberate tuning baselines.

This document may lead the implementation. A missing POC feature or an implementation bug does not redefine the desired
Player contract. Conversely, behavior found only in current HTML/CSS/JavaScript is evidence rather than contract until it
is adopted here or by a higher-authority source. When implementation is deliberately changed first, this specification
must be synchronized once the desired result is accepted.

A competent implementation should be able to reproduce the maintained Standard Player from this document plus the
accepted platform/runtime contracts without copying the existing source. A review agent should likewise use this
observable contract instead of treating current selectors, DOM structure, CSS techniques, or demo fixtures as
requirements.

## Authority and scope

The most relevant higher-authority sources are:

- [ADR 0001](../decisions/0001-browser-first.md): browser-first UI and responsive PWA direction;
- [ADR 0012](../decisions/0012-custom-view-capability.md): accepted blocking and non-blocking/asynchronous custom-view capability;
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

General reusable UI engineering and visual-design guidance lives in
[UI-DESIGN-AND-ENGINEERING.md](UI-DESIGN-AND-ENGINEERING.md). That guide informs implementation quality but does not
replace the Player-specific contract here.

## Current maturity boundary

Current implementation status belongs in [`PHASE-STATUS.md`](../../PHASE-STATUS.md);
[`player/README.md`](../../player/README.md) records POC seams and demo-only behavior. This specification may lead the
implementation. The current `player/` POC is a presentation implementation with incomplete runtime/host wiring;
`Visual Lab`, `Layout Debug`, `Scene`, placeholder content, and demo media are development fixtures rather than
Standard Player product content. Values explicitly marked for retesting remain provisional tuning baselines.

A current implementation detail is not a durable requirement merely because it exists. Owner-confirmed behavior here is
the target unless higher authority conflicts with it.

## Upstream contract integration

This temporary checklist records Owner-decided behavior that still needs synchronization into its runtime, Standard
Library, persistence, or accepted-language owner. It is not a second permanent authority layer. Remove an item when its
controlling source adopts it; remove this section and its router references when empty.

- **Long-lived control presentation:** the maintained right-rail sections below currently choose busy-in-place and
  visible-history behavior that still needs final visual testing and later accepted-language/Standard-Library
  synchronization. Runtime value, scheduling, stale-event, media-continuity, lifecycle, and provenance semantics are
  maintained in [`RUNTIME.md`](../RUNTIME.md); exact public API names and author syntax remain open.
- **Timer presentation metadata:** the maintained timer section below defines visible/mystery/hidden presentation and
  optional labeling. The accepted label placement remains presentation-only; exact runtime/Standard-Library metadata,
  author syntax, and stable generic-label numbering across timer lifecycle changes remain unsynchronized.

## Surface hierarchy

The Standard Player fills the available Player viewport and uses the following normal presentation regions. A region
may reserve space, overlay another region, or temporarily hide according to the responsive and custom-presentation
rules, but changing a backing surface must not implicitly delete unrelated controls.

```text
+-----------------------------------------------------------------------+
| title / Player chrome                                                 |
+----------------------+--------------------------------+---------------+
|                      |                                | timer +       |
| tools                | stage                          | background    |
|                      |                                | controls /    |
|                      +--------------------------------+ status        |
|                      | transcript                     |               |
|                      +--------------------------------+               |
|                      | foreground controls when any   |               |
|                      | composer                       |               |
+----------------------+--------------------------------+---------------+
```

`stage` is the structural name. Standard image/video/media presentation is one kind of stage content; later canvas,
custom HTML, games, and other accepted custom presentation may use the same structural region without forcing the
surrounding Player geometry to change.

### Visual hierarchy

- **Canvas surface:** transcript and composer-area background.
- **Chrome surface:** title bar and opaque docked side regions.
- **Component surface:** tool columns, input/control surfaces, timer, and ordinary Standard controls.
- **Stage surface:** visually separate content region; media may be full-bleed to device edges while Player chrome
  respects safe areas.
- **Content identity:** speaker, authored control, theme, and media-derived colours remain distinct from unrelated
  application chrome roles.

The title, tools, right rail, stage, transcript, foreground controls, and composer are structural peers. The normal
vertical middle-column order is stage, transcript, foreground controls when active, then composer. The stage and
transcript remain present in the Standard Player even when empty.

## Responsive modes

Responsive behavior is constraint-driven. Current width/height thresholds remain implementation baselines where noted;
they are not a substitute for checking usable stage width, readable conversation width, side-region reservation, and
currently available visual-viewport height.

| Condition | Current POC role | Intended behavior |
| --- | --- | --- |
| width `>= 761px` | wide tool-composition baseline | Open tools use a docked horizontal strip. Right-control docking is decided separately from the width breakpoint by the space left after the complete preferred tool-strip width. |
| width `<= 760px` | narrow tool-composition baseline | Left tools become an overlay drawer. Right-side presentation overlays the stage so the conversation can use the full width beneath it. |
| width `<= 480px` | compact review target | Re-audit selected control geometry. If compact values remain, use deliberate discrete values rather than continuous viewport-driven shrinking. Do not shrink arbitrary tool content. |
| usable visual-viewport height `<= 768px`, or fullscreen | **overlay chrome mode** | Ordinary title chrome auto-hides/overlays so stage height is not consumed unnecessarily; required tools/fullscreen-exit/global controls remain reachable. Timer compaction is a separate height decision and currently starts at `<= 600px`. |

The old term `low-height mode` is therefore replaced by **overlay chrome mode**. Low available height and actual
fullscreen may activate the same chrome presentation rather than maintaining two unrelated implementations. Fullscreen
is an actual Player/browser fullscreen state; it is separate from a future package full-player takeover.

Use available dimensions rather than device classes. Portrait/landscape or aspect ratio may be used as an optimization
signal when both axes are constrained: a tall shape can spend relatively more vertical space to preserve horizontal
content, while a wide/short shape can preserve vertical control extent because horizontal reading room is more abundant.
A narrow tall desktop window and a similarly shaped phone should therefore converge on the same layout reasoning.
Foldables likewise use their currently available dimensions rather than a special device category.

Manual open/closed tool intent is preserved across resizing and rotation when the tool region owns focus or remains the
active interaction context. A responsive change must not spontaneously open a previously closed drawer. When an open
docked strip becomes an overlay drawer while focus is elsewhere, it may close so that it does not unexpectedly block the
active Player region. Right backing intent is likewise stable, while the layout independently decides whether the right
controls can occupy a reserved rail or must overlay the stage. A future persistent user preference may refine this
session-local policy separately.

The Player must size against the currently usable visual viewport when a software keyboard or similar browser UI reduces
available space.

## Global geometry and overflow

The Player shell itself does not normally scroll. Scrolling belongs to the specific region that owns the overflowing
content. Major numerical values below are POC reconstruction/tuning baselines unless explicitly marked otherwise.

| Item | POC baseline / intended rule |
| --- | --- |
| Player viewport | full viewport width and currently usable visual-viewport height; `100dvh` is the CSS baseline and the outer document is not the normal scroll owner |
| normal title bar | `52px` plus top safe-area inset; visually retestable |
| normal stage row | current `55dvh` baseline; expose as a development tuning value and visually re-evaluate |
| overlay-chrome stage row | current `64dvh` baseline; visually re-evaluate with low-height and fullscreen cases |
| tool column | fixed `300px` default; individual columns do not shrink to hide their content |
| readable conversation maximum | current `900px` baseline; keep a cap for ultrawide readability and visually retest, including browser zoom |
| protected conversation minimum | current `380px` baseline; remeasure after tool-width/right-rail simplification |
| normal conversation side gap | current `18px` baseline before safe-area contribution |
| narrow tools drawer | grows from one complete `300px` tool plus strip gutters when more columns are open, capped at `90vw`; the remaining outside area dismisses the drawer |

Keeping the stage roughly square when practical is a design goal, not a hard 1:1 layout invariant. The goal exists so
both portrait and landscape media remain useful. Side panels should not casually crush the stage into a narrow strip,
but a rigid 1:1 rule must not cause surprising responsive transitions. Final dock/overlay decisions should use the full
set of layout constraints.

Current dynamic safe-area insets reported by the browser affect Player chrome and controls. Do not permanently reserve
the static maximum inset, infer rounded hardware corners, or add a device/UA-based fallback when the browser reports
zero; rectangular and currently unobstructed viewports must not lose space. Stage/media remains allowed to occupy its
complete visual region rather than receiving identical safe-area padding by default. During the POC, `Visual Lab` may
temporarily override stage
heights, fixed tool width, conversation bounds, and composer line/viewport caps; Reset removes those development-only
overrides. The shared `2px` focus outline is the accepted Player baseline rather than a tuning control.

Scrolling ownership:

- transcript: vertical conversation scrolling;
- tool-column strip: native horizontal scrolling, with carousel navigation only while content actually overflows;
- each tool body: its own vertical scrolling;
- right background-control/status stack: vertical scrolling when needed;
- composer input: internal vertical scrolling after its constraint-based growth limit;
- Player shell: no normal scrolling.

Input axes remain predictable. Vertical wheel input stays vertical and horizontal wheel input stays horizontal; reaching
an edge on one axis must not silently repurpose that input to the other axis. Nested content should not create a second
scrollbar for the same axis/responsibility.

### Typography and visible control geometry

Current typography and component geometry are provisional visual baselines. Values marked for tuning may change through
`Visual Lab` before production without implying a compatibility promise.

| Element | Current Player baseline |
| --- | --- |
| UI font stack | `"Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| title | `14px`, weight `700` |
| speaker name | `9px`, weight `700`, line-height `1.2` |
| speaker message | `16px` (`1rem`), line-height `1.25`; authored speaker font may replace the UI font |
| player-authored message | `16px` (`1rem`), following the same transcript rhythm |
| normal composer text / Send | composer `16px` (`1rem`); Send remains `11px`, weight `700` |
| narrow composer text | composer remains `16px` (`1rem`); Send remains `11px` |
| normal timer | `18px`, weight `700`, tabular numerals |
| compact timer | current smaller timer values remain a visual-tuning baseline rather than a final `<= 480px` contract |
| background control label | `12px`, weight `600`, line-height `1.2` |
| global icon control | `34px` square, `6px` corner radius |
| tool column | fixed width from the maintained global-geometry baseline; column radius `8px` |
| tool-column header | minimum `44px` high; selector/add/close controls are `30px` high; add/close are `30px` square; controls use `6px` radius |
| wide integrated composer shell | minimum `50px` high, `8px` corner radius; input minimum `38px`; Send `38px` high with `7px` radius |
| narrow composer controls | input and Send `42px` minimum/high respectively, each `7px` radius |
| right background control | current maximum `156px` wide and `6px` radius remain the POC baseline; final sizing is visually reviewable |

Tool-column header and body use one continuous `surface-component` background. The header separator does not introduce
a second chrome-colour band; selector/add/close controls provide the header's raised hierarchy.

The shared UI guide adopts the current `1px` border, moderate-radius, visible-focus, and interaction-state
vocabulary as a shared starting baseline. Player-specific widths, heights, and spacing remain owned here rather than
becoming universal dimensions.

## Title and global panel controls

The normal title bar uses the chrome surface and spans the Player width. It contains:

- the left tools toggle;
- the Player title area;
- a fullscreen control in the completed Standard Player;
- room for other genuinely global Player controls as the product grows.

The current POC title text is `TeaseScript Player`; the future title source remains a host/package contract question.

In normal composition the title bar is a fixed Standard Player part. In overlay chrome mode, including fullscreen, the
same chrome may auto-hide and return on relevant pointer/touch/focus activity rather than creating a second title
implementation. Required tools access, fullscreen exit, and other critical global controls must remain discoverable and
reachable. Auto-hide timing and exact reveal zones are implementation/tuning details unless later promoted.

## Left tools area

The Standard Player owns the tools framework: panel open/close state, column chrome, selector, `+`, close control,
horizontal carousel behavior, responsive drawer behavior, and surrounding layout. A tool owns only its body content.

### Panel state

The left tools area has `auto`, explicit `open`, and explicit `closed` presentation states. `auto` opens/reserves on wide
layouts and closes on narrow layouts under the current baseline. The tools toggle changes `auto` to the opposite of the
current responsive default and thereafter toggles explicit state. Rotation/resizing preserves the user's closed intent;
an open tool region remains open across composition changes only while it owns the active interaction/focus context, so
a newly overlaid drawer does not unexpectedly cover the Player while the user is working elsewhere.

On wide layouts an open tools area reserves horizontal space. On narrow layouts it becomes an opaque chrome-surface
drawer rather than shrinking the main Player content.

### Narrow drawer behavior

The narrow drawer:

- uses the current drawer-width baseline from the geometry table;
- remains opaque so stage/transcript content does not bleed through;
- leaves a visible outside area covered by a scrim;
- intercepts outside pointer input so activation does not pass through to underlying Player controls;
- closes when the scrim is activated;
- closes on `Escape` and returns keyboard focus to the tools toggle;
- remains below critical/global chrome in z-order.

### Tool columns and lifecycle

The tools framework always retains at least one presentation column internally. Each column has one Player-owned header
row containing:

1. a tool selector;
2. a local `+` control that appends another column to the right;
3. a close control.

If no tool has ever been selected, the single initial column automatically selects the first available tool. Pressing
`+` appends a column and selects the first tool in the fixed selector order that is not already open in another column.
If every available tool is already open at least once, `+` still appends a deliberately blank/unselected column; that
blank state is the natural signal that no unused tool remains. The user may explicitly select a duplicate tool through
the selector when duplicates are useful.

With multiple columns, close removes only that presentation column. Closing the only remaining column collapses the
entire tools area instead of deleting the internal final column; reopening restores that column and its selected tool.
Closing a column or switching its selected tool does not erase underlying settings or canonical tool data. Temporary
presentation-instance state such as scroll position, an unsubmitted field draft, or arbitrary DOM state need not survive
a tool switch in the POC unless the tool explicitly stores it in its own supported state.

Tool selectors may list platform tools and developer-provided/custom tools. Tool display name is required by the
selector; an icon may be supplied where supported. A tool cannot replace or restyle the shared header/selector/`+`/close
chrome directly. A separate permitted theme API may affect global Player styling, but that is not tool ownership.

### Standard tool controls

The Standard Player's built-in structured tool vocabulary deliberately avoids drag-based sliders/range controls. Use the
simplest fitting control from:

- momentary button;
- on/off switch/toggle;
- dropdown/select for one mutually exclusive choice;
- text input;
- numeric input;
- static text/content.

A future stepper may be added for small fixed-step ranges when it is clearer than a select or numeric field. Multiple
independent booleans can use multiple switches. Fully custom tool HTML/CSS/TypeScript may use any otherwise permitted
control, including sliders; the restriction applies only to the Standard structured control set.

The exact developer-facing declaration that combines a tool title, ordered static content, and these typed controls
into a Player-generated Standard tool remains open. This specification fixes the presentation vocabulary and shared
tool ownership only; it does not invent author syntax, value binding, submission, or persistence semantics. That contract
is tracked in [OPEN-DECISIONS.md](../OPEN-DECISIONS.md).

### Tool body isolation and scrolling

The selected tool body occupies the remaining column height and owns vertical overflow. The tool name is not repeated as
another body heading merely because it already appears in the selector. A fully custom tool body is confined to its
assigned surface; Shadow DOM is the preferred isolation candidate when custom CSS/DOM is allowed so package styles do
not escape into Player chrome.

The complete strip is a horizontal browser-native carousel/scroll surface. Prefer native horizontal scrolling and CSS
Scroll Snap rather than bespoke swipe physics. In effectively single-tool narrow layouts, proximity snapping near a tool
boundary should settle a nearly completed swipe cleanly onto the adjacent tool. When the viewport can usefully display
more than one tool or partial views of multiple tools, do not force page-like snapping; positions such as two tools each
roughly 75% visible remain valid. Previous/next arrow controls may advance by logical tool columns without creating a
second carousel state model. Arrows and scroll markers appear only when the strip actually overflows; strip gutters are
part of its visible allocation and must not create a false overflow state at the final column. Native horizontal
wheel/trackpad, touch-pan, and keyboard scrolling remain the fallback where enhanced CSS carousel controls are not
supported. A gesture that became a pan/scroll must not accidentally fire a child button click, and navigation markers
must never activate the tool/control whose position they reveal.

Compact explanatory copy for Visual Lab-style options may be disclosed without permanently consuming every row. The
complete title/copy area reveals its information on pointer hover and toggles it on tap/click; a visible information
button remains the touch and keyboard affordance. Keyboard focus reveals the same text. At most one such disclosure is
latched open, and an outside activation or `Escape` closes it. This disclosure behavior is Player/tool chrome behavior,
not a requirement that every custom tool use the same explanatory-copy component.

### Wide sizing direction

Tool growth must protect useful primary content, but a hard 1:1 stage boundary is not the layout algorithm. Use the full
constraint set: stage usefulness, readable conversation width, right-side reservation, available height, and the fixed
POC tool width. The maintained conversation bounds and stage-shape goal remain visual/tuning inputs rather than hidden
additional responsive modes.

`Visual Lab` and `Scene` remain development fixtures, not Standard Player tools. A real Debugger is a future platform
tool described in [DEBUGGER.md](../DEBUGGER.md).

## Stage and media presentation

The stage is a dedicated structural surface above the transcript in the main content column and remains present even
when no media is active. An empty stage shows its normal background/ambience rather than collapsing and expanding the
transcript into that space.

Standard image/video-like presentation:

- defaults to `contain`, keeping the complete media visible within the allocated stage;
- centers media within the stage unless an accepted media capability explicitly positions it otherwise;
- uses a restrained media-derived ambience/vignette in otherwise unused stage area by default where that effect is
  available, while allowing an accepted author/media capability to provide an explicit stage/background presentation;
- clips ambience/vignette layers to the stage and keeps decorative effects pointer-neutral;
- uses a direct replacement as the Standard default transition; accepted explicit media transitions such as V30
  `fade`/`crossfade` remain author-requested behavior;
- does not add duplicate filename, fit, or scene-information captions merely because those values exist elsewhere.

Accepted future background/foreground/overlay media, canvas, and custom stage rendering should replace stage content
without changing the surrounding Standard Player geometry. Per-asset fit/background/transition metadata may be needed
for randomly selected assets, but exact author-facing media metadata/API remains owned by the media contract rather than
filename conventions in this UI specification.

## Transcript

The Standard Player has one visible conversation transcript surface even when it is empty, and it remains visible during
foreground interactions. The visible transcript is a presentation over conversation/history data; a future author action
may start a new visible segment without implying that retained canonical history needed for runtime/history/LLM policy
has been destroyed. Exact retention and LLM context policy remain upstream work.

The transcript:

- uses the canvas surface;
- is centered within the actual middle content region rather than the full viewport;
- keeps the maintained ultrawide readability cap pending visual retuning;
- owns vertical scrolling and contains overscroll;
- uses the maintained soft top fade beneath the stage instead of a hard cut;
- may hide the visible scrollbar on narrow layouts while retaining scroll behavior;
- must remain performant for histories that can reach extremely large sizes. Do not retain millions of words as active
  DOM nodes. Use virtualization/windowing or an equivalent technique while preserving stable scroll position and the
  illusion that the complete retained history is continuously present; loading/rendering older content must not make a
  user who appeared near the top suddenly jump to a different relative location.

### Smart follow and return to latest

Smart follow is active while the user is following the newest content. New transcript entries and composer growth keep
the newest content readable in that state. When the user intentionally scrolls upward, smart follow suspends and new
content/composer growth must not drag the reading position back to the bottom.

Smart follow reactivates when either:

- the user manually scrolls back to the latest/bottom region; or
- the user activates a contextual return-to-latest control.

The return-to-latest control appears only when the user is sufficiently away from current content and is not in the
middle of an active touch/scroll gesture. On touch, wait until the finger is released and scrolling has settled rather
than placing a button under the user's moving finger. Hide the control once latest content is reached/follow resumes.
It is a compact, translucent down-arrow control at the lower right of the transcript, using the conversation's unused
side margin instead of claiming a new vertical row. It may overlap an avatar margin before it obscures message text and
uses restrained backdrop blur where supported. Its exact threshold remains a tuning detail.

### Message presentation and provenance

Speaker/package output aligns to the normal reading side; player-authored output aligns to the opposite side. A message
row may use at most `90%` of the conversation width, while its readable copy is capped at `65ch`; this preserves an
opposite-side margin on narrow layouts without forcing short wrapping on wider ones. The current avatar, speaker-name,
and speaker-coloured rule remain the POC visual baseline. Speaker identity colour/font and per-message rich-text styling
are content presentation, not application palette roles.

ADR 0018 owns canonical transcript effects of foreground completion: valid text/number answers and choice/button
activations become player-authored transcript messages according to its normalization and visible-text rules. Every
accepted user activation/change on the long-lived control family also carries machine-readable canonical provenance. A
momentary action is shown as a player-authored transcript action; toggle/select visibility is author-controlled and,
when shown, uses a neutral session-event presentation rather than implying spoken prose. Programmatic control updates
are not user activations and use the same neutral event family with their script origin identified. Visual markers must
not become canonical punctuation; their exact appearance remains tuning work.

The POC's letter-glyph avatars remain fixtures; accepted V30 speaker avatar references are the product capability.

## Composer and foreground interactions

The Standard Player uses one persistent composer at the bottom of the conversation area. It is the normal chat input and
the answer field for `askText` and `askNumber`; `choose` and `showButton` controls appear immediately above it within the
same central conversation width.

### Wide presentation

At normal wide presentation the composer is one integrated component shell containing the expanding input and primary
`Send` control. The shell owns its border, hover/pressed feedback, focus outline, disabled treatment, and moderate
rounding; the input does not draw a second bordered box inside it.

### Narrow presentation

At `<= 760px` under the current baseline, the composer remains in the bottom footer position but the input and `Send`
control are separate visible component surfaces on the canvas. This is an intentional mobile presentation difference.

### Input growth, focus, and keyboard behavior

The input grows upward only within the conversation area. Its maximum height is constraint-based: a large desktop may
show more lines than a phone with its software keyboard open. After the limit, only the input scrolls internally. Composer
growth may reduce the visible transcript viewport but must never push or resize the stage out of its allocated position,
and the composer may never grow larger than the conversation area available beneath the stage. The composer row must
contain the complete measured input and Send control; a growing textarea may not paint beyond that row or beneath the
visual-viewport/keyboard boundary.

The Player re-evaluates during and after keyboard/orientation transitions. Normal browser presentation uses the visual
viewport that the browser already resizes. Fullscreen uses feature-detected software-keyboard geometry when available,
because fullscreen viewport resizing is not reliable. The outer fullscreen Player remains full-size while its internal
content allocation reserves the reported keyboard height against the stable pre-keyboard viewport. The Player does not
request layout-viewport resizing.

An open measured keyboard does not select a separate Player composition. The normal stage, transcript, foreground, and
composer ownership remains intact. The stage may shrink below its preferred height so the complete measured composer,
any foreground controls, and a `5rem` transcript target reserve fit in the actually available height. That reserve is
bounded by the real remainder rather than enforced as a hard minimum; the transcript may receive more when the stage is
already at its preferred height, or less when less space exists. The Player itself never grows or becomes a vertical
scroll owner. A fullscreen browser that reports neither keyboard nor viewport geometry keeps the stable normal
composition rather than guessing an occlusion or replacing the Player with a full-area editor. Browser-reported safe
areas remain in force, but a measured open keyboard already owns the usable bottom edge and is not combined with a
second bottom-safe-area reservation. While that keyboard is open, the measured usable height also owns the outer Player
height instead of being capped again by a potentially stale dynamic-viewport unit. For a shifted visual viewport, that
usable bottom edge includes its reported top offset rather than treating its height alone as a document coordinate.

The composer receives focus by default. Non-interactive Player clicks should not arbitrarily steal typing focus; an
explicitly focused tool/input/control naturally owns keyboard input while it is active. Standard keyboard behavior is:

- `Enter` submits;
- `Shift+Enter` inserts a newline;
- a future user preference may invert or otherwise refine that choice;
- whitespace-only ordinary submissions are rejected;
- the maintained default hint is `Type your response…` when an interaction does not provide its own hint. An explicit
  interaction hint replaces that visible text; an explicit empty hint remains possible where the upstream contract
  permits it.

### Foreground interaction presentation

`askText` and `askNumber` use the composer as their active answer field. `choose` and `showButton` keep the composer
enabled rather than visually disabling it:

- `choose`: selecting a rendered control or typing one exact unambiguous visible option completes the same choice;
- `showButton`: clicking the rendered button, typing its exact visible label, or pressing Space while the empty composer
  owns focus activates the one available button;
- a primary click on unrelated/blank Player space does **not** activate `showButton`;
- while any mandatory foreground interaction is active, other composer text does not advance ordinary canonical script
  execution. In the deterministic first POC it is an invalid attempt and the same interaction remains active with the
  accepted validation/retry behavior. A future LLM clarification/interpretation layer may consume non-matching text
  without silently changing the deterministic choice, but that is outside the current POC contract.

This is distinct from a skippable `say` pacing gate: when no foreground interactive control owns the input, a primary
click/tap on Player background/unused space or Space with the empty focused composer may settle that gate under ADR 0018.
Actual interactive controls always take precedence and must not also fire the viewport-wide pacing shortcut.

A `showButton` is the one-option presentation of the same Standard foreground-control vocabulary. Its width is bounded by
the available foreground-control lane, has a practical touch/click minimum, and otherwise grows with its label rather
than becoming arbitrarily full-width. Long labels may wrap. The foreground-control lane spans the available middle
region between an open tools strip and reserved right rail; unlike prose, it is not capped by the `900px` reading width.
Buttons are centered while they fit. When they overflow they remain individually authored buttons in a native
horizontal scroll/snap carousel, preserving authored colour and semantics rather than changing into a dropdown.
Enhanced CSS arrows/markers appear only during real overflow and are navigation only; selecting a marker reveals a
button but never activates it. The arrows sit at the left and right edges beside the button row; only a compact marker
strip sits beneath the buttons, so carousel chrome does not claim another control-height row. Browsers without those
enhanced controls keep the usable native horizontal scroller. Carousel position is Player UI state, not canonical
runtime or checkpoint state. Authored foreground buttons use their solid authored colour because media never sits behind
this lane; authored right-rail actions retain the translucent floating-control treatment described below.

Validation content and retry semantics come from the controlling interaction/runtime contract. The Player must not
invent a competing inline-error semantic merely because the current POC lacks the richer accepted V30 `invalidMessage`
/`invalidLlmInstruction` compatibility path.

## Right timer and background rail

The right region is a Standard Player presentation area for visible timers and long-lived background controls/status. It
is not another tool column. Timer/control presence, rail backing surface, and layout reservation are separate concerns.
Changing the backing mode must not swap component instances or change their normal appearance.

### Timer presentation

The Standard Player supports three timer-presentation classes:

1. **visible timer** — circular timer with actual remaining time and determinate elapsed-progress ring;
2. **mystery timer** — the same visible timer vocabulary, but the center displays `?` and the accent ring uses a stable
   indeterminate/loading-style rotation rather than exposing duration or progress;
3. **hidden timer** — no timer UI at all and no visible hint that a timer exists. Accepted blocking `wait` is the
   simple hidden blocking case; future non-blocking timers may likewise request hidden presentation.

A visible blocking timer and a visible non-blocking timer use the same visual vocabulary. Presentation must not reveal
whether script execution is blocked. Multiple visible timers may coexist: only one blocking timer can own the foreground
path at once, but background timers may add further visible timers. A visible timer may have an authored label. A lone
unlabeled visible timer need not display one; when multiple visible timers coexist, unlabeled visible timers receive
generic labels from visible presentation order (for example `Timer 1`, `Timer 2`). Internal IDs and hidden timers must
not leak through those labels. The accepted generic-label baseline places the label inside the timer below its time/value.
Stable generic numbering as timers enter and leave remains open tuning.

Normal timer text is:

- below one hour: `m:ss`;
- one hour or more: `h:mm:ss`.

The determinate ring represents elapsed fraction. The current circular size and package/theme accent treatment remain the
POC visual baseline. In overlay chrome mode the timer may use the current compact title-height presentation; exact compact
size remains visually tuneable. Multiple compact timers use one horizontally scrollable row rather than consuming
additional Action height. A timer disappears when its underlying visible timer action/lifecycle has completed and no
longer requires presentation.

When exactly one visible timer exists, its timer pane never presents a scrollbar; the complete ring fits and stays fixed
while the background-control/status list scrolls independently beneath it. When multiple visible timers exist, the timer
pane may scroll only when those timers actually exceed its allocation. A hidden timer removes its complete pane and does
not leave a scrollbar, gap, or lifecycle hint. Overflow content fades/softens at relevant boundaries rather than being
hard-clipped; with one fixed timer the upper action fade carries scrolling controls visually behind/beneath the timer
region.

### Background controls and status

The Standard rail presentation supports:

- momentary/background action button;
- toggle/switch with persistent on/off value;
- dropdown/select for one persistent mutually exclusive choice;
- non-interactive status/progress item.

They share a coherent outer visual family while preserving correct semantics and accessibility roles. A status item is
not styled or exposed as a disabled button. A switch exposes toggle semantics; a select exposes the appropriate
single-choice semantics. Determinate progress/fill may be shown on a status item and may also be used on an interactive
control when the explicit progress data is meaningful and does not obscure the control state.

Interactive right-rail controls remain in place while their handlers execute and expose a distinct busy state without
changing the control's committed value or implying that the control was disabled or removed. This target supersedes the
accepted V30 permanent-button disappear-while-handler-runs presentation once the controlling runtime/Standard-Library
contract is synchronized. Exact busy animation is a Phase-4 visual-tuning question; it should use a familiar
indeterminate-activity cue, must not require control reflow, and must remain distinguishable from keyboard focus and
disabled/inert presentation. Programmatic updates visibly change the same control state but must remain recognizable as
script-initiated rather than user input. They add a neutral session event to transcript history rather than a speaker
message. Additional feedback is transient and must not add permanent text to the control or change rail geometry. The
Visual Lab currently compares toast, local highlight, and toast-plus-highlight; this fixture intentionally does not
select the final transient paint treatment. Explicit removal is a separate lifecycle operation.

Ordering is stable and deterministic at the presentation level:

- controls with explicit authored priority/order appear before controls with no explicit priority;
- explicit priorities sort from lower number to higher number;
- equal explicit priorities preserve creation order;
- unprioritized controls follow in creation order.

Equal explicit priorities are valid because creation order is deterministic; when the eventual authored syntax makes
such a static conflict detectable, compiler/authoring tooling should warn rather than reject it. Exact author syntax and
runtime data representation remain upstream work. Long labels wrap rather than widening the rail.
Recorded background-control activation history follows the transcript provenance rule above.

### Vertical placement and overflow

With one timer, the control/status group targets the Player viewport centre while all items fit, yielding downward only
when the fixed timer would otherwise collide with it. A software keyboard reduces the usable space for this calculation.
Once the control/status list no longer fits, only that list scrolls and the timer remains fixed. With multiple timers,
the timer pane owns timer overflow and the action pane continues to own action overflow; compact timers use a horizontal
row so timer count does not unnecessarily consume vertical Action space.

### Right background mode

The right presentation has two independent state axes: **control geometry** (`rail` or stage overlay) and **backing
paint** (docked surface or transparent overlay). The compact toggle changes only the backing preference; it never moves
the controls, changes their vertical owner, or alters timer/control existence. Its icon represents the effective backing
state.

Automatic control geometry is constraint-driven rather than tied to a second viewport breakpoint. It considers the
complete preferred width of all currently open docked tool columns, the `190px` right-control width, and the larger of
the protected conversation minimum and useful stage minimum. If that full composition fits, controls occupy the
right-rail track from the title boundary downward. If it does not fit—or tools use the narrow drawer—the right track is
returned to the middle region and the same controls overlay the stage. This one geometry decision applies to the timer
and complete action stack; no action-specific alignment owner may move the buttons at another threshold.

- explicit backing preference remains stable while geometry changes;
- a docked backing may remain reserved even when no timer/control/status item is currently visible so later content does
  not cause geometry churn;
- removing the backing surface does not alter control geometry or state styling;
- in rail geometry with transparent backing, stage media may extend behind the floating controls while transcript and
  composer retain their readable rail reservation;
- in stage-overlay geometry, stage, transcript, foreground lane, and composer all reclaim the returned right track;
- timer and ordinary background-control surfaces keep the tuned approximately `60%` component-surface opacity in both
  backing modes, while explicitly authored action colour uses the same translucent right-rail treatment.

## Interaction states and input methods

### Neutral controls

Ordinary neutral controls use the shared progression without geometric movement:

1. default: quiet component surface with `border-subtle`;
2. hover: `border-interactive` plus component-hover fill;
3. pressed/active: `border-strong` plus component-pressed fill;
4. keyboard focus: use the shared `2px` accent-outline baseline with `1px` visible separation and no layout shift;
5. disabled: dedicated readable disabled surface/border/text roles and non-interactive semantics/cursor behavior.

A non-interactive status item is a separate semantic/visual class, not a disabled control.

### Primary and authored control colours

The primary `Send` action uses the Player/theme solid accent family. Per-control authored colour does not redefine the
Player accent; changing the global accent belongs to an explicit theme API.

For supported authored Standard controls, the developer provides only a base/fill colour. The Player derives enabled
hover/pressed states from that fill, keeps Player-owned focus/disabled treatment, and chooses readable black or white
label text; Standard control text colour is not separately author-overridable. Derived colours are presentation state,
not compiler/source semantics. The calculation is an implementation detail provided it gives the same readable result
and does not repaint unrelated Player chrome, speaker identity, or theme accent.

### Input capability and motion

- hover styling applies whenever the actual browser/input capability supports hover; do not infer it from desktop versus
  phone. A phone/tablet with a mouse or hover-capable pen may legitimately receive hover feedback;
- touch/coarse activation uses pressed/active feedback without requiring hover;
- keyboard focus remains visible through `:focus-visible`-equivalent behavior;
- actual interactive controls take precedence over viewport-wide pacing-skip gestures;
- functional motion is allowed for carousel/snap movement, drawer/rail transitions, mystery-timer indeterminate motion,
  edge fades, fullscreen auto-hide chrome, and similarly meaningful state transitions;
- `prefers-reduced-motion` reduces/removes non-essential animation while preserving understandable state changes.

## Z-order, overlays, and click-through

The maintained relative layering direction is:

1. ordinary Standard Player content;
2. floating timer/background-control surfaces;
3. tools drawer and its scrim, with the drawer above its own scrim;
4. blocking modal or custom overlay;
5. critical fullscreen/global auto-hide controls needed to leave or operate the Player.

Exact numeric `z-index` values are implementation detail. The drawer scrim intentionally intercepts outside activation.
Decorative stage/media effects are pointer-neutral. Floating right controls remain interactive even when their backing
surface is absent. A visible overlay must not create accidental click-through into covered controls.

Custom tool/stage HTML/CSS is confined to its assigned surface and cannot escape through accidental selectors or
`z-index`. A deliberate full-player takeover uses its future explicit capability rather than CSS leakage from a smaller
custom surface.

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

The palette follows the project-owned Radix-inspired twelve-step role-band convention described in the shared UI guide;
there is no Radix runtime or CSS dependency.

## Theme and customization boundary

The application palette does not own speaker/person colours, authored transcript spans, authored per-control fills,
media ambience, or technical masks. The Player/theme accent remains theme-owned; local control colour never changes it.

Standard Player theme precedence is: explicit user-selected theme, package/developer-selected default, then platform
default. A package may select a default but cannot force it against a user override.

Custom themes are standalone, light, or dark. A developer may provide one or a light/dark pair; both variants are not
required. A standalone theme is used as authored. A mode-qualified theme uses the variant matching the effective
light/dark mode; a missing variant falls back to the corresponding platform theme. Do not synthesize or auto-convert it.
Exact author-facing schema/names remain upstream API work.

Standard theming covers defined semantic colour roles, not arbitrary CSS. Geometry, fonts, spacing, DOM/chrome
ownership, and other Standard Player properties remain Player-owned unless a later explicit capability says otherwise.
Authored speaker/rich-text/control colours that carry script meaning are content semantics, not theme defaults. User
theme or accessibility preferences must preserve that meaning: for example, a story-defined red control cannot simply
be recoloured blue. Accessibility treatment may add or alter non-semantic presentation while retaining the authored
distinction. Platform dark-theme values, theme API shape, preference persistence, rich-text allowlist, exact fallback
mechanics, and numeric accessibility thresholds remain open; see [OPEN-DECISIONS.md](../OPEN-DECISIONS.md). Ordinary
transcript text does not accept unrestricted raw HTML. Fully custom HTML/CSS/TypeScript uses the separate custom
view/tool/stage capability inside the accepted sandbox.

## Accessibility invariants

Higher-authority ADR 0018 requires a programmatic accessible name for every Standard UI text field, number field, choice
group, and button. The Player preserves that requirement regardless of visible hint text or authored styling.

Additional maintained presentation invariants:

- keyboard focus is visibly distinguishable and does not rely on hover;
- touch interaction does not depend on hover state;
- drawer dismissal is available through outside activation and `Escape`;
- actual controls take precedence over viewport pacing-skip gestures;
- disabled controls remain readable and distinguishable from enabled quiet states;
- status items expose non-interactive semantics rather than disabled-button semantics;
- switches/toggles and selects expose their correct control semantics;
- tool-carousel next/previous controls and horizontal scrolling remain keyboard/pointer accessible when those controls are
  present;
- authored Standard control fills receive Player-owned readable black/white label text;
- reduced-motion preference suppresses non-essential motion without changing layout or interaction semantics.

Broader text scaling, final minimum-control sizing, custom-view accessibility responsibility, and exact numeric contrast
requirements remain controlled by accepted accessibility requirements plus unresolved decisions; do not invent a
project-wide threshold here without an accepted source.

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
