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

General reusable UI engineering and visual-design guidance lives in
[UI-DESIGN-AND-ENGINEERING.md](UI-DESIGN-AND-ENGINEERING.md). That guide informs implementation quality but does not
replace the Player-specific contract here.

## Current maturity boundary

The current Player POC is a presentation implementation, not a completed production Player. In particular:

- transcript, timer, background controls, tools, and stage/media currently still consume demo presentation data;
- the composer shell exists but runtime interaction wiring is incomplete;
- Standard foreground controls are not yet wired end to end in the demo Player;
- host/iframe messaging, production checkpoint transport, restore/reconnect, and package capability negotiation remain
  outside this presentation specification;
- exact final values marked below for visual retesting remain POC tuning baselines rather than frozen production values;
- `Visual Lab` and `Scene`, placeholder avatar letters, demo action labels, and random local demo media are development
  fixtures rather than Standard Player product content. `Visual Lab` may remain during the POC for live tuning, but must
  be removed or separated from production Player content before production maturity.

A current implementation detail is not a durable requirement merely because it exists. Owner-confirmed behavior in this
specification is the target even when implementation lags, subject to a higher-authority conflict being surfaced rather
than silently resolved.

## Upstream contract integration

This is a temporary integration checklist for Owner-decided Player behavior whose corresponding runtime, Standard
Library, persistence, or custom-view contract has not yet been fully synchronized. It is intentionally not a second
permanent authority layer. `README-FIRST.md` and `docs/README.md` route Player work here while this section is non-empty.
Remove each item when its controlling upstream source adopts it; remove this entire section and those router references
when no items remain.

Current items:

- **Custom presentation freedom:** later package UI may use a Player-owned custom tool body, replace the central stage,
  add a floating overlay, add a blocking modal, or temporarily take over the complete Player presentation and later
  return to the same Standard Player state. Full-player takeover and browser fullscreen are separate capabilities and may
  coexist. All such UI remains inside the accepted sandboxed Player iframe and does not gain parent DOM, host cookies,
  or unrestricted external-network access.
- **Custom-view recoverability:** arbitrary custom HTML/CSS/TypeScript is not required to be checkpoint-restorable.
  Future runtime/persistence design needs a recovery/resume frontier: the latest point from which the complete experience
  is guaranteed reconstructible. A crash during a non-restorable custom view may roll back to that frontier rather than
  pretending the custom DOM/JavaScript state can be proven or serialized automatically.
- **Time continuity across unavailability:** Standard session time is continuous rather than implicit active-playtime.
  When the Player was unavailable, logical script execution may not skip past the first script event that should have
  executed during that absence; later runtime work must implement the owner-selected missed-event barrier without
  replaying events already materialized in a valid checkpoint. Exact checkpoint/deadline mechanics remain upstream work.
- **Durable effects beyond a recovery frontier:** server-side effects must not depend on a package claim that arbitrary
  custom UI is reconstructible. Future contracts need durable effect IDs and ownership/release authority; where practical,
  checkpoint/recovery state and an external effect should commit durably together. Effects that must be live during a
  non-restorable view need a reservation/lease then commit/rollback model rather than relying on browser liveness or TTL
  alone. Exact server/runtime APIs remain upstream work.
- **Background-control family:** the right-rail presentation below covers momentary actions, toggles/switches,
  single-choice selects, and non-interactive status/progress items. Accepted V30 permanent-button behavior remains the
  current button semantic baseline; exact Standard-Library binding, persistence, update, and handler APIs remain
  upstream work.
- **Busy background controls:** accepted V30 disappear-while-handler-runs behavior remains available. A later control
  contract must also allow a control to remain in place as disabled/busy while its handler runs; explicit removal is a
  separate lifecycle action. Exact syntax/default remains upstream work.
- **Background ordering and progress:** authored controls may provide an explicit order/priority; controls with explicit
  priority sort before controls without one, equal priorities preserve creation order, and unprioritized controls follow
  in creation order. If a statically authored API later allows equal explicit priorities, authoring/compiler tooling
  should warn rather than fail because creation order already provides a deterministic tie-breaker. Status and
  interactive controls may present explicit determinate progress/fill. Exact data shapes and lifecycle semantics remain
  upstream work.
- **Transcript/history provenance:** foreground and background control activations need machine-readable provenance so
  history/LLM consumers can distinguish typed prose from button/choice/control activation without relying on visual
  punctuation. A future visible-transcript reset starts a new visible segment without implicitly destroying retained
  canonical history; exact history retention and LLM-context policy remain upstream work.
- **Timer presentation metadata:** visible, mystery, and hidden timer presentation must work for blocking and non-blocking
  timer semantics without revealing whether a visible timer blocks script execution. The accepted V30 `timer`,
  `mysteryTimer`, `wait`, and background-timer semantics remain the language baseline; final public background-timer
  presentation metadata is still upstream work.

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
| width `>= 761px` | wide-composition baseline | Side regions may reserve space. Automatic tools are open and the automatic right backing rail is docked when constraints permit. |
| width `<= 760px` | narrow-composition baseline | Left tools become an overlay drawer. Right-side presentation uses overlay/reservation rules that protect readable content rather than a device label. |
| width `<= 480px` | compact review target | Re-audit selected control geometry. If compact values remain, use deliberate discrete values rather than continuous viewport-driven shrinking. Do not shrink arbitrary tool content. |
| low usable height or fullscreen | **overlay chrome mode** | Ordinary title chrome auto-hides/overlays so stage height is not consumed unnecessarily; required tools/fullscreen-exit/global controls remain reachable. |

The old term `low-height mode` is therefore replaced by **overlay chrome mode**. Low available height and actual
fullscreen may activate the same chrome presentation rather than maintaining two unrelated implementations. Fullscreen
is an actual Player/browser fullscreen state; it is separate from a future package full-player takeover.

Use available dimensions rather than device classes. Portrait/landscape or aspect ratio may be used as an optimization
signal when both axes are constrained: a tall shape can spend relatively more vertical space to preserve horizontal
content, while a wide/short shape can preserve vertical control extent because horizontal reading room is more abundant.
A narrow tall desktop window and a similarly shaped phone should therefore converge on the same layout reasoning.
Foldables likewise use their currently available dimensions rather than a special device category.

Manual panel choices are temporary overrides **within the current wide/narrow composition class**. Resizing inside the
same class preserves that explicit choice. Crossing between wide and narrow re-evaluates the responsive default instead
of carrying a stale override into a materially different composition. A future persistent user preference may refine
this policy separately.

The Player must size against the currently usable visual viewport when a software keyboard or similar browser UI reduces
available space.

## Global geometry and overflow

The Player shell itself does not normally scroll. Scrolling belongs to the specific region that owns the overflowing
content. Major numerical values below are POC reconstruction/tuning baselines unless explicitly marked otherwise.

| Item | POC baseline / intended rule |
| --- | --- |
| Player viewport | full viewport width and `100dvh`; outer document is not the normal scroll owner |
| normal title bar | `52px` plus top safe-area inset; visually retestable |
| normal stage row | current `62dvh` baseline; expose as a development tuning value and visually re-evaluate |
| overlay-chrome stage row | current `64dvh` baseline; visually re-evaluate with low-height and fullscreen cases |
| tool column | move to one fixed default POC width rather than viewport-proportional `clamp()` sizing; use the current `250px` clamp maximum as the initial Visual Lab test value, not a frozen final width |
| readable conversation maximum | current `900px` baseline; keep a cap for ultrawide readability and visually retest, including browser zoom |
| protected conversation minimum | current `380px` baseline; remeasure after tool-width/right-rail simplification |
| normal conversation side gap | current `18px` baseline before safe-area contribution |
| narrow tools drawer | current `min(300px, 100vw - 120px)` baseline, preserving an outside dismissal area |

Keeping the stage roughly square when practical is a design goal, not a hard 1:1 layout invariant. The goal exists so
both portrait and landscape media remain useful. Side panels should not casually crush the stage into a narrow strip,
but a rigid 1:1 rule must not cause surprising responsive transitions. Final dock/overlay decisions should use the full
set of layout constraints.

Safe-area insets affect Player chrome and controls. Stage/media remains allowed to occupy its complete visual region
rather than receiving identical safe-area padding by default.

Scrolling ownership:

- transcript: vertical conversation scrolling;
- tool-column strip: horizontal carousel/scrolling;
- each tool body: its own vertical scrolling;
- right background-control/status stack: vertical scrolling when needed;
- composer input: internal vertical scrolling after its constraint-based growth limit;
- Player shell: no normal scrolling.

Input axes remain predictable. Vertical wheel input stays vertical and horizontal wheel input stays horizontal; reaching
an edge on one axis must not silently repurpose that input to the other axis. Nested content should not create a second
scrollbar for the same axis/responsibility.

### Typography and visible control geometry

PR #318 preserves the current typography and most component geometry as the provisional visual baseline. Values marked
for tuning may change through `Visual Lab` before production without implying a compatibility promise.

| Element | Current Player baseline |
| --- | --- |
| UI font stack | `"Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| title | `14px`, weight `700` |
| speaker name | `9px`, weight `700`, line-height `1.2` |
| speaker message | `12px`, line-height `1.25`; authored speaker font may replace the UI font |
| player-authored message | `13px`; otherwise follows transcript message rhythm |
| normal composer text / Send | `11px`; Send weight `700` |
| narrow composer text | `10px`; Send remains `11px` |
| normal timer | `18px`, weight `700`, tabular numerals |
| compact timer | current smaller timer values remain a visual-tuning baseline rather than a final `<= 480px` contract |
| background control label | `12px`, weight `600`, line-height `1.2` |
| global icon control | `34px` square, `6px` corner radius |
| tool column | one fixed POC width; `250px` is the initial tuning value; column radius `8px` |
| tool-column header | minimum `44px` high; selector/add/close controls are `30px` high; add/close are `30px` square; controls use `6px` radius |
| wide integrated composer shell | minimum `50px` high, `8px` corner radius; input minimum `38px`; Send `38px` high with `7px` radius |
| narrow composer controls | input and Send `42px` minimum/high respectively, each `7px` radius |
| right background control | current maximum `156px` wide and `6px` radius remain the POC baseline; final sizing is visually reviewable |

Tool-column header and body use one continuous `surface-component` background. The header separator does not introduce
a second chrome-colour band; selector/add/close controls provide the header's raised hierarchy.

The shared UI guide adopts the current `1px` border, moderate-radius, visible-focus, and interaction-state
vocabulary as a shared starting baseline. Player-specific widths, heights, spacing, and tuned focus thickness remain
owned here rather than becoming universal dimensions.

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
current responsive default and thereafter toggles explicit state. Explicit state is preserved while the Player remains
in the same wide/narrow composition class; crossing that composition boundary re-evaluates the automatic policy.

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
second carousel state model. A gesture that became a pan/scroll must not accidentally fire a child button click.

### Wide sizing direction

Tool growth must protect useful primary content, but a hard 1:1 stage boundary is not the layout algorithm. Use the full
constraint set: stage usefulness, readable conversation width, right-side reservation, available height, and the fixed
POC tool width. The current `900px`, `380px`, and stage-shape values remain visual/tuning inputs rather than hidden
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
- keeps an ultrawide readability cap, with the current `900px` value pending visual retuning;
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
Its exact threshold and placement remain visual tuning details; it must not permanently occupy reading space.

### Message presentation and provenance

Speaker/package output aligns to the normal reading side; player-authored output aligns to the opposite side. The
current avatar, speaker-name, speaker-coloured rule, and message-width geometry remain the POC visual baseline. Speaker
identity colour/font and per-message rich-text styling are content presentation, not application palette roles.

ADR 0018 owns canonical transcript effects of foreground completion: valid text/number answers and choice/button
activations become player-authored transcript messages according to its normalization and visible-text rules. Background
activation history remains an upstream runtime contract; when recorded, the Player uses the same player-authored action
presentation and preserves machine-readable activation provenance. Visual markers must not become canonical punctuation;
their exact appearance remains tuning work.

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
and the composer may never grow larger than the conversation area available beneath the stage.

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
the available conversation control area, has a practical touch/click minimum, and otherwise grows with its label rather
than becoming arbitrarily full-width. Long labels may wrap. `choose` uses one or two rows of buttons when practical and
dynamically switches to a dropdown/select when option count, label length, font metrics, zoom, accessibility settings, or
available space make buttons impractical. Button-versus-dropdown presentation is Player UI state, not canonical runtime
or checkpoint state.

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
3. **hidden timer** — no timer UI at all. Accepted blocking `wait` is the simple hidden blocking case; future
   non-blocking timers may likewise request hidden presentation.

A visible blocking timer and a visible non-blocking timer use the same visual vocabulary. Presentation must not reveal
whether script execution is blocked. Multiple visible timers may coexist: only one blocking timer can own the foreground
path at once, but background timers may add further visible timers.

Normal timer text is:

- below one hour: `m:ss`;
- one hour or more: `h:mm:ss`.

The determinate ring represents elapsed fraction. The current circular size and package/theme accent treatment remain the
POC visual baseline. In overlay chrome mode the timer may use the current compact title-height presentation; exact compact
size remains visually tuneable. A timer disappears when its underlying visible timer action/lifecycle has completed and
no longer requires presentation.

When exactly one visible timer exists, it stays fixed while the background-control/status list scrolls beneath it. When
multiple visible timers exist, they form part of the right-side stack and may scroll together with that stack when the
available height is insufficient. Overflow content fades/softens at both top and bottom boundaries rather than being
hard-clipped; with one fixed timer the upper fade carries scrolling controls visually behind/beneath the timer region.

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

For accepted V30 permanent buttons, disappearing while the handler executes remains the current semantic baseline. A
future upstream option also permits the control to remain visible but disabled/busy while its handler executes. In both
cases explicit removal is a separate lifecycle operation.

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

With one timer, the control/status group is vertically centered in the **currently usable space that remains around the
fixed timer** while all items fit. A software keyboard therefore reduces the space used for this calculation. Once the
list no longer fits, only that list scrolls and the timer remains fixed. With multiple timers, the timers join the
scrollable stack when required as described above.

### Right background mode

The right backing region has automatic docked/overlay behavior plus an explicit user override. The compact toggle changes
only the **rail background/reservation mode**, not whether timers or controls exist. Its icon should change to represent
the effective expanded/docked versus collapsed/overlay state rather than using one unchanged glyph.

- automatic mode uses the current wide/narrow responsive policy subject to actual layout constraints;
- explicit mode is stable inside the current wide/narrow composition class;
- crossing that composition boundary re-evaluates the responsive policy;
- a docked/open backing reservation remains stable even when no timer/control/status item is currently visible so later
  content does not recenter the transcript or stage;
- removing the rail background does not alter timer/control geometry or state styling;
- timer and ordinary background-control surfaces keep the already tuned approximately `60%` component-surface opacity in
  both docked and overlay backing modes. Sliding the backing surface underneath them must not change their opacity.

On wide layouts an overlay backing may retain the same right-side reservation so transcript/composer geometry does not
recenter while stage media extends behind floating controls. On narrow layouts the final overlay/reservation split is
constraint-driven; protect readable transcript/composer content rather than assuming a physical device category.

## Interaction states and input methods

### Neutral controls

Ordinary neutral controls use the shared progression without geometric movement:

1. default: quiet component surface with `border-subtle`;
2. hover: `border-interactive` plus component-hover fill;
3. pressed/active: `border-strong` plus component-pressed fill;
4. keyboard focus: visible accent outline with separation and no layout shift; the current `2px` thickness is a Visual
   Lab tuning value and may be reduced after owner testing;
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
Authored speaker/rich-text identity colours remain content styling. An explicit user accessibility/readability override
takes precedence. Platform dark-theme values, theme API shape, preference persistence, rich-text allowlist, and numeric
accessibility thresholds remain open; see [OPEN-DECISIONS.md](../OPEN-DECISIONS.md). Ordinary transcript text does not
accept unrestricted raw HTML. Fully custom HTML/CSS/TypeScript uses the separate custom view/tool/stage capability
inside the accepted sandbox.

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
