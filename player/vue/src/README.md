# Player components

This is the Player implementation. Keep development fixtures separate from the components that own Player presentation.

## Design lint

The required [Player design lint](../../../docs/LINTING.md#player-design-lint) checks these Player components,
shared UI definitions and the story-button wrapper. `player/vue/components.json` selects `style.css` for utility
resolution; the component and theme boundaries remain defined by the Player implementation and its maintained UI
specification.

## Adding a shadcn-vue component

`shadcn-vue add` copies a component's source into `components/ui/` after `npm ci` at the root. It needs a
`package.json` beside `player/vue/components.json`, which `player/vue` does not have, and it would install the component's npm
packages there. Give it a temporary one, keep npm from installing anything, and remove it again:

```shell
cd player/vue
printf '{ "private": true, "type": "module" }\n' > package.json
npm_config_dry_run=true npx shadcn-vue add <component> --yes
rm package.json
npx prettier --write 'src/components/ui/<component>/*.ts'
```

`npx shadcn-vue view <component>` lists the npm packages the component needs. Most, such as `reka-ui` and
`@vueuse/core`, are root dependencies already. Any other one is added to the root `package.json` under the dependency
rule in `AGENTS.md`. The copied code may need changes for the Player's TypeScript settings, such as
`exactOptionalPropertyTypes`, so run `npm run typecheck:player`. Knip reports a component that nothing imports yet.

## Responsibility boundaries

- `shell/PlayerApp.vue` composes the product Player from props and slots. It installs `shell/usePlayerKeyboardFocus.ts`
  once, including for body-portaled controls; the [focus contract](../../../docs/ui/PLAYER-UI.md#input-growth-focus-and-keyboard-behavior)
  defines input modality and composer/Send focus.
- The session composable is its owners, each one `use…` function under `session/`:
  - `session/usePlayerSession.ts`, the composition root: the options, the shared state, the owners' composition in setup
    order, the one disposal hook and the return surface;
  - `session/activation/`: the activation under way (`session/activation/useSessionActivation.ts`, the scheduler: prepared Start or
    Continue, begin, the error stop's tokens and the loss), the record (`session/activation/useActivationRun.ts`: each activation's origin,
    its admission, the resources it owns until it retires, and the settlement of its replies), its failure recording
    and a debug export's candidate;
  - `session/activation/work/`: the work an activation does, acting only through its origin: the trusted adapter
    (`session/activation/work/target.ts`, the session and stop targets, each operation admitting its origin right before it acts), Continue's
    begin (`session/activation/work/continue.ts`), the error stop (`session/activation/work/stop.ts`), the adoption (`session/activation/work/adopt.ts`), Debug mode's completion
    (`session/activation/work/debugMode.ts`) and the draw (`session/activation/work/draw.ts`); `tools/activation-work-checks.mjs` checks its wiring forms;
  - `session/persistence/`: the room and the saved values' route, the saved values, the kept session and its
    persistence operations, the saved data's export and import, a session's export and import;
  - flat: Debug's random control (`session/useRandomControl.ts`), Debug mode and the value trace (`session/useDebugModeAndTrace.ts`),
    the shown session's media (`session/useSessionMedia.ts`), Debug's rewind work (`session/useSessionRewind.ts`).
- `session/usePlayerSession.ts` holds the shown `PlayerSession` publication for presentation; the engine's host owns the
  canonical runtime state. Starting a session remounts the transcript and resets interaction-local state. Vue derives
  everything else from that publication. Its
  `session/useRuntimeSceneClock.ts` maps browser time onto the session's scene time: it observes time at the next runtime
  deadline, before input (`interaction/RuntimeInteraction.vue` rejects input when the presented interaction changed), before a
  checkpoint capture, and on `visibilitychange`, `pagehide`, and `pageshow`; hidden pages keep running. A late
  observation without media progress catches up on a copy of the session, a short task at a time, which the session
  adopts in one publication. Starting or
  restoring a session rebases the clock so no gap is consumed; see
  [timers and scene time](../../../docs/RUNTIME.md#timers-and-scene-time). The host prepares a new session for
  the explicit Start control on the start page (`start-and-end/SessionActivation.vue`, with the header's title and author) and
  creates it only on that click. It keeps the session in `player/persistence/kept-sessions.ts`, so a reload shows Continue, which
  restores it, or Start with the reason when a Player update changed the session's format (`start-and-end/ProblemCard.vue`, the card
  `start-and-end/ScriptProblems.vue` shows too); closing the end dialog after `exit` returns to the start page. With `room=debug`, or once Debug goes on in
  the normal room, the debug room ([`DEBUGGER.md`](../../../docs/DEBUGGER.md#debug-room)) stands in with its own saved
  values, photos, and session; `debug/DebugRoomMark.vue` marks it in the title pill, and `shell/ConfirmDialog.vue` asks before Debug
  on overwrites its session. Start and Continue record the wall clock and the player's zone and presentation, which the host-supplied
  `temporalContext` resolves (the browser's by default). The host also owns the framework-independent `player/media/media-device.ts`: it reconciles the session's media
  projection onto `Audio` elements, reports loading through the adapter, and measures progress. Media progress is
  included in every clock observation; while media loads or plays, sampling offers an observation opportunity every
  100 ms. Start and Continue first open the
  session camera (`player/media/session-camera.ts`) when the Player has the camera capability, and a Start with script
  storage, which `main.ts` always gives, then reads the script's saved values again
  ([`DATA-AND-API.md`](../../../docs/DATA-AND-API.md#script-storage-in-the-browser)). The session is created after these
  waits, so in the shipped Player only a Continue without the camera starts it within the click. Because some browsers
  (Safari) allow playback per element only from a user activation, which the session may outlive while it waits, the
  host reuses released elements and, within a Start or Continue click that waits, plays silence on every spare one,
  ensuring at least two; elements allocated beyond the pool fall back to the refused-playback retry. For the same reason, as Safari grants a page's
  first screen wake lock only right after a click, `session/useScreenWakeLock.ts` asks for it within that click, before the
  camera opens, and holds it while the session plays. In a Player that can capture or read stored
  photos, a save first stores the captured photos its value references (`player/media/captured-media-persistence.ts`);
  captured references resolve only through that trusted store, and authored
  media references only through the host-supplied `resolveAsset`. `shell/PlayerApp.vue` derives the Stage image from
  runtime state and provides the same resolver to `transcript/TranscriptMessage.vue` for speaker avatars.
- `development/DevelopmentPreview.vue` opens one runtime choice scenario, with a Stage image and a short chime that
  `development/developmentMedia.ts` resolves, and supplies Visual Lab's Theme Lab, Stage media picker,
  and timer/background-button presentation fixtures, plus Layout Debug; `?scenario=camera` instead opens a camera
  scenario with persistent script storage that shows the saved photo again in a later run, `?scenario=viewfinder` a
  photo scenario whose script shows, moves, and hides the camera view with `showCamera` and `hideCamera`, and
  `?scenario=buttons` a scenario whose permanent buttons fill the rail in place of the button fixtures; all three
  speak as the repository demo's Mistress with that demo's images and sounds. `main.ts` loads it as a
  separate chunk on the development server, or in a build only with the `?dev` URL opt-in. The default build mounts `shell/PlayerApp.vue` with the
  repository demo: `demoHost.ts` supplies its source and resolves its package-relative references to the package's
  SVG files and to sounds that `generatedAudio.ts` synthesizes. With `?package=<id>`, `packageHost.ts` loads a package
  of the playground server's development package root instead and resolves its images, audio, and video; with `?dev`
  too, the development preview plays that package instead of a scenario. `hostedScript.ts` compiles the script before
  Start; one that does not compile shows `start-and-end/ScriptProblems.vue` with its errors instead of Start. `shell/PlayerApp.vue`
  composes the Debug panel: `debug/usePlayerDebug.ts` owns the Debug menu and Debug switches, the countdown line that
  `interaction/RuntimeInteraction.vue` shows, and the scopes of `debug/useDebugLog.ts`, of the time controls that
  `debug/useDevelopmentTime.ts` drives through the session host's `publishJump`, and of `debug/history/useDebugRewind.ts`, which shows the
  engine's host's rewind history and asks the host for each step, showing what it restores through the session host's
  `rewind`, and of `debug/random/useDebugRandom.ts`, which sends Debug's random settings to the engine's
  host (`setRandomControl`, `forgetRandomHistory`), where `player/debug/random-decisions.ts` decides draws and keeps each
  site's history, and resolves a waiting draw there (`resolveRandomDraw`, `randomTried`); `debug/DebugPanel.vue` and
  `debug/DebugStatus.vue` present them. While a draw waits,
  `debug/random/RandomDrawPicker.vue` asks for its outcome from what `debug/random/randomDrawPresentation.ts` derives, showing the code in the
  shared `debug/random/CodeBlock.vue` under a `debug/random/PathBreadcrumb.vue`, and `debug/random/useRandomDrawGuard.ts` keeps the rest of the page from
  acting meanwhile. In the chat,
  `transcript/TranscriptMessage.vue` offers Back to here through `debug/history/rewindPresentation.ts`, `transcript/Transcript.vue` shows the grey future
  `shell/PlayerApp.vue` appends while a state is inspected, and `debug/history/RewindInspection.vue` is the bar above the composer.
  `transcript/useMessageUpdateAnnouncements.ts` feeds the messages that live play changes in place to
  `player/presentation/message-update-announcer.ts`, whose text `shell/PlayerApp.vue` puts in a polite status region; `transcript/Transcript.vue` reports
  each measurement to `player/presentation/transcript-measurement.ts`, which keeps the text in view still when a changed message is measured
  again while the reader scrolls up.
  The preview only passes the initial `?dev` and `time=skip` state.
- `shell/PlayerToolsShell.vue` receives its tool list from the root and owns tool selection, pinning, order, resizing, retained content and dock/drawer focus.
  `shell/PlayerApp.vue` adds the Debug panel and `shell/AbTestsPanel.vue`, the A/B tests, while their Settings switches are on.
  Its tool slot supplies content; its default slot supplies the Player. Closing a visited panel retains its content.
  Tool bodies scroll vertically; the outer carousel handles overflow between panels. Shared shadcn-vue/Reka
  `components/ui/scroll-area` supports per-location visibility without reserving width. The transcript currently
  reveals its thumb during scrolling or track hover; native textareas keep browser editing/scrolling. Visibility
  remains a visual trial.
- `interaction/usePlayerConditions.ts` owns the five independent Player conditions: horizontal and vertical space, touch/hover
  capability, raised keyboard, and composer edge clearance. The shell exposes these as `data-player-*` attributes;
  descendants consume the provided signals. Keep feature-specific fit calculations with their layout owner and use
  actual pointer events for hybrid mouse/touch interactions. See [Player conditions](../../../docs/ui/PLAYER-UI.md#player-conditions)
  before adding a responsive rule.
- `shell/ResizeHandle.vue` supplies the separator, marker and tooltip for menu/panel widths. Panel handles sit outside
  scrolling content; menu handles share existing right padding. Dotted grips move entire panels.
- `shell/PlayerTopBar.vue` owns control placement and translucent material. Fullscreen is rightmost; the title, with the author after it,
  truncates inside a pill without clipping its shadow and then shows in full in the bar's tooltip. `hostedScript.ts` reads both
  from the `main.tease` header. The title, the sidebar's own controls and tool icons, the panel-header controls, and display
  controls share `--player-top-control-radius`; in the open sidebar its toggle is flat like the menu's tools.
- `shell/PlayerComposition.vue` uses Reka Splitter, also underlying shadcn-vue Resizable, for pointer/keyboard allocation
  between stage and conversation, which it hides, still laid out, on the start page. Starting ratio and minimum sizes
  remain visual trials.
- `interaction/ConversationSurface.vue` places the overlay and forwards margin wheel input to `transcript/Transcript.vue`, excluding nested
  tools, composer input, horizontal gestures and browser zoom. Its measured composer inset keeps final content reachable.
- `transcript/Transcript.vue` owns virtualization, grouping and scrolling. Its scrollport includes conversation padding to avoid
  clipping bubble borders; the scrollbar ends above the composer. The trailing slot contributes foreground-control
  height to the end inset. Message rendering and contrast are split into `transcript/TranscriptMessage.vue`, `transcript/TranscriptMarkup.vue`,
  `transcript/TranscriptLine.vue`, `transcript/transcriptPresentation.ts` and `transcript/messageContrast.ts`.
- `interaction/RuntimeInteraction.vue` composes `interaction/Composer.vue` and `interaction/ForegroundControls.vue` and
  handles focus. `interaction/useComposerState.ts` owns the composer's slots (chat, form field, date control,
  password, lock password): only the player's edits, each under its field's token, and its own operations change them,
  and `select` alone changes the slot shown. `interaction/useAnswerSubmission.ts` checks each answer at once with
  `src/interaction-completion.ts`, sends it, including [pacing skips](../../../docs/ui/PLAYER-UI.md#composer-and-foreground-interactions),
  and settles it by the runtime's outcome or the session's end; `interaction/useFormUpdates.ts` sends a form's updates,
  which are no answers, in order, and counts those not yet answered. The composer uses shadcn Textarea/Button and VueUse autosizing;
  foreground controls use `components/PlayerActionButton.vue` in the transcript's trailing slot.
  `playerRuntimeForeground` maps authored backgrounds from live/restored actions; `player/theme/story-choice.ts`
  supplies theme/authored button material. See [ADR 0018](../../../docs/decisions/0018-first-standard-library-poc-contract.md)
  for syntax and completion semantics.
- `stage/useImageCapture.ts` holds the Player-only state of an `askImage` request's two steps and its preview, which
  `interaction/RuntimeInteraction.vue` answers with on "Use image". Its camera step uses the session camera while that is open,
  without opening or releasing it; otherwise it opens a camera of its own, which only it uses, and turns it off when the
  step ends. `interaction/ForegroundControls.vue` draws the steps' controls, `stage/Stage.vue` the preview, and `stage/ImageCapture.vue` the
  camera step's status and countdown on the viewfinder, through `stage/Stage.vue`'s `camera` slot or
  `stage/FloatingViewfinder.vue`'s default slot, with the shadcn Alert.
- `shell/usePlayerTheme.ts` applies/restores document variables; `player/theme` calculates colours and Theme Lab edits intent.
  `stage/stagePhotos.ts` downloads a Stage photo once into the Player's Cache Storage, for the Stage and for measuring it in
  `stage/stagePhotoWorker.ts` where the browser's image decoder can, and loads the images the script names
  (`playerRuntimeStageImages`) ahead;
  `stage/useStagePhoto.ts` shows a new photo together with its colours, which `stage/usePhotoColour.ts` applies and
  `shell/PlayerApp.vue` passes to the theme. See
  [theme evaluation](../../README.md#experimental-dynamic-theme-evaluation).
- `stage/StageRightRail.vue` owns the right overlay rail and its viewport-centred control placement, `interaction/TimerRegion.vue` its
  timer collection and `interaction/TimerDisplay.vue` individual timers. `shell/PlayerApp.vue` presents runtime timers in the rail; the
  development preview's fixture timers fill it only while no runtime timer is presented, and `development/BackgroundControlsFixture.vue` samples
  action, local-toggle and disabled states. The sample actions have no scripted handlers or canonical history; runtime
  background-control wiring remains separate work.

The development preview opens with one runtime choice scenario. Composer dimensions and height caps remain visual
trials.

Story-button ink and transcript readability follow the current Player treatment in
[Player UI](../../../docs/ui/PLAYER-UI.md); Visual Lab does not offer contrast-method switches.

Shared chrome geometry lives in `style.css`; the
[Player geometry contract](../../../docs/ui/PLAYER-UI.md#global-geometry-and-overflow) records dimensions and their tuning status.
Top controls, menu and tool headers share edge/control tokens. The menu width ruler avoids a second JavaScript formula;
its resize target shares right padding. The right rail derives top clearance from header height. Timer diameter and rail
width are selected separately from the shared space conditions, independently of root font size; no outside halo space
is reserved.

Component-specific presentation belongs with its component. Shared theme-token
mapping and overall composition remain in `style.css`. Do not change settled
behavior as part of a structural extraction. Provisional palette values and rail
policies are not permanent product contracts.
