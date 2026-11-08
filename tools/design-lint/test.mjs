import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, test } from "node:test";
import { ESLint } from "eslint";
import { judge, loadTailwind } from "./oracle.mjs";
import { ADMITTED_VARIANTS, classifyOpacityToken } from "./plugin.mjs";

const eslint = new ESLint({ overrideConfigFile: "eslint.design.config.mjs" });
const vueFile = "player/vue/src/PlayerApp.vue";
const tsFile = "player/vue/src/components/ui/button/index.ts";
const vue = (body) =>
  `<script setup lang="ts">import { Button } from '@/components/ui/button';</script><template>${body}</template>`;
async function messages(source, filePath = vueFile) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.ok(result, "The configured scope must include this file");
  assert.equal(
    result.messages.some((message) => message.fatal),
    false,
    JSON.stringify(result.messages),
  );
  return result.messages;
}
async function rejects(source, ruleId, filePath) {
  const found = await messages(source, filePath);
  assert.ok(
    found.some((message) => message.ruleId === ruleId && message.severity === 2),
    JSON.stringify(found),
  );
}

for (const [name, token, rule] of [
  ["palette colors", "bg-red-500", "no-raw-colors"],
  ["unknown utilities", "flex-colum", "no-unknown-classes"],
  ["arbitrary padding", "p-[13px]", "no-arbitrary-values"],
]) {
  test(`${name} are errors in Vue and TypeScript variants`, async () => {
    await rejects(vue(`<div class="${token}" />`), `shadcn/${rule}`);
    await rejects(
      `import { cva } from 'class-variance-authority'; export const variants = cva('${token}');`,
      `shadcn/${rule}`,
      tsFile,
    );
  });
}

test("appearance and padding belong to component variants", async () => {
  for (const token of ["p-4", "rounded-none", "text-lg", "bg-primary"]) {
    await rejects(vue(`<Button class="${token}" />`), "shadcn/no-restyle");
  }
  assert.deepEqual(await messages(vue('<Button size="sm" class="mt-4 w-full min-w-0" />')), []);
});

test("local material contracts cannot be reused at arbitrary call sites", async () => {
  await rejects(vue('<Button class="composer-send" />'), "shadcn/no-restyle");
  await rejects(
    vue('<Button class="composer-send p-4" />'),
    "shadcn/no-restyle",
    "player/vue/src/Composer.vue",
  );
  assert.deepEqual(
    await messages(
      vue('<Button class="composer-send" />') +
        "<style scoped>.composer-send { font-weight: 700; }</style>",
      "player/vue/src/Composer.vue",
    ),
    [],
  );
  await rejects(
    vue('<Button class="bg-red-500" />'),
    "shadcn/no-raw-colors",
    "player/vue/src/components/PlayerActionButton.vue",
  );
});

test("native and component bindings reject direct class fragments", async () => {
  for (const element of ["div", "Button"]) {
    for (const expression of [
      "`bg-${tone}`",
      "'bg-' + tone",
      "tone + '-500'",
      "`hover:${token}`",
      "{ [`bg-${tone}`]: active }",
      "active ? { [`bg-${tone}`]: active } : {}",
    ]) {
      await rejects(vue(`<${element} :class="${expression}" />`), "design/no-fragmented-classes");
    }
  }
  await rejects(
    "import { cva } from 'class-variance-authority'; const style = cva(`bg-${tone}`);",
    "design/no-fragmented-classes",
    tsFile,
  );
});

test("complete alternatives, class lists and safe helpers remain valid", async () => {
  const source = `<script setup lang="ts">
import { Button } from '@/components/ui/button';
function placement() { return 'mt-4'; }
const active = true;
</script><template>
<div :class="active ? 'bg-primary' : 'bg-muted'" />
<div :class="['bg-primary', { 'text-foreground': active }]" />
<div :class="{ 'bg-primary': active && \`state-\${placement()}\` === 'state-mt-4' }" />
<div :class="cn({ 'bg-muted': 'mode-' + active })" />
<div :class="active ? { 'bg-primary': 'mode-' + active } : {}" />
<div :class="active && { 'bg-primary': 'mode-' + active }" />
<div :class="\`mt-4 \${placement()}\`" />
<div :class="'mt-4 ' + placement()" />
<div :class="'mt-4' + ' mb-4'" />
<div :class="('mode-' + active) === 'mode-true' ? 'bg-primary' : 'bg-muted'" />
<Button :class="placement()" />
</template>`;
  assert.deepEqual(await messages(source), []);
});

test("authored appearance, virtualization and non-class strings are legitimate", async () => {
  assert.deepEqual(
    await messages(
      vue(
        '<div :style="{ color: authoredInk, background: authoredFill, transform: `translateY(${offset}px)` }" :data-id="`row-${id}`" />',
      ),
    ),
    [],
  );
});

// design/no-disabled-opacity over its axes (docs/LINTING.md): how the class is spelled, where it is written, and the
// variants before its opacity utility. Tailwind's own CSS is the oracle (`oracle.mjs`): a class it compiles to opacity
// on the element's own disabled state, or on a subject the oracle does not know, must be refused; a class the rule
// admits must compile cleanly.
const disabledSpellings = [
  "",
  "disabled",
  "data-disabled",
  "data-[disabled]",
  "data-[disabled=true]",
  "[&:disabled]",
  "[&[disabled]]",
];
const companionForms = [
  "",
  "hover",
  "dark",
  "md",
  "group-hover/item",
  "peer-disabled",
  "aria-disabled",
  "aria-[busy=true]",
  "data-[state=open]",
  "data-[label='(']",
  'data-[label="x"]',
  "data-[label=a\\:b]",
  "data-[x",
  "[&_svg]",
  "not-enabled",
];
const opacityUtilities = ["opacity-50", "opacity-[0.4]", "[opacity:0.5]", "opacity-50!"];
const lexicalFamily = [];
for (const disabled of disabledSpellings)
  for (const companion of companionForms)
    for (const order of ["disabled first", "companion first"])
      for (const utility of opacityUtilities) {
        const variants = order === "disabled first" ? [disabled, companion] : [companion, disabled];
        lexicalFamily.push({
          token: [...variants.filter(Boolean), utility].join(":"),
          axes: [disabled, companion, order, utility],
        });
      }
// One representative of each admitted form and parameter shape, and adversarial `group-*`/`peer-*`, `aria-*` and data
// forms; every pair of them, in both orders, is a row of the composition matrix.
const representatives = [
  ..."sm md lg xl 2xl max-sm max-md max-lg max-xl max-2xl".split(" "),
  ..."dark motion-safe motion-reduce contrast-more contrast-less forced-colors print portrait landscape ltr rtl".split(
    " ",
  ),
  ..."hover focus focus-visible focus-within active visited target enabled checked indeterminate default open".split(
    " ",
  ),
  ..."required optional valid invalid user-valid user-invalid in-range out-of-range placeholder-shown autofill".split(
    " ",
  ),
  ..."read-only empty first last only odd even first-of-type last-of-type only-of-type".split(" "),
  ..."before after placeholder file marker selection first-line first-letter backdrop".split(" "),
  ..."aria-disabled aria-busy aria-[label=:disabled] aria-foo aria-[disabled] aria-[busy=true]".split(
    " ",
  ),
  ..."data-open data-foo data-[state=open] data-[state=:disabled] data-[disabledness] data-[x=disabled]".split(
    " ",
  ),
  ..."group-hover/item peer-disabled group-[&:disabled] peer-[&:disabled] group-[:is(&:disabled)]".split(
    " ",
  ),
  ..."group-[&:is(.group),&:disabled] group-has-[:disabled] group-not-enabled group-odd peer-even".split(
    " ",
  ),
  ..."group-[&_*:disabled] group-[&:disabled,_&] group-[:is(&:disabled,_*)] peer-[:is(&:disabled,_*)]".split(
    " ",
  ),
];
/** Every pair of representatives, in both orders: 88 × 88 = 7,744 rows. */
function matrixRows() {
  return representatives.flatMap((first) =>
    representatives.map((second) => `${first}:${second}:opacity-50`),
  );
}
// Rows named by the reviews of #2071 and this rule's design rounds, and one per admitted form; `kind` is the decision
// the rule must take.
const namedRows = [
  // R1-2: a disabled variant later in the chain.
  ["dark:disabled:opacity-50", "disabled"],
  ["hover:data-[disabled]:opacity-50", "disabled"],
  ["disabled:focus:opacity-50", "disabled"],
  // Final B1: an arbitrary variant.
  ["[&:disabled]:opacity-50", "disabled"],
  // R4-1: recognition.
  ["disabled:data-[label='(']:opacity-50", "unreadable"],
  ["data-[label='(']:disabled:opacity-50", "unreadable"],
  ["disabled:data-[label=')']:opacity-50", "unreadable"],
  ["disabled:aria-[label='(']:opacity-50", "unreadable"],
  ["disabled:data-[label='[']:opacity-50", "unreadable"],
  ["disabled:!opacity-50", "unreadable"],
  // R5-1: an own-element alternative beside `.group` or `.peer`.
  ["[&:is(:where(.group),:disabled)]:opacity-50", "disabled"],
  ["[&:is(:where(.peer),:disabled)]:opacity-50", "disabled"],
  // Design round 2: each own-disabled predicate, and a functional atom's argument.
  ["[&[data-disabled]]:opacity-50", "disabled"],
  ["[&:nth-child(1_of_:disabled)]:opacity-50", "disabled"],
  ["data-[disabled~=true]:opacity-50", "disabled"],
  ["!disabled:opacity-50", "disabled"],
  ["[&:not(:enabled)]:opacity-50", "unclassified"],
  ["has-checked:opacity-50", "unclassified"],
  ["[&:fullscreen]:opacity-50", "unclassified"],
  ["new-state:opacity-50", "unclassified"],
  ["before:hover:opacity-50", "misplaced"],
  ["placeholder:sm:opacity-50", "misplaced"],
  ["hover:before:opacity-50", "pseudo-element"],
  ["max-sm:opacity-70", "breakpoint"],
  ["rtl:opacity-70", "direction"],
  ["focus-visible:opacity-100", "element state"],
  ["data-[state=disabled]:opacity-50", "data attribute"],
  ["data-open:opacity-100", "data attribute"],
  ["group-disabled:opacity-50", "another element"],
  ["group-[&:disabled]:opacity-50", "another element"],
  ["group-[:is(&:disabled)]:opacity-50", "another element"],
  ["peer-[&:disabled]:opacity-50", "another element"],
  ["hover:opacity-(--dim)", "element state"],
  ["disabled:pointer-events-none", "no opacity"],
  ["hover:transition-opacity", "no opacity"],
  ["opacity-50", "no opacity"],
];
const refusals = {
  disabled: "opacity",
  unreadable: "unreadable",
  misplaced: "misplaced",
  unclassified: "unclassified",
};
/** The rule's decision for a token: its refusal (as the rule reports it), else its admitted forms. */
function decision(token) {
  const decisions = classifyOpacityToken(token);
  if (decisions === null) return { refusal: null, kinds: ["no opacity"] };
  const kinds = decisions.map((entry) => entry.kind);
  return { refusal: Object.keys(refusals).find((kind) => kinds.includes(kind)) ?? null, kinds };
}

// The routes class text reaches an element by, each with the expression forms it reads.
const jsString = (token) => `'${token.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const template = (token) => `\`${token.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
const attribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const bound = (expression) => `<button :class="${attribute(expression)}" />`;
const props = (expression) => `<button v-bind="${attribute(`{ ${expression} }`)}" />`;
const classSites = {
  "a static class": (token) => `<button class="${attribute(token)}" />`,
  ":class, a string": (token) => bound(jsString(token)),
  ":class, a template string": (token) => bound(template(token)),
  ":class, a string in a template": (token) => bound(`\`mt-4 \${${jsString(token)}}\``),
  ":class, an array": (token) => bound(`['mt-4', ${jsString(token)}]`),
  ":class, a class map's key": (token) => bound(`{ ${jsString(token)}: active }`),
  ":class, a conditional's branch": (token) => bound(`active ? ${jsString(token)} : 'mt-4'`),
  ":class, a logical right operand": (token) => bound(`active && ${jsString(token)}`),
  ":class, cn()": (token) => bound(`cn(${jsString(token)})`),
  ":class, clsx()": (token) => bound(`clsx(${jsString(token)})`),
  "v-bind's class, a string": (token) => props(`class: ${jsString(token)}`),
  "v-bind's 'class', a string": (token) => props(`'class': ${jsString(token)}`),
  "v-bind's class, a template string": (token) => props(`class: ${template(token)}`),
  "v-bind's class, an array": (token) => props(`class: [${jsString(token)}]`),
  "v-bind's class, a class map's key": (token) => props(`class: { ${jsString(token)}: active }`),
  "v-bind's class, cn()": (token) => props(`class: cn(${jsString(token)})`),
  "cva()": (token) => `cva(${jsString(token)});`,
  "cva()'s variant map": (token) =>
    `cva('', { variants: { tone: { quiet: ${jsString(token)} } } });`,
  "cn() in TypeScript": (token) => `cn(${jsString(token)});`,
  "clsx() in TypeScript": (token) => `clsx(${jsString(token)});`,
};
/** The rule's message per token at `site`, linting every token in one file, one token per line. */
async function siteMessages(site, tokens) {
  const lines = tokens.map(classSites[site]);
  const typescript = !lines[0].startsWith("<");
  const [source, filePath] = typescript
    ? [`import { cva } from 'class-variance-authority';\n${lines.join("\n")}`, tsFile]
    : [
        `<script setup lang="ts">const active = true;</script><template>\n${lines.join("\n")}\n</template>`,
        vueFile,
      ];
  const byLine = new Map();
  for (const message of await messages(source, filePath))
    if (message.ruleId === "design/no-disabled-opacity")
      byLine.set(message.line, message.messageId);
  return tokens.map((_, index) => byLine.get(index + 2) ?? null);
}

let compile;
before(async () => {
  const system = await loadTailwind(process.cwd());
  compile = (tokens) => system.candidatesToCss(tokens).map(judge);
});

test("the disabled-opacity family covers every combination of its axes and every decision", () => {
  const sizes = [disabledSpellings, companionForms, ["", ""], opacityUtilities].map(
    (a) => a.length,
  );
  assert.equal(lexicalFamily.length, 840);
  assert.equal(
    lexicalFamily.length,
    sizes.reduce((product, size) => product * size),
  );
  assert.equal(new Set(lexicalFamily.map(({ axes }) => axes.join("\u0000"))).size, 840);
  assert.equal(representatives.length, 88);
  const decided = new Set(
    [...lexicalFamily.map(({ token }) => token), ...namedRows.map(([token]) => token)].flatMap(
      (token) => {
        const { refusal, kinds } = decision(token);
        return refusal ? [refusal] : kinds;
      },
    ),
  );
  for (const kind of [...Object.keys(ADMITTED_VARIANTS), ...Object.keys(refusals), "no opacity"])
    assert.ok(decided.has(kind), `no row is decided as ${kind}`);
});

test("the named rows take their decisions", () => {
  for (const [token, kind] of namedRows) {
    const { refusal, kinds } = decision(token);
    if (kind in refusals) assert.equal(refusal, kind, token);
    else assert.ok(refusal === null && kinds.includes(kind), `${token}: ${JSON.stringify(kinds)}`);
  }
});

test("the oracle reads each own-disabled predicate, each unknown subject, and another element's state", () => {
  const rows = {
    "disabled:opacity-50": "own",
    "[&[disabled]]:opacity-50": "own",
    "[&[data-disabled]]:opacity-50": "own",
    "[&:is(:where(.group),:disabled)]:opacity-50": "own",
    "[&:is(:where(.peer),:disabled)]:opacity-50": "own",
    "[&:not(:enabled)]:opacity-50": "unknown",
    "[&:fullscreen]:opacity-50": "unknown",
    "[&:nth-child(1_of_:disabled)]:opacity-50": "unknown",
    "before:hover:opacity-50": "unknown",
    "peer-disabled:opacity-50": "clean",
    "group-[&:disabled]:opacity-50": "clean",
    "hover:before:opacity-50": "clean",
    "hover:transition-opacity": "none",
  };
  const verdicts = compile(Object.keys(rows));
  assert.deepEqual(
    Object.fromEntries(Object.keys(rows).map((token, index) => [token, verdicts[index]])),
    rows,
  );
});

test("every subject atom an admitted representative emits is in the oracle's inventory", () => {
  const tokens = representatives.map((variant) => `${variant}:opacity-50`);
  compile(tokens).forEach((verdict, index) => {
    if (decision(tokens[index]).refusal === null)
      assert.equal(verdict, "clean", `${tokens[index]} compiles to ${verdict}`);
  });
});

test("Tailwind's output agrees with the rule over the family, the named rows and the composition matrix", () => {
  const tokens = [
    ...lexicalFamily.map(({ token }) => token),
    ...namedRows.map(([token]) => token),
    ...matrixRows(),
  ];
  const verdicts = compile(tokens);
  tokens.forEach((token, index) => {
    const { refusal, kinds } = decision(token);
    const verdict = verdicts[index];
    if (verdict === "own" || verdict === "unknown")
      assert.notEqual(refusal, null, `${token} compiles to ${verdict} but is admitted`);
    if (refusal === null && !kinds.includes("no opacity"))
      assert.equal(verdict, "clean", `${token} is admitted but compiles to ${verdict}`);
  });
});

for (const site of Object.keys(classSites)) {
  test(`at ${site}, the rule reports each token as it decides it`, async () => {
    const tokens = [
      ...lexicalFamily.map(({ token }) => token),
      ...namedRows.map(([token]) => token),
    ];
    const reported = await siteMessages(site, tokens);
    tokens.forEach((token, index) => {
      const { refusal } = decision(token);
      assert.equal(
        reported[index],
        refusal === null ? null : refusals[refusal],
        `${site}: ${token}`,
      );
    });
  });
}

test("class-map guards, other props and other attributes are not class text", async () => {
  const found = (
    await messages(
      vue(
        [
          `<button :class="{ 'mt-4': 'disabled:opacity-50' }" />`,
          `<button v-bind="{ id: 'disabled:opacity-50', title: \`disabled:opacity-50\` }" />`,
          `<button v-bind="{ class: { 'mt-4': 'disabled:opacity-50' } }" />`,
          `<button :title="'disabled:opacity-50'" data-x="disabled:opacity-50" />`,
        ].join(""),
      ),
    )
  ).filter((message) => message.ruleId === "design/no-disabled-opacity");
  assert.deepEqual(found, []);
});

test("a refused variant's message names it", async () => {
  const found = (
    await messages(
      vue(
        `<button class="[&_svg]:opacity-50" /><button class="data-[x:opacity-50" /><button class="before:hover:opacity-50" />`,
      ),
    )
  ).filter((message) => message.ruleId === "design/no-disabled-opacity");
  assert.match(found[0]?.message ?? "", /'\[&_svg\]' before an opacity class/);
  assert.match(found[1]?.message ?? "", /'data-\[x:opacity-50' names opacity in a form/);
  assert.match(found[2]?.message ?? "", /'before' is a pseudo-element before another variant/);
});

test("inline configuration cannot silence errors", async () => {
  for (const directive of [
    "eslint-disable",
    "eslint-disable shadcn/no-raw-colors",
    "eslint shadcn/no-raw-colors: off",
  ]) {
    await rejects(
      `<script setup lang="ts">/* ${directive} */</script><template><div class="bg-red-500" /></template>`,
      "shadcn/no-raw-colors",
    );
  }
});

test("the ESLint CLI exits nonzero on a real violation", () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/eslint/bin/eslint.js",
      "--config",
      "eslint.design.config.mjs",
      "--stdin",
      "--stdin-filename",
      tsFile,
      "--max-warnings",
      "0",
    ],
    {
      input:
        "import { cva } from 'class-variance-authority'; export const variants = cva('bg-red-500');",
      encoding: "utf8",
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /shadcn\/no-raw-colors/);
});
