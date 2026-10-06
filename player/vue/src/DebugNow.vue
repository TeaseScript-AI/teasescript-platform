<script setup lang="ts">
import { computed, ref } from "vue";
import { useElementVisibility } from "@vueuse/core";
import { ChevronDown, ChevronUp } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import { isCapturedMediaReference } from "../../captured-media.js";
import { debugStageImageStatus, type DebugStageImageStatus } from "../../presentation.js";
import {
  playerRuntimeDebugNow,
  playerRuntimeMedia,
  type PlayerDebugSourceLocation,
  type PlayerDebugWaitKind,
} from "../../runtime-adapter.js";
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
const waitLabels: Record<PlayerDebugWaitKind, string> = {
  wait: "Wait",
  timer: "Timer",
  button: "Button",
  choice: "Choice",
  input: "Answer",
  image: "Image request",
  pacing: "Pacing",
  media: "Media",
  save: "Save",
  photo: "Photo",
};
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

const stageVideo = computed(() => {
  const session = props.player.session.value;
  return session === null ? null : playerRuntimeMedia(session.snapshot).stage.videoMediaId;
});
const stage = computed(() => {
  const image = props.player.stageImage.value;
  const observed = props.player.stageImageObservation.value;
  const status = debugStageImageStatus({
    image,
    source: image === null ? null : props.player.resolveAsset(image),
    overridden: props.stageOverridden,
    covered: props.stageCovered || stageVideo.value !== null,
    loaded: observed.loaded,
    failed: observed.failed,
  });
  return {
    path: image === null ? null : isCapturedMediaReference(image) ? "Captured or chosen image" : image,
    status,
    problem: status === "unresolved" || status === "failed",
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
</script>

<template>
  <div ref="root" class="grid gap-3" data-debug-now>
    <p v-if="!now" class="text-muted-foreground">No session yet.</p>
    <template v-else>
      <dl class="grid gap-1">
        <div class="flex min-w-0 gap-2">
          <dt class="text-muted-foreground">Next</dt>
          <dd class="min-w-0 break-all font-mono" data-debug-now-next>{{ now.next ? at(now.next) : "Ended" }}</dd>
        </div>
        <div class="flex min-w-0 gap-2">
          <dt class="shrink-0 text-muted-foreground">Waiting at</dt>
          <dd class="min-w-0 break-words" data-debug-now-waiting>
            <template v-if="now.waitingAt">
              {{ waitLabels[now.waitingAt.kind] }} · <span class="break-all font-mono">{{ at(now.waitingAt.at) }}</span>
            </template>
            <template v-else>Nothing</template>
          </dd>
        </div>
      </dl>
      <Collapsible v-if="now.calls.length" v-slot="{ open }" class="grid gap-1">
        <CollapsibleTrigger as-child>
          <Button variant="ghost" size="xs" class="justify-self-start" data-debug-now-calls-toggle>
            Call chain ({{ now.calls.length }})
            <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
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
          <span v-if="stage.path" class="min-w-0 break-all font-mono" data-debug-now-image-path>{{ stage.path }}</span>
          <Badge :variant="stage.problem ? 'destructive' : 'outline'" :data-status="stage.status">
            {{ imageLabels[stage.status] }}
          </Badge>
        </div>
        <p v-if="stage.path" class="text-muted-foreground">Set by: not recorded yet</p>
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

      <Collapsible v-slot="{ open }" class="grid gap-1">
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            size="xs"
            class="justify-self-start"
            :disabled="!now.timers.length"
            data-debug-now-timers-toggle
          >
            Timers ({{ now.timers.length }})
            <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul class="grid gap-1 ps-2" data-debug-now-timers>
            <li v-for="timer in now.timers" :key="timer.actionId" class="min-w-0 break-words">
              {{ timer.blocking ? "Blocking timer" : "Async timer" }}<template v-if="timer.label">
                “{{ timer.label }}”</template> · {{ timer.display }} ·
              {{ timer.state }}{{ timer.repeat ? " · repeats" : "" }} · {{ seconds(timer.remainingMs) }} left
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
