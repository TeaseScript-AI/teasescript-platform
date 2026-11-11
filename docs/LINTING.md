# Lint policy

The lint policy catches discarded type evidence and straightforward JavaScript mistakes while preserving runtime
validation. `.oxlintrc.json` is the executable rule/severity list; all selected rules are errors. `npm run lint` checks
TypeScript and JavaScript source, tests, playground code, and tooling, including the vendored rules themselves, and the
`<script>` blocks of `.vue` files.
Dependency, build, coverage, and Git directories are excluded. `npm run check` includes lint and rule fixtures.

## Correctness category

Oxlint's `correctness` category is on. Two of its rules are off, because every site the code has is deliberate:
`unicorn/no-new-array` (`new Array(n)` preallocates on purpose, and some tests build holey arrays; `Array.from` would
change holes and cost) and `require-yield` (the type core's contract API requires a generator `*make()` that may return
without yielding). `no-unused-vars` ignores names that start with `_`, as `tsc`'s unused checks do. The files whose
findings of these rules wait for another open pull request or a cleanup are a [waiting list](#waiting-lists).

## Type-aware rules

`npm run lint` runs oxlint with `--type-aware`: four rules read TypeScript's types through `oxlint-tsgolint`.

- On every linted TypeScript and JavaScript file:
  - `typescript/no-floating-promises`: a promise is awaited, returned, ended with `.catch` or with a `.then` that has a
    rejection handler, or marked ignored with `void`. node:test's `test`, `describe`, `it` and `suite` are exempt, as
    the runner awaits them. The exemption matches by name, so it also covers a test's `t.test(…)` subtests, which
    node:test awaits before the test ends.
  - `typescript/no-misused-promises`: a promise is not passed where its result is ignored or a boolean is expected,
    such as an `async` event listener or an `if (promise)`; handle the promise inside the callback, ending it with
    `.catch`. TypeScript types `.finally`'s callback as returning `void`, so the rule refuses a callback that returns a
    promise even though `finally` awaits it; write `try … finally` with `await` there.
- On the TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) in `src/`, `player/` and `tests/helpers/`, which are product
  code and the shared oracles:
  - `typescript/restrict-template-expressions`: a template literal may interpolate a string, number, bigint, boolean,
    `null`, `undefined`, `any`, `RegExp`, `Error` or `URL`, and may not interpolate an object, array, function,
    `unknown` or `never`. A `never` usually means that a type guard narrowed more than it proves.
  - `typescript/no-base-to-string`: `String(x)`, `x.toString()`, `` `${x}` ``, `"…" + x` and `join()` refuse a value
    whose type may print `[object Object]`.

  In test files and JavaScript, types are wider than values, and the fixes would be casts, so these two rules are off
  there.
- The `correctness` category's other type-aware rules are off: this policy has not chosen them, and `.oxlintrc.json`
  lists them.
- `.vue` files: these four rules do not reach them, because tsgolint reads only the TypeScript program. oxlint's other
  rules read their `<script>` blocks with its own loader. The [exception check](#evidence-and-exceptions) reads them
  as Vue's parser finds them, and refuses a lint directive in a file that Vue cannot parse.
  Vue handles a promise that a component's template handler, `watch` callback or lifecycle hook returns: a rejection in
  a component inside `PlayerApp.vue` reaches `PlayerApp.vue`'s `onErrorCaptured`, which reports it, and one in
  `PlayerApp.vue`'s own reaches Vue's default handler, as no `app.config.errorHandler` is set. #2023 lists the
  components' session and data functions as composable candidates; in a composable, these rules reach them.
- In agent sessions oxlint prints one line per finding, which leaves out the type a coercion rule refused; `-f default`
  shows it. If these two rules' findings need their type in the one-line form, it is added to those findings alone,
  never by switching every finding to `-f default`.

On the LXC (2026-11-08), `npm run lint` took 47–52 s with these rules and 40–43 s without them, run alone at a load
of 8 to 20, and 46 s with them and the waiting-list check below at a load of 6 to 11. The largest process peaked at
about 1.7 GB in each. Inside `tools/check-changed.mjs`, beside its other checks, the lint step took 113 s with these
rules, and 70 s without them in another run at a similar load. The pre-push check runs lint as CI does.

## Waiting lists

An `overrides` entry whose rules are all off (`"allow"`, `"off"` or `0`, oxlint's `AllowWarnDeny`) is a waiting list:
the findings of those rules in its files wait for another open pull request or a cleanup. It names files, never
patterns. `tools/oxlint/check-waiting-overrides.mjs`, in `npm run lint`, checks that each path a waiting entry lists has
a finding that oxlint reports without that entry and not with it, and refuses a path that is not a linted file. A
finding is oxlint's whole diagnostic, so one whose message or place changes when the entry goes keeps the entry too. A
severity oxlint's schema does not have is refused, in the root `rules` or an entry's. An entry is added only for a
finding that waits, so that with the check each list shrinks. A SIGINT, SIGTERM or SIGHUP removes the check's probe
configuration and stops oxlint and the check by that signal; the next run removes the probe a SIGKILL left.

## Comment forecasts

`tools/oxlint/check-comment-forecasts.mjs` refuses a comment that forecasts later work, in the forms
[Code that does not mislead](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-that-does-not-mislead) lists (its
`FORECASTS` table); a citation of a repository record passes. The old design record (TABLE) is not in the repository,
so it cites nothing: in every file Git lists except the check's own test, a line that names it as a whole word and
holds the whole word `r4` or a section mark later on, or whose next line holds one anywhere, is refused. What stands
between does not count, markup or words, so such a line is refused in prose too: state the fact, or keep the revision
two lines away. A citation over three or more lines, in another letter case or inside a longer word is outside the check
and left to review. A revision number `r4.N` (a whole token) names the accepted record's entry `r4-N`: outside the
record's own pages and the check's test, one with no such heading is refused, in every file Git lists; the check proves
the entry exists, not that it carries the sentence's claim, and other spellings (`R4.1`, an anchor `#r4-N`) are not its.
A section number (`§` or `§§`, then a digit) stands in a section list right after a repository document's name on its
line (`V30 §13`, `ADR 0021 §6.2`, `V30 §5, §35`); `PLAN`, `S3` and `S6-CARRIERS` name the port plan's documents outside
the repository and are allowed as labels while #2423 decides them. Any other section number is refused in every file
Git lists except `docs/`, whose documents number their own sections; `src/`, whose comments #2209 rewrites;
`tests/fixtures/type-core/cells.jsonl`, whose section numbers are cell ids in recorded data whose bytes `MANIFEST.md`
fixes; `tools/oxlint/comment-declarations-waiting.json`, which quotes comments word for word, its section numbers only
`src/`'s, and shrinks with #2209; and the check's test. The check proves the form, not that the section exists or carries the sentence's claim.
`comment-citations.json` holds each file's exact counts in comments of its other forms (a bare `r4.N`, the record's name
with another id), which may only fall.
`comment-forecasts-allowed.json` lists the forecasts the check accepts, and each entry must still be found.

## Comment declarations

`tools/oxlint/check-comment-declarations.mjs` refuses a backticked name in a comment that names nothing the repository
declares or reads: it proves only that the name exists somewhere, not that it names what the comment's site means.
`comment-external-names.json` declares names no file can, each with its kind and source; that list may grow. It also
refuses a `/**` docblock that does not stand directly on its declaration (a blank line, another block or comment between,
or nothing after it); a file's opening header and a same-line cast are allowed. `comment-declarations-waiting.json`
lists the findings that wait for another pull request or the compiler's cleanup, and only shrinks.

## Type evidence

Keep precise contracts through ordinary code. Do not erase a known value into `any`, `unknown`, broad `object`, or an
uninformative dictionary and recreate its type with assertions. Precise inline object contracts, typed dictionaries,
and calls to runtime validators remain valid. Mutable boundary accumulators may start with a nullish sentinel.

Explicit `unknown` inputs and dictionary values remain appropriate for capture, validation, error handling, and
external data. Do not disguise `unknown` with a type alias or claim an already parsed domain type before validation.
Functions returning still-unvalidated data need a local return-contract exception. Dictionaries of `any`, broad
`object`, or effectively empty objects need a concrete value contract or a justified exception. Explicit `any` is also
checked outside dictionary types, including test helpers and mutation callbacks.

Runtime `typeof`, descriptor/prototype inspection, property omission, and partial static analyses are legitimate
techniques. Lint does not require schema dependencies, forbid every reflective operation, or determine whether a
boundary validation is sufficient. `Reflect.get` and `Reflect.apply` require a specific justification because they
bypass ordinary typed property access or invocation.

## Evidence and exceptions

Every non-const type assertion needs an `EVIDENCE:` comment attached to that assertion or its immediate statement.
State the actual invariant, validation stage, external contract, or intentionally invalid fixture. A comment above a
function or block does not justify assertions inside it. A comment immediately before an object property applies to
assertions in that property's value. For example:

```ts
// EVIDENCE: validation: the preceding descriptor checks captured every required envelope field.
```

Use a rule-specific line exception when a selected rule would reject a necessary construct:

```ts
// oxlint-disable-next-line anti-slop/no-reflect-get -- EVIDENCE: fixture: forward unchanged proxy keys while varying items.
```

Only `oxlint-disable-next-line` and `oxlint-disable-line` with explicit rule names and an `EVIDENCE:` explanation are
allowed. Multiple named rules may apply to the same operation. File/block/all-rule disables and alternative inline
configuration are prohibited. A separate comment check enforces this syntax; Oxlint rejects unused disables.
An evidence comment alone does not disable other rules. Search for `EVIDENCE:` to find intentional exceptions.

Legitimate cases include external capture/validation, branded constructors, compiler invariants not represented by
TypeScript, and malformed-data or proxy fixtures. File location alone is not evidence. Keep fixture setup and outcome
assertions typed where possible; do not centralize exceptions in universal unchecked cast or mutation helpers.
Comments must describe real evidence, not merely repeat that an assertion is safe. Their truth remains a review
responsibility: the checker validates attachment and syntax, not the underlying invariant.

## Maintenance

Oxlint and its plugin API package are development-only dependencies pinned together in `package.json` and the lockfile.
They execute native/JavaScript code during local checks and CI. Vendored source retains upstream attribution and the
selected revision in `tools/oxlint/anti-slop/`; upgrades require reviewing changes and rerunning local rule fixtures.
The local adaptations allow precise contracts and honest `unknown` dictionaries and restrict assertion-comment scope.
Do not enable new upstream defaults as an incidental upgrade.

`oxlint-tsgolint`, which gives oxlint its type-aware rules, is a development dependency pinned exactly. Oxlint declares
it as an optional peer and speaks its protocol, so the two are upgraded together. It is a native Go binary per
platform, installed through optional dependencies and published by oxlint's maintainers with npm provenance, and it is
built on typescript-go 7.0, the compiler line of the repository's `@typescript/native`. It reads the source in local
checks and CI; nothing of it reaches the Player bundle. The alternative, typescript-eslint's typed rules, type-checks
through TypeScript's JavaScript API at another version and was not measured. `node_modules/typescript` is TypeScript
6.0.3, a peer dependency npm installs for the ESLint parser and `vue-tsc`; the repository's `tsc` is
`@typescript/native` 7.0.2 (`node_modules/.bin/tsc`, `npm run typecheck`).

This type-evidence route avoids a schema library, another test runner, and a second type-checking engine. Node runs
the rule fixtures directly; the existing compiler type-checks their source. The separate exception checker reuses the
existing `ts-morph` parser dependency. The costs are maintaining the selected plugin source and reviewing justified
exceptions; the plugin's lexical analysis does not prove cross-file type safety or replace runtime boundary tests.

## Player design lint

`npm run lint:design` checks the Player's Vue/TypeScript under `player/vue/src/`, including shared `components/ui`
source (including CVA variants) and `PlayerActionButton.vue`. `eslint.design.config.mjs` owns the executable scope and
contracts. The command and `npm run test:lint:design` are required by `npm run check`, including CI.
Selected rules are errors; warnings fail the command. This scope does not cover the framework-independent `player/*.ts`
modules; the lint configuration remains the executable scope owner.

Use semantic theme utilities and complete class names. Shared components own their appearance;
choose their variants instead of adding padding, color, shape or typography overrides at call sites.
Composition can control placement and containment. Check ownership before adding a variant or
exception: an existing override is not evidence of a sound boundary. The embedded Textarea variant
removes field chrome because Composer owns the enclosing surface and focus treatment; BubbleContent
owns reading size and joined corners. Player-owned material, authored appearance and specialized
chrome stay in their local components. File/component-specific contracts allow their named CSS hooks,
not arbitrary overrides throughout the application. Inline ESLint configuration is disabled; necessary
exceptions belong in the configuration with a concrete rationale and regression coverage.

The arbitrary-value rule rejects bracket values outside the configured mechanics and theme-derived
component formulas. It does **not** impose a finite spacing scale: Tailwind values such as `p-3.25`
remain valid. Do not replace a rejected value mechanically to make lint pass; assess the design intent.
The local fragmented-class rule catches direct interpolation/concatenation in Vue class bindings and
`cn`, `clsx` and `cva` calls, including native elements. Use complete literal alternatives. Unlike upstream
`require-static-classes`, it permits safe helpers; it does not resolve arbitrary helper bodies, aliased
class builders or data flow. Review those paths when changing them.

Disabled controls take the theme's `text-disabled`, `surface-disabled` and `border-disabled` roles from one unlayered
rule in `player/vue/src/style.css`, which overrides Tailwind's layered utilities. An opacity class on the element's own
disabled state therefore never shows, or with `!important` overrides the theme's disabled treatment.
`design/no-disabled-opacity` refuses both:
- **Routes.** It reads class text from four routes only: a static `class`, a `:class` expression, a direct
  `v-bind="{ … }"` object's statically named `class` property, and the arguments of `cn`, `clsx` and `cva`. Class text
  built elsewhere (helpers, spreads, data flow) is not read; the fragmented-class rule shares these routes.
- **Recognition.** Every class that names `opacity` must parse under a closed class grammar (`plugin.mjs`); one it cannot
  read, with quotes, a backslash or unbalanced brackets, is refused by name.
- **Admission.** The variants before an opacity utility are admitted only in a closed set of forms that cannot select
  the element's own disabled state (`ADMITTED_VARIANTS`): breakpoints, media and direction, element states,
  pseudo-elements (only as the last variant, as some compositions after one are nested), `aria-*`, data attributes other than
  `data-disabled`, and `group-*`/`peer-*`, which read another element.
- **Refusals.** `disabled`, `data-disabled`, `data-[disabled…]` and arbitrary selectors naming `:disabled`, `[disabled]`
  or `[data-disabled]` are refused as overridden; any other variant, such as another arbitrary selector or `not-*`, by
  name until a row admits it.

`aria-disabled` stays admitted: the shared rule does not cover it, and it marks controls that dim while busy yet keep
focus.

The rule's tests check it against Tailwind's own output (`tools/design-lint/oracle.mjs`).
- **The oracle.** Tailwind compiles each tested class with the Player's `style.css`. `postcss` finds the selector of
  each `opacity` declaration, and `postcss-selector-parser` reads its subject compounds, expanding `:is()` and
  `:where()`.
- **Its verdicts.** A class is refused when a subject holds `:disabled`, `[disabled]` or `[data-disabled…]`, or when
  its selector holds anything outside the oracle's inventory of known subject atoms: a nested rule, `:not`, or a
  functional pseudo-class with another argument than the admitted variants emit. Every admitted tested class must
  compile cleanly.
- **What the tests cover.** A generated family of spellings × variant order × utility spellings, a matrix of 88
  admitted representatives in both orders, and each route. A run checks a seeded sample of 500 matrix rows (default
  seed 2102), as the property campaign samples its cases; `DESIGN_LINT_MATRIX_SEED=<n>` picks another sample and
  `DESIGN_LINT_MATRIX=full node --test tools/design-lint/test.mjs` checks all 7,744. A failure names its seed.

Named residuals:
- a class the grammar reads but Tailwind reads differently, with the oracle rows as its check (an admitted class for
  which Tailwind emits no CSS sets no opacity);
- parameterised admitted forms beyond the tested rows;
- a utility that sets opacity without naming it.

The oracle uses Tailwind's `__unstable__loadDesignSystem`, as `@shadcn/lint` does, so a Tailwind upgrade that changes
that API fails the oracle tests loudly. Then update `loadTailwind` in `oracle.mjs` to the new API, or pin Tailwind until
it can be. Keep the rule's tests running against Tailwind's output, never without the oracle.

These checks do not inspect CSS declarations, compute contrast, validate author colors, or prove visual
consistency. Scoped/global CSS, runtime style objects and externally supplied classes still need review
and relevant browser checks. `no-inline-styles` stays off because authored styles, virtualizer offsets
and measured geometry are legitimate; forcing them through CSS variables solely for lint adds indirection.
Do not move a violation into CSS or an opaque helper to evade a diagnostic. Preserve author-selected
foreground/background pairs under the Player color contract. A CSS linter is not added here: meaningful
palette validation would also need to distinguish theme definitions, technical masks/lighting, debug
overlays and author data, beyond this utility/component check.

ESLint, `@shadcn/lint` and the Vue/TypeScript parsers are pinned development dependencies. Oxlint remains
the JavaScript/type-evidence check; its plugin route cannot inspect Vue templates. These packages parse
local source and load theme configuration during checks, execute code in local/CI environments, and add
no browser runtime. The alternative was manual review alone or a larger custom Vue analyzer. Keep the
local rule limited to the demonstrated upstream gap; review parser/plugin compatibility and dependency
advisories on upgrades and run the configured positive/negative fixtures. Upstream currently prints
informational notices for exact scoped CSS hook contracts; these are not ESLint diagnostics and do not
weaken the rules. Do not broaden them to wildcards to hide those notices.
