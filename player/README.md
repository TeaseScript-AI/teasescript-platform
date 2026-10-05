# Player implementation

The Player implementation is under `vue/src/`. The canonical observable UI contract is
[`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md). Do not infer new product requirements from HTML structure, CSS
selectors, TypeScript helpers, demo data, or other implementation details here.

General cross-surface UI engineering/design guidance lives in
[`docs/ui/UI-DESIGN-AND-ENGINEERING.md`](../docs/ui/UI-DESIGN-AND-ENGINEERING.md); narrow tasks use its focused reading
route. Accepted runtime, interaction, security, and custom-view semantics remain in their controlling specifications and
ADRs.

For local inspection, run `npm run dev:player -- --host 0.0.0.0` and open `/player/`; the development server loads the
development preview. The default build, served on `/player/` by `npm run playground`, plays the repository demo in
[`examples/demo/`](../examples/demo/demo.tease) behind Start and loads preview fixtures only when `?dev` is selected.
With a development package root, `?package=<id>` plays that package instead (see the repository `README.md`).
This is a local inspection route, not the production cross-origin Player/host protocol.

## Implementation seams

- `runtime-adapter.ts` contains framework-independent runtime-to-Player translation and shared action helpers used by
  the Player and playground workspace controller, including reporting a persisted script-storage write.
- `notices.ts` contains the Player notice channel and its fixed wording per condition; see
  [`PLAYER-UI.md`](../docs/ui/PLAYER-UI.md#player-notices).
- `script-storage.ts` contains the asynchronous script-storage provider boundary and its browser-local
  implementation; see [`DATA-AND-API.md`](../docs/DATA-AND-API.md#script-storage-in-the-browser).
- `vue/src/` contains the Player composition, components, shared layout/theme CSS, demo host, and development preview;
  its [component map](vue/src/README.md) records responsibility boundaries.
- `model.ts` and `presentation.ts` contain shared presentation shapes and timer formatting helpers.
- `theme/` owns theme generation and authored action-button material.
- `capture-device.ts`, `rgba-image.ts`, and `browser-capture.ts` contain the framework-independent camera/microphone
  capture foundation: Player-owned stream lifecycle, bounded failures, recording, still frames, pixel copies, and
  microphone sampling. `session-camera.ts` opens the session camera at Start and answers `takePhoto()`;
  `captured-media.ts`, `indexeddb-media-repository.ts`, and `captured-media-persistence.ts` keep captured photos as
  session media and durable while saved script storage references them. These shapes are implementation details rather
  than an accepted author-facing API.

Browser-native CSS remains responsible for layout and responsive composition. Vue 3 owns rendering and local
presentation state in the Player; Tailwind CSS 4 is integrated through Vite as a foundation layer,
repository-owned shadcn-vue source/config provides local component seams, Reka is the selected accessible
primitive/positioning/focus layer when interactive components need it, and TanStack Vue Virtual is the single
transcript windowing/scroll-anchoring owner. The engine and shared presentation contracts remain framework-independent
as required by ADR 0020.

`vue/src/style.css` owns shared Player geometry and semantic token mapping; `theme/` generates the currently
applied light/dark roles. Components consume semantic roles. Speaker, authored control, media, and technical mask
colours retain separate ownership. The maintained presentation contract and intended theme boundaries live in
[`docs/ui/PLAYER-UI.md`](../docs/ui/PLAYER-UI.md); provisional generator values do not settle final palette policy.

## Experimental dynamic theme evaluation

The Player currently renders generated light/dark theme roles. In the development preview, Visual Lab → Theme Lab
edits the live theme intent. See the [component map](vue/src/README.md).

`theme/palette.ts` resolves Material-based light/dark roles; `theme/material.ts` isolates MCU's tonal palettes;
`theme/color.ts` isolates Color.js conversion, gamut mapping and contrast. `usePlayerTheme.ts` applies the generated
roles to the document root, including body-portaled controls, and restores previous inline values on unmount.
Theme Lab edits session-local intent: accent, surface hue/tint, maximum chroma and monochrome. Contrast is shared
with Player Settings and kept browser-locally like the other Player Settings. Zero tint is achromatic; accent remains
independent. High contrast increases tone separation rather than saturation.
Colour-pair presets change surface/accent inputs without changing mode or contrast; they do not register themes.

Surface roles drive canvas ambience, containers and neutral interaction states; accent drives primary actions,
focus and progress. Nested surfaces use less tint. Translucent media controls and Timer materials account for
background media independently of light/dark mode; theme generation does not control their geometry or recolour
content. Exact provisional tones and effects live in the implementation. Diagnostics measure opaque colour pairs;
they do not certify translucent overlays or perceptual state distinction.

The generator consumes resolved platform intent. User/package precedence, authored-theme registration and
missing-variant fallback are not yet implemented; see the
[theme boundary](../docs/ui/PLAYER-UI.md#theme-and-customization-boundary). It does not convert authored custom themes
or scene/speaker colours. The generated system and its default light/dark intents are adopted
([default themes](../docs/ui/PLAYER-UI.md#default-themes)); preference persistence beyond Player Settings and
palette/contrast policy remain Owner decisions.

MCU (Apache-2.0) and Color.js (MIT) replace local colour-science implementations while leaving product role choices
explicit. Versions are pinned in the package manifest/lockfile. They add browser bundle size and dependency-update
review, without a network service or new data access. MCU 0.4.0's extensionless internal ESM imports require the Vite
bundler here: direct Node ESM execution of the adapter fails. No package patch or custom loader is installed.

## Component dependencies

The Player components follow the shadcn-vue structure and use four further pinned browser packages. `@lucide/vue`
supplies the shared SVG icons; the alternative is locally maintained SVGs. `@vueuse/core` supplies lifecycle-aware
events, observers, media queries, storage and textarea autosizing; the alternative is local browser-API composables.
`class-variance-authority` expresses the shared component variants that the design lint checks; the alternative is
computed class maps. `tw-animate-css` supplies the overlay enter/exit animation utilities used by the shadcn-vue
components; the alternative is maintained CSS keyframes. They add browser code/CSS and dependency-update review, without
a network service, data access or host boundary. On upgrades, verify icons, focus/autosizing, variants and overlay
animations.

`vue-sonner` (MIT) draws the Player notice toasts through shadcn-vue's Sonner wrapper: stacking, enter/exit
animation, swipe-to-hide, pause under the pointer and polite announcement. The alternative is a locally maintained
toast stack with its own timers, stacking and animation. It adds browser code/CSS and dependency-update review from a single
maintainer, without a network service, data access or host boundary; notice state, the bell and the panel stay
Player-owned. Version 2.0.9 orders its stack by mount, so `PlayerToasts.vue` creates each toast in its own render. On
upgrades, verify that order, placement, swipe, expiry and the theme status colours.

## Tool panel ordering

The Tool Panel strip uses SortableJS for mouse/touch reordering and edge autoscroll. The binding restores
Sortable's DOM move before updating Vue's authoritative order; pinning and widths remain independent. Reka menu
actions provide the keyboard/non-drag alternative. A Vue wrapper adds little value for this single list, native drag
and drop has weaker touch support, and Pointer Events would require custom sorting/autoscroll.
SortableJS adds browser code and dependency maintenance, but no network service, runtime data access or host boundary.
Its type package is development-only; versions live in the manifest/lockfile. Verify sorting and scrolling on updates.

## Development-only behavior

`DevelopmentPreview.vue` opens one runtime choice scenario and supplies Visual Lab's Owner A/B presentation settings:
Theme Lab, the Stage media picker, and timer/background-button fixtures. As the scenario's development host, it
resolves the scenario's Stage images to the development illustrations and its chime to a generated tone; the picker's
"Runtime" option shows the scenario's own Stage image, and a fixture overrides it. Visual Lab and Layout Debug are development
surfaces, not Standard Player product tools or runtime/package/host APIs. Fixture timer/control values remain local;
the opening scenario still uses the shared canonical runtime adapter.

Run retained presentation checks through `npm run test:player:preview -- <preview-url>`; see
[`docs/TESTING.md`](../docs/TESTING.md#player-browser-and-visual-verification) for prerequisites and for the demo's
end-to-end checks.
