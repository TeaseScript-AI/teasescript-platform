# ADR 0020 — Vue 3 for production browser UI

**Status:** Accepted
**Decision source:** Owner direction during draft PR #318 and issues #335 and #340

## Context

The first production-oriented Player presentation POC deliberately began with browser-native HTML, CSS, and
TypeScript so its layout and interaction contracts could be discovered without first committing to component
machinery. That POC now has several coordinated presentation regions, reactive control state, responsive panel state,
keyboard/fullscreen geometry, and transcript interactions. Continuing to grow manual DOM creation and event delegation
would create competing render and state owners at the point where the confirmed Player core must become maintainable
production UI.

The Owner confirmed that Vue 3 was the intended production frontend once the Player reached this level of component and
state complexity. The later Phase 1 foundation selected Tailwind CSS 4, repository-owned shadcn-vue/Reka primitives,
and TanStack Vue Virtual for the responsibilities described below. The original manual implementation was transitional
legacy while its development fixtures were migrated or retired; it is not a maintained alternative frontend direction.

This decision records that current direction without moving framework concerns into the deterministic engine or
prematurely promoting development fixtures into product contracts.

## Decision

1. Production browser UI, including the Standard Player, uses Vue 3 single-file components with the Composition API and
   TypeScript.
2. Vue owns component rendering and local presentation state. One rendered region has one owner; production code does
   not combine Vue rendering with a second imperative renderer for the same DOM.
3. The parser, compiler, deterministic runtime, plans, checkpoints, Standard Library semantics, and shared domain
   contracts remain framework-independent TypeScript and do not import Vue.
4. Browser-native CSS remains the owner of layout geometry, responsive composition, safe areas, and visual styling.
   Vue supplies semantic structure and state; it does not replace structural CSS with inline layout calculations.
5. Vite and the official Vue plugin build the browser bundle, with Tailwind CSS 4 integrated through Vite as the
   styling foundation. `vue-tsc` checks Vue templates and component TypeScript. The repository's native
   TypeScript compiler remains the engine/tooling compiler; the Vue checker uses a separately pinned compatible
   TypeScript compiler until the official Vue checker supports that native compiler API.
6. The UI foundation uses repository-owned local shadcn-vue source/config and Reka for relevant accessible
   interactive primitives, positioning, and focus behavior, and uses TanStack Vue Virtual as the single transcript
   windowing and scroll-anchoring owner. No router, general state library, server-side rendering layer, duplicate
   scroller, or separate positioning stack is added. Browser-native CSS remains the owner of layout geometry and
   visual styling.
7. Visual Lab, Layout Debug, demo media selection, and other deliberately development-only fixtures may remain outside
   the Vue production core only while they still need migration or retirement. They must not define runtime or product
   APIs merely because they are useful during playtesting.
8. The manual/vanilla Player implementation has been removed after its retained development fixtures moved to Vue. The
   Vue Player is the sole maintained local rendering path.

## Dependency and maintenance impact

- Browser runtime dependencies now include Vue, TanStack Vue Virtual, Reka, and the small `clsx`/`tailwind-merge`
  class utilities. The production bundle is self-hosted; no CDN runtime is used.
- Tailwind CSS 4, Vite, the Vue Vite plugin, and the shadcn-vue CLI are build/development foundation tooling, as are
  `vue-tsc`, `@vue/tsconfig`, and the compatible TypeScript checker.
- The selected foundation supports the current large, variable-height transcript and the two Owner-selected Phase 2
  design paths that share UI seams. Manual local windowing and a
  competing `MessageScroller` were rejected because they would split ownership and evidence. Local/self-hosted source
  avoids a CDN or host/security-protocol change; the existing dependency audit and update path remains in force.
- The foundation does not prebuild a component catalogue. Reka is the selected primitive layer for locally owned
  interactive components when they are needed; it avoids adding a separate positioning/focus stack.
- These Vue/foundation packages use their declared upstream licenses. Exact versions and transitive dependency
  identity remain executable facts in `package.json` and `package-lock.json`.
- Dependency updates follow the existing repository verification path: install from the lockfile, type-check both
  TypeScript surfaces, build the browser bundle, run the repository test suite, and inspect dependency audit results.

## Consequences

- Confirmed Player regions can be decomposed into explicit components with testable presentation-state transitions.
- Runtime adapters pass typed presentation data through framework-independent boundaries without coupling the engine
  to Vue.
- During migration, documentation and development tooling identified the manual route as legacy pending removal rather
  than a supported comparison architecture.
- Development-only tools need a deliberate migration or retirement before the manual route is removed; they are not
  copied into the production core by default.

## Alternatives considered

- **Continue manual DOM rendering:** rejected for the production core because state and render ownership are already
  complex enough that further imperative wiring would be harder to reason about and safely modify.
- **Mount Vue around the existing imperative renderer:** rejected because two systems would own the same DOM and state.
- **Add a separate Floating UI positioning stack:** rejected because repository-owned shadcn-vue/Reka primitives own
  the current popover, menu, collision, and focus responsibilities. A later concrete requirement may justify revisiting
  that dependency choice.
- **Use a broader frontend stack immediately:** rejected because routing, global state infrastructure, SSR, or an
  external component suite do not solve a current Player requirement. The selected foundation remains the narrow,
  locally owned stack recorded above.
