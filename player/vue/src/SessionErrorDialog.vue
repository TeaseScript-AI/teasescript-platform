<script setup lang="ts">
import { computed } from "vue";
import { Bug, ChevronDown, ChevronUp, Download } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogDescription from "@/components/ui/dialog/DialogDescription.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import type { PlayerDebugCall } from "../../runtime-adapter.js";
import type { RuntimeFailureSnapshot } from "../../../src/index.js";

// The error dialog (PLAYER-UI "Session end and failure"), opened only from the error line above the composer or its
// notice: that the script stopped and where, or that the Player itself failed, with the technical details collapsed:
// the error code with the runtime's message, the failing line, and the calls it happened in, each said once. Download
// debug export and Open in Debug close it and hand over to the export dialog or the Debug panel; otherwise only Close
// and Escape close it, not a click beside it.
const props = defineProps<{
  failure: RuntimeFailureSnapshot | null;
  /** The error name of an exception of the Player itself. */
  hostError: string | null;
  /** The source text of the failing file, or `null` when the host did not supply it. */
  source: string | null;
  /** The calls the error happened in, innermost first. */
  calls: readonly PlayerDebugCall[];
  /** Whether the Debug panel can show the failure: Debug is on and the script failed. */
  debugAvailable: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ export: []; debug: []; returnFocus: [] }>();

const line = computed(() => (props.failure === null ? null : props.failure.span.start.line + 1));
// The failing line without its indentation, split around the failing expression: the span's columns on its first line,
// at least one character.
const sourceLine = computed(() => {
  const { failure, source } = props;
  if (failure === null || source === null) return null;
  const { start, end } = failure.span;
  const lineStart = start.offset - start.column;
  if (lineStart < 0 || start.offset > source.length) return null;
  const newline = source.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? source.length : newline;
  if (source[lineEnd - 1] === "\r") lineEnd -= 1;
  const text = source.slice(lineStart, lineEnd);
  const indent = text.length - text.trimStart().length;
  const from = Math.min(Math.max(start.column, indent), text.length);
  let to = end.line === start.line ? Math.min(end.column, text.length) : text.length;
  if (to <= from) to = Math.min(from + 1, text.length);
  return { before: text.slice(indent, from), failing: text.slice(from, to), after: text.slice(to) };
});
// The calls the error happened in, innermost first, as one sentence: "in punish(), called from main.tease:7"; the
// error's own location is the dialog's. A deep recursion lists its innermost calls.
const SHOWN_CALLS = 10;
const callLabels: Record<PlayerDebugCall["kind"], (name: string) => string> = {
  function: (name) => `${name}()`,
  file: (name) => name,
  timer: () => "a timer block",
  media: () => "a media cue block",
  button: () => "a button block",
};
const callPath = computed(() => {
  const { failure, calls } = props;
  if (failure === null || calls.length === 0) return null;
  const label = (call: PlayerDebugCall) => callLabels[call.kind](call.name);
  const parts = [`in ${label(calls[0]!)}`];
  calls.slice(0, SHOWN_CALLS).forEach((call, index) => {
    const outer = calls[index + 1];
    const how =
      call.kind === "function" || call.kind === "file" ? "called from" : "which interrupted";
    parts.push(
      `${how} ${call.from.path}:${call.from.line}${outer === undefined ? "" : ` in ${label(outer)}`}`,
    );
  });
  if (calls.length > SHOWN_CALLS) parts.push(`and ${calls.length - SHOWN_CALLS} more calls`);
  return parts.join(", ");
});
let handedOver = false;
function handOver(next: "export" | "debug") {
  handedOver = true;
  open.value = false;
  if (next === "export") emit("export");
  else emit("debug");
}
// Opened without a trigger, the dialog returns focus to the error line; a dialog or panel it handed over to keeps it.
function returnFocus(event: Event) {
  event.preventDefault();
  if (!handedOver) emit("returnFocus");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      :show-close-button="false"
      data-session-error-dialog
      @interact-outside.prevent
      @close-auto-focus="returnFocus"
    >
      <DialogHeader>
        <DialogTitle>{{ failure ? "Script error" : "Player error" }}</DialogTitle>
        <DialogDescription class="text-foreground" data-session-error-summary>
          {{ failure ? `In ${failure.path}, line ${line}.` : "The script did not cause this." }}
        </DialogDescription>
      </DialogHeader>

      <Collapsible v-slot="{ open: expanded }" class="grid gap-2">
        <CollapsibleTrigger as-child>
          <Button
            variant="outline"
            class="min-h-11 w-full justify-between"
            data-session-error-technical-toggle
          >
            Technical details
            <component :is="expanded ? ChevronUp : ChevronDown" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div class="grid gap-2 text-xs" data-session-error-technical>
            <p class="break-words" data-session-error-code>
              <template v-if="failure"
                ><code class="font-mono">{{ failure.code }}</code
                >: {{ failure.message }}</template
              >
              <span v-else class="flex min-w-0 gap-2"
                ><span class="text-muted-foreground">Error</span
                ><code class="min-w-0 font-mono">{{ hostError }}</code></span
              >
            </p>
            <!-- prettier-ignore -->
            <pre v-if="sourceLine" class="rounded-md border bg-muted p-2 font-mono break-all whitespace-pre-wrap" data-session-error-source><code>{{ sourceLine.before }}<mark class="rounded-xs bg-destructive/15 text-destructive underline decoration-wavy" data-session-error-failing>{{ sourceLine.failing }}</mark>{{ sourceLine.after }}</code></pre>
            <p v-if="callPath" class="flex min-w-0 gap-2">
              <span class="shrink-0 text-muted-foreground">Call path</span>
              <span class="min-w-0 break-words font-mono" data-session-error-calls>{{
                callPath
              }}</span>
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div class="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          class="min-h-11"
          data-session-error-export
          @click="handOver('export')"
        >
          <Download />
          Download debug export
        </Button>
        <Button
          v-if="debugAvailable"
          variant="outline"
          class="min-h-11"
          data-session-error-debug
          @click="handOver('debug')"
        >
          <Bug />
          Open in Debug
        </Button>
        <Button class="min-h-11" data-session-error-close @click="open = false">Close</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
