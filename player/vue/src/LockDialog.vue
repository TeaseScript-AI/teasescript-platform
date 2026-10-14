<script setup lang="ts">
import { computed, ref } from "vue";
import { useElementBounding } from "@vueuse/core";
import { Button } from "@/components/ui/button";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Input } from "@/components/ui/input";
import PasswordField from "./PasswordField.vue";
import type { LockDialog, LockDialogInput } from "../../lock-service.js";

// The dialogs of a lock (V30 §13, PLAYER-UI "Foreground interaction presentation"), outside the chat like a popup's.
// The lock dialog asks how an encrypt call that wrote no opener locks: the moment its time lock opens by itself,
// suggested 7 days from now, which the player may move but not remove, and an optional password, typed twice. The
// unlock dialog shows what opens a decrypt call's lock: a password field where a password does, and the moment of its
// time lock; Cancel gives the call's default. What is typed stays in the Player; while the Player locks or opens with
// it (`busy`), the dialog takes no input. As for a popup, a click beside it does not close it, and while Debug runs it
// is not modal and stands in the middle of the session's `area`.
const props = defineProps<{
  dialog: LockDialog;
  busy: boolean;
  modal: boolean;
  /** The session's area, which a dialog that is not modal centres on instead of the window. */
  area?: HTMLElement | null;
}>();
const emit = defineEmits<{ submit: [input: LockDialogInput]; cancel: [] }>();

const bounds = useElementBounding(() => (props.modal ? null : (props.area ?? null)));
const placement = computed(() =>
  props.modal || !props.area
    ? undefined
    : {
        left: `${bounds.left.value + bounds.width.value / 2}px`,
        top: `${bounds.top.value + bounds.height.value / 2}px`,
        maxWidth: `min(32rem, ${Math.max(0, bounds.width.value - 32)}px)`,
      },
);

const password = ref("");
const repeated = ref("");
const passwordField = ref<InstanceType<typeof PasswordField> | null>(null);
const momentField = ref<InstanceType<typeof Input> | null>(null);

/** A moment as the `datetime-local` field shows it, in this browser's time zone, to the minute. */
function localText(moment: number): string {
  const date = new Date(moment);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}
const moment = ref(props.dialog.kind === "lock" ? localText(props.dialog.suggestedOpenAtMs) : "");
const earliest = localText(Date.now());
/** The moment chosen, or `null` while the field holds none. */
const chosenMs = computed(() => {
  const value = new Date(moment.value).getTime();
  return moment.value === "" || Number.isNaN(value) ? null : value;
});
const future = computed(() => chosenMs.value !== null && chosenMs.value > Date.now());
const mismatch = computed(() => repeated.value !== "" && repeated.value !== password.value);
const canLock = computed(
  () => future.value && (password.value === "" || repeated.value === password.value),
);

const shownMoments = computed(() =>
  props.dialog.kind === "unlock"
    ? props.dialog.moments.map((value) =>
        new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(value),
      )
    : [],
);

function lock() {
  if (props.busy || !canLock.value) return;
  emit("submit", {
    password: password.value === "" ? null : password.value,
    openAtMs: chosenMs.value,
  });
}
function unlock() {
  if (props.busy || password.value === "") return;
  emit("submit", { password: password.value, openAtMs: null });
}
function tryAgain() {
  if (!props.busy) emit("submit", { password: null, openAtMs: null });
}
function cancel() {
  if (!props.busy) emit("cancel");
}

function focusFirst(event: Event) {
  event.preventDefault();
  if (props.dialog.kind === "unlock" && props.dialog.password) passwordField.value?.focus();
  else (momentField.value?.$el as HTMLElement | undefined)?.focus();
}
// Opened by the script, the dialog has no trigger to return focus to; the next interaction takes it.
function keepFocus(event: Event) {
  event.preventDefault();
}
// Escape cancels an unlock dialog from inside only; the lock dialog has no cancel.
function escape(event: KeyboardEvent) {
  event.preventDefault();
  if (
    !event.repeat &&
    props.dialog.kind === "unlock" &&
    (props.modal || document.activeElement?.closest("[data-lock-dialog]"))
  )
    cancel();
}
</script>

<template>
  <Dialog :open="true" :modal="modal">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      :class="{ 'z-[38]': !modal }"
      :style="placement"
      :show-close-button="false"
      :aria-describedby="undefined"
      :data-lock-dialog="dialog.kind"
      @interact-outside.prevent
      @escape-key-down="escape"
      @open-auto-focus="focusFirst"
      @close-auto-focus="keepFocus"
    >
      <DialogHeader>
        <DialogTitle>{{ dialog.kind === "lock" ? "Lock" : "Unlock" }}</DialogTitle>
      </DialogHeader>
      <form v-if="dialog.kind === 'lock'" class="grid gap-3" novalidate @submit.prevent="lock">
        <div class="grid gap-1.5">
          <label for="lock-dialog-moment" class="text-sm font-medium">Opens by itself at</label>
          <Input
            id="lock-dialog-moment"
            ref="momentField"
            v-model="moment"
            type="datetime-local"
            required
            :min="earliest"
            :disabled="busy"
            :aria-invalid="future ? undefined : 'true'"
            data-lock-moment
          />
          <p class="min-h-5 text-sm text-muted-foreground" data-lock-moment-hint>
            {{ future ? "" : "Choose a moment in the future." }}
          </p>
        </div>
        <PasswordField
          v-model="password"
          label="Password (optional)"
          autocomplete="new-password"
          :disabled="busy"
          data-lock-password
        />
        <PasswordField
          v-if="password !== ''"
          v-model="repeated"
          label="Repeat password"
          autocomplete="new-password"
          :disabled="busy"
          :invalid="mismatch"
          data-lock-repeat
        />
        <p v-if="password !== ''" role="status" class="min-h-5 text-sm" data-lock-mismatch>
          {{ mismatch ? "The passwords do not match" : "" }}
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="submit" class="min-h-11" :disabled="busy || !canLock" data-lock-submit>
            {{ busy ? "Locking…" : "Lock" }}
          </Button>
        </div>
      </form>
      <form v-else class="grid gap-3" novalidate @submit.prevent="unlock">
        <p v-for="(shown, index) in shownMoments" :key="index" class="text-sm" data-unlock-moment>
          Opens by itself at {{ shown }}
        </p>
        <div v-if="dialog.notice === 'unreachable'" class="grid gap-2" data-unlock-unreachable>
          <p class="text-sm">Its time has passed, but the time service could not be reached.</p>
          <Button
            type="button"
            variant="outline"
            class="min-h-11 justify-self-start"
            :disabled="busy"
            data-unlock-retry
            @click="tryAgain"
          >
            Try again
          </Button>
        </div>
        <template v-if="dialog.password">
          <PasswordField
            ref="passwordField"
            v-model="password"
            label="Password"
            autocomplete="current-password"
            :disabled="busy"
            :invalid="dialog.notice === 'wrongPassword'"
            data-unlock-password
          />
          <p
            v-if="dialog.notice === 'wrongPassword'"
            role="status"
            class="text-sm text-destructive"
            data-unlock-wrong
          >
            That password does not open it.
          </p>
        </template>
        <div class="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            class="min-h-11"
            :disabled="busy"
            data-unlock-cancel
            @click="cancel"
          >
            Cancel
          </Button>
          <Button
            v-if="dialog.password"
            type="submit"
            class="min-h-11"
            :disabled="busy || password === ''"
            data-unlock-submit
          >
            {{ busy ? "Opening…" : "Unlock" }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
