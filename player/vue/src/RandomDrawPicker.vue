<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical } from "@lucide/vue";
import { RadioGroupItem, RadioGroupRoot } from "reka-ui";
import Sortable from "sortablejs";
import { Button, buttonVariants } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RandomDrawView, RandomOutcome, RandomSite } from "../../../src/index.js";
import CodeBlock from "./CodeBlock.vue";
import PathBreadcrumb from "./PathBreadcrumb.vue";
import {
  CONTEXT_ROWS,
  outcomeLines,
  randomDrawChoices,
  randomDrawCode,
} from "./randomDrawPresentation";
import { outcomeKey, type DebugRandomNext, type DebugRandomTried } from "./useDebugRandom";

// The random draw picker (DEBUGGER.md "Random draws"): the session is paused at a draw, shown in its file's code. A
// click on an outcome resumes with it, a typed value or a new order with its Use button, Least tried with the outcome
// the site has taken least, and Random with the natural outcome. Counts on the outcomes and the list of earlier
// outcomes show what the site took before. Next time sets what the draw's site does when it draws again. Only those
// close it: the session waits. It is not modal: the Player keeps the controls `useRandomDrawGuard` allows usable
// meanwhile.
const props = defineProps<{
  draw: RandomDrawView;
  /** The draw's site in the plan, or `null` when the plan does not list it. */
  site: RandomSite | null;
  /** The source text of the draw's file, or `null` when the host did not supply it. */
  source: string | null;
  /** The package's name, the breadcrumb's first part, or `null`. */
  root: string | null;
  /** What the site took before; see `DebugRandomTried`. */
  tried: DebugRandomTried;
}>();
const next = defineModel<DebugRandomNext>("next", { required: true });
const emit = defineEmits<{ resolve: [outcome: RandomOutcome | "natural"]; untried: [] }>();

// The site's earlier outcomes, numbered from its first draw, the newest at the bottom, in view when it opens.
const history = computed(() => outcomeLines(props.tried.history, props.tried.first));
const historyRows = ref(Math.min(4, Math.max(1, props.tried.history.length)));

const choices = computed(() => randomDrawChoices(props.draw));
// Each outcome is an outline Button as a plain element: thousands of components take seconds to mount and update.
const outcomeClass = cn(
  buttonVariants({ variant: "outline" }),
  "h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words text-start",
);
const code = computed(() =>
  props.source === null || props.site === null ? null : randomDrawCode(props.source, props.site),
);
// The whole file, showing the draw's line in the middle of 7 lines, or the range Show whole fits from its top.
const sourceRows = ref(CONTEXT_ROWS);
const expanded = ref(false);
const sourceFocus = computed(() => {
  const range = code.value?.enclosing;
  return expanded.value && range
    ? { line: range.from, top: true }
    : { line: props.site?.line ?? 1 };
});
function toggleExpanded() {
  const range = code.value?.enclosing;
  expanded.value = !expanded.value && range != null;
  sourceRows.value = expanded.value && range ? Math.min(range.to - range.from + 1, 40) : CONTEXT_ROWS;
}
const expandLabels = {
  function: "Show whole function",
  block: "Show whole block",
  file: "Show whole file",
} as const;

const typed = ref("");
const typedValue = computed(() => {
  const current = choices.value;
  if (current.kind !== "number" || typed.value.trim() === "") return null;
  const value = Number(typed.value);
  return current.accepts(value) ? value : null;
});
// The shuffle's items in the order shown, as their old indexes.
const order = ref<number[]>([]);
watch(
  () => props.draw.drawId,
  () => {
    typed.value = "";
    const items = choices.value.kind === "order" ? choices.value.items : [];
    order.value = items.map((_, index) => index);
  },
  { immediate: true },
);
function move(position: number, direction: -1 | 1) {
  const destination = position + direction;
  if (destination < 0 || destination >= order.value.length) return;
  const moved = [...order.value];
  [moved[position], moved[destination]] = [moved[destination]!, moved[position]!];
  order.value = moved;
}
const list = ref<HTMLElement | null>(null);
watch(
  list,
  (element, _, onCleanup) => {
    if (element === null) return;
    let originalNextSibling: ChildNode | null = null;
    const sortable = new Sortable(element, {
      // The tool panels' drag: a copy on the page follows the pointer, outside the dialog, so it never makes it scroll,
      // and the other items make room.
      handle: "[data-random-order-handle]",
      direction: "vertical",
      animation: 150,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 5,
      ghostClass: "reorder-drag-placeholder",
      fallbackClass: "reorder-dragging",
      onStart(event) {
        originalNextSibling = event.item.nextSibling;
      },
      onEnd(event) {
        // Undo Sortable's DOM move before Vue applies the authoritative keyed-list update.
        element.insertBefore(event.item, originalNextSibling);
        if (event.oldIndex === undefined || event.newIndex === undefined) return;
        const moved = [...order.value];
        const [item] = moved.splice(event.oldIndex, 1);
        if (item === undefined) return;
        moved.splice(event.newIndex, 0, item);
        order.value = moved;
      },
    });
    onCleanup(() => sortable.destroy());
  },
  { flush: "post" },
);

function use() {
  const current = choices.value;
  if (current.kind === "order") emit("resolve", { kind: "order", order: [...order.value] });
  else if (current.kind === "number" && typedValue.value !== null)
    emit("resolve", { kind: "number", value: typedValue.value });
}

const nextOptions: readonly { readonly value: DebugRandomNext; readonly label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "random", label: "Random" },
  { value: "untried", label: "Prefer untried" },
];
const fieldId = useId();
const nextId = useId();
// The natural outcome is the safe default: focus starts on Random, so Enter never picks an outcome by accident.
const randomButton = ref<InstanceType<typeof Button> | null>(null);
function focusRandom(event: Event) {
  event.preventDefault();
  (randomButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <Dialog :open="true" :modal="false">
    <DialogContent
      class="top-[10dvh] max-h-[calc(90dvh-1rem)] translate-y-0 overflow-y-auto"
      :show-close-button="false"
      data-random-draw-picker
      :data-random-draw-kind="draw.kind"
      :data-random-draw-site="draw.site"
      @interact-outside.prevent
      @escape-key-down.prevent
      @open-auto-focus="focusRandom"
    >
      <DialogHeader class="min-w-0">
        <DialogTitle>Random draw</DialogTitle>
        <DialogDescription as-child>
          <PathBreadcrumb
            :path="site?.path ?? draw.site"
            :root="root"
            class="[&_ol]:justify-center sm:[&_ol]:justify-start"
            data-random-draw-location
          />
        </DialogDescription>
      </DialogHeader>
      <div v-if="code" class="grid min-w-0 gap-1" data-random-draw-source>
        <CodeBlock
          v-model:rows="sourceRows"
          :lines="code.lines"
          :label="site?.path ?? draw.site"
          :focus="sourceFocus"
          :highlight="site?.line ?? null"
          @resized="expanded = false"
        >
          <template #title
            ><PathBreadcrumb :path="site?.path ?? draw.site" :root="root" wrap
          /></template>
        </CodeBlock>
        <Button
          v-if="code.enclosing"
          variant="ghost"
          size="xs"
          class="justify-self-start"
          :aria-expanded="expanded"
          data-random-draw-expand
          @click="toggleExpanded"
        >
          {{ expanded ? "Show less" : expandLabels[code.enclosing.kind] }}
          <component :is="expanded ? ChevronUp : ChevronDown" aria-hidden="true" />
        </Button>
      </div>

      <!-- The list scrolls, so it clips: its 4px inner gutter keeps an outcome's 2px focus outline and 2px separation
           inside, also where focus scrolls an outcome into view, and the negative margin keeps the layout as it was. -->
      <div
        v-if="choices.kind === 'buttons'"
        role="group"
        aria-label="Outcomes"
        class="-m-1 flex max-h-74 scroll-py-1 flex-wrap gap-2 overflow-y-auto p-1"
        data-random-draw-outcomes
      >
        <button
          v-for="(choice, index) in choices.outcomes"
          :key="index"
          data-slot="button"
          data-button
          data-variant="outline"
          :class="outcomeClass"
          data-random-draw-outcome
          @click="emit('resolve', choice.outcome)"
        >
          {{ choice.label }}
          <template v-if="tried.counts.get(outcomeKey(choice.outcome))">
            <span class="text-xs text-muted-foreground tabular-nums" aria-hidden="true"
              >×{{ tried.counts.get(outcomeKey(choice.outcome)) }}</span
            >
            <span class="sr-only"
              >, {{ tried.counts.get(outcomeKey(choice.outcome)) }} times before</span
            >
          </template>
        </button>
      </div>
      <form
        v-else-if="choices.kind === 'number'"
        class="grid gap-2 text-sm"
        novalidate
        @submit.prevent="use"
      >
        <label :for="fieldId">Outcome</label>
        <Input
          :id="fieldId"
          v-model="typed"
          :inputmode="choices.integer ? 'numeric' : 'decimal'"
          autocomplete="off"
          :aria-invalid="typed.trim() !== '' && typedValue === null"
          data-random-draw-value
        />
        <p class="text-muted-foreground" data-random-draw-hint>{{ choices.hint }}</p>
      </form>
      <ol v-else ref="list" aria-label="Order" class="grid gap-1 text-sm" data-random-draw-order>
        <li
          v-for="(item, position) in order"
          :key="item"
          class="flex min-h-11 items-center gap-1 rounded-md border bg-background ps-1"
          data-random-draw-item
        >
          <span
            class="grid size-8 shrink-0 cursor-grab place-items-center text-muted-foreground"
            aria-hidden="true"
            data-random-order-handle
            ><GripVertical class="size-4"
          /></span>
          <span class="min-w-0 flex-1 break-words">{{ choices.items[item] }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-11"
            :class="{ invisible: position === 0 }"
            aria-label="Move up"
            @click="move(position, -1)"
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-11"
            :class="{ invisible: position === order.length - 1 }"
            aria-label="Move down"
            @click="move(position, 1)"
          >
            <ArrowDown />
          </Button>
        </li>
      </ol>

      <div v-if="history.length" class="grid min-w-0 gap-1.5" data-random-draw-history>
        <span class="text-xs text-muted-foreground">Earlier outcomes</span>
        <CodeBlock
          v-model:rows="historyRows"
          :lines="history"
          label="Earlier outcomes"
          :focus="null"
          :highlight="null"
        >
          <template #title><span>Earlier outcomes</span></template>
        </CodeBlock>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span :id="nextId">Next time</span>
        <RadioGroupRoot
          v-model="next"
          orientation="horizontal"
          :aria-labelledby="nextId"
          class="inline-flex min-h-11 items-center rounded-lg bg-muted p-0.75 text-muted-foreground"
          data-random-draw-next
        >
          <RadioGroupItem
            v-for="option in nextOptions"
            :key="option.value"
            :value="option.value"
            class="inline-flex h-full min-h-10 items-center justify-center rounded-md border border-transparent px-2 text-sm font-medium whitespace-nowrap text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:bg-background data-[state=checked]:shadow-sm dark:text-muted-foreground dark:data-[state=checked]:border-input dark:data-[state=checked]:bg-input/30 dark:data-[state=checked]:text-foreground"
            :data-random-draw-next-option="option.value"
          >
            {{ option.label }}
          </RadioGroupItem>
        </RadioGroupRoot>
      </div>

      <div class="flex flex-wrap justify-end gap-2">
        <Button
          v-if="choices.kind !== 'buttons'"
          variant="outline"
          class="min-h-11"
          :disabled="choices.kind === 'number' && typedValue === null"
          data-random-draw-use
          @click="use"
        >
          {{ choices.kind === "order" ? "Use this order" : "Use this value" }}
        </Button>
        <Button
          variant="outline"
          class="min-h-11"
          data-random-draw-untried
          @click="emit('untried')"
        >
          Least tried
        </Button>
        <Button
          ref="randomButton"
          class="min-h-11"
          data-random-draw-natural
          @click="emit('resolve', 'natural')"
        >
          Random
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
