import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint({ overrideConfigFile: "eslint.design.config.mjs" });
const vueFile = "player/vue/src/phase2c/App.vue";
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
    "player/vue/src/phase2c/Composer.vue",
  );
  assert.deepEqual(
    await messages(
      vue('<Button class="composer-send" />') +
        "<style scoped>.composer-send { font-weight: 700; }</style>",
      "player/vue/src/phase2c/Composer.vue",
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

test("the real scope includes shared variants and the story material wrapper", async () => {
  for (const file of [
    tsFile,
    "player/vue/src/components/ui/bubble/index.ts",
    "player/vue/src/components/PlayerActionButton.vue",
    "player/vue/src/phase2c/TranscriptMessage.vue",
    "player/vue/src/phase2c/Composer.vue",
  ]) {
    assert.deepEqual(await messages(readFileSync(file, "utf8"), file), [], file);
  }
});
