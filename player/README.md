# Player presentation POC

This directory contains the production-oriented Player UI presentation POC. It is intentionally separate from the technical editor/playground UI and is served by the existing local playground server at `/player/` after `npm run playground`.

The Player currently consumes `demo-session.ts` presentation data. It is not yet the accepted runtime/Player protocol, does not mutate canonical engine state, and does not implement the future cross-origin host contract. Runtime integration can replace the demo data/bootstrap seam without changing the layout CSS or the data-driven message/action renderers.

## Source layout

- `index.html`: semantic Player shell and local asset entrypoints.
- `model.ts`: internal presentation-only types; not a public engine contract.
- `demo-session.ts`: temporary POC presentation data.
- `panel-state.ts`: pure left/right panel transition helpers.
- `tool-columns.ts`: pure add/select/close transitions for user-created tool columns.
- `render.ts`: data-driven message, action, timer, media, and tool-column presentation.
- `browser.ts`: DOM bootstrap and local UI interactions.
- `styles/`: cascade-layered layout, component, effect, and responsive CSS.

The CSS keeps the browser-native direction established by the Player research: Grid, dynamic viewport units,
`clamp()`, `color-mix()`, `aspect-ratio`, `field-sizing`, stable scrollbar gutters, masks, safe-area environment insets for
Player controls, input-capability media queries, and `prefers-reduced-motion`. The demo has no external runtime asset or
network dependency.

The left tool area supports user-created columns. `+` reuses the existing Player title row instead of consuming another
vertical header; each column has one fixed selector/close row and one vertically scrollable body. Tool content no longer
adds nested vertical scrolling or repeats the selected tool name as another heading. Columns may duplicate a tool, switch
tools, and be closed independently, while the whole strip owns horizontal overflow.

On wide docked layouts the tool area grows only in response to user-created columns. Its growth is capped by the stricter
of the square-media (1:1) boundary and the current minimum usable conversation/composer width. This protects text input
independently from media geometry without reserving a fixed percentage of an ultrawide viewport. Narrow layouts keep the
existing overlay drawer. Tall portrait docked layouts can already start below 1:1; multi-column sizing preserves that
baseline rather than shrinking the media further, while the future constraint-driven dock/overlay transition remains
open.

The browser bootstrap measures only the strip's intrinsic preferred width. CSS owns the actual Grid allocation and layout
caps; there is no JavaScript width optimizer. The current `Visual Lab` and `Scene` tool registry is demo presentation
data, not a runtime or package API. Player Actions remain the dedicated right-hand controls beneath the timer rather than
becoming tool-column content.

No UI or CSS framework is required by this POC. Presentation data, rendering, panel transitions, and browser bootstrap are separate seams so a later runtime integration or UI-framework decision does not become part of the presentation contract by accident.

Open, non-implemented Standard Player presentation work is tracked in
[`docs/planning/PLAYER-UI-FOLLOW-UPS.md`](../docs/planning/PLAYER-UI-FOLLOW-UPS.md). General UI engineering and design
guardrails remain in [`docs/UI-DESIGN-AND-ENGINEERING.md`](../docs/UI-DESIGN-AND-ENGINEERING.md).
