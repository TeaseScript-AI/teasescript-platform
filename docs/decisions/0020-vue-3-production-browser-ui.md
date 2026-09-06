# ADR 0020 — Vue 3 for production browser UI

**Status:** Accepted
**Decision source:** Owner direction during draft PR #318
**Amendment context:** The Owner decision recorded in issue #335 later amends only this ADR's dependency and
UI-foundation portion for Phase 1. It does not replace the Vue rendering decision, browser-native CSS geometry and
styling ownership, or framework-independent engine and domain boundaries below.

## Context

The first production-oriented Player presentation POC deliberately began with browser-native HTML, CSS, and
TypeScript so its layout and interaction contracts could be discovered without first committing to component
machinery. That POC now has several coordinated presentation regions, reactive control state, responsive panel state,
keyboard/fullscreen geometry, and transcript interactions. Continuing to grow manual DOM creation and event delegation
would create competing render and state owners at the point where the confirmed Player core must become maintainable
production UI.

The Owner confirmed that Vue 3 was the intended production frontend once the Player reached this level of component and
state complexity. This decision records that direction without moving framework concerns into the deterministic engine
or prematurely promoting development fixtures into product contracts.

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
   Phase 1 styling foundation. `vue-tsc` checks Vue templates and component TypeScript. The repository's native
   TypeScript compiler remains the engine/tooling compiler; the Vue checker uses a separately pinned compatible
   TypeScript compiler until the official Vue checker supports that native compiler API.
6. The Phase 1 UI foundation uses repository-owned local shadcn-vue source/config, Reka for relevant accessible
   interactive primitives, positioning, and focus behavior, and TanStack Vue Virtual as the single transcript
   windowing and scroll-anchoring owner. No router, general state library, server-side rendering layer, duplicate
   scroller, or separate positioning stack is added. Browser-native CSS remains the owner of layout geometry and
   visual styling.
7. Visual Lab, Layout Debug, demo media selection, and other development fixtures may remain outside the Vue production
   core while parity is established. They must not define runtime or product APIs merely because they are useful during
   playtesting.
8. During migration, the manual Player route may remain as a temporary comparison reference. It is not a second
   production architecture and is removed or reduced only after the Vue core passes explicit visual and interaction
   acceptance.

## Dependency and maintenance impact

- Browser runtime dependencies now include Vue, TanStack Vue Virtual, Reka, and the small `clsx`/`tailwind-merge`
  class utilities. The production bundle is self-hosted; no CDN runtime is used.
- Tailwind CSS 4, Vite, the Vue Vite plugin, and the shadcn-vue CLI are build/development foundation tooling, as are
  `vue-tsc`, `@vue/tsconfig`, and the compatible TypeScript checker.
- The later foundation is needed for the current large, variable-height transcript and the two scheduled Phase 2
  branches that share UI seams. Manual local windowing and a competing `MessageScroller` were rejected because they
  would split ownership and evidence. Local/self-hosted source avoids a CDN or host/security-protocol change; the
  existing dependency audit and update path remains in force.
- These Vue/foundation packages use their declared upstream licenses. Exact versions and transitive dependency
  identity remain executable facts in `package.json` and `package-lock.json`.
- Dependency updates follow the existing repository verification path: install from the lockfile, type-check both
  TypeScript surfaces, build the browser bundle, run the repository test suite, and inspect dependency audit results.

## Consequences

- Confirmed Player regions can be decomposed into explicit components with testable presentation-state transitions.
- Runtime integration can later provide typed presentation data without coupling the engine to Vue.
- The migration temporarily carries two local Player entry points, so their comparison/reference status must remain
  explicit and short-lived.
- Development-only tools need a deliberate adapter or later migration; they are not copied into the production core by
  default.

## Alternatives considered

- **Continue manual DOM rendering:** rejected for the production core because state and render ownership are already
  complex enough that further imperative wiring would be harder to reason about and safely modify.
- **Mount Vue around the existing imperative renderer:** rejected because two systems would own the same DOM and state.
- **Use a broader frontend stack immediately:** rejected because routing, global state infrastructure, SSR, or an
  external component suite do not solve a current Player requirement. The later #335 amendment accepts only the
  narrow, locally owned foundation recorded above.
