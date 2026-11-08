import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { ESLint } from "eslint";
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

// The disabled-opacity rule over its axes: the lexical form of the variants, their order, the opacity utility's
// spelling and where the class is written. Tailwind's own output is the oracle: a class it compiles to an opacity
// declaration on a selector naming the element's own `:disabled` or `[data-disabled]` must be refused, and a class the
// rule admits must compile, to a selector naming neither.
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
const family = [];
for (const disabled of disabledSpellings)
  for (const companion of companionForms)
    for (const order of ["disabled first", "companion first"])
      for (const utility of opacityUtilities) {
        const variants = order === "disabled first" ? [disabled, companion] : [companion, disabled];
        family.push({
          token: [...variants.filter(Boolean), utility].join(":"),
          axes: [disabled, companion, order, utility],
        });
      }
// Rows named by the reviews, and one per admitted form; `kind` is the decision the rule must take.
const namedRows = [
  ["disabled:data-[label='(']:opacity-50", "unreadable"],
  ["data-[label='(']:disabled:opacity-50", "unreadable"],
  ["[&:disabled]:opacity-50", "disabled"],
  ["dark:disabled:opacity-50", "disabled"],
  ["hover:data-[disabled]:opacity-50", "disabled"],
  ["disabled:focus:opacity-50", "disabled"],
  ["!disabled:opacity-50", "disabled"],
  ["[&:not(:enabled)]:opacity-50", "unclassified"],
  ["has-checked:opacity-50", "unclassified"],
  ["max-sm:opacity-70", "breakpoint"],
  ["rtl:opacity-70", "direction"],
  ["focus-visible:opacity-100", "element state"],
  ["before:opacity-50", "pseudo-element"],
  ["data-[state=disabled]:opacity-50", "data attribute"],
  ["data-open:opacity-100", "data attribute"],
  ["group-disabled:opacity-50", "another element"],
  ["group-[&:disabled]:opacity-50", "another element"],
  ["group-[:is(&:disabled)]:opacity-50", "another element"],
  ["group-[&:is(.group),&:disabled]:opacity-50", "another element"],
  ["peer-[&:disabled]:opacity-50", "another element"],
  ["data-[disabled~=true]:opacity-50", "disabled"],
  ["disabled:data-[label=')']:opacity-50", "unreadable"],
  ["disabled:aria-[label='(']:opacity-50", "unreadable"],
  ["disabled:data-[label='[']:opacity-50", "unreadable"],
  ["disabled:!opacity-50", "unreadable"],
  ["new-state:opacity-50", "unclassified"],
  ["hover:opacity-(--dim)", "element state"],
  ["disabled:pointer-events-none", "no opacity"],
  ["hover:transition-opacity", "no opacity"],
  ["opacity-50", "no opacity"],
];
const refusals = { disabled: "opacity", unclassified: "unclassified", unreadable: "unreadable" };
/** The rule's decision for a token: its refusal (`unreadable`, `disabled`, `unclassified`), else its admitted forms. */
function decision(token) {
  const decisions = classifyOpacityToken(token);
  if (decisions === null) return { refusal: null, kinds: ["no opacity"] };
  const kinds = decisions.map((entry) => entry.kind);
  return {
    refusal:
      ["unreadable", "disabled", "unclassified"].find((kind) => kinds.includes(kind)) ?? null,
    kinds,
  };
}

const jsString = (token) => `'${token.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const attribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const classSites = {
  "a static class": (token) => `<button class="${attribute(token)}" />`,
  "a bound string": (token) => `<button :class="${attribute(jsString(token))}" />`,
  "cn()": (token) => `<button :class="${attribute(`cn(${jsString(token)})`)}" />`,
  "an object binding": (token) =>
    `<button :class="${attribute(`{ ${jsString(token)}: active }`)}" />`,
  "an array binding": (token) => `<button :class="${attribute(`['mt-4', ${jsString(token)}]`)}" />`,
  "a cva variant": (token) => `cva(${jsString(token)});`,
};
/** The rule's message per token at `site`, linting every token in one file, one token per line. */
async function siteMessages(site, tokens) {
  const lines = tokens.map(classSites[site]);
  const [source, filePath] =
    site === "a cva variant"
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

let oracle;
before(async () => {
  const tailwind = await import("tailwindcss");
  const cssFile = path.resolve("player/vue/src/style.css");
  const system = await tailwind.__unstable__loadDesignSystem(readFileSync(cssFile, "utf8"), {
    base: path.dirname(cssFile),
    async loadStylesheet(id, base) {
      let file = path.resolve(base, id);
      if (!id.startsWith(".")) {
        const directory = path.resolve("node_modules", id);
        const entry = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        file = path.join(directory, entry.exports?.["."]?.style ?? entry.style);
      }
      return { base: path.dirname(file), content: readFileSync(file, "utf8") };
    },
  });
  oracle = (tokens) => system.candidatesToCss(tokens).map(selectsOwnDisabledState);
});
/** `selector` without each `:is(…)` that names Tailwind's `.group` or `.peer`: those select another element. */
function withoutOtherElements(selector) {
  let own = "";
  for (let index = 0; index < selector.length; index++) {
    if (selector.startsWith(":is(", index)) {
      let depth = 0;
      let end = index + 3;
      for (; end < selector.length; end++) {
        if (selector[end] === "(") depth++;
        else if (selector[end] === ")" && --depth === 0) break;
      }
      const group = selector.slice(index, end + 1);
      if (/:where\(\.(?:group|peer)\b/.test(group)) {
        index = end;
        continue;
      }
    }
    own += selector[index];
  }
  return own;
}
/**
 * What Tailwind's CSS for one class does: `null` when it compiles to no opacity declaration, else whether a selector
 * of one names the element's own `:disabled` or `[data-disabled]`. Escapes belong to the class name, and what names
 * `.group` or `.peer` selects another element, so both are left out.
 */
function selectsOwnDisabledState(css) {
  if (css === null) return null;
  let opacity = false;
  let disabled = false;
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[;\s])opacity\s*:/.test(declarations)) continue;
    opacity = true;
    const own = withoutOtherElements(selector.replace(/\\./g, ""));
    if (/:disabled|\[data-disabled/.test(own)) disabled = true;
  }
  return opacity ? disabled : null;
}

test("the disabled-opacity family covers every combination of its axes, and every decision the rule takes", () => {
  const sizes = [disabledSpellings, companionForms, ["", ""], opacityUtilities].map(
    (axis) => axis.length,
  );
  assert.equal(
    family.length,
    sizes.reduce((product, size) => product * size),
  );
  assert.equal(new Set(family.map(({ axes }) => axes.join("\u0000"))).size, family.length);
  const decided = new Set(
    [...family.map(({ token }) => token), ...namedRows.map(([token]) => token)].flatMap((token) => {
      const { refusal, kinds } = decision(token);
      return refusal ? [refusal] : kinds;
    }),
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

test("Tailwind's output agrees: what selects a disabled control is refused, and what is admitted selects none", () => {
  const tokens = [...family.map(({ token }) => token), ...namedRows.map(([token]) => token)];
  const disabled = oracle(tokens);
  tokens.forEach((token, index) => {
    const { refusal, kinds } = decision(token);
    if (disabled[index] === true)
      assert.notEqual(refusal, null, `${token} selects a disabled control`);
    if (refusal === null && !kinds.includes("no opacity"))
      assert.equal(
        disabled[index],
        false,
        `${token} is admitted but compiles to ${disabled[index]}`,
      );
  });
  // The reviews' reproductions compile to disabled selectors, so the oracle rows are not vacuous.
  assert.deepEqual(
    oracle([
      "disabled:data-[label='(']:opacity-50",
      "[&:disabled]:opacity-50",
      "dark:disabled:opacity-50",
    ]),
    [true, true, true],
  );
});

for (const site of Object.keys(classSites)) {
  test(`at ${site}, the rule reports each family token as it decides it`, async () => {
    const tokens = [...family.map(({ token }) => token), ...namedRows.map(([token]) => token)];
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

test("a refused variant's message names it", async () => {
  const found = (
    await messages(
      vue('<button class="[&_svg]:opacity-50" /><button :class="\'data-[x:opacity-50\'" />'),
    )
  ).filter((message) => message.ruleId === "design/no-disabled-opacity");
  assert.match(found[0]?.message ?? "", /'\[&_svg\]' before an opacity class/);
  assert.match(
    found[1]?.message ?? "",
    /'data-\[x:opacity-50' names opacity in a form this rule cannot read/,
  );
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
