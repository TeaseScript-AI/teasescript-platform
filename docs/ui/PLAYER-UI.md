# Standard Player UI specification

- **Status:** Provisional maintained normative specification for the intended Standard Player presentation.
- **Purpose:** Define the intended Standard Player presentation built on the Vue Player: observable layout,
  responsive behavior, interaction presentation, and visual states, independently of the current HTML/CSS/JavaScript
  implementation.
- **Authority:** Accepted ADRs and accepted specifications remain higher authority for the exact architecture, runtime,
  language, isolation, and persistence scope they decide. The temporary [Upstream contract integration](#upstream-contract-integration)
  section below records Owner-decided Player behavior that still needs synchronization into those upstream contracts.
- **Implementation state:** The Player is the Vue implementation under `player/vue/src/`. Its implemented
  transcript, foreground interaction, pacing, runtime timer, Stage image, and audio paths use the shared runtime
  adapter. Browser video playback, production host integration, and several provisional presentation values remain
  incomplete.

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

Player verification follows [`TESTING.md`](../TESTING.md), including its local browser and scoped visual-check route.
ADR 0001 fixes the responsive PWA direction; exact offline, storage, cache, and update lifecycle choices remain in
[`OPEN-DECISIONS.md`](../OPEN-DECISIONS.md) rather than being duplicated here.

## Current maturity boundary

Current implementation status belongs in [`PHASE-STATUS.md`](../../PHASE-STATUS.md);
[`player/README.md`](../../player/README.md) records implementation seams and development-only behavior. This
specification may lead the implementation. The Player presents supported transcript, foreground interaction, and
pacing behavior from canonical runtime state. Its development preview opens one runtime choice scenario and adds Visual
Lab, Layout Debug, the Stage media picker, Theme Lab, and timer/background-button presentation fixtures. The default
build plays the repository demo without that preview; the development server or explicit `?dev` URL opt-in loads it.
Runtime timers, the Stage image, and audio are wired; browser video playback and production host integration remain
separate work. Values marked for retesting remain provisional tuning baselines.

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
  optional labeling. Authored timers carry visible/mystery/hidden display and optional labels (see
  [`RUNTIME.md`](../RUNTIME.md#timers-and-scene-time)); `player/runtime-adapter.ts` derives presented timers and
  observation deadlines from runtime state. The Player renders runtime timers in its right rail; its
  development preview shows timer fixtures only while no runtime timer is presented. Stable generic-label numbering across timer lifecycle changes remains unsynchronized.

## Surface hierarchy

The Standard Player fills the available Player viewport and uses the following normal presentation regions. A region
may reserve space, overlay another region, or temporarily hide according to the responsive and custom-presentation
rules, but changing a backing surface must not implicitly delete unrelated controls.

```text
+-----------------------------------------------------------------------+
| tools menu / panels | Stage                                            |
|                     | top title / global controls overlay             |
|                     | timer / background-control overlay at the right |
|                     +-------------------------------------------------+
|                     | transcript, including foreground controls       |
|                     | composer overlay at the bottom                  |
+---------------------+-------------------------------------------------+
```

`stage` is the structural name. Standard image/video/media presentation is one kind of stage content; later canvas,
custom HTML, games, and other accepted custom presentation may use the same structural region without forcing the
surrounding Player geometry to change.

### Visual hierarchy

- **Canvas surface:** the continuous Player background, including stage and conversation ambience.
- **Chrome surface:** the tools menu and opaque tools drawer.
- **Component surface:** tool panels, composer, and ordinary Standard controls.
- **Media-control surface:** translucent title/global controls and timer material over the stage.
- **Stage surface:** the structural primary-content region; media may use its available rectangle.
- **Content identity:** speaker, authored control, theme, and media-derived colours remain distinct from unrelated
  application chrome roles.

The tools framework sits beside the primary stage/conversation composition on comfortable layouts and becomes an
overlay drawer when constrained. Title/global controls and the timer/background rail overlay the stage. Foreground
controls belong to the transcript scroll surface; the composer overlays its bottom. The stage and transcript remain
present even when empty.

## Player conditions

The Player combines independent conditions rather than choosing a phone, tablet, or desktop mode. The Player exposes
them on its shell; [`usePlayerConditions.ts`](../../player/vue/src/usePlayerConditions.ts) owns their
shared browser signals. Add a responsive rule to the condition that describes its actual constraint; do not infer device
identity or add a separate width breakpoint for touch or rounded corners.

| Condition | Signal | Current behavior |
| --- | --- | --- |
| Horizontal space | Usable visual-viewport width compared with the greater of `900px` and the complete minimum dock composition, including the chosen menu width | The tool owner switches between a dock and an overlay drawer. A narrow desktop window can use the drawer; wider menu labels may require more than `900px`. |
| Vertical space | Usable visual-viewport height; `<= 700px` is the current compact baseline | Timers use compact presentation when either the horizontal or vertical condition is constrained. Fullscreen is a separate state. |
| Touch and hover | `any-pointer: coarse` and `any-hover: hover`, independently; each pointer event still identifies the pointer actually used | Touch taps, mouse hover, and keyboard focus retain their distinct menu behavior, including on hybrid devices. Primary coarse input without hover identifies the fallback corner-clearance case. |
| Raised software keyboard | Composer input focused while the visual viewport shrinks by more than the current `120px` detection allowance on a touch-capable browser | The composer uses the normal reading width above the keyboard; Send keeps the existing focus behavior. |
| Composer edge clearance | Browser safe-area inset; when it reports zero, a touch-first viewport spans the screen width and the composer is at the bottom near its sides | Only the composer receives up to `32px` side clearance. A narrow browser window on a touchscreen laptop keeps the normal composer width. This does not change the transcript, tool layout, or bottom spacing. |
| Fullscreen top clearance | Browser top safe-area inset; in fullscreen, a touch-first viewport reaching the display edge also needs a minimum when the browser reports zero at a camera cutout | The Player shell begins its usable rectangle below that clearance. Media, title controls, tools, transcript, and composer all stay inside it. The canvas background continues behind the clearance. Normal presentation uses the browser-reported inset. |

These conditions can overlap. For example, a tablet in split screen can have constrained horizontal space, touch
input, and a raised keyboard at the same time. Fullscreen is a Player/browser state, separate from a future package
full-player takeover.

Use available dimensions rather than device classes. Portrait/landscape or aspect ratio may be used as an optimization
signal when both axes are constrained: a tall shape can spend relatively more vertical space to preserve horizontal
content, while a wide/short shape can preserve vertical control extent because horizontal reading room is more abundant.
A narrow tall desktop window and a similarly shaped phone should therefore converge on the same layout reasoning.
Foldables likewise use their currently available dimensions rather than a special device category.

Manual open/closed tool intent is preserved across resizing and rotation when the tool region owns focus or remains the
active interaction context. A responsive change must not spontaneously open a previously closed drawer. When an open
docked strip becomes an overlay drawer while focus is elsewhere, it may close so that it does not unexpectedly block the
active Player region. A future persistent user preference may refine this session-local policy separately.

The Player must size against the currently usable visual viewport when a software keyboard or similar browser UI reduces
available space.

## Global geometry and overflow

The Player shell itself does not normally scroll. Scrolling belongs to the specific region that owns the overflowing
content. Major numerical values below are POC reconstruction/tuning baselines unless explicitly marked otherwise.

| Item | POC baseline / intended rule |
| --- | --- |
| Player viewport | full viewport width and currently usable visual-viewport height; `100dvh` is the CSS baseline and the outer document is not the normal scroll owner |
| Player chrome outer spacing | fixed `8px` for top controls, menu edges and right rail; independent of root font size |
| Player chrome control size | compact controls use `calc(1rem + 16px)`; top controls share a size derived from icon/text size and padding |
| top-control overlay | shared control size plus `8px` outer spacing above and below; it does not reserve a separate title row in the stage/conversation split |
| content below top controls | one 16px visible gap from the controls' lower edge to the first tool-menu control or timer; no separate outer timer-halo space is reserved |
| stage/conversation allocation | user-adjustable split, currently starting at 60% stage / 40% conversation; the starting ratio and panel minimums remain provisional. See [Stage and media presentation](#stage-and-media-presentation) |
| tool panel | independent width presets, currently `14rem`, `18rem`, `24rem`, and `32rem`, with `18rem` as the default; available dock/drawer space may cap the rendered width. These values remain provisional |
| readable conversation maximum | current `880px` reading width inside a `896px` outer column; keep a cap for ultrawide readability and visually retest, including browser zoom |
| protected primary content | the current fit calculation protects a `380px` conversation baseline plus surrounding chrome/gutters; remeasure with the complete dock composition |
| normal conversation side gap | current `8px` on each side of the reading width; the narrow composer has separate edge clearance |
| constrained tools drawer | shows the menu or one active tool; the active tool's selected width is capped at `90%` of usable viewport width. Its saved wide-layout width is preserved |

Keeping the stage roughly square when practical is a design goal, not a hard 1:1 layout invariant. The goal exists so
both portrait and landscape media remain useful. Side panels should not casually crush the stage into a narrow strip,
but a rigid 1:1 rule must not cause surprising responsive transitions. Final dock/overlay decisions should use the full
set of layout constraints.

Current dynamic safe-area insets reported by the browser affect Player chrome and controls. The bottom composer has the
limited touch-first side-clearance fallback described above because browsers can report zero beside rounded corners;
viewport width comparisons tolerate small browser rounding and scrollbar differences. The whole Player viewport has a
scoped touch-first top minimum in fullscreen when a browser reports zero despite drawing through a camera cutout. Do not
infer a device model or apply that fallback to a narrow desktop window, including one with touch input. A maximized
touch-first rectangular screen can still qualify because the web platform cannot report its corner shape. Stage/media
remains allowed to occupy its complete visual region rather than receiving identical safe-area padding by default.
Development-only Visual Lab controls live in the development preview. Their fixture content and provisional
presentation values do not redefine this specification. The shared `2px` focus outline remains the accepted Player
baseline rather than a tuning control.

Scrolling ownership:

- transcript: vertical conversation scrolling, with one native browser scroll owner across the reading column, both
  margins and its overlay thumb, so wheel units and motion match everywhere in the conversation region;
- tool-panel strip: horizontal scrolling in the dock when the open panels exceed its allocation;
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
The reading size is shared by transcript bubbles, loose prose, and composer input. Headings scale relative to that size,
and authored `[size]` spans scale relative to their containing text, including inside headings. Changing the reading
size therefore scales ordinary text, headings, and authored size spans together without changing Player chrome text.

| Element | Current Player baseline |
| --- | --- |
| UI font stack | system stack `ui-sans-serif, system-ui, sans-serif`; the POC bundles no UI web font |
| title | `14px`, weight `500` |
| speaker name | current bubble attribution uses `0.75rem`, weight `500`; this remains a visual baseline |
| speaker message and loose prose | shared reading size `1rem` (16px at the current browser base), line-height `1em + 8px`; authored speaker font may replace the UI font |
| player-authored message | shared reading size, following the same transcript rhythm |
| normal composer text / Send | composer uses the shared reading size; Send remains `14px`, weight `700` |
| narrow composer text | composer keeps the shared reading size; Send remains `14px` |
| timer time/value | tabular numerals; size follows timer diameter, with smaller text for visible times of one hour or more. Mystery typography does not expose duration; exact type proportions remain provisional |
| Player action button label | `0.875rem` (14px at the current browser base), weight `600`, line-height `1.3` |
| global controls | shared derived top-control size and rounding; the title is a truncating pill and display controls share a translucent group |
| tool panel | per-tool width presets capped by available allocation; see the global geometry table |
| tool-panel header | shared chrome spacing/control sizes; a title, reordering grip, Panel settings, and pin control. Panel settings uses a compact trigger when its full label does not fit |
| integrated composer shell (POC tuning candidate) | `42px` high for one line at the current reading size, `24px` corner radius, `2px` vertical padding, and `8px`/`4px` start/end padding |
| composer input / Send (POC tuning candidate) | `36px` minimum height at the current reading size; input has `6px` vertical padding and grows upward for longer text; Send keeps its full button bounds while its fill is inset `2px` vertically |
| right background control | wraps inside the current stage-rail allocation and uses the shared Player action-button material; exact rail sizing remains provisional |

Tool-panel header and body share one component surface. The header separator and shared controls provide hierarchy
without adding a second chrome-colour band.

The shared UI guide adopts the current `1px` border, moderate-radius, visible-focus, and interaction-state
vocabulary as a shared starting baseline. Player-specific widths, heights, and spacing remain owned here rather than
becoming universal dimensions.

## Title and global panel controls

The Player's top controls overlay the stage without reserving a separate title row. The surrounding bar is transparent;
the title pill and individual control groups use shared translucent media-control material. The title truncates when
space is constrained; a bar narrower than `200px` hides the title visually while keeping it for assistive technology.
Display controls include the light/dark toggle and the rightmost fullscreen control. Tools access
appears in the top controls when the sidebar is hidden and in the tools framework while it is open.

The embedding caller supplies the title. The final host/package title-source contract remains open.

The same top-control overlay serves normal and fullscreen presentation. On short screens outside fullscreen, the
title-bar A/B setting chooses the presentation:

- **A · Always visible, controls left** (default): the bar stays visible and its controls move left of the timer rail;
- **B · Auto-hide, controls right**: the bar hides and reveals on mouse entry, a tap on unused bar space, or keyboard
  focus, then hides again 3 seconds after the pointer and focus leave. Hidden controls do not take pointer input;
  reduced motion removes the fade.

Tools access, fullscreen exit, and other critical global controls must remain discoverable and reachable in both
variants. Timing and exact reveal zones remain tuning details.

## Player Settings

The settings control at the bottom of the tools menu opens Player Settings: user preferences for the Player interface,
available in every build to every user. It currently offers:

- **Menu Sidebar labels:** icons only, icons with a temporary label preview, or icons with labels;
- **Contrast:** Standard or High, an accessibility preference that strengthens theme contrast and authored-colour
  treatment and is kept when switching light/dark;
- **Title bar on short screens · A/B test:** variant A or B above.

These are presentation preferences, not canonical runtime state. The Player keeps them in this browser's local storage
across reloads, treats stored text as external input that falls back to the default when unknown, and works without
storage when the host frame denies it. Account settings may later take over or synchronize them.

When the host persists script storage, Player Settings also contains a **Saved script data** section. Its **Clear saved
script data** control removes, after a confirmation, only the values the current script saved for later runs; Player
Settings, checkpoints, account data, and other scripts are unaffected, and the next new session starts without them. It
is available before Start and after the session has ended, but not while a session runs or waits for Continue, because
a running session keeps its own view of the saved values, and not when this browser's storage could not be read.

## Left tools area

The Standard Player owns the tools menu, sidebar visibility, temporary/pinned panels, shared headers, panel order and
width, horizontal dock overflow, and responsive drawer composition. A tool owns its body content.

### Panel state

The tools sidebar starts visible on comfortable layouts and closed when constrained. The toggle and `Ctrl/Meta+B` change
its visibility; the shortcut is ignored while focus is in the composer or another text-editing control.
Resizing does not spontaneously reopen a closed sidebar. An open dock becoming a drawer stays open only when tools own
the active focus, drag, or resize context; otherwise it closes to avoid covering the Player unexpectedly.

Closing keeps the sidebar contents visible until its slide-out motion ends; reduced motion removes the slide and
reopening cancels the pending cleanup. A closed sidebar is inert, open Player Settings or panel-settings popups close
with it, and focus that was inside it returns to the visible sidebar toggle. Sidebar, splitter and reorder-grip hints
use the shared tooltip after a `700ms` hover delay; keyboard focus shows the tooltip immediately, a mouse click does
not leave a focus tooltip behind, and `Escape` still closes a narrow drawer while a tooltip is open.

An open dock reserves horizontal space. A constrained layout presents an opaque tools drawer over the Player without
shrinking the stage or conversation.

### Narrow drawer behavior

The narrow drawer:

- shows the tools menu or one active tool, using the constrained-width baseline in the geometry table;
- remains opaque so stage/transcript content does not bleed through;
- leaves a visible outside area covered by a scrim;
- intercepts outside pointer input so activation does not pass through to underlying Player controls;
- closes when the scrim is activated;
- closes on `Escape` and returns keyboard focus to the tools toggle;
- remains below critical/global chrome in z-order.

### Tool panels and lifecycle

Tools open from the Player-owned menu. The dock can contain pinned panels and one temporary panel. Opening another
temporary tool replaces the previous temporary panel in its visual position. Pinning retains a panel when other tools
are selected; unpinning makes it the temporary panel. Pin state and visual order are independent.

Each tool has at most one panel instance. No tool is selected automatically merely because the menu exists, and closing
all panels leaves the menu available. Selecting an open tool can close its panel; double-clicking its menu entry toggles
pinning. The header provides the title, Panel settings, pin control, and reordering grip. Panel settings offers width
presets and Move left/right; pointer/touch dragging provides another way to reorder panels.

A tool mounts when first visited and retains its body state and scroll position until the Player unmounts. Closing,
replacing, hiding, reordering, or moving it between dock and drawer does not reset that retained body. This does not
define reload persistence or alter canonical runtime/tool data.

The menu may expose platform and custom tools. Display names identify tools; icons may accompany them. A tool cannot
replace or restyle the shared menu/header controls. Global theme APIs remain separate from tool-body ownership.

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

The active tool body occupies the remaining panel height and owns vertical overflow. Its title is not repeated as a body
heading merely because it already appears in the shared header. A fully custom tool body is confined to its assigned
surface; Shadow DOM remains the preferred isolation candidate when custom CSS/DOM is allowed. Custom-body isolation
is not yet implemented in the Player.

Open docked panels share one horizontal scroll surface when they exceed the dock allocation; each body keeps its own
vertical scrolling. Native pointer/trackpad/touch and keyboard scrolling remain available. Proximity snapping helps
settle panel boundaries without creating a second carousel state model. Snapping is suspended while reordering or
resizing. In the constrained drawer, the menu and active-tool views replace multi-panel horizontal browsing.

A gesture that becomes a pan/scroll must not also activate a child control. Panel movement has a keyboard/non-drag
alternative through Panel settings.

Compact explanatory copy for Visual Lab-style options may be plain visible text or a disclosure. A disclosure reveals
its text on pointer hover and keyboard focus, toggles it on tap/click, keeps a visible information button as the touch
and keyboard affordance, latches at most one disclosure open, and closes it on outside activation or `Escape`. Neither
pattern is required for the POC or for custom tools.

### Wide sizing direction

The dock protects useful primary content before allocating additional panel space. The menu width and minimum complete
dock composition determine whether the tools framework uses a dock or drawer. Extra open panels scroll inside the dock;
individual panels are capped by available allocation while retaining their chosen width preset. Conversation bounds and
the stage-shape goal remain provisional visual inputs, not additional device modes.

`Visual Lab` and `Layout Debug` are development-preview tools, not Standard Player product tools. A real
platform Debugger remains future work described in [DEBUGGER.md](../DEBUGGER.md).

## Session start and user activation

The Player does not run a script on page load. Before the first runtime entry of a new session, it shows an explicit
Start control; after a page load that restores an existing session, it shows an explicit Continue control before
execution resumes. The player's activation of that control is the user activation that later audible media playback
relies on, so scripts may play audio from their first statement without a separate unlock step.

If the browser still refuses required audible playback, the Player surfaces a deliberate activation/retry control. It
does not silently substitute muted playback or report the audio as played: refused audio reports no progress, so its
cues and settlement wait, and an **Enable audio** [player notice](#player-notices) retries playback from the user's
click. In the Player the
session is created only when Start is activated; the Continue path applies to a session the host restores. Durable
checkpoint storage and automatic resume across page reloads are tracked in #469.

## Player notices

Player notices tell the player that something about the session's environment matters, such as blocked audio,
unavailable storage, or a camera problem. They never stop the session and are separate from runtime developer warnings,
which are creator diagnostics about a script location. Host features publish them through one Player-owned channel
(`player/notices.ts`) with fixed Player wording per condition; a condition has one notice, which it replaces or
withdraws, so repeated causes do not stack.

Notices belong to the Player, not the story, so they never appear in the conversation. A new or replaced notice shows
as a temporary toast below the Player's top controls, right-aligned and left of the timer rail when timers occupy the
top right; on a screen too narrow for that, the toast keeps a readable width and may cover the timer. Each toast names
the Player as its source and shows a level icon (info, warning, or error), its text, at most one action control that
runs from the player's click (such as **Enable audio**), and a hide control. At most three toasts show, newest first.
Info toasts expire after 5 seconds, warnings after 8, and errors after 10; pointer or focus on a toast pauses expiry.
Hiding or expiry removes only the toast.

The notification bell in the top controls opens the notification panel, which lists every current notice, newest
first, with its age, its action, and a dismiss control; **Clear all** dismisses every dismissible notice. A dot on the
bell marks notices published since the panel was last opened and any notice the player must act on. Opening the panel
marks the notices seen and replaces the toasts. Dismissal moves focus to the nearest remaining control in the panel. A
notice whose action is the only way to continue, such as **Enable audio** while the script waits for that audio, is
tagged **Needs action**, offers no dismiss control, and disappears once its condition resolves. Separate status and
alert live regions announce the messages; both exist before any notice, so the first notice is announced too, and
errors use the alert region.

The current conditions are blocked audio (warning, with **Enable audio**), browser storage unavailable at session start
(info: saved progress is not kept), and a failed script-storage write (warning, for the run it happened in; a new
Start withdraws it). Each level also has a theme status colour, following the usual convention: info blue, warning
orange, error red. A toast uses the level's soft tint as its surface and its solid tone for the border and icon; a
panel entry uses the same tint with a solid mark along its start edge and a solid icon; and the bell's dot takes the
most severe level that needs attention. The development
preview's Visual Lab shows every level.

## Stage and media presentation

The stage is a dedicated structural surface above the transcript in the main content column and remains present even
when no media is active. An empty stage shows its normal background/ambience rather than collapsing and expanding the
transcript into that space.

The Player currently starts with a 60% stage / 40% conversation split. A keyboard-accessible horizontal handle lets the
user adjust the division; only its compact centered grip starts a drag. The composer grows inside the conversation
allocation. The chosen split survives viewport resizing for the current mount. The starting ratio and 20% minimum per
panel remain provisional visual baselines.

The Stage shows the persistent Stage image set by `showImage`, or its empty look after `hideImage`. An active Stage
video temporarily occupies the Stage over that image; when the video ends or is stopped, the image is visible again
([§22](../specifications/accepted-syntaxes-v30.md#22-stage-image-audio-and-video)). Presentation follows canonical
runtime Stage and media state; browser media callbacks are observations reported to the runtime, not settlement.

Media playback is script-controlled. Audio and video elements show no native browser controls, and the Player offers
no seek, scrub, pause, or skip control of its own: playback the runtime did not command would make reported progress
disagree with the canonical timeline. A progress indicator may extrapolate between reports for display only. Whether
users may ever control playback is open; if accepted, such controls send typed host input to the runtime rather than
acting on the media element ([`RUNTIME.md`](../RUNTIME.md#stage-image-and-media-playback)).

The trusted host resolves authored package-relative references, such as `sounds/bell.mp3`, to playable sources; the
runtime keeps them opaque, and arbitrary external URLs are not resolved. An audio reference the host cannot resolve is
reported as a failed load; an unresolvable Stage image leaves the Stage empty. The Player plays audio; a `playVideo`
request is reported as a failed load ("Video playback is not supported by this Player yet."), so the script continues
with the runtime's warning. An authored Stage image has no alternative text yet. Media-derived ambience, explicit
transitions, and custom stage rendering are not yet implemented in the Player; the development preview's Stage media
picker can override the Stage for layout comparison.

Standard image/video-like presentation:

- defaults to `contain`, keeping the complete media visible within the allocated stage;
- centers media within the stage unless an accepted media capability explicitly positions it otherwise;
- uses a restrained media-derived ambience/vignette in otherwise unused stage area by default where that effect is
  available, while allowing an accepted author/media capability to provide an explicit stage/background presentation;
- shares one continuous background field with the transcript beneath it. The media-derived ambience covers the stage,
  continues across the stage/transcript boundary, and fades out before the foreground lane and composer, so the scene
  colour reads as one surface rather than meeting a hard seam. The field stays inside the middle content column, so
  tool panels and Player controls retain their own materials. Stage and transcript remain
  separate regions with separate content and scrolling ownership;
- clips the vignette to the stage and keeps decorative effects pointer-neutral;
- uses a direct replacement as the Standard default transition; V30 `fade`/`crossfade` belong to the future layered
  scene and are not part of the Stage image and media foundation;
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

- uses the canvas surface, continuous with the stage background above it;
- owns a stable horizontal center shared by the stage media and composer: all remain centered in the Player viewport until the docked tools framework consumes the reading column's free margin, then move together to stay visible; changing media or resizing the stage vertically does not move or narrow the reading column, while media fits within the remaining space around that center;
- keeps the maintained ultrawide readability cap pending visual retuning;
- places one viewport of empty scroll space before the messages, so even a single message can be scrolled; at the latest
  position, messages and active controls sit above the composer and new messages grow the conversation upward;
- owns vertical scrolling and contains overscroll;
- uses the maintained soft top fade beneath the stage instead of a hard cut only while the transcript is actually
  scrolled away from its top; at the top of history, the first visible content remains fully opaque;
- may hide the visible scrollbar on narrow layouts while retaining scroll behavior;
- must remain performant for histories that can reach extremely large sizes. Do not retain millions of words as active
  DOM nodes. In the accepted Vue implementation, TanStack Vue Virtual is the single windowing and scroll-anchoring
  owner; it must preserve stable scroll position and the illusion that the complete retained history is continuously
  present. Loading/rendering older content must not make a user who appeared near the top suddenly jump to a different
  relative location. The presentation mechanism must use stable entry identities, support variable message heights,
  bound rendered DOM, and preserve the visible anchor across prepend, append, measurement, and resize; it does not own
  or truncate canonical history.

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

Received bubbles align left and player-authored bubbles align right. The Player owns bubble placement and text
alignment; authors can set `position` and `align` only for prose, as defined by the language contract below. Messages
occupy at most `75%` of the conversation width and `65ch`. Consecutive messages group only while both the speaker and
presentation kind remain the same. The first received bubble in a group shows its avatar and name. Player-authored
messages do not. Speaker identity colour/font and per-message rich-text styling are content presentation, not
application palette roles. Adjacent bubbles in one speaker/presentation group have a 3px gap. Separate bubble groups
start 12px apart. Prose keeps its own spacing.

The runtime adapter supplies resolved message presentation according to the
[language contract](../specifications/accepted-syntaxes-v30.md#message-presentation-defaults-and-overrides). Where that
contract reports no authored choice, the Player supplies one. Prose has no avatar, defaults its block and text alignment
to centre, uses the same width limits as bubbles, and has no panel unless the author supplies a background.

When an authored foreground sits on a Player-generated bubble or prose surface, the Player measures it against
that surface unless an inline authored background encloses it. It leaves readable pairs alone using APCA or a
WCAG ratio backed by a minimum APCA score; neither is a universal readability guarantee. For other pairs it compares a
subtle local backing with an ink lightness change by colour difference, and can combine both when gamut mapping would
wash out the authored colour. It retains the ink's original light/dark direction. Inline coloured text on a
Player-generated surface follows the same rule. When an author supplies the bubble or prose background, authored text
remains unchanged, including inline colours and high-contrast mode. Without an authored foreground, the Player chooses
default black or white ink for that background. Authored text inside an inline background (including inherited message
colour) also remains unchanged. Compile-time feedback for a poorly contrasting authored pair is tracked in #434.
The High contrast setting in [Player Settings](#player-settings) gives one-sided colours stronger treatment.

An authored typeface uses the theme font stack as its fallback. Font bundling is tracked in
[`RELEASE-ROADMAP.md`](../planning/RELEASE-ROADMAP.md).

Authored Standard-chat `say` messages carry the typed structure defined by the
[message-markup specification](../specifications/message-markup.md). The Player renders only those controlled blocks,
spans, values, and validated HTTP(S) links; it does not interpret authored HTML or use a raw-HTML rendering path. Links
open a new browsing context with opener isolation. Spoiler markup and reveal controls are removed.
Player-authored transcript messages remain plain text and do not enter the markup parser.

ADR 0018 owns canonical transcript effects of foreground completion: valid text/number answers and choice/button
activations become player-authored transcript messages according to its normalization and visible-text rules. Every
accepted user activation/change on the long-lived control family also carries machine-readable canonical provenance. A
momentary action is shown as a player-authored transcript action; toggle/select visibility is author-controlled and,
when shown, uses a neutral session-event presentation rather than implying spoken prose. Programmatic control updates
are not user activations and use the same neutral event family with their script origin identified. Visual markers must
not become canonical punctuation; their exact appearance remains tuning work.
Long-lived control activation/update history is not yet implemented in the Player.

The POC's letter-glyph avatars use twelve fixed colour families, with a light fill and dark letter in light mode and the
inverse in dark mode. On a speaker's first bubble, the Player assigns the colour used by the fewest messages so far;
ties follow a fixed, perceptually spaced palette order. Later messages increase that colour's count, and the speaker
keeps the assignment. Authored text and bubble colours do not choose avatar colours. An authored V30 speaker `avatar`
image replaces the glyph and is decorative beside the visible speaker name; while it is unavailable or fails to load,
the glyph remains. Like Stage media, the reference is package-relative and resolved by the trusted host; an
unresolvable avatar keeps the glyph.

## Composer and foreground interactions

The Standard Player uses one persistent composer at the bottom of the conversation area. It is the normal chat input and
the answer field for `askText` and `askNumber`; `choose` and `showButton` controls appear after the latest message inside the
same vertically scrolling transcript. The composer stays at the bottom. Its shell has a 12px gap above and below in the
normal viewport; a larger bottom safe-area inset takes precedence where needed.
Invalid submissions show a short red notice anchored to the composer input without changing its height or moving choices.
In a tight layout the floating notice may temporarily cover a choice. It clears when typing resumes, the interaction
changes, after a brief delay, or when the player taps outside it.

### Wide presentation

At normal wide presentation the composer is one integrated component shell containing the expanding input and primary
`Send` control. The shell owns its border, hover/pressed feedback, focus outline, disabled treatment, and moderate
rounding; the input does not draw a second bordered box inside it. The shell spans the transcript's reading width, so
received-message avatars and player bubbles align with its outer edges. The current reading gutter is `8px` on both
sides; the narrow composer can retain larger side clearance near rounded screen corners.

### Narrow presentation

The composer remains one integrated shell in narrow layouts. Its extra side clearance follows the edge condition above,
independently of the tool drawer and the transcript reading width.

### Input growth, focus, and keyboard behavior

The input grows upward only within the conversation area. Its maximum height is constraint-based: a large desktop may
show more lines than a phone with its software keyboard open. After the limit, only the input scrolls internally. Composer
growth may reduce the visible transcript viewport but must never push or resize the stage out of its allocated position,
and the composer may never grow larger than the conversation area available beneath the stage. The composer row must
contain the complete measured input and Send control; a growing textarea may not paint beyond that row or beneath the
visual-viewport/keyboard boundary.

The following fullscreen keyboard-geometry and allocation behavior is intended but not yet fully implemented in the
Player.

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

The composer receives focus by default, except on touch-only devices, where automatic focus would raise the software
keyboard; there the user taps the input to start typing. Non-interactive Player clicks should not arbitrarily steal
typing focus; an explicitly focused tool/input/control naturally owns keyboard input while it is active.
Submitting with `Send` keeps editing focus and preserves the software keyboard's current state: a visible keyboard stays
open, while a dismissed keyboard is not reopened. A hardware keyboard can continue typing after Send; tapping the input
explicitly opens the software keyboard again. Submitting with `Enter` from the input keeps editing focus for a retry or
the next interaction.

Focus indication distinguishes navigation from text editing. Clicking or touching the composer and then typing does
not add a focus outline. Keyboard navigation into its input marks the integrated composer shell; Tab to Send removes
that shell outline and marks only Send. Shift+Tab back marks the shell again. Send remains a separate keyboard focus
target and invokes the same submission as Enter in the input. Ordinary editing keys do not switch pointer-origin focus
to keyboard navigation. Player controls and body-portaled tool controls share this input-modality policy.

Standard keyboard behavior is:

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
- `showButton`: clicking the rendered button or submitting its exact non-empty visible label in the composer activates
  the same action; other text and Space while the empty composer owns focus do not activate it;
- a primary click on unrelated/blank Player space does **not** activate `showButton`;
- while any mandatory foreground interaction is active, other composer text does not advance ordinary canonical script
  execution. In the deterministic first POC it is an invalid attempt and the same interaction remains active with the
  accepted validation/retry behavior. A future LLM clarification/interpretation layer may consume non-matching text
  without silently changing the deterministic choice, but that is outside the current POC contract.

This is distinct from a skippable `say` pacing gate: when no foreground interactive control owns the input, a primary
click/tap on Player background/unused space or Space with the empty focused composer may settle that gate under ADR 0018.
A click/tap settles only the gate presented when the press began; if that gate ended while the press was held, the
release settles nothing. Actual interactive controls always take precedence and must not also fire the viewport-wide
pacing shortcut.

Constraint-driven dropdown presentation under ADR 0018 is not yet implemented in the Player; it currently uses wrapping
buttons.

A `showButton` is the one-option presentation of the same Standard foreground-control vocabulary. Controls share
the transcript's reading width, grow with their labels, and allow long labels to wrap. The group centers its
buttons and wraps onto additional rows rather than scrolling horizontally. It adds no inline padding beyond the
transcript reading gutter; each button retains its own label padding. The gap from the preceding message to the
group follows the separate-bubble gap (12px). The Player action button is the shared style
for script-driven foreground and right-rail actions, including `choose` and `showButton`: minimum height `44px`, `8px`
vertical and `12px` horizontal padding, `8px` gaps in both directions, `0.875rem` label text, and unitless `1.3`
line-height. Short buttons take their content width; long labels wrap and grow the button vertically. These dimensions
apply on desktop and touch alike. Player action buttons use the shared shadcn Button with a soft-bevel
presentation: modest rounding, a lighter top, darker lower edge, and a small depth shadow. Hover changes the lighting
without moving the label; pressing reduces the depth. Controls scroll away with the transcript; there is no separate
button scroller. The transcript’s leading scroll space keeps messages and controls together above the composer when
following the latest content. After completion, the active controls disappear and the existing runtime transcript
records the response. Completed choices and buttons carry a visible `›` marker in the transcript, distinct from typed
text/number answers. Pointer or touch activation does not focus the composer or summon a software keyboard; keyboard
activation can move focus to the next choice. Foreground and right-rail action buttons retain their opaque authored
colour as the material base. Without an authored fill, the light or dark theme's neutral control surface supplies that
base. Black or white labels and contrast-limited lighting keep the material readable across normal, hover, and pressed
states. Unavailable action buttons use the shared disabled surface, text and border roles, without relief or hover/pressed
feedback. They retain native disabled semantics and cannot activate. Right-rail action buttons use the same opaque
material as foreground buttons.

The [Player action button design rationale](UI-DESIGN-AND-ENGINEERING.md#player-action-button-design-rationale) explains the
material choice and its reuse boundaries.

Validation content and retry semantics come from the controlling interaction/runtime contract. The Player must not
invent a competing inline-error semantic merely because the current POC lacks the richer accepted V30 `invalidMessage`
/`invalidLlmInstruction` compatibility path.

## Right timer and background rail

The Player's right timer/background rail is an overlay at the Player's right edge, not another tool panel. Timer and background-control
content have separate overflow owners. Presentation remains separate from runtime action/lifecycle ownership; fixture
content in the development preview does not create a second runtime model.

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

The determinate ring represents elapsed fraction. Current horizontal and vertical space conditions select the compact
timer together: either constrained condition uses `96px`. With comfortable space, usable viewport widths from `2240px`
use `192px`; other comfortable widths use `128px`. The rail is `156px` wide with compact/ordinary timers and `192px`
with the large timer. Diameter and rail width are separate provisional layout values; no outside halo shadow or its
former reservation is restored.

Timers currently form a vertical collection in the stage overlay, including compact presentation. Their typography and
material remain visual baselines. A timer disappears when its visible action/lifecycle no longer requires presentation;
runtime lifecycle wiring is separate from the development fixtures.

When exactly one visible timer exists, its timer pane never presents a scrollbar; the complete ring fits and stays fixed
while the background-control/status list scrolls independently beneath it. When multiple visible timers exist, the timer
pane may scroll only when those timers actually exceed its allocation. A hidden timer removes its complete pane and does
not leave a scrollbar, gap, or lifecycle hint. Overflow content fades/softens at relevant boundaries rather than being
hard-clipped; with one fixed timer the upper action fade carries scrolling controls visually behind/beneath the timer
region.

### Background controls and status

Runtime-backed long-lived controls/status are not yet implemented in the Player; the development preview demonstrates
only local button/toggle/disabled presentation.

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
contract is synchronized. Exact busy animation remains an unresolved visual-tuning detail; it should use a familiar
indeterminate-activity cue, must not require control reflow, and must remain distinguishable from keyboard focus and
disabled/inert presentation. Programmatic updates visibly change the same control state but must remain recognizable as
script-initiated rather than user input. They add a neutral session event to transcript history rather than a speaker
message. Momentary buttons do not generate explanatory text on their own; narrative responses come from the script.
Feedback for programmatic updates is transient and must not add permanent text to the control or change rail geometry.
Explicit removal is a separate lifecycle operation.

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

The complete control/status group is vertically centred on the Player viewport, not on the Stage, whenever it fits. The
centre is a preference, not a fixed coordinate: the whole group shifts only as far as needed to stay below the timers
and inside the usable Player area, and individual controls are never clipped. A software keyboard reduces that usable
area. When the group cannot fit even after shifting, only the group scrolls and the timers remain fixed. With multiple
timers, the timer pane owns vertical timer overflow and the action pane continues to own action overflow.

### Stage overlay and material

The rail never reserves a right-hand track and has no backing toggle. It spans the full Player height while it stays
clear of the reading column, overlaying the Stage and the conversation margin. When it would cover transcript or composer
content, it falls back to the Stage height, with the controls directly below the timers. Rail dimensions remain
provisional. Timer surfaces use the current graded translucent timer material. Right-rail action
buttons remain fully opaque, including authored colours and hover/pressed states.

## Interaction states and input methods

### Neutral controls

Ordinary neutral controls use the shared progression without geometric movement:

1. default: quiet control surface with `border-subtle`;
2. hover: `border-default` plus `surface-hover` fill;
3. pressed/active: `border-strong` plus `surface-pressed` fill;
4. keyboard focus: a `2px` accent outline with `2px` visible separation and no layout shift. The outline is the only
   focus mark; components add no separate focus ring. The Player's `2px` separation replaces the shared `1px` baseline;
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

Player scroll regions use theme-colored overlay scrollbars that hide when inactive. Visibility may be configured per region;
the exact hover-versus-scroll choice remains under visual evaluation.
They do not reserve extra content width or introduce another panel border. Native text-editing fields retain their
browser scroll behavior with matching scrollbar colors.

- hover styling applies whenever the actual browser/input capability supports hover; do not infer it from desktop versus
  phone. A phone/tablet with a mouse or hover-capable pen may legitimately receive hover feedback;
- touch/coarse activation uses pressed/active feedback without requiring hover;
- keyboard focus remains visible through `:focus-visible`-equivalent behavior;
- actual interactive controls take precedence over viewport-wide pacing-skip gestures;
- functional motion is allowed for carousel/snap movement, drawer/rail transitions, mystery-timer indeterminate motion,
  edge fades, fullscreen auto-hide chrome, and similarly meaningful state transitions;
- `prefers-reduced-motion` reduces/removes non-essential animation while preserving understandable state changes.

## Z-order, overlays, and click-through

The complete blocking/custom-overlay and critical-global-control hierarchy is not yet implemented in the Player.

The maintained relative layering direction is:

1. ordinary Standard Player content;
2. floating timer/background-control surfaces;
3. tools drawer and its scrim, with the drawer above its own scrim;
4. blocking modal or custom overlay;
5. critical fullscreen/global auto-hide controls needed to leave or operate the Player.

Exact numeric `z-index` values are implementation detail. The drawer scrim intentionally intercepts outside activation.
Decorative stage/media effects are pointer-neutral. Floating right controls remain interactive over the stage. A visible
overlay must not create accidental click-through into covered controls.

Custom tool/stage HTML/CSS is confined to its assigned surface and cannot escape through accidental selectors or
`z-index`. A deliberate full-player takeover uses its future explicit capability rather than CSS leakage from a smaller
custom surface.

## Default themes

The Standard Player generates its semantic colour roles from a theme intent (`player/theme/palette.ts`) and applies
them before components consume them. The defaults are a warm light theme (surface hue `70°`, `50%` tint, maximum
surface chroma `8.5`, rose accent `#D63B61`) and a cool dark theme (surface hue `240°`, otherwise the same surface
intent, blue accent `#2255EE`). Switching light/dark applies that mode's default palette and keeps the contrast
choice. Generated values and contrast targets remain provisional and are tuned through `Visual Lab`.

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
Exact author-facing schema/names remain upstream API work. Theme registration, user/package precedence, and
missing-variant fallback are not yet implemented in the Player.

Standard theming covers defined semantic colour roles, not arbitrary CSS. Geometry, fonts, spacing, DOM/chrome
ownership, and other Standard Player properties remain Player-owned unless a later explicit capability says otherwise.
Authored speaker/rich-text/control colours that carry script meaning are content semantics, not theme defaults. User
theme or accessibility preferences must preserve that meaning: for example, a story-defined red control cannot simply
be recoloured blue. Accessibility treatment may add or alter non-semantic presentation while retaining the authored
distinction. Theme API shape, preference persistence beyond [Player Settings](#player-settings), exact authored-colour
fallback mechanics, and numeric accessibility thresholds remain open; see [OPEN-DECISIONS.md](../OPEN-DECISIONS.md). Ordinary
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
- development fixture tool names/content, placeholder messages, timer values, sample media, and action labels.

Do not preserve an implementation technique merely because the current POC uses it. Preserve the observable behavior,
authoritative upstream semantics, and explicitly recorded geometry/state/theme contracts instead.
