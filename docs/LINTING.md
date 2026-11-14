# Lint policy

The lint policy catches discarded type evidence and straightforward JavaScript mistakes while preserving runtime
validation. `.oxlintrc.json` is the executable rule/severity list; all selected rules are errors. `npm run lint` checks
TypeScript and JavaScript source, tests, playground code, and tooling, including the vendored rules themselves, and the
`<script>` blocks of `.vue` files.
Dependency, build, coverage, and Git directories are excluded. `npm run check` includes lint and rule fixtures.

`npm run lint` also runs the repository's own checks (`tools/oxlint/run.mjs`), each in a folder by what it reads. A
check of what comments say goes in `tools/oxlint/comments/`, beside the lists it reads. A check over the type
analysis's code (`src/type-inference/core/`) or its test helpers goes in `tools/oxlint/type-core/`; a check over the
compiler outside the type analysis (none exists yet) starts a folder of its own. A check of the lint configuration
stays in `tools/oxlint/`. Any other check starts a subject folder beside these, not in `tools/oxlint/` itself.

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

- In `player/vue/src/session/activation/work/`, `no-floating-promises` also refuses `void` (`ignoreVoid: false`):
  activation work ends each chain it starts, or returns it to the page owner that called it (session split S2).
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

## Names in JavaScript files

No `tsconfig.json` includes a JavaScript file, so no compiler sees a name such a file reads and does not bind. On every
`.js`, `.jsx`, `.mjs` and `.cjs` file, `no-undef` refuses a name that is neither declared, imported, nor one of the
language's or Node's globals (`env.builtin`, `env.node`), as `FILE:LINE:COL: 'name' is not defined`. An ES module
(`.mjs`, and `.js` or `.jsx` under the root `package.json`'s `"type": "module"`) has none of the five names Node's
CommonJS wrapper defines, so there `no-restricted-globals` refuses `exports`, `require`, `module`, `__filename` and
`__dirname` unless the file binds them. `tools/player-firefox-camera.mjs` and `tools/player-preview-checks.mjs` may
also read the browser globals their override names, each such read sitting in a function the tool hands to the page,
which runs in the browser; the lint does not check where such a read sits. A later tool that hands functions to a page
joins that override by name, with the names its page functions read.

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

`tools/oxlint/comments/check-comment-forecasts.mjs` refuses a comment that forecasts later work, in the forms
[Code that does not mislead](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#code-that-does-not-mislead) lists (its
`FORECASTS` table); a citation of a repository record passes. The old design record (TABLE) is not in the repository,
so it cites nothing: in every file Git lists except the check's own test, a line that names it as a whole word and
holds the whole word `r4` or a section mark later on, or whose next line holds one anywhere, is refused. What stands
between does not count, markup or words, so such a line is refused in prose too: state the fact, or keep the revision
two lines away. A citation over three or more lines, in another letter case or inside a longer word is outside the check
and left to review. A revision number `r4.N` (a whole token) names the accepted record's entry `r4-N`, and so does a
range's short second end (`45` in `r4.44–45` or `r4.44-45`; a spaced dash makes no range): outside the record's own
pages and the check's test, one with no such heading is refused, in every file Git lists; the check proves the entry
exists, not that it carries the sentence's claim, and other spellings (`R4.1`, an anchor `#r4-N`) are not its. A
comment's pointer at the record (`…/type-inference-accepted-record/<page>.md#<anchor>`, a nested page or `.markdown`
included) names an anchor of a record page Git lists, read and slugged as the doc-links check reads them
(`headingAnchors`); another mention of the record (its folder, a page without an anchor) is not its, and the check
proves the anchor exists, not that it carries the comment's claim. A section number (`§` or `§§`, then a digit) stands,
as a whole number, in a section list right after a repository document's name on its line (`V30 §13`, `ADR 0021 §6.2`,
`V30 §5, §35`); a section of the port plan's documents (`S3 §5`, `S6-CARRIERS §4.1`) cites what is outside the
repository. Any other section number is refused in every file
Git lists except `docs/`, whose documents number their own sections; `src/`, whose comments #2209 rewrites;
`tests/fixtures/type-core/cells.jsonl`, whose section numbers are cell ids in recorded data whose bytes `MANIFEST.md`
fixes; and the check's test. The check proves the form, not that the section exists or
carries the sentence's claim. A research label (a `LABEL` of the check: `C9`, `W34`, `S6-CARRIERS`) has a row in the
record's glossary (its `README.md`, "Labels") where it stands in a comment under `src/type-inference/core/` or in
printed test text: a test's title (the first argument of `test`, `it`, `describe` or `suite`, or of a property so
named, with or without `.skip`, `.only` or `.todo`) or the value of a `measures` or `authority` property (an object's
or a class's, its name bare, quoted or a string in brackets). Of a title or value the check reads a string, a
template's text (not its `${}` expressions), either side of a `+`, parentheses, what TypeScript erases (an `as` or
angle-bracket assertion, `satisfies`, a non-null assertion) and an arrow function's expression body, with escapes
resolved; a variable, a call or a helper's result is not read. A review reference (`Codex r2's B1`) and the names
`V30`, `V8` and `RE2` are no labels. Test comments, other strings and code are not read, and a row proves the label is
defined, not that the text uses it in that sense.
`comment-citations.json` holds each file's exact counts in comments of its other forms (a
bare `r4.N`, read as the revision rule reads it, and the record's name with another id), which may only fall.
`comment-forecasts-allowed.json` lists the forecasts the check accepts, and each entry must still be found.

## Comment declarations

`tools/oxlint/comments/check-comment-declarations.mjs` refuses a backticked name in a comment that names nothing the repository
declares or reads: it proves only that the name exists somewhere, not that it names what the comment's site means.
`comment-external-names.json` declares names no file can, each with its kind and source; that list may grow.

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
bypass ordinary typed property access or invocation. Type inference is the exception: see the next section.

## Retained state in type inference

`tools/oxlint/type-core/check-retained-state.mjs` holds the code side of the frozen retained-state regime (docs/TESTING.md,
"Frozen retained state"), which catches a write to retained state that the type core makes by ordinary code, across
runs, in test mode; it does not claim to resist code written to get around it (#1072 R33).

Its widest rule closes the meta-object layer: in every file of `src/type-inference/`, the core files its other lines
leave out included, a property changes only by assignment or by a kind's own method (#1072 R30, R34). Refused there:

- `Object`, but as `Object.freeze`, `hasOwn`, `keys`, `values`, `entries`, `fromEntries`, `assign` or `is`: another
  member, an alias (`const O = Object`) and a computed member (`Object[name]`) are refused;
- `Reflect`, `globalThis`, `Function` and `eval`;
- the `delete` operator;
- `.prototype`, `__proto__` and `.constructor`, as a member, a computed key or a destructured name;
- `defineProperty`, `defineProperties`, `__defineGetter__` and `__defineSetter__`, by name anywhere;
- a constructor's `return <value>`.

The retained API's own folder (`core/retained/`), which makes the makers' copy, is outside it.

The check reads the program `tsconfig.json` defines: each file of `src/type-inference/` and `tests/helpers/` it compiles,
a module reached only through another included. A `Retained` call is the one the checker resolves to the API's
declaration, however it is spelled (#1072 Amendment 4). Its other lines:

- a native `Map`, `Set`, `WeakMap` or `WeakSet`, found by the constructor the checker resolves, is not kept where the
  instrument cannot reach it (a class field, a module's mutable variable, a parameter property);
- a private field is `readonly` and either made by a maker or given by its class's `hidden` (`Retained.owner`, or
  `Retained.programPart` in the program's own files);
- a `Retained.closure` registration stands right below its comment naming what the function captures (#1072 R26);
- a `catch` handles only type inference's own errors, and a `finally` completes normally (#1072 R60). Each `instanceof`
  test of a `catch` binding names a class declared under `src/type-inference/` that extends `Error` directly. The block
  ends in `throw <binding>`, or returns, yields, breaks, continues or throws another error only inside such a test's
  consequent or after a top-level guard `if (!(<binding> instanceof C …)) throw <binding>;` (#1072 R67: a consumer that
  stops at a `yield` closes the generator before its rethrow). A `finally` holds no `yield`, `return`, `break`,
  `continue` or `throw`. The solver's step catch and the budget's forward their error, as `yield*` does, and are listed
  by name. So V8's error at a write to frozen data is never handled in type inference while it leaves as the pending
  error; a later error can replace it, which no line here sees (R68; docs/TESTING.md, "Frozen retained state", what is
  not covered). The instrument's own refusals are counted where they are raised;
- an `accessor` field is refused (#1072 R67): its value sits in a private slot that neither the private-field line nor
  the instrument's lock of an owner sees.

What these reach (a descriptor, a prototype, an integrity level, a deletion) could change a locked owner's field or a
retained collection's writer unseen by the instrument, or make a frozen run compute what production does not. Only
`src/type-inference/` and the tests import the core. The tests and `tests/helpers/` hold retained owners and use this
layer on purpose, to observe the core (`type-core-held-host.ts` defines accessors on an owner to watch its reads); they
are outside the rule, which reads only type inference. A type-inference author who needs a refused form takes it to the
coordinator; there is no waiting list and no local disable.

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
checks and CI; nothing of it reaches the Playroom bundle. The alternative, typescript-eslint's typed rules, type-checks
through TypeScript's JavaScript API at another version and was not measured. `node_modules/typescript` is TypeScript
6.0.3, a peer dependency npm installs for the ESLint parser and `vue-tsc`; the repository's `tsc` is
`@typescript/native` 7.0.2 (`node_modules/.bin/tsc`, `npm run typecheck`).

This type-evidence route avoids a schema library, another test runner, and a second type-checking engine. Node runs
the rule fixtures directly; the existing compiler type-checks their source. The separate exception checker reuses the
existing `ts-morph` parser dependency. The costs are maintaining the selected plugin source and reviewing justified
exceptions; the plugin's lexical analysis does not prove cross-file type safety or replace runtime boundary tests.

## Playroom design lint

`npm run lint:design` checks the Playroom's Vue/TypeScript under `player/vue/src/`, including shared `components/ui`
source (including CVA variants) and `PlayerActionButton.vue`. `eslint.design.config.mjs` owns the executable scope and
contracts. The command and `npm run test:lint:design` are required by `npm run check`, including CI.
Selected rules are errors; warnings fail the command. This scope does not cover the framework-independent `player/*.ts`
modules; the lint configuration remains the executable scope owner.

Use semantic theme utilities and complete class names. Shared components own their appearance;
choose their variants instead of adding padding, color, shape or typography overrides at call sites.
Composition can control placement and containment. Check ownership before adding a variant or
exception: an existing override is not evidence of a sound boundary. The embedded Textarea variant
removes field chrome because Composer owns the enclosing surface and focus treatment; BubbleContent
owns reading size and joined corners. Playroom-owned material, authored appearance and specialized
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

- **The oracle.** Tailwind compiles each tested class with the Playroom's `style.css`. `postcss` finds the selector of
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
foreground/background pairs under the Playroom color contract. A CSS linter is not added here: meaningful
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
