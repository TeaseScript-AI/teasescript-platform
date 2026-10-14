<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
// time lock; Cancel gives the call's default. What is typed stays in the Player. While the Player locks or opens with it
// (`busy`), the dialog takes no input but keeps focus where it is, and the control that started the work says so. As
// for a popup, a click beside it does not close it, a key held down since before it opened does nothing, and while
// Debug runs it is not modal and stands in the middle of the session's `area`.
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
const cancelButton = ref<InstanceType<typeof Button> | null>(null);
/** Which control started the work the dialog is busy with: Try again, or else Lock or Unlock. */
const retrying = ref(false);

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
/** Whether the chosen moment is in the future; checked again when the player locks, as time passes meanwhile. */
const future = ref(true);
const checkFuture = () => (future.value = chosenMs.value !== null && chosenMs.value > Date.now());
checkFuture();
watch(moment, checkFuture);
/** The repeat no longer matches the password as typed so far. */
const mismatch = computed(
  () => repeated.value !== "" && !password.value.startsWith(repeated.value),
);
const canLock = computed(
  () => chosenMs.value !== null && (password.value === "" || repeated.value === password.value),
);

const now = Date.now();
const momentFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
/** The moments to show: a passed one only when the dialog does not say that the time has passed. */
const shownMoments = computed(() => {
  const dialog = props.dialog;
  if (dialog.kind !== "unlock") return [];
  return dialog.moments
    .filter((value) => dialog.notice !== "unreachable" || value > now)
    .map((value) => momentFormat.format(value));
});
/** Busy without a button of the dialog having started it, as when a time lock opens by itself. */
const openingByItself = computed(
  () => props.busy && props.dialog.kind === "unlock" && !props.dialog.password && !retrying.value,
);

function lock() {
  if (props.busy || !canLock.value) return;
  checkFuture();
  if (!future.value) return;
  retrying.value = false;
  emit("submit", {
    password: password.value === "" ? null : password.value,
    openAtMs: chosenMs.value,
  });
}
function unlock() {
  if (props.busy || password.value === "") return;
  retrying.value = false;
  emit("submit", { password: password.value, openAtMs: null });
}
function tryAgain() {
  if (props.busy) return;
  retrying.value = true;
  emit("submit", { password: null, openAtMs: null });
}
function cancel() {
  if (!props.busy) emit("cancel");
}

// The password field takes focus, or else Cancel, so the dialog always has it.
function focusFirst(event: Event) {
  event.preventDefault();
  if (props.dialog.kind === "lock" || props.dialog.password) passwordField.value?.focus();
  else (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
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
// A repeated Enter would submit the form, and a repeated Space would arm a button for the key's release.
function heldKey(event: KeyboardEvent) {
  if (event.repeat) event.preventDefault();
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
      <form
        v-if="dialog.kind === 'lock'"
        class="grid gap-3"
        novalidate
        @keydown="heldKey"
        @submit.prevent="lock"
      >
        <div class="grid gap-1.5">
          <label for="lock-dialog-moment" class="text-sm font-medium">Opens by itself at</label>
          <Input
            id="lock-dialog-moment"
            v-model="moment"
            type="datetime-local"
            required
            :min="earliest"
            :readonly="busy"
            :aria-invalid="future ? undefined : 'true'"
            aria-describedby="lock-dialog-moment-hint"
            data-lock-moment
          />
          <p
            id="lock-dialog-moment-hint"
            role="status"
            class="min-h-5 text-sm text-destructive"
            data-lock-moment-hint
          >
            {{ future ? "" : "Choose a moment in the future." }}
          </p>
        </div>
        <PasswordField
          ref="passwordField"
          v-model="password"
          label="Password (optional)"
          :busy="busy"
          data-lock-password
        />
        <PasswordField
          v-if="password !== ''"
          v-model="repeated"
          label="Repeat password"
          :busy="busy"
          :error="mismatch ? 'The passwords do not match' : null"
          data-lock-repeat
        />
        <div class="flex flex-wrap justify-end gap-2">
          <Button
            type="submit"
            class="min-h-11"
            :disabled="!busy && !canLock"
            :aria-disabled="busy ? 'true' : undefined"
            :class="{ 'opacity-50': busy }"
            data-lock-submit
          >
            {{ busy ? "Locking…" : "Lock" }}
          </Button>
        </div>
      </form>
      <form v-else class="grid gap-3" novalidate @keydown="heldKey" @submit.prevent="unlock">
        <p v-for="(shown, index) in shownMoments" :key="index" class="text-sm" data-unlock-moment>
          Opens by itself at {{ shown }}
        </p>
        <div v-if="dialog.notice === 'unreachable'" class="grid gap-2" data-unlock-unreachable>
          <p class="text-sm">Its time has passed, but the time service could not be reached.</p>
          <Button
            type="button"
            variant="outline"
            class="min-h-11 justify-self-start"
            :aria-disabled="busy ? 'true' : undefined"
            :class="{ 'opacity-50': busy }"
            data-unlock-retry
            @click="tryAgain"
          >
            {{ busy && retrying ? "Opening…" : "Try again" }}
          </Button>
        </div>
        <PasswordField
          v-if="dialog.password"
          ref="passwordField"
          v-model="password"
          label="Password"
          :busy="busy"
          :error="dialog.notice === 'wrongPassword' ? 'That password does not open it.' : null"
          data-unlock-password
        />
        <p v-if="openingByItself" role="status" class="text-sm" data-unlock-opening>Opening…</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            class="min-h-11"
            :aria-disabled="busy ? 'true' : undefined"
            :class="{ 'opacity-50': busy }"
            data-unlock-cancel
            @click="cancel"
          >
            Cancel
          </Button>
          <Button
            v-if="dialog.password"
            type="submit"
            class="min-h-11"
            :disabled="!busy && password === ''"
            :aria-disabled="busy ? 'true' : undefined"
            :class="{ 'opacity-50': busy }"
            data-unlock-submit
          >
            {{ busy && !retrying ? "Opening…" : "Unlock" }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
