# Main-site frontend and rendering options

- **Status:** Non-authoritative analysis; no frontend/rendering option is selected by this document.
- **Decision owner:** The unresolved choice remains in [`../OPEN-DECISIONS.md`](../OPEN-DECISIONS.md).
- **Scope:** Main TeaseScript site rendering and interactive UI. Player and Editor remain governed by their current
  topic/architecture sources; forum architecture is outside this comparison.

## Current accepted constraints

The current architecture keeps PHP 8/Laravel as the only public backend and PostgreSQL as the database. Laravel owns
server-side platform responsibilities such as authentication, authorization, persistence, publishing, moderation, and
public platform APIs. The accepted browser UI foundation uses Vue 3 with TypeScript, Tailwind CSS 4, and
repository-owned shadcn-vue/Reka primitives where applicable.

[ADR 0020](../decisions/0020-vue-3-production-browser-ui.md) says production browser UI uses Vue 3 and explicitly did
not add a router, general state library, or server-side rendering layer. Its context and rejected broader-stack option
are centered on the Player work that motivated the decision. That leaves a scope tension for the not-yet-selected
main-site model: substantial Blade rendering could conflict with the broad Vue wording, while Inertia-style navigation
or Vue SSR would expand the deliberately narrow foundation. A later accepted decision must reconcile that scope
explicitly; this planning document does not override ADR 0020.

Laravel remains the only accepted public backend. If SSR is later selected, a server-side JavaScript renderer can only
be treated as an internal rendering process under the current boundary; exposing a second public backend would require a
separate accepted architecture change.

Authentication is largely orthogonal to the rendering choice. Laravel can continue to own sessions, permissions,
validation, controller/business logic, and a future or current Google SSO/OAuth integration whether the resulting page
is rendered with Blade or Vue.

## Options under consideration

### A. Blade-first with targeted Vue regions

Laravel renders public/main-site HTML with Blade. Vue and shadcn-vue/Reka are mounted only where richer interaction
justifies them.

Potential strengths:

- complete useful HTML is available in the first response without waiting for Vue to start;
- low browser JavaScript, CPU, and memory cost for content-heavy pages;
- straightforward SEO, metadata, crawler, and social-preview behavior;
- simple PHP-first deployment and strong full-response caching opportunities for public content;
- Vue remains available for complex controls without making every page an application.

Potential costs:

- Blade and Vue become two rendering/component models that agents must maintain coherently;
- shadcn-vue/Reka components cannot be used directly in Blade-only regions;
- shared visual primitives may need Blade/Tailwind equivalents, even if common design tokens are reused;
- richer pages can become awkward if many small Vue islands accumulate without a clear boundary.

### B. Laravel + Inertia + Vue client rendering

Laravel keeps routes, controllers, authentication, validation, and data ownership. Inertia connects those routes to Vue
page components, and Vue/shadcn-vue renders the main-site interface in the browser without a server-side Vue renderer.

Potential strengths:

- one Vue component model can cover the main site, Player, and Editor;
- direct reuse of shadcn-vue/Reka interaction primitives and a shared visual/component language;
- app-like navigation and interaction after the initial load without designing a separate REST API for every page;
- Laravel remains the public backend and can provide the required page data in the initial response rather than forcing
  an avoidable follow-up API request.

Potential costs:

- the browser still downloads, parses, and executes Vue/component JavaScript before a client-rendered page becomes fully
  usable;
- initial content and image discovery can occur later than with already-rendered HTML, even when the page data itself is
  included in the initial response;
- client-only rendering is a weaker default for SEO-critical public pages and non-JavaScript/failure resilience;
- using Vue everywhere spends browser resources on pages whose main job may only be reading static/public content.

### C. Laravel + Inertia + Vue SSR

Laravel keeps the same backend responsibilities, while a server-side JavaScript runtime also renders the Vue page to
HTML for the initial response. The browser then hydrates that HTML so the same Vue components become interactive.

Potential strengths:

- search engines and users receive useful rendered HTML immediately while the site retains one Vue component model;
- public content, links, and image URLs can be present in the initial HTML rather than waiting for client-side
  rendering;
- shadcn-vue/Reka and shared Vue components can remain the common UI implementation across the main site, Player, and
  Editor;
- subsequent Inertia navigation can retain app-like behavior.

Potential costs:

- an additional server-side JavaScript runtime/process, SSR build, supervision, deployment, monitoring, and recovery
  path;
- more server work on uncached renders than direct Blade rendering;
- the browser still pays for Vue JavaScript and hydration after the initial HTML is visible;
- additional failure classes, including SSR-runtime unavailability, hydration mismatches, and components that assume
  browser-only APIs during server rendering;
- public-response caching becomes more sensitive to personalized/authenticated props and SSR output ownership.

### D. Deliberate Blade/Vue surface split

Use Blade for a clearly defined class of public, content-heavy, SEO-sensitive pages and Inertia/Vue for a clearly
defined class of application-like pages. This is not an invitation to choose rendering technology independently on
every page.

Potential strengths:

- each rendering model is used where its strengths are most valuable;
- public content can remain light and directly rendered while interactive workflows share the Vue/shadcn-vue stack;
- Vue SSR is not required merely to give simple public pages complete initial HTML.

Potential costs:

- two maintained rendering models remain part of the product;
- shared visual components may need parallel Blade and Vue implementations or a deliberately smaller common token layer;
- navigation, layout shells, authentication presentation, and design-system changes must remain coherent across the
  boundary;
- a weak or vague boundary can degrade into arbitrary technology choice and duplicated frontend responsibility.

## Key trade-offs and tensions

### SEO and crawlability versus one Vue component model

Blade and Vue SSR can both provide complete initial HTML for SEO-critical pages. Client-only Vue can still be indexed by
capable crawlers, but it makes crawler execution and JavaScript success a larger dependency. Vue SSR retains the common
Vue/shadcn-vue component model at the cost of an additional rendering runtime.

### First response and asset discovery versus app-like navigation

With Blade or Vue SSR, the first HTML can already contain meaningful text, links, and image URLs, allowing the browser
to start parsing and fetching them immediately. Client-rendered Vue can avoid a separate data waterfall by receiving
initial page data from Laravel/Inertia, but the browser must still load and execute the rendering code before
client-created DOM and asset references exist. After startup, Inertia/Vue navigation can be lighter and more
application-like than replacing complete HTML documents.

### Mobile browser cost versus frontend consistency

Blade can make content-heavy pages usable with little JavaScript. Vue requires bundle download, parsing/execution,
component initialization, and memory; SSR removes the wait for visible HTML but not the later hydration work. The
benefit of spending that browser cost is a common interactive component model and easier reuse of
Vue/shadcn-vue/Reka behavior.

### Simple infrastructure versus shared components

Blade can remain close to the existing PHP/Laravel deployment model. Vue SSR adds a long-running or otherwise managed
server-side JavaScript renderer and another build/runtime failure boundary. That complexity may be justified if a common
Vue implementation materially reduces duplicated UI work across the site, Player, and Editor; it is not free merely
because the frontend code can be generated by agents.

### Public-content caching versus personalization

Public Blade or SSR output can be cached effectively when the response is shared across users. Authentication-specific
or personalized props reduce full-response cacheability and require clearer cache ownership. The rendering choice should
be tested with both anonymous public pages and signed-in variations rather than assuming one cache model covers both.

### One frontend model versus two rendering models

A mostly-Vue main site reduces the number of component/rendering models agents must understand. A Blade/Vue split can be
simpler at runtime but preserves two implementation styles. Shared Tailwind/design tokens can reduce visual divergence,
but they do not remove duplicated component behavior when the same interaction exists in both Blade and Vue.

### SSR benefits versus SSR-specific failure modes

SSR can combine complete initial HTML with the Vue component model, but it creates states that Blade does not have:
server/client render disagreement, hydration mismatch, browser-only component assumptions, and renderer process failure.
Those risks should be evaluated operationally rather than treated as theoretical or as reasons to reject SSR outright.

### Interaction richness versus unnecessary disclosure or JavaScript

Application-like workflows benefit from Vue's stateful component model. A mostly static package/creator/landing page may
not. The design should avoid both extremes: rebuilding every simple document as a heavy application, or forcing complex
interactive workflows through server-rendered patterns that require increasingly fragmented client-side patches.

### Authentication and Google SSO are mostly neutral

Laravel can own login redirects, OAuth/Google SSO, sessions, authorization, CSRF, validation, and protected data in all
four options. Authentication should therefore be evaluated for integration details and caching/personalization effects,
not treated as a primary reason to choose Blade or Vue.

### Avoid an accidental second interactive frontend stack

Livewire-based component libraries such as WireUI or maryUI could be evaluated separately, but adopting them alongside
Vue would introduce another interactive component/state model. A Blade choice does not by itself require Livewire, and a
future Livewire proposal should justify why its benefits outweigh the additional stack and duplicated interaction model.

## Evidence still needed before deciding

A small representative POC can reduce uncertainty more reliably than an architecture choice based on framework
preference alone. At minimum, compare a realistic public package/creator-style page under the serious candidate models,
including an anonymous view and a signed-in/personalized variation.

Useful evidence includes:

- initial HTML completeness: visible content, metadata, links, structured data, and image URLs before client JavaScript;
- SEO/crawler and social-preview behavior, including canonical/meta output and correct HTTP status handling;
- transferred/compressed JavaScript and CSS size, plus route-level code-splitting behavior;
- mid-range-phone startup/hydration CPU time, long tasks, memory pressure, and interaction readiness;
- Core Web Vitals or equivalent measurements such as LCP, INP, and CLS under representative network/device conditions;
- server TTFB, render CPU, memory, and throughput for uncached responses, plus cache-hit behavior;
- navigation behavior and transferred data after the first page load;
- cacheability of anonymous versus authenticated/personalized responses;
- failure behavior with delayed/failed client JavaScript and, for SSR, an unavailable renderer process;
- implementation size and complexity, component reuse, duplicated Blade/Vue behavior, and agent maintenance burden;
- deployment/process count, monitoring/restart needs, and the operational work required for upgrades or failures.

The POC should use the same content, data shape, visual requirements, authentication assumptions, and measurement setup
so results compare rendering models rather than unrelated implementations. Exact numeric thresholds should be selected
only when a later decision has measured evidence and a concrete product requirement.

## Decision path

A later decision should record not only the selected rendering model but also its scope: which main-site surfaces it
owns, whether SSR is required, how public and authenticated responses are cached, and how the common design/component
system crosses any Blade/Vue boundary. If the choice adds Inertia-style navigation or SSR, or if it defines substantial
main-site Blade rendering under ADR 0020's broad Vue wording, update or clarify the accepted architecture explicitly
rather than treating this planning analysis as authority.

If this planning is later accepted, rejected, or superseded, synchronize the result into the applicable ADR/current
architecture sources and remove or retain this file according to [`README.md`](README.md) planning lifecycle rules.
