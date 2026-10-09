<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Check, Copy, Maximize2, TextWrap } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Toggle } from "@/components/ui/toggle";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { CodeLine, CodeTokenClass } from "./randomDrawPresentation";

// A block of code like an editor's (DEBUGGER.md "Random draws"): on the page's background, line numbers in a gutter,
// tokens in the theme's `syntax-*` colours, and one line highlighted with its marked part. It shows `rows` lines and
// scrolls through all of them; the grip in its bottom-right corner resizes it a whole line at a time. While it shows a
// line in focus, that line stays centred; otherwise the last line stays at the bottom. Its tools, top right, float over
// the code on the title bar's translucent material while the pointer is over the block, or one of them has keyboard
// focus; on a touch screen they always show. Copy copies the lines in view, Wrap wraps long lines, which otherwise
// scroll sideways, and Expand opens all of it large over the page, with the `title` slot as its title. `fill` is the
// block in that large view: as tall as its lines up to most of the screen, with no grip or Expand.
const props = defineProps<{
  lines: readonly CodeLine[];
  /** The block's name, for assistive technology and as the title of its large view. */
  label: string;
  /** The line kept in view: centred, or from the top when `focus.top` holds; `null` keeps the bottom in view. */
  focus: { readonly line: number; readonly top?: boolean } | null;
  /** The highlighted line, whose marked segments are underlined, or `null`. */
  highlight: number | null;
  fill?: boolean;
}>();
const rows = defineModel<number>("rows", { default: 7 });
const emit = defineEmits<{ resized: [] }>();

const MIN_ROWS = 2;
const maxRows = computed(() => Math.max(MIN_ROWS, Math.min(props.lines.length, 40)));
const wrap = ref(false);
const expanded = ref(false);

const tokenClasses: Record<CodeTokenClass, string> = {
  keyword: "code-block-keyword",
  string: "code-block-string",
  number: "code-block-number",
  comment: "code-block-comment",
  name: "code-block-name",
  operator: "code-block-operator",
};
// The gutter holds the longest number with its padding, so it also covers code scrolled sideways under it.
const gutter = computed(() => `calc(${String(props.lines.at(-1)?.number ?? 1).length}ch + 20px)`);
// A wrapped line goes on at its own indent.
function hangingIndent(line: CodeLine) {
  if (!wrap.value) return undefined;
  const indent = /^[ \t]*/.exec(line.segments.map((segment) => segment.text).join(""))![0];
  const width = [...indent].reduce((sum, character) => sum + (character === "\t" ? 4 : 1), 0);
  return width === 0 ? undefined : { paddingInlineStart: `${width}ch`, textIndent: `-${width}ch` };
}

const scroller = ref<HTMLElement | null>(null);
function lineElement(number: number) {
  return scroller.value?.querySelector<HTMLElement>(`[data-code-line="${number}"]`) ?? null;
}
function keepInView() {
  const container = scroller.value;
  if (container === null) return;
  const focus = props.focus;
  if (focus === null) {
    container.scrollTop = container.scrollHeight;
    return;
  }
  const line = lineElement(focus.line);
  if (line === null) return;
  // Whole lines above it: half the others, the odd one below, so each added line alternates below and above. The large
  // view has no line count, so it centres the line.
  container.scrollTop = focus.top
    ? line.offsetTop
    : props.fill
      ? line.offsetTop - (container.clientHeight - line.offsetHeight) / 2
      : line.offsetTop - Math.floor((rows.value - 1) / 2) * line.offsetHeight;
}
onMounted(keepInView);
watch(
  [rows, wrap, () => props.focus, () => props.lines],
  async () => {
    await nextTick();
    keepInView();
  },
  { flush: "post" },
);

// Resizing snaps to whole lines: the pointer's distance in line heights, rounded.
let drag: { readonly y: number; readonly rows: number; readonly line: number } | null = null;
const dragging = ref(false);
function setRows(next: number) {
  const clamped = Math.min(maxRows.value, Math.max(MIN_ROWS, next));
  if (clamped === rows.value) return;
  rows.value = clamped;
  emit("resized");
}
function startResize(event: PointerEvent) {
  const line = scroller.value?.querySelector<HTMLElement>("[data-code-line]")?.offsetHeight ?? 19;
  drag = { y: event.clientY, rows: rows.value, line };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveResize(event: PointerEvent) {
  if (drag !== null) setRows(drag.rows + Math.round((event.clientY - drag.y) / drag.line));
}
function endResize() {
  drag = null;
  dragging.value = false;
}
function resizeKey(event: KeyboardEvent) {
  const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  setRows(rows.value + step);
}

// The lines at least partly in view, with their elements.
function shownLines(): { line: CodeLine; element: HTMLElement }[] {
  const container = scroller.value;
  if (container === null) return [];
  const top = container.scrollTop;
  const bottom = top + container.clientHeight;
  return props.lines.flatMap((line) => {
    const element = lineElement(line.number);
    return element !== null &&
      element.offsetTop + element.offsetHeight > top &&
      element.offsetTop < bottom
      ? [{ line, element }]
      : [];
  });
}
// Outside a secure context the clipboard API is missing; the selection route copies where the browser allows it, and
// focus returns to where it was. Its field sits in the block, so a dialog around the large view keeps focus on it.
function copyBySelection(text: string): boolean {
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  (scroller.value?.parentElement ?? document.body).append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  return copied;
}
// Where the browser refuses both routes, the lines in view are selected, so the player copies them with the browser.
function selectLines(elements: readonly HTMLElement[]) {
  const [first, last] = [elements[0], elements.at(-1)];
  const selection = document.getSelection();
  if (first === undefined || last === undefined || selection === null) return;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  selection.removeAllRanges();
  selection.addRange(range);
}
const copyStatus = ref<"" | "copied" | "failed">("");
const copyLabel = computed(() =>
  copyStatus.value === "copied"
    ? "Copied"
    : copyStatus.value === "failed"
      ? "Copying is not available here. The lines are selected, so copy them with the browser."
      : "Copy visible lines",
);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  const shown = shownLines();
  const text = shown.map(({ line }) => line.segments.map((segment) => segment.text).join("")).join("\n");
  let copied = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    copied = copyBySelection(text);
  }
  if (!copied) selectLines(shown.map(({ element }) => element));
  copyStatus.value = copied ? "copied" : "failed";
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copyStatus.value = ""), 1500);
}
</script>

<template>
  <div class="code-block-frame" :class="{ 'code-block-fill': fill }" data-code-block-frame>
    <!-- prettier-ignore -->
    <pre
      ref="scroller"
      class="code-block"
      :class="{ 'code-block-wrap': wrap }"
      :style="{ '--gutter': gutter, '--rows': rows }"
      tabindex="0"
      role="region"
      :aria-label="label"
      data-code-block
    ><code><span
      v-for="line in lines"
      :key="line.number"
      class="code-block-line"
      :data-code-line="line.number"
      :data-code-highlight="line.number === highlight || undefined"
    ><span class="code-block-gutter" aria-hidden="true">{{ line.number }}</span><span class="code-block-text" :style="hangingIndent(line)"><span
      v-for="(segment, index) in line.segments"
      :key="index"
      :class="[segment.kind && tokenClasses[segment.kind], { 'code-block-mark': segment.mark }]"
      :data-code-mark="segment.mark || undefined"
    >{{ segment.text }}</span>{{ line.segments.length ? "" : " " }}</span></span></code></pre>
    <div class="code-block-tools" data-code-block-tools>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="copyLabel"
            data-code-block-copy
            @click="copy"
          >
            <component :is="copyStatus === 'copied' ? Check : Copy" />
          </Button>
        </TooltipTrigger>
        <!-- The failure text wraps within the screen. -->
        <TooltipContent :collision-padding="8" class="max-w-(--reka-tooltip-content-available-width)">{{
          copyLabel
        }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <span class="inline-flex">
            <Toggle
              v-model="wrap"
              size="sm"
              aria-label="Wrap long lines"
              data-code-block-wrap
            >
              <TextWrap />
            </Toggle>
          </span>
        </TooltipTrigger>
        <TooltipContent>Wrap long lines</TooltipContent>
      </Tooltip>
      <Tooltip v-if="!fill">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="`Expand ${label}`"
            data-code-block-expand
            @click="expanded = true"
          >
            <Maximize2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Expand</TooltipContent>
      </Tooltip>
    </div>
    <div
      v-if="!fill"
      class="code-block-grip"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="`Resize ${label}`"
      :aria-valuenow="rows"
      :aria-valuemin="MIN_ROWS"
      :aria-valuemax="maxRows"
      :data-active="dragging ? '' : undefined"
      data-code-block-resize
      @pointerdown="startResize"
      @pointermove="moveResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @keydown="resizeKey"
    >
      <!-- The two strokes of a text field's resize corner. -->
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M9 1 1 9M9 5.5 5.5 9" />
      </svg>
    </div>
    <!-- The large view, like a photo opened from its thumbnail; its X, Escape, and the dimmed page close it. -->
    <Dialog v-if="!fill" v-model:open="expanded">
      <DialogContent
        class="max-h-[80dvh] w-[min(64rem,calc(100%-2rem))] max-w-none gap-3 p-4 sm:max-w-none"
        :aria-describedby="undefined"
        data-code-block-lightbox
      >
        <DialogTitle as-child class="min-h-6 pe-10 text-sm font-normal">
          <slot name="title" />
        </DialogTitle>
        <CodeBlock :lines="lines" :label="label" :focus="focus" :highlight="highlight" fill />
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/* A long line scrolls inside the block; it never widens what holds the block. */
.code-block-frame {
  position: relative;
  min-width: 0;
}
.code-block-fill > .code-block {
  height: auto;
  max-height: calc(80dvh - 6rem);
}
.code-block {
  --line: 1.2rem;
  /* Lines measure their place from the block itself. */
  position: relative;
  box-sizing: border-box;
  height: calc(var(--rows) * var(--line) + 2px);
  margin: 0;
  overflow: auto;
  border: 1px solid var(--theme-border-subtle);
  border-radius: var(--radius-md);
  background: var(--theme-surface-canvas);
  color: var(--theme-syntax-name);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: var(--line);
}
.code-block-line {
  display: grid;
  grid-template-columns: var(--gutter) max-content;
  min-width: 100%;
  width: max-content;
  padding-inline-end: 8px;
}
.code-block-wrap .code-block-line {
  grid-template-columns: var(--gutter) minmax(0, 1fr);
  width: auto;
}
/* The gutter stays in view while long lines scroll sideways. */
.code-block-gutter {
  position: sticky;
  inset-inline-start: 0;
  padding-inline: 8px 12px;
  background: var(--theme-surface-canvas);
  color: var(--theme-text-secondary);
  text-align: end;
  user-select: none;
}
.code-block-line[data-code-highlight],
.code-block-line[data-code-highlight] .code-block-gutter {
  background: color-mix(in oklab, var(--theme-accent-solid) 10%, var(--theme-surface-canvas));
}
.code-block-text {
  white-space: pre;
  tab-size: 4;
}
.code-block-wrap .code-block-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.code-block-name {
  color: var(--theme-syntax-name);
}
/* Keywords stand out by weight as well, as their colour is the text colour. */
.code-block-keyword {
  color: var(--theme-syntax-keyword);
  font-weight: 600;
}
.code-block-string {
  color: var(--theme-syntax-string);
}
.code-block-number {
  color: var(--theme-syntax-number);
}
.code-block-comment {
  color: var(--theme-syntax-comment);
  font-style: italic;
}
.code-block-operator {
  color: var(--theme-syntax-operator);
}
.code-block-mark {
  text-decoration: underline 2px var(--theme-accent-mark);
  text-underline-offset: 3px;
}
/* The tools float top right over the code as the title bar's control group: one pill of its translucent material with
   a thin outline, so code shows through. */
.code-block-tools {
  --tools-radius: var(--player-top-control-radius);
  position: absolute;
  inset-block-start: 4px;
  inset-inline-end: 4px;
  display: flex;
  gap: 0.125rem;
  border: 1px solid var(--media-border);
  border-radius: var(--tools-radius);
  background: var(--media-surface);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
  opacity: 0;
  transition: opacity 120ms ease;
}
/* As in the title bar's group: each tool's hover fill and focus outline frame the whole tool. */
.code-block-tools :deep(button) {
  block-size: calc(var(--player-top-control-size) - 2px);
  border-radius: calc(var(--tools-radius) - 1px);
}
/* Only while the pointer is over the block, or a tool has keyboard focus: a click in the code then moving away hides
   them. */
.code-block-frame:hover > .code-block-tools,
.code-block-tools:has(:focus-visible) {
  opacity: 1;
}
/* Without hover they always show, in the same place. In the large view, a reading view, the code starts below them. */
@media (hover: none) {
  .code-block-tools {
    opacity: 1;
  }
  .code-block-fill > .code-block {
    padding-block-start: calc(var(--player-top-control-size) + 8px);
  }
}
.code-block-grip {
  position: absolute;
  inset-block-end: 1px;
  inset-inline-end: 1px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-end-end-radius: var(--radius-md);
  background: var(--theme-surface-canvas);
  color: var(--theme-text-secondary);
  cursor: ns-resize;
  touch-action: none;
}
.code-block-grip svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.2;
}
/* A finger gets a larger corner; the strokes stay the same. */
@media (pointer: coarse) {
  .code-block-grip {
    width: 32px;
    height: 32px;
    place-items: end;
    padding: 3px;
  }
}
.code-block-grip:hover,
.code-block-grip[data-active] {
  color: var(--theme-text-primary);
}
.code-block-grip:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .code-block-tools {
    transition: none;
  }
}
</style>
