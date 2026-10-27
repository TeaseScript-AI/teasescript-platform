<script setup lang="ts">
import { computed, ref } from "vue";
import { useElementVisibility } from "@vueuse/core";
import { Badge } from "@/components/ui/badge";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleDisclosure from "@/components/ui/collapsible/CollapsibleDisclosure.vue";
import { playerDebugImageOrigin } from "../../debug-variables.js";
import type { DebugStageImageStatus } from "../../presentation.js";
import {
  playerRuntimeDebugNow,
  type PlayerDebugSourceLocation,
  type PlayerDebugWaitKind,
} from "../../runtime-adapter.js";
import { debugStageImage } from "./debugStageImage";
import type { PlayerSessionHost } from "./usePlayerSession";

// Debug's Now view (DEBUGGER.md "Player Debug"): where the script is, what the Stage and media show, and every timer,
// derived from canonical state and the Stage's own load reports while it is mounted. Paths are the authored ones, never
// URLs; a captured or chosen image has no path.
const props = defineProps<{
  player: PlayerSessionHost;
  /** Whether the camera view covers the Stage image. */
  stageCovered: boolean;
  /** Whether the development preview shows a Stage media fixture instead of the session's image. */
  stageOverridden: boolean;
}>();
const root = ref<HTMLElement | null>(null);

const now = computed(() => {
  const session = props.player.session.value;
  return session && playerRuntimeDebugNow(session, props.player.sceneTimeMs.value);
});
// Remaining timer times tick like the timer rail, while the tab is on screen.
const onScreen = useElementVisibility(root);
props.player.refreshSceneTimeWhile(() => onScreen.value && (now.value?.timers.length ?? 0) > 0);

const at = (location: PlayerDebugSourceLocation) => `${location.path}:${location.line}`;
// Where the script stopped: the error and its statement after a failure, which the error dialog's Open in Debug shows.
const ended = computed(() => {
  const failure = props.player.session.value?.state.failure ?? null;
  return failure === null
    ? "Ended"
    : `Error ${failure.code} at ${at({ path: failure.path, line: failure.span.start.line + 1 })}`;
});
const waitLabels: Record<PlayerDebugWaitKind, string> = {
  wait: "Wait",
  timer: "Timer",
  button: "Button",
  choice: "Choice",
  input: "Answer",
  image: "Image request",
  popup: "Popup",
  url: "Web address",
  export: "Text export",
  pacing: "Pacing",
  media: "Media",
  save: "Save",
  photo: "Photo",
  file: "Stored file",
  lock: "Lock",
  unlock: "Unlock",
};
/** A lock step's openers as Debug shows them; never its text, password, or key. */
function lockDetail(
  kind: PlayerDebugWaitKind,
  lock: {
    dialog: boolean;
    password: boolean;
    publicKeys: number;
    key: boolean;
    timeLockMs: number | null;
    choices: readonly string[];
  },
): string {
  const moment = lock.timeLockMs === null ? null : new Date(lock.timeLockMs).toISOString();
  const chosen = lock.choices.map((choice) =>
    choice === "publicKey"
      ? "public key"
      : choice !== "timeLock"
        ? choice
        : lock.dialog && moment !== null
          ? `time lock (suggests ${moment})`
          : "time lock",
  );
  const given = [
    ...(lock.password ? ["password"] : []),
    ...(lock.publicKeys === 0
      ? []
      : [lock.publicKeys === 1 ? "public key" : `${lock.publicKeys} public keys`]),
    ...(lock.key ? ["key"] : []),
    ...(moment === null || lock.choices.includes("timeLock") ? [] : [`time lock ${moment}`]),
  ];
  if (kind === "unlock")
    return lock.dialog ? "dialog" : given.length > 0 ? given.join(", ") : "time lock";
  if (chosen.length === 0) return given.join(", ");
  const choosing = `${lock.dialog ? "dialog" : "as the player chose"}: ${chosen.join(", ")}`;
  return given.length === 0 ? choosing : `${choosing}; given: ${given.join(", ")}`;
}
const callLabels = {
  function: (name: string) => `${name}()`,
  file: (name: string) => `call ${name}`,
  timer: (name: string) => `timer block ${name}`,
  media: (name: string) => `media cue block ${name}`,
  button: (name: string) => `button block ${name}`,
};
const imageLabels: Record<DebugStageImageStatus, string> = {
  hidden: "Hidden",
  unresolved: "Unresolved path",
  overridden: "Replaced by a preview fixture",
  covered: "Covered by camera or video",
  failed: "Load failed",
  displayed: "Displayed",
  loading: "Loading",
};

const stage = computed(() => {
  const image = debugStageImage(props.player, {
    covered: props.stageCovered,
    overridden: props.stageOverridden,
  });
  return {
    path: image.captured ? "Captured or chosen image" : image.path,
    status: image.status,
    problem: image.status === "unresolved" || image.status === "failed",
  };
});
const media = computed(() =>
  (now.value?.media ?? []).map((item) => ({
    id: item.mediaId,
    kind: item.media === "audio" ? "Audio" : "Video",
    source: item.source,
    status: !item.loaded ? "Loading" : item.state === "running" ? "Playing" : "Paused",
    playhead: `${(item.playheadMs / 1000).toFixed(1)} s`,
    startedAt: item.startedAt,
  })),
);
const seconds = (milliseconds: number) => `${Math.ceil(milliseconds / 1000)} s`;
// The statement that set the Stage image, from the value trace, or why the trace does not know it, as for a message.
const imageOrigin = computed(() => {
  const trace = props.player.debugTrace.value;
  if (trace === null || props.player.session.value === null) return null;
  const origin = playerDebugImageOrigin(trace);
  if (origin.kind === "unavailable")
    return stage.value.path === null ? null : { location: null, reason: origin.reason };
  const location = trace.record(origin.id)?.location ?? null;
  return location === null ? null : { location: at(location), reason: null };
});
</script>

<template>
  <div ref="root" class="grid gap-3" data-debug-now>
    <p v-if="!now" class="text-muted-foreground">No session yet.</p>
    <template v-else>
      <dl class="grid gap-1">
        <div class="flex min-w-0 gap-2">
          <dt class="text-muted-foreground">Next</dt>
          <dd class="min-w-0 break-all font-mono" data-debug-now-next>
            {{ now.next ? at(now.next) : ended }}
          </dd>
        </div>
        <div class="flex min-w-0 gap-2">
          <dt class="shrink-0 text-muted-foreground">Waiting at</dt>
          <dd class="min-w-0 break-words" data-debug-now-waiting>
            <template v-if="now.waitingAt">
              {{ waitLabels[now.waitingAt.kind] }} ·
              <span class="break-all font-mono">{{ at(now.waitingAt.at) }}</span>
              <span v-if="now.waitingAt.lock" class="block" data-debug-now-lock>
                {{ lockDetail(now.waitingAt.kind, now.waitingAt.lock) }}
              </span>
            </template>
            <template v-else>Nothing</template>
          </dd>
        </div>
      </dl>
      <Collapsible v-if="now.calls.length" class="grid gap-1">
        <CollapsibleDisclosure data-debug-now-calls-toggle>
          Call chain ({{ now.calls.length }})
        </CollapsibleDisclosure>
        <CollapsibleContent>
          <ol class="grid gap-1 ps-2" data-debug-now-calls>
            <li v-for="(call, index) in now.calls" :key="index" class="min-w-0 break-words">
              {{ callLabels[call.kind](call.name) }} ·
              <span class="font-mono">{{ at(call.from) }}</span>
            </li>
          </ol>
        </CollapsibleContent>
      </Collapsible>

      <section aria-labelledby="debug-now-stage" class="grid gap-1" data-debug-now-image>
        <h4 id="debug-now-stage" class="font-semibold">Stage image</h4>
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span v-if="stage.path" class="min-w-0 break-all font-mono" data-debug-now-image-path>{{
            stage.path
          }}</span>
          <Badge :variant="stage.problem ? 'destructive' : 'outline'" :data-status="stage.status">
            {{ imageLabels[stage.status] }}
          </Badge>
        </div>
        <p v-if="imageOrigin" class="text-muted-foreground" data-debug-now-image-origin>
          <template v-if="imageOrigin.location">
            Set by <span class="break-all font-mono">{{ imageOrigin.location }}</span>
          </template>
          <template v-else>{{ imageOrigin.reason }}</template>
        </p>
      </section>

      <section aria-labelledby="debug-now-media" class="grid gap-1">
        <h4 id="debug-now-media" class="font-semibold">Audio and video</h4>
        <p v-if="!media.length" class="text-muted-foreground">None playing</p>
        <ul v-else class="grid gap-1" data-debug-now-media>
          <li v-for="item in media" :key="item.id" class="min-w-0 break-words">
            {{ item.kind }} <span class="break-all font-mono">{{ item.source }}</span>
            <Badge variant="outline" class="ms-1">{{ item.status }} · {{ item.playhead }}</Badge>
            <span class="block text-muted-foreground">
              from <span class="font-mono">{{ at(item.startedAt) }}</span>
            </span>
          </li>
        </ul>
      </section>

      <Collapsible class="grid gap-1">
        <CollapsibleDisclosure :disabled="!now.timers.length" data-debug-now-timers-toggle>
          Timers ({{ now.timers.length }})
        </CollapsibleDisclosure>
        <CollapsibleContent>
          <ul class="grid gap-1 ps-2" data-debug-now-timers>
            <li v-for="timer in now.timers" :key="timer.actionId" class="min-w-0 break-words">
              {{ timer.blocking ? "Blocking timer" : "Async timer"
              }}<template v-if="timer.label"> “{{ timer.label }}”</template> · {{ timer.display }} ·
              {{ timer.state }}{{ timer.repeat ? " · repeats" : "" }} ·
              {{ seconds(timer.remainingMs) }} left
              <span class="block text-muted-foreground">
                from <span class="font-mono">{{ at(timer.startedAt) }}</span>
              </span>
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </template>
  </div>
</template>
