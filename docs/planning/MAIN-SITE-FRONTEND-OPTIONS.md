# Main-site frontend options

- **Status:** Active non-implemented planning
- **Authority:** Non-authoritative analysis for the [open decision](../OPEN-DECISIONS.md#main-site-frontend); it
  selects no option, and accepted sources control
- **Use when:** Preparing the main-site rendering decision ([#260][i260])
- **Do not use for:** The Player inside its iframe, which ADR 0020 settles, or current implementation status

The main site is the trusted site Laravel serves, including the page that hosts the Player iframe. The repository has
no Laravel application yet: Laravel, accounts, publishing, and production hosting are later milestones
([`PRODUCT.md`](../PRODUCT.md)), so evidence has to come from a POC.

## Accepted constraints

- Laravel is the only public backend and owns authentication, authorization, and persistence. Laravel may invoke a
  local Node/TypeScript CLI; there is no second public Node server ([`CURRENT-DESIGN.md`](../../CURRENT-DESIGN.md),
  [`ARCHITECTURE.md`](../ARCHITECTURE.md)).
- Community UI runs in the browser; mobile begins as a responsive PWA
  ([ADR 0001](../decisions/0001-browser-first.md)).
- The Player and package code run in a sandboxed cross-origin iframe, and main-site cookies stay host-only
  ([`SECURITY.md`](../SECURITY.md)).
- [ADR 0020](../decisions/0020-vue-3-production-browser-ui.md): production browser UI, including the Standard Player,
  uses Vue 3 single-file components (decision 1); one rendered region has one owner (2); the foundation is Vite,
  Tailwind CSS 4, and repository-owned shadcn-vue/Reka, with no router, general state library, server-side rendering
  layer, duplicate scroller, or separate positioning stack (5, 6). It rejected routing, global state infrastructure,
  SSR, and an external component suite because they "do not solve a current Player requirement".

## Conflicts with accepted text

Each option needs an accepted decision on at least one point:

1. **Scope of ADR 0020 decision 1.** It covers all production browser UI, and `CURRENT-DESIGN.md` and
   `ARCHITECTURE.md` repeat it without limiting it to the Player. Blade-rendered pages (options A and D) need that
   scope narrowed.
2. **Router and SSR exclusion (decision 6).** Inertia keeps routes in Laravel ([Routing][in-routing]) but calls itself
   "essentially a client-side routing library" ([How it works][in-how]). Inertia SSR (option C) is an SSR layer.
3. **Node process.** Inertia SSR runs a long-lived Node process that Laravel calls over HTTP
   ([Protocol][in-protocol]) and that binds to `0.0.0.0` unless configured ([SSR][in-ssr]). Accepted text allows a
   Laravel-invoked CLI and accepts no second public Node server; it does not address a private one.

## Proposal on record

[#260][i260] (label `owner: parked`) records a direction the owner endorsed on 2026-08-07 "as a concept but not in
every detail": Laravel-owned server-rendered pages by default, Vue islands or dedicated trusted Vue apps where
justified, and a hard DOM boundary around the Player iframe. Bootstrap and the exact architecture remain open. It is
not accepted.

## Options

### A. Blade-first

Laravel renders every page with Blade. Vue runs only as islands, small apps mounted on the elements they own as the Vue
guide recommends for server-rendered HTML ([Vue: multiple instances][vue-app]), or as dedicated apps for whole tools.

- **Reasons:** every response is complete HTML, which crawlers and link previews read without running JavaScript; Google
  calls server rendering "faster for users and crawlers" and notes that "not all bots can run JavaScript"
  ([Google][google]). Pages without islands load no Vue code. PHP is the only server runtime, and complete HTML pages
  cache like any other response.
- **Costs:** Blade cannot render the shadcn-vue/Reka components, so each control a Blade page needs outside an island
  is implemented twice or becomes its own island. Interactive behaviour that is not Vue is a second interactive stack;
  Bootstrap, still open in #260, says its JavaScript "is not fully compatible with JavaScript frameworks like React,
  Vue, and Angular" because both may change the same DOM ([Bootstrap][bootstrap]). Every navigation is a full page
  load. Needs conflict 1 resolved.

### B. Inertia + Vue, client-side rendering

Every page is a Vue page component. Laravel keeps routes, controllers, middleware, and authentication; Inertia swaps
page components on navigation without a full reload ([How it works][in-how]).

- **Reasons:** one component stack for the whole site, so the existing shadcn-vue/Reka components and Vue tooling apply
  everywhere. Laravel's official Vue starter kit is this stack, "Inertia 3, Vue 3 Composition API, Tailwind, and
  shadcn-vue" ([Laravel: starter kits][laravel-kits]), and shadcn-vue's Laravel guide starts from it
  ([shadcn-vue][shadcn-laravel]).
- **Costs:** the first response is a root `<div>` plus a JSON page object; content appears only after the JavaScript
  loads and runs ([Protocol][in-protocol]), and a bundle that fails leaves the page empty. Each page is its own lazily
  loaded bundle by default ([Code splitting][in-split]). Google renders JavaScript pages from a queue that "can take
  longer" than a few seconds, and other bots may not run it ([Google][google]); titles and meta tags can still come
  from the root Blade template ([Responses][in-responses]), page content cannot. One URL returns HTML or JSON
  depending on the `X-Inertia` request header and says so with `Vary: X-Inertia` ([Protocol][in-protocol]), which
  shared caches must honour. Needs conflict 2 resolved.

### C. Inertia + Vue with SSR

Option B plus a Node render process: for a full page request Laravel posts the page object to it, returns the rendered
HTML, and the browser hydrates it ([Protocol][in-protocol]).

- **Reasons:** B's single stack with complete HTML on first load, "easier for search engines to index" ([SSR][in-ssr]),
  and faster time-to-content, "more prominent on slow internet or slow devices" ([Vue: SSR][vue-ssr]).
- **Costs:** a second server runtime: Node.js 22 or later, started with `php artisan inertia:start-ssr`, kept alive by
  a process monitor, and stopped on deploy ([SSR][in-ssr]), using more CPU than serving static files
  ([Vue: SSR][vue-ssr]). A failed or timed-out render falls back to client-side rendering, so "SSR failures may go
  unnoticed" ([SSR][in-ssr]) and B's first-load and indexing costs return without an error. Browser-specific code may
  run only in certain lifecycle hooks, and differing server and client markup is a hydration mismatch
  ([Vue: SSR][vue-ssr]); Reka supports SSR ([Reka][reka-ssr]), but the repository's Vue components have never been
  server-rendered. The phone still downloads and hydrates the page's JavaScript. Needs conflicts 2 and 3 resolved.

### D. Deliberate Blade/Vue split

Each area is wholly Blade or wholly Vue, decided per area rather than per widget: for example public pages in Blade
and signed-in tools in Vue, through Inertia or one Vue app per page.

- **Reasons:** complete HTML where crawlers and first visits matter and one component stack where interaction is
  dense, without a Node process.
- **Costs:** two page shells for one visual language, with A's duplicate controls and second-stack risk on the Blade
  side. Moving between areas is a full page load; an Inertia request that redirects into a Blade area needs
  `Inertia::location()` ([Redirects][in-redirects]). Needs conflict 1 resolved, and conflict 2 if the Vue areas use
  Inertia.

## Same in every option

- Laravel owns authentication. Google sign-in, raised in #360 but required by no accepted source, uses OAuth
  redirects; Laravel's Socialite supports Google ([Laravel: Socialite][socialite]). Under Inertia the redirect to Google
  must be a full page visit: a plain link or `Inertia::location()` ([Redirects][in-redirects]).
- The Player stays in its cross-origin iframe; the host message schemas, sandbox flags, and Content Security Policy
  are a separate [open decision](../OPEN-DECISIONS.md#player-and-interactions).

## Evidence that would settle it

Owner inputs: which pages must be indexable or show link previews, whether Google sign-in is required, and whether a
Node process on the production server is acceptable.

A POC outside `main`: one Laravel app with a public tease page (meta tags and the Player iframe), a catalog list with
filters, and a signed-in form with Google sign-in, built as A, B, and C; D combines the A and B results. Measure:

1. compressed JavaScript and CSS per page, on a first visit and on the next navigation;
2. Largest Contentful Paint and Interaction to Next Paint on a throttled mid-range phone profile, median of several
   runs;
3. what a fetch without JavaScript returns: title, meta and Open Graph tags, and main content;
4. for C, response time, CPU and memory per render, render-process memory under sustained load, and behaviour with
   the process stopped and during a deploy;
5. which shadcn-vue/Reka controls the Blade pages would need again, and any non-Vue script they needed;
6. the Google sign-in round trip.

[i260]: https://github.com/TeaseScript-AI/teasescript-platform/issues/260
[in-how]: https://inertiajs.com/docs/v3/core-concepts/how-it-works
[in-routing]: https://inertiajs.com/docs/v3/the-basics/routing
[in-protocol]: https://inertiajs.com/docs/v3/core-concepts/the-protocol
[in-ssr]: https://inertiajs.com/docs/v3/advanced/server-side-rendering
[in-redirects]: https://inertiajs.com/docs/v3/the-basics/redirects
[in-responses]: https://inertiajs.com/docs/v3/the-basics/responses#root-template-data
[in-split]: https://inertiajs.com/docs/v3/advanced/code-splitting
[vue-app]: https://vuejs.org/guide/essentials/application.html#multiple-application-instances
[vue-ssr]: https://vuejs.org/guide/scaling-up/ssr.html
[reka-ssr]: https://reka-ui.com/docs/guides/server-side-rendering
[shadcn-laravel]: https://www.shadcn-vue.com/docs/installation/laravel
[laravel-kits]: https://laravel.com/docs/13.x/starter-kits#vue
[socialite]: https://laravel.com/docs/13.x/socialite
[google]: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
[bootstrap]: https://getbootstrap.com/docs/5.3/getting-started/javascript/#usage-with-javascript-frameworks
