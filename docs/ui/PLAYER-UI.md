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
Player Settings' Debug menu adds the Debug panel ([Player Settings](#player-settings)); `player/README.md` describes
its controls.
Runtime timers, permanent buttons, the Stage image, and audio are wired; browser video playback and production host
integration remain separate work. Values marked for retesting remain provisional tuning baselines.

A current implementation detail is not a durable requirement merely because it exists. Owner-confirmed behavior here is
the target unless higher authority conflicts with it.

## Upstream contract integration

This temporary checklist records Owner-decided behavior that still needs synchronization into its runtime, Standard
Library, persistence, or accepted-language owner. It is not a second permanent authority layer. Remove an item when its
controlling source adopts it; remove this section and its router references when empty.

- **Long-lived control presentation:** for the toggles, selects, and status items beyond permanent buttons, the
  maintained right-rail sections below choose inactive-in-place and visible-history behavior that still needs final
  visual testing and later accepted-language/Standard-Library synchronization. Runtime value, scheduling, stale-event,
  media-continuity, lifecycle, and provenance semantics are maintained in [`RUNTIME.md`](../RUNTIME.md); exact public
  API names and author syntax remain open.
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
| global controls | shared derived top-control size and corner radius (`--player-top-control-radius`), also for the truncating title pill and the sidebar's own controls, tool icons, and panel-header controls; display controls share a translucent group |
| dialog close (X) | a `32px` button with a `20px` icon, centred `24px` from the dialog's top and right edges; its click target reaches `4px` further on each side (`40px`) |
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
appears in the top controls when the sidebar is hidden, with the display controls' raised material, and in the tools
framework while it is open, flat like the menu's tools.

The title pill shows the `title` and `author` of the package's `main.tease` header: "BuzzQuiz by NIFOC99", the title
only, or "by NIFOC99", with the author in quieter text; without either it is absent, with no fallback. A pill the bar
cuts off shows the full title and author in the bar's tooltip on hover, keyboard focus, or a tap; otherwise it is plain
text. In the [debug room](../DEBUGGER.md#debug-room) an outlined bug before the title marks the pill, filled red inside
while Debug runs, named by the bar's tooltip "Debug session · Debug on" or "Debug session · Debug off".
Which identity a multi-script package or the active script should show remains open.

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
- **Title bar on short screens · A/B test:** variant A or B above;
- **Testing · Debug menu:** adds the Debug panel to the tools menu ([`DEBUGGER.md`](../DEBUGGER.md#player-debug)); on
  in the normal room, play goes on in the [debug room](../DEBUGGER.md#debug-room).
  **Download debug export…** beside it opens the [debug export dialog](#session-end-and-failure) once a session has
  started, also with the Debug menu off.

Apart from the Debug menu, these are presentation preferences, not canonical runtime state. The Player keeps them in this browser's local storage
across reloads, treats stored text as external input that falls back to the default when unknown, and works without
storage when the host frame denies it. Account settings may later take over or synchronize them. The Debug menu is not
stored: every load in the normal room starts with it off, so a tester who opens another script never debugs it by
accident, and every load in the debug room with it on; the development preview's `?dev` starts it on.

Player Settings also contains a **Saved data** section, on every Player page whatever script it shows. Saved data
belongs to the player, like an account's: **Export…** and **Import…** take the saved data of every script this browser
has played at once, or of the scripts the player keeps ticked ([format](../DATA-AND-API.md#saved-data-transfer)). It is
not a session checkpoint.

**Export…** reads every script's saved data freshly, also during a session, so saves already stored count. It lists each
script that has saved values, by its title when a Player has shown it, otherwise by its storage scope, with its values,
photos, and size; all are ticked, with **Select all** and **Select none**, and a long list scrolls. It warns that the
export can contain private photos and offers two tabs for the ticked scripts: **File** prepares one file and then
downloads it from the player's own press of **Download file**; **Text** shows the data in a read-only field with
**Copy** and **Select text**, and when copying is refused or unavailable it selects the text for copying with the
browser. Every change of the ticks prepares them again. Nothing leaves the browser except through these player actions,
and closing the dialog releases the prepared file and text.

**Import…** reads one exported file, chosen with **Choose file…** or dropped on its drop area in the **File** tab, or
pasted text after **Review import** in the **Text** tab; a file dropped elsewhere on the dialog is ignored. Everything,
every script's values and every photo, is checked before anything changes, and a problem, such as damaged data, is shown
with nothing changed. The review asks "Replace the saved data of the ticked scripts? This cannot be undone.", lists the
file's scripts, all ticked, each marked **New** or **Replaces saved data** with its counts and the shown script marked
**This script**, and suggests exporting first; unticked scripts keep their saved data. Each script's data goes into its
own saved data and never another's. When the shown script is ticked while its session runs, waits for Continue, or is
starting, the confirmation is **End session and replace data** and explains that unsaved progress is lost; Cancel
leaves the session running. Confirming replaces each ticked script's saved data at once; it ends that session first and
then offers Start, which begins a new session with the imported data, and leaves a session of another script running.
A script that cannot be imported keeps its saved data, and the dialog names it. Import is unavailable while saved data
is imported or cleared.

When the host persists the shown script's storage, the section also offers **Clear saved script data**, which removes,
after a confirmation, only the values this script saved for later runs; Player Settings, checkpoints, account data, and
other scripts are unaffected, and the next new session starts without them. It is available before Start and after the
session has ended, but not while a session runs or waits for Continue, because a running session keeps its own view of
the saved values, and not when this browser's storage could not be read. The dialogs fit narrow screens, and their own
controls and rows are at least 44px tall.

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
pinning. The menu's tools are flat, with a fill on hover; an open tool keeps the selected fill. The header provides the
title, Panel settings, pin control, and reordering grip. Panel settings offers width presets and Move left/right;
pointer/touch dragging provides another way to reorder panels.

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

`Visual Lab` and `Layout Debug` are development-preview tools, not Standard Player product tools. The Debug panel is
the Standard Player's platform Debugger tool ([DEBUGGER.md](../DEBUGGER.md#player-debug)); it appears first in the
tools menu while Player Settings' Debug menu is on, and turning that menu off removes it from every panel state. Its
time controls stand above its tabs (shadcn-vue Tabs): Now, Variables, Log, and Storage, with its saved-value editor in
a Dialog, when the host persists script storage. The tabs wrap to a second row in the narrowest panel, each still a
44 px target; Now, Variables, and Storage wrap long paths, keys, names, and values
so they fit the Small dock and the narrow drawer, also at the deepest indentation, where tags and text actions wrap
instead of keeping one line. Variables rows open with full-height (44 px) toggles that name what they open; a long value
shows three lines until **Show all**. While Debug runs, each script message, bubble or prose, has a 44 px **Explain
values** icon button at its end, beside a bubble and below prose text, outside the message's own links; it opens the
Debug panel, also in the narrow drawer, on the Variables tab and moves focus to the selected message there. Turning
Debug off removes the buttons without re-creating the transcript's rows.

## Session start and user activation

The Player does not run a script on page load. It opens on the start page: the menu and the title bar, and in the
middle the `title` and "by" `author` of the script's `main.tease` header, either alone when only it is given and
neither without them, above an explicit **Start** control, which takes focus. The transcript, composer, and Stage stay
hidden until a session is shown. A script that does not compile cannot start: instead of Start, the Player lists its
diagnostics, each with its file, line, and message. The player's activation of Start is the user activation that later
audible media playback relies on, so scripts may play audio from their first statement without a separate unlock step.

The Player keeps the session in this browser: at each interaction it newly presents, when it ends, and when the page
is hidden, it stores the session's state, the events that led to it, and the photos only the session uses, which no
save stored, in the IndexedDB database `teasescript-kept-sessions` (`player/kept-sessions.ts`). Opening the script
again, after a reload or with the browser closed in between, shows **Continue** on the start page instead of Start; it
goes on from the last kept point, with those photos as session media again; a stored photo the kept session uses
stays stored while it is kept, also once no saved value references it. What is read back is checked as external data:
a kept session whose events lack what the Player reads from them, such as a message's markup or an answer's form, is
not continued, and Start shows instead. A session ends only with `exit`; there is no restart. Keeping is asynchronous browser storage, so a step after the last kept point, such as a reload in the
moment after an answer, can be lost. A saved-data import of the script discards its kept session
([transfer](../DATA-AND-API.md#saved-data-transfer)). A script a host prepares without its plan, such as a development
scenario, keeps none. The debug room has a start page of its own, with its restarts
([`DEBUGGER.md`](../DEBUGGER.md#debug-room)). Start and Continue
also record the wall clock and the player's time zone and numeric date and time presentation, resolved again at each:
the account setting when the host supplies one, else the browser's. With them they record the rules of the time zones
the script names. They are session data
([Date and time context](../RUNTIME.md#date-and-time-context)).

If the browser still refuses required audible playback, the Player surfaces a deliberate activation/retry control. It
does not silently substitute muted playback or report the audio as played: refused audio reports no progress, so its
cues and settlement wait, and an **Enable audio** [player notice](#player-notices) retries playback from the user's
click. In the Player the
session is created only when Start is activated; Continue resumes a kept session. Keeping a session across browsers or
devices, and reconciling a continued session's view of saved data with saves made meanwhile, such as in another tab,
are tracked in #469.

## Session end and failure

An ordinary end opens the end dialog by itself: **The end**, a review placeholder, and **Close**, which takes focus. The
review is a placeholder that sends and stores nothing: a 1 to 5 star rating, a radio group of 44px stars chosen by click
or arrow keys, an empty "Write a review (optional)", and **Send review**, unavailable, with the note "Sending reviews
will be possible once TeaseScript has its website.". An end Debug's [rewind](../DEBUGGER.md#rewind) restores does not
open it again. While the dialog is open the session stays behind it, so its last messages remain visible; closing it,
with Close or Escape, returns to the [start page](#session-start-and-user-activation), whose Start begins a new session
and takes focus.

When a script error stops the session, a line above the composer says "The script stopped because of an error." and
offers **Details**. An exception of the Player itself also stops the session until the next Start: it no longer runs,
observes time, or takes input; its captures, cameras, and media end; and late answers and reports, including save
acknowledgements, are dropped. The line then says "The Player ran into an error." An error notice with
**Details** supplements the line until a new session starts. Both open one error dialog, which never opens by itself. It
shows "Script error" and "In rules.tease, line 3.", then **Technical details**, collapsed, with the error code and the
runtime's message ("TSR036: Division by zero: '1 / zero' has no result because 'zero' is 0. Check that 'zero' is not 0
first."), the failing line with the failing expression marked, when the host supplied the script's source, and, for an
error inside a function, called file, or timer, media, or button block, the call path, such as "in punish(), called from
main.tease:6". After a Player exception it shows "Player error" and "The script did not cause this.", with the error's
name as its technical detail. **Download debug export** and, for a script error while Debug runs, **Open in Debug**
close it and open the debug export dialog, or the Debug panel's Now tab, which names the error and its statement;
**Close** returns focus to the line. Apart from those hand-overs, each dialog closes only with **Close** or Escape.
Media warnings are notices, never failures. The transcript and Stage stay for inspection, with the transcript's end
scrolling clear of the line. The dialogs fit narrow screens, and their buttons are at least 44px tall.

The error dialog, Player Settings, and the Debug panel open one **Download debug export** dialog for a developer
([`DEBUGGER.md`](../DEBUGGER.md#debug-export)). The technical report is always included; each personal category is a
labelled switch with its help text, off whenever the dialog opens, and engine replay data can be turned on only after
saved values, answers, and session text, which its state copies. With photos on, the photos the session used are listed
with a thumbnail, size, and where they were used, each with its own checkbox. The dialog warns that the file is not
encrypted and that removing credentials and paths from text is best effort, so the player checks the preview; it states
the file's size and whether the error can be replayed exactly, and previews what the file contains; every change
prepares the file again, and **Download debug export** saves exactly that file from the player's press. An export larger
than an issue attachment allows is not offered. The dialog fits narrow screens and scrolls, and its rows and buttons are
at least 44px tall.

## Player notices

Player notices tell the player that something about the session's environment matters, such as blocked audio,
unavailable storage, or a camera problem. They never stop the session and are separate from runtime developer warnings,
which are creator diagnostics about a script location. Host features publish them through one Player-owned channel
(`player/notices.ts`) with fixed Player wording per condition; a condition has one notice, which it replaces or
withdraws, so repeated causes do not stack.

Notices belong to the Player, not the story, so they never appear in the conversation. A new or replaced notice shows
as a temporary toast (shadcn-vue Sonner) at the top centre of the window, below the Player's top controls, whether or
not a side panel is open; on a narrow screen the toast spans the window and may cover the timer. Each toast shows a level icon (info, warning, or error), its text, and at
most one action control that runs from the player's click (such as **Enable audio**). Up to three toasts show as a
stack with the newest in front; the pointer expands the stack and pauses expiry. Info toasts expire after 5 seconds,
warnings after 8, and errors after 10; swiping a toast away hides it sooner. Hiding or expiry removes only the toast.
The toasts are announced politely, errors included.

The notification bell in the top controls opens the notification panel, which lists every current notice, newest
first, with its age, its action, and a dismiss control; **Clear all** dismisses every dismissible notice. A dot on the
bell marks notices published since the panel was last opened and any notice the player must act on. Opening the panel
marks the notices seen and replaces the toasts. When dismissal, **Clear all**, or a resolved condition removes the
focused control, focus moves to the nearest remaining control; with none left, the panel closes and focus returns to
the bell. A notice whose action is the only way to continue, such as **Enable audio** while the script waits for that
audio, is labelled **Needs action**, offers no dismiss control, and disappears once its condition resolves.

The current conditions are blocked audio (warning, with **Enable audio**), browser storage unavailable at session start
(info: saved progress is not kept), a failed script-storage write (warning, for the run it happened in; a new
Start withdraws it), an image request that allows only the camera where no camera can be used (warning,
withdrawn when the request ends), a media file the script refers to that the Player cannot use (warning, see
[Stage and media presentation](#stage-and-media-presentation)), and a session stopped by an error (error, with
**Details**; see [Session end and failure](#session-end-and-failure)). Each level also has a theme status colour, following
the usual convention: info blue, warning orange, error red. A toast uses the level's soft tint as its surface and its
solid tone for the border and icon; a panel entry uses the same tint with a solid mark along its start edge and a solid
icon; and the bell's dot takes the most severe level that needs attention. The development preview's Visual Lab shows every level.

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

A script can show the user what the session camera sees, for example to get into frame before a photo it announces, with
`showCamera` in a floating window or `showCamera stage` over the Stage image, and hide it with `hideCamera`
([§22](../specifications/accepted-syntaxes-v30.md#camera-view)). The camera view is only a preview: it has no capture
control, and the script alone takes photos with `takePhoto()`. It shows a live image at the camera's aspect ratio,
without a visible label, mirrored (selfie view) by default; a button switches the mirroring off and on while the Player
is mounted. Captured photos are never mirrored. Without an available camera it is not shown. In the window it floats
over the Player with a slim title bar that holds the mirror button. Like a desktop window, the user drags it anywhere
and resizes it from any edge or corner, keeping the camera's aspect; focused, the arrow keys move it and + and - resize
it. It floats in the whole Player, so showing or hiding the tools sidebar never moves it: it lies over the docked
sidebar, and the narrow layout's drawer slides over it. It keeps its place while the Player is mounted, also when the
script moves the view to the Stage and back. Over the Stage, the view covers the Stage image, which stays loaded
underneath, and the Stage takes the camera's aspect until the view goes; the mirror button sits in the view's upper
corner. The Player's camera view is the only one: the browser's own picture-in-picture is not offered for it.

Media playback is script-controlled. Audio and video elements show no native browser controls, and the Player offers
no seek, scrub, pause, or skip control of its own: playback the runtime did not command would make reported progress
disagree with the canonical timeline. A progress indicator may extrapolate between reports for display only. Whether
users may ever control playback is open; if accepted, such controls send typed host input to the runtime rather than
acting on the media element ([`RUNTIME.md`](../RUNTIME.md#stage-image-and-media-playback)).

The trusted host resolves authored package-relative references, such as `sounds/bell.mp3`, to playable sources; the
runtime keeps them opaque, and arbitrary external URLs are not resolved. An audio reference the host cannot resolve, or
that the browser cannot load, is reported as a failed load; a Stage image that does not resolve, or that the browser
cannot load or decode, leaves the Stage empty. The Player plays audio; a `playVideo` request is reported as a failed
load ("Video playback is not supported by this Player yet."), so the script continues with the runtime's warning. Each
such package file is a warning [player notice](#player-notices), once per session and authored path, for example
"Image not found: images/hall.jpg" or "Audio could not be loaded: sounds/bell.wav (main.tease, line 4)"; audio and
video also name the file and line of the play that started them. A video that does resolve gets no notice, since only
video playback itself is missing; captured photos and chosen images are no package files and are never reported. An
authored Stage image has no alternative text yet. Media-derived ambience, explicit transitions, and custom stage
rendering are not yet implemented in the Player; the development preview's Stage media picker can override the Stage
for layout comparison.

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

An update that adds more than the transcript can show at once, such as several messages that arrive together, does not
follow to its end: the transcript stops with the update's first new entry at its top, where the user starts reading,
and smart follow suspends as after an upward scroll. This includes what development time jumps add. Start, Continue,
and the states Debug's rewind shows open at the end of their history, as does a session's first content when the script
shows it only once the host answered, such as after a media request.

Smart follow reactivates when either:

- the user manually scrolls back to the latest/bottom region; or
- the user activates a contextual return-to-latest control.

The return-to-latest control appears only when the user is sufficiently away from current content and is not in the
middle of an active touch/scroll gesture. On touch, wait until the finger is released and scrolling has settled rather
than placing a button under the user's moving finger. Hide the control once latest content is reached/follow resumes.
It is a compact, translucent down-arrow control at the lower right of the transcript, using the conversation's unused
side margin instead of claiming a new vertical row. It may overlap an avatar margin before it obscures message text and
uses restrained backdrop blur where supported. Its exact threshold remains a tuning detail; while smart follow stopped at
an update's first new entry, it appears as soon as anything of that update is below the view.

### Entering content

During live play, what newly appears in the transcript enters from below: a script message, a player-authored message,
and the choice, button, or form controls of a new interaction fade in while rising slightly. While smart follow is
active, the transcript glides up to make room for them instead of jumping. Only the drawing moves: the scroll position
reaches its new place at once, so smart follow, the anchoring of the reading position, and its measurements behave as
they would without the motion. Updates in quick succession continue one movement instead of queueing animations. A
message changed in place does not enter again; while smart follow is active, the transcript glides when its height
changes.

Content shows directly, without entering: the transcript at Start and Continue and the states Debug's rewind shows,
also when input adopts one; a session's first content, also when it follows Start in a later update; what development
time jumps add; and an update with many entries or, under smart follow, with more than the transcript shows at once. End and error notices and Debug's own status lines do not enter. With a
reduced-motion preference nothing enters or glides. The duration, the rise, and what counts as many are tuning of the
Player, not behavior a script can observe.

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

A script message can change in place through its handle ([`RUNTIME.md`](../RUNTIME.md#message-handles)). Its entry keeps
its identity, place, grouping, speaker, and presentation and shows the new text; history shows the current text, with no
edit marker, new entry, or unread indication. A change does not scroll to the message or resume smart follow: while
following, the newest content stays readable when an earlier entry changes height, and while reading history the text
in view stays in place, also when an entry that changed out of view is measured again as it scrolls back. When a change
removes the element inside the message that had focus, such as a link, focus moves to the message itself without
scrolling, which is a tab stop only until focus leaves it. Because a changed message may be out of view or already read,
the Player speaks changes that live play produces from a polite status region outside the transcript list, as
`speaker: text`, or `message cleared` for empty text: coalesced per message to its latest text, one at a time, at most
one each second and the same message at most once every five seconds, and not when the visible text is what was last
shown or spoken. Start, Continue, and states that Debug's rewind shows speak nothing of their history. The intervals are
accessibility tuning of the Player, not limits a script can observe.

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
image replaces the glyph and is decorative beside the visible speaker name. Like Stage media, the reference is
package-relative and resolved by the trusted host. An avatar that does not resolve or does not load keeps the glyph and,
like a Stage image, is a warning [player notice](#player-notices).

## Composer and foreground interactions

The Standard Player uses one persistent composer at the bottom of the conversation area. It is the normal chat input and
the answer field for `askText` and `askNumber`; `choose` and `showButton` controls appear after the latest message inside the
same vertically scrolling transcript. The composer stays at the bottom. Its shell has a 12px gap above and below in the
normal viewport; a larger bottom safe-area inset takes precedence where needed.
Invalid submissions show a short red notice anchored to the composer input without changing its height or moving choices.
In a tight layout the floating notice may temporarily cover a choice. It clears when typing resumes, the interaction
changes, after a brief delay, or when the player taps outside it.

While Debug runs ([`DEBUGGER.md`](../DEBUGGER.md#player-debug)), one small muted status line below the foreground
controls counts down the current foreground wait, also while the Debug panel is closed: **Debug · Continues in 4 s**,
**Debug · Press within 4 s**, or **Debug · Pacing: 4 s remaining**. It is not a timer: it has no card, ring, or
right-rail entry, takes no input, is not announced each second, and never enters the transcript.

Debug's [rewind](../DEBUGGER.md#rewind) works in the chat. While Debug runs, each of the player's answers to an
interaction before the state shown has a 44 px **Back to here** button beside its bubble. While a restored state is
inspected, the transcript ends at that state, the messages of the later state Forward restores follow it grey, under
**Future · Forward restores it**, without Back to here or Explain values, and the interaction of the state shown is
offered again after them. A bar above the composer, below the error line when the inspected state failed, shows a **Debug fork** badge,
what the interaction shown was answered before, and **Forward**, **Resume**, and **Return to session**, each a 44 px
button with a tooltip; it wraps on a narrow screen. New input or Resume removes the bar and the grey messages.

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
- Space in the empty composer activates the preselected button: a `showButton`, or the button that `prefill:` of
  `choose` or `askBoolean` preselects; without one it does nothing, and while a text, number, or date field waits
  it types. A focused button keeps its own Space: it activates that button, and a focused form toggle flips without
  submitting the form;
- Enter, in the input or on Send, and that Space act only on a fresh press, one that began after the interaction appeared and is not a held key's
  repeat, so the Space that skips a message never also answers the button that appears after it, and a held Enter
  never submits the next field;
- a future user preference may invert or otherwise refine that choice;
- whitespace-only ordinary submissions are rejected;
- the maintained default hint is `Type your response…` when an interaction does not provide its own hint. An explicit
  interaction hint replaces that visible text; an explicit empty hint remains possible where the upstream contract
  permits it.

### Foreground interaction presentation

`askText`, `askNumber`, and `askInteger` use the composer as their active answer field; `askInteger` asks for a numeric
keyboard. `askDate`, `askTime`, and `askDateTime` replace the composer's text field with the browser's date, time, or
date-and-time control, which submits ISO text, and show the hint beside it. These native controls cover the years 0001
through 9999; a prefill in year 0000, which they cannot show, is offered as editable ISO text in the text field. When
Send moves to an interaction whose field is of the other kind, the editing focus and the keyboard's state move to the
new field. A prefill starts as the composer text,
which the player submits unchanged or edits first; a cleared composer stays empty. After a checkpoint restore the
composer shows the prefill again, and unsent edits are not kept.

`askImage(...)` that allows files shows a paperclip before the composer's input, named "Attach an image", with the
request's `hint:` as the input's hint, or "Add an image…" without one. The paperclip opens the browser's native file
picker for one image, with the request's `types` and `mime` as its `accept` hint. A file dragged over the composer
marks it as a drop target ("Drop the image here") and answers when dropped; dragged text or links are not taken.
Outside such a request there is no paperclip and no drop target. The Player identifies a file's image type from its first bytes (PNG, JPEG, GIF, WebP,
AVIF, or BMP), requires the extension and the type to match `types` and `mime` when given, and has the browser decode
it; a file that fails, more than one file, or typed text shows the composer notice and the request keeps waiting, as
does a cancelled picker. A file chosen in a picker opened for a request that is no longer presented, for example
because a timer's request replaced it meanwhile, answers nothing and shows the composer notice. An accepted image is
stored as session media and recorded in the transcript as the player message `Image`.

An `askImage(...)` that allows the camera turns the camera on by itself as it asks, where the browser can capture. Its
viewfinder opens over the Stage, or in the camera window when the script shows one, and draws on the picture the
request's question, also said in the chat, or else "Take a photo", and a **Take photo** shutter in the material of the
viewfinder's mirror button, both at the bottom so the top stays clear. The
shutter starts a five-second countdown: a number from 5 to 1 as large as the viewfinder allows, each appearing large and
settling over the live picture, without the motion when the player prefers reduced motion; a request that ends during
the countdown takes no photo. The photo taken covers the live picture, unmirrored as it will be used, with **Retake** and **Use this**; only **Use this**
answers the request, and **Retake** drops the photo and returns to the live camera. The paperclip stays available
throughout. Once the player works in the viewfinder, each step moves keyboard focus to its main control; opening by
itself, it takes no focus. None of these controls enter the transcript. The session camera is used when it is open;
otherwise the request opens a camera of its own, only for itself, and turns it off after the answer, whether a photo or
a file answered. A camera that is denied, missing, broken, or ended shows why in an alert, with **Try again**, which asks
for it again. The viewfinder belongs to its request: it closes when the request ends or is interrupted, or its session is
replaced, and a restored session asks for the camera again but never takes a photo by itself. Where no camera can be
used, such as on a page that is not a secure context, a request that allows only the camera cannot be answered, and a
[player notice](#player-notices) says so.

`choose` and `showButton` keep the composer enabled rather than visually disabling it:

- `choose`: selecting a rendered control or typing one exact unambiguous visible option completes the same choice;
- `showButton`: clicking the rendered button or submitting its exact non-empty visible label in the composer activates
  the same action, and so does Space in the empty composer, since its button is always preselected; other text does
  not;
- a primary click on unrelated/blank Player space does **not** activate `showButton`;
- a `showButton` timeout removes the button without a transcript message; the Player observes time at the timeout
  so the button disappears on schedule;
- while any mandatory foreground interaction is active, other composer text does not advance ordinary canonical script
  execution. In the deterministic first POC it is an invalid attempt and the same interaction remains active with the
  accepted validation/retry behavior. A future LLM clarification/interpretation layer may consume non-matching text
  without silently changing the deterministic choice, but that is outside the current POC contract.

`askForm` presents one group of controls after the latest message that stays in place while the player edits it, named
by the form's accessible name. Its field buttons wrap in authored order inside a scroll region bounded to a third of the
viewport height (at most `24rem`), and the submit button and the cancel button of a form written with `cancel:` stay
below it, without a count of the answers: each field shows its own. A toggle is a Player action button with toggle
semantics (`aria-pressed`), its label behind a check or cross mark that alone shows whether it is on; like any action
button, it looks pressed in only while held (Owner decision on #512, 2026-10-09). With authored options it shows
`label: option` instead of the mark. A cycle shows `label: option` with a cycle mark, and a press shows the next
option. The shown option's authored colour wins over the field's; the submit button takes its own. A typed field shows
`label: value`, or `Set…` (`Not set` when optional) without one; activating it opens it in the composer, which takes the
field's name, its `hint:` as the input hint (`label…` by default), and the numeric keyboard or the date or time control
of its kind, with the field's text selected so typing replaces it and Enter keeps it. The edited field stays pressed in
and is marked current. Enter commits it and returns focus to the field's button; a refused answer keeps the text with
the composer notice. While a field is edited, **Back** (and Escape in the input) closes it and drops the text, and
**Clear** leaves an optional field without a value; selecting another field or submitting first commits the text. Every
control keeps the action button geometry above, also among 43 toggles on a phone. An edit keeps focus on its control and
adds nothing to the transcript; submitting adds the player's answer listing every field
([V30](../specifications/accepted-syntaxes-v30.md#forms)) one per line, a toggle behind a check or an empty box instead
of the `›` response marker; screen readers read its plain text. Each cycle line names the option the cycle showed,
also where several of its options share a value. Exact
unambiguous text of one field label or of the submit or cancel button activates it from the composer, as for `choose`. A
form with a time limit closes at it without a transcript line, as a `showButton` timeout does.

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
without moving the label; pressing reduces the depth. Neither changes the rim colour or the button's size; only keyboard
focus (`:focus-visible`) draws an outline. A preselected button, a `showButton` or the one `prefill:` names, wears a
1px ring in the theme's solid accent tone drawn around its rim, so its size does not change; its focus outline keeps
its gap outside the ring. Controls scroll away with the transcript; there is no separate
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

Permanent buttons ([V30 §28](../specifications/accepted-syntaxes-v30.md#28-permanent-buttons)) are the implemented
momentary buttons. Toggles, selects, and status items are not yet implemented; the development preview demonstrates
them only as local fixtures while the script shows no permanent button.

The Standard rail presentation supports:

- momentary/background action button;
- toggle/switch with persistent on/off value;
- dropdown/select for one persistent mutually exclusive choice;
- non-interactive status/progress item.

They share a coherent outer visual family while preserving correct semantics and accessibility roles. A status item is
not styled or exposed as a disabled button. A switch exposes toggle semantics; a select exposes the appropriate
single-choice semantics. Determinate progress/fill may be shown on a status item and may also be used on an interactive
control when the explicit progress data is meaningful and does not obscure the control state.

From an activation until its handler finishes, an interactive right-rail control stays in place and is inactive (Owner
decision on #610): it uses the disabled presentation without a separate busy animation, cannot be activated, and is
exposed as disabled (`aria-disabled`) while it keeps keyboard focus; its committed value does not change. It becomes
active again when the handler finishes, unless the script removed it. When a focused control is removed, focus moves to
the control that takes its place. Programmatic updates visibly change the same control state but must remain
recognizable as script-initiated rather than user input. They add a neutral session event to transcript history rather
than a speaker message. Momentary buttons do not generate explanatory text on their own; narrative responses come from
the script. Feedback for programmatic updates is transient and must not add permanent text to the control or change rail
geometry. Explicit removal is a separate lifecycle operation.

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
4. keyboard focus: a `2px` outline in the neutral `focus-ring` role, the primary text tone, with `2px` visible
   separation and no layout shift. The outline is the only focus mark; components add no ring of their own. The
   Player's neutral colour and `2px` separation replace the shared accent and `1px` baseline, so focus looks alike in
   both modes, does not follow an author's accent, and stays apart from the accent of primary actions;
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
  edge fades, fullscreen auto-hide chrome, content entering the transcript, and similarly meaningful state transitions;
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
group, and button. The Player preserves that requirement regardless of visible hint text or authored styling: a button's
visible label is its accessible name, and the localized default names it only when the label is blank.

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
