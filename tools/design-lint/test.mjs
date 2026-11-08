import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
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

// The disabled-opacity rule over its two axes: where a class is written, and the form of the variants before an opacity
// utility. Every form the classifier knows has a row, refused or admitted, and every row runs at every site.
const classSites = {
  "a static class": (token) => [vue(`<button class="${token}" />`)],
  "a bound string": (token) => [vue(`<button :class="'${token}'" />`)],
  "cn()": (token) => [vue(`<button :class="cn('${token}')" />`)],
  "an object binding": (token) => [vue(`<button :class="{ '${token}': active }" />`)],
  "an array binding": (token) => [vue(`<button :class="['mt-4', '${token}']" />`)],
  "a cva variant": (token) => [
    `import { cva } from 'class-variance-authority'; export const variants = cva('${token}');`,
    tsFile,
  ],
};
const opacityForms = [
  ["disabled:opacity-50", "disabled"],
  ["disabled:opacity-[0.4]", "disabled"],
  ["disabled:[opacity:0.5]", "disabled"],
  ["!disabled:opacity-50", "disabled"],
  ["data-disabled:opacity-50", "disabled"],
  ["data-[disabled]:opacity-50", "disabled"],
  ["data-[disabled=true]:opacity-50", "disabled"],
  ["[&:disabled]:opacity-50", "disabled"],
  ["[&[disabled]]:opacity-50", "disabled"],
  ["dark:disabled:opacity-50", "disabled"],
  ["disabled:focus:opacity-50", "disabled"],
  ["hover:data-[disabled]:opacity-50", "disabled"],
  ["[&:not(:enabled)]:opacity-50", "unclassified"],
  ["[&_svg]:opacity-50", "unclassified"],
  ["not-enabled:opacity-50", "unclassified"],
  ["has-checked:opacity-50", "unclassified"],
  ["md:hover:opacity-100", "breakpoint"],
  ["max-sm:opacity-70", "breakpoint"],
  ["dark:opacity-70", "media"],
  ["rtl:opacity-70", "direction"],
  ["hover:opacity-100", "element state"],
  ["focus-visible:opacity-100", "element state"],
  ["before:opacity-50", "pseudo-element"],
  ["aria-disabled:opacity-50", "aria"],
  ["aria-[busy=true]:opacity-50", "aria"],
  ["data-[state=closed]:opacity-0", "data attribute"],
  ["data-[state=disabled]:opacity-50", "data attribute"],
  ["data-open:opacity-100", "data attribute"],
  ["peer-disabled:opacity-50", "another element"],
  ["group-disabled:opacity-50", "another element"],
  ["group-hover/item:opacity-100", "another element"],
  ["disabled:pointer-events-none", "no opacity"],
  ["opacity-50", "no opacity"],
];
const refusedKinds = { disabled: "opacity", unclassified: "unclassified" };

test("every variant form the disabled-opacity rule knows has a row, at every class site", () => {
  const kinds = new Set(opacityForms.map(([, kind]) => kind));
  for (const kind of [
    ...Object.keys(ADMITTED_VARIANTS),
    ...Object.keys(refusedKinds),
    "no opacity",
  ])
    assert.ok(kinds.has(kind), `no row for ${kind}`);
  assert.equal(Object.keys(classSites).length, 6);
});

for (const [token, kind] of opacityForms) {
  test(`${token} is ${kind in refusedKinds ? "refused" : "admitted"} (${kind}) at every class site`, async () => {
    // A refused token's decision is its disabled variant, else its first unclassified one; an admitted token has the
    // row's form among its variants and nothing refused.
    const decisions = classifyOpacityToken(token);
    const kinds = decisions?.map((decision) => decision.kind) ?? ["no opacity"];
    const refused = ["disabled", "unclassified"].find((refusal) => kinds.includes(refusal));
    if (kind in refusedKinds) assert.equal(refused, kind, JSON.stringify(decisions));
    else assert.ok(refused === undefined && kinds.includes(kind), JSON.stringify(decisions));
    let sites = 0;
    for (const [site, source] of Object.entries(classSites)) {
      const found = (await messages(...source(token))).filter(
        (message) => message.ruleId === "design/no-disabled-opacity",
      );
      assert.deepEqual(
        found.map((message) => message.messageId),
        kind in refusedKinds ? [refusedKinds[kind]] : [],
        `${site}: ${JSON.stringify(found)}`,
      );
      sites++;
    }
    assert.equal(sites, Object.keys(classSites).length);
  });
}

test("an unclassified variant's message names it", async () => {
  const [found] = (await messages(vue('<button class="[&_svg]:opacity-50" />'))).filter(
    (message) => message.ruleId === "design/no-disabled-opacity",
  );
  assert.match(found?.message ?? "", /'\[&_svg\]' before an opacity class/);
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
