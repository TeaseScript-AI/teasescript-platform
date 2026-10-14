<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useElementBounding } from "@vueuse/core";
import { Copy, Download, TriangleAlert } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import Dialog from "@/components/ui/dialog/Dialog.vue";
import DialogContent from "@/components/ui/dialog/DialogContent.vue";
import DialogHeader from "@/components/ui/dialog/DialogHeader.vue";
import DialogTitle from "@/components/ui/dialog/DialogTitle.vue";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import PasswordField from "./PasswordField.vue";
import PublicKeyHelp from "./PublicKeyHelp.vue";
import type { LockDialog, LockDialogInput } from "../../lock-service.js";
import { invalidAnswerMessage } from "../../../src/interaction-answers.js";
import { parsePublicKey } from "../../../src/public-keys.js";
import { MAX_LOCK_PUBLIC_KEYS } from "../../../src/runtime/actions/lock.js";

// The dialogs of a lock (V30 §13, PLAYER-UI "Foreground interaction presentation"), outside the chat like a popup's.
// The lock dialog shows only the openers the player chooses, each with a plain sentence: a time lock, suggested 7 days
// from now, which the player may move, or switch off, a password, typed twice, and public keys, one per line. It locks
// once the lock has an opener, also one the call gives, and while no time lock would open it, warns which openers are
// left. The unlock dialog shows what opens a decrypt call's lock: a password field where a password does; where a public
// key does, the unlock request to send to the owner of the private key, with Copy and Download, and a field for the
// unlock key they send back; and the moment of its time lock. Cancel gives the call's default. What is typed stays in the
// Player. While the Player locks or opens with it (`busy`), the dialog takes no input but keeps focus where it is, and
// the control that started the work says so. As for a popup, a click beside it does not close it, a key held down since
// before it opened does nothing, and while Debug runs it is not modal and stands in the middle of the session's `area`.
const props = defineProps<{
  dialog: Exclude<LockDialog, { kind: "password" }>;
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
/** Which button of the unlock dialog started the work it is busy with, or `null` when it opens by itself. */
const started = ref<"unlock" | "retry" | null>(null);

/** A moment as the `datetime-local` field shows it, in this browser's time zone, to the minute. */
function localText(moment: number): string {
  const date = new Date(moment);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}
/** The openers the lock dialog lets the player choose, and those the call gives itself. */
const choices = computed(() => (props.dialog.kind === "lock" ? props.dialog.choices : []));
const given = computed(() =>
  props.dialog.kind === "lock"
    ? props.dialog.given
    : { password: false, timeLock: false, publicKeys: 0 },
);
const choosesTime = computed(() => choices.value.includes("timeLock"));
const choosesPassword = computed(() => choices.value.includes("password"));
const choosesKeys = computed(() => choices.value.includes("publicKey"));
const moment = ref(
  props.dialog.kind === "lock" && props.dialog.suggestedTimeLockMs !== null
    ? localText(props.dialog.suggestedTimeLockMs)
    : "",
);
/** Whether the lock opens by itself at the chosen moment; switched off, the moment stays for when it is on again. */
const timed = ref(true);
function setTimed(on: boolean | "indeterminate") {
  if (!props.busy) timed.value = on === true;
}
// The current moment, kept fresh while the dialog is open, so that a chosen moment that passes meanwhile is no longer
// accepted and the field's minimum moves on.
const now = ref(Date.now());
const ticking = setInterval(() => (now.value = Date.now()), 15_000);
onBeforeUnmount(() => clearInterval(ticking));
const earliest = computed(() => localText(now.value));
/** The moment chosen, or `null` while the field holds none. */
const chosenMs = computed(() => {
  const value = new Date(moment.value).getTime();
  return moment.value === "" || Number.isNaN(value) ? null : value;
});
/** Whether the chosen moment is in the future. */
const future = computed(() => chosenMs.value !== null && chosenMs.value > now.value);
/** The repeat no longer matches the password as typed so far. */
const mismatch = computed(
  () => repeated.value !== "" && !password.value.startsWith(repeated.value),
);
/** The public keys as typed, one per line, and whether one of them is no public key. */
const publicKeyText = ref("");
const publicKeyLines = computed(() =>
  publicKeyText.value
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== ""),
);
const badPublicKey = computed(() =>
  publicKeyLines.value.some((line) => parsePublicKey(line) === null),
);
/** More keys than a lock holds. */
const tooManyKeys = computed(() => publicKeyLines.value.length > MAX_LOCK_PUBLIC_KEYS);
/** Whether the public keys were checked: once the field was left, or Lock was pressed, as a key is long to type. */
const publicKeysChecked = ref(false);
/** Whether the lock will have a time lock, a password, and how many public keys, as chosen here or given by the call. */
const hasTime = computed(() => (choosesTime.value && timed.value) || given.value.timeLock);
const hasPassword = computed(
  () => (choosesPassword.value && password.value !== "") || given.value.password,
);
const keyCount = computed(
  () => (choosesKeys.value ? publicKeyLines.value.length : 0) + given.value.publicKeys,
);
/** Nothing would open the lock. */
const openerless = computed(() => !hasTime.value && !hasPassword.value && keyCount.value === 0);
/** A field the player may leave empty, as another opener may open the lock. */
const optional = computed(
  () =>
    choices.value.length > 1 ||
    given.value.password ||
    given.value.timeLock ||
    given.value.publicKeys > 0,
);
/** Why Lock waits: the openers the player can still set. */
const reason = computed(() => {
  const names = choices.value.map((choice) =>
    choice === "timeLock" ? "a time" : choice === "password" ? "a password" : "a public key",
  );
  return `Set ${names.length < 3 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`}.`;
});
/** The warning of a lock without a time lock: what still opens it, by the openers it has. */
const untimedWarning = computed(() => {
  const keys = keyCount.value;
  if (!hasPassword.value)
    return keys === 1
      ? "Without a time, this only opens with the private key. If it is lost, it never opens."
      : "Without a time, this only opens with one of the private keys. If they are all lost, it never opens.";
  if (keys === 0)
    return "Without a time, this only opens with the password. If the password is forgotten, it never opens.";
  return keys === 1
    ? "Without a time, this only opens with the password or the private key. If both are lost, it never opens."
    : "Without a time, this only opens with the password or one of the private keys. If all are lost, it never opens.";
});
const canLock = computed(
  () =>
    (!choosesTime.value || !timed.value || chosenMs.value !== null) &&
    (!choosesPassword.value || password.value === "" || repeated.value === password.value) &&
    (!choosesKeys.value || (!badPublicKey.value && !tooManyKeys.value)) &&
    !openerless.value,
);

const opened = Date.now();
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
    .filter((value) => dialog.notice !== "unreachable" || value > opened)
    .map((value) => momentFormat.format(value));
});
/** Busy without a button of the dialog having started it, as when a time lock opens by itself. */
const openingByItself = computed(
  () => props.busy && props.dialog.kind === "unlock" && started.value === null,
);

function lock() {
  publicKeysChecked.value = true;
  if (props.busy || !canLock.value) return;
  // Checked at this moment too, as the clock may have passed the chosen moment since the last tick.
  now.value = Date.now();
  if (choosesTime.value && timed.value && !future.value) return;
  emit("submit", {
    password: choosesPassword.value && password.value !== "" ? password.value : null,
    timeLockMs: choosesTime.value && timed.value ? chosenMs.value : null,
    publicKeys: choosesKeys.value ? publicKeyLines.value : [],
  });
}
/** The unlock key sent back, as pasted. */
const keyText = ref("");
const keyField = ref<InstanceType<typeof Input> | null>(null);
// The unlock key, when one is given, or else the password. An empty password is a password too: a script may lock with
// `password: ""`.
function unlock() {
  if (props.busy || props.dialog.kind !== "unlock") return;
  const key = keyText.value.trim();
  if (key === "" && !props.dialog.password) return;
  started.value = "unlock";
  emit(
    "submit",
    key === ""
      ? { password: password.value, timeLockMs: null }
      : { password: null, timeLockMs: null, key },
  );
}

// The unlock request for the owner of the private key: Copy and Download leave the dialog as it is.
const ageField = ref<InstanceType<typeof Textarea> | null>(null);
const copyStatus = ref<"" | "copied" | "failed">("");
let fileUrl: string | null = null;
onBeforeUnmount(() => {
  if (fileUrl !== null) URL.revokeObjectURL(fileUrl);
});
async function copyAge() {
  if (props.busy || props.dialog.kind !== "unlock" || props.dialog.ageText === null) return;
  copyStatus.value = "";
  let copied: boolean;
  try {
    await navigator.clipboard.writeText(props.dialog.ageText);
    copied = true;
  } catch {
    // Where the browser refuses, the selected text copies the older way, or stays selected for the player.
    const element: unknown = ageField.value?.$el;
    const focused = document.activeElement;
    if (element instanceof HTMLTextAreaElement) {
      element.focus();
      element.select();
    }
    copied = document.execCommand("copy");
    if (copied && focused instanceof HTMLElement) focused.focus();
  }
  copyStatus.value = copied ? "copied" : "failed";
}
function downloadAge() {
  if (props.busy || props.dialog.kind !== "unlock" || props.dialog.ageText === null) return;
  // Not text/plain, which some phones save with a `.txt` ending; age reads the armor either way.
  fileUrl ??= URL.createObjectURL(
    new Blob([props.dialog.ageText], { type: "application/octet-stream" }),
  );
  // In the document while it is clicked, as some browsers download only from a link there.
  const link = document.createElement("a");
  link.href = fileUrl;
  link.download = "unlock-request.age";
  document.body.append(link);
  link.click();
  link.remove();
}
function tryAgain() {
  if (props.busy) return;
  started.value = "retry";
  emit("submit", { password: null, timeLockMs: null });
}
function cancel() {
  if (!props.busy) emit("cancel");
}

// The lock dialog's first opener takes focus: the password field, or else the time lock's moment, or else the public
// keys. In the unlock dialog the unlock key field takes it after a wrong key, so its message is read; otherwise the
// password field, or else the unlock key field, or else Cancel, so the dialog always has it.
const momentField = ref<InstanceType<typeof Input> | null>(null);
const publicKeyField = ref<InstanceType<typeof Textarea> | null>(null);
function focusFirst(event: Event) {
  event.preventDefault();
  const element = (field: { $el?: unknown } | null) => field?.$el as HTMLElement | undefined;
  if (props.dialog.kind === "lock") {
    if (choosesPassword.value) passwordField.value?.focus();
    else if (choosesTime.value) element(momentField.value)?.focus();
    else element(publicKeyField.value)?.focus();
  } else if (props.dialog.notice === "wrongKey") element(keyField.value)?.focus();
  else if (props.dialog.password) passwordField.value?.focus();
  else if (props.dialog.ageText !== null) element(keyField.value)?.focus();
  else element(cancelButton.value)?.focus();
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
// A repeated Enter would submit the form, and a repeated Space would arm a button for the key's release; other keys,
// such as Backspace in a long key, repeat as usual.
function heldKey(event: KeyboardEvent) {
  if (
    event.repeat &&
    (event.key === "Enter" || (event.key === " " && event.target instanceof HTMLButtonElement))
  )
    event.preventDefault();
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
        <!-- With one opener to set there is nothing to choose: its own line says what it does. -->
        <p v-if="choices.length > 1" class="text-sm text-muted-foreground" data-lock-intro>
          Choose one or more ways this can be opened again.
        </p>
        <div v-if="choosesTime" class="grid gap-1.5" data-lock-time>
          <!-- The checkbox switches the time lock off; the moment's field names itself by its label. -->
          <label class="flex min-h-11 items-center gap-3 text-sm font-medium">
            <Checkbox
              :model-value="timed"
              :aria-disabled="busy ? 'true' : undefined"
              aria-describedby="lock-dialog-time-text"
              data-lock-timed
              @update:model-value="setTimed"
            />
            <span id="lock-dialog-time-label">Time lock</span>
          </label>
          <p id="lock-dialog-time-text" class="text-sm text-muted-foreground">
            Opens by itself after the time you set.
          </p>
          <Input
            v-if="timed"
            id="lock-dialog-moment"
            ref="momentField"
            v-model="moment"
            type="datetime-local"
            required
            :min="earliest"
            :readonly="busy"
            :aria-invalid="future ? undefined : 'true'"
            aria-labelledby="lock-dialog-time-label"
            aria-describedby="lock-dialog-time-text lock-dialog-moment-hint"
            data-lock-moment
          />
          <p
            v-if="timed && !future"
            id="lock-dialog-moment-hint"
            role="status"
            class="text-sm text-destructive"
            data-lock-moment-hint
          >
            {{ invalidAnswerMessage("pastTimeLock") }}
          </p>
        </div>
        <template v-if="choosesPassword">
          <PasswordField
            ref="passwordField"
            v-model="password"
            :label="optional ? 'Password (optional)' : 'Password'"
            description="Opens with a password you choose."
            :busy="busy"
            data-lock-password
          />
          <PasswordField
            v-if="password !== ''"
            v-model="repeated"
            label="Repeat password"
            :busy="busy"
            :error="mismatch ? invalidAnswerMessage('passwordMismatch') : null"
            data-lock-repeat
          />
        </template>
        <div v-if="choosesKeys" class="grid gap-1.5" data-lock-keys>
          <label for="lock-dialog-public-keys" class="text-sm font-medium">{{
            optional ? "Public key (optional)" : "Public key"
          }}</label>
          <p id="lock-dialog-public-keys-text" class="text-sm text-muted-foreground">
            Only the person with the matching private key can open it.
          </p>
          <Textarea
            id="lock-dialog-public-keys"
            ref="publicKeyField"
            v-model="publicKeyText"
            rows="3"
            variant="code"
            placeholder="age1… or ssh-ed25519 …, one per line"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :readonly="busy"
            :aria-invalid="tooManyKeys || (publicKeysChecked && badPublicKey) ? 'true' : undefined"
            aria-describedby="lock-dialog-public-keys-text lock-dialog-public-keys-hint"
            data-lock-public-keys
            @blur="publicKeysChecked = publicKeysChecked || publicKeyLines.length > 0"
          />
          <p
            id="lock-dialog-public-keys-hint"
            role="status"
            class="min-h-5 text-sm text-destructive"
            data-lock-public-keys-hint
          >
            {{
              publicKeysChecked && badPublicKey
                ? "That is not a public key."
                : tooManyKeys
                  ? `A lock holds at most ${MAX_LOCK_PUBLIC_KEYS} public keys.`
                  : ""
            }}
          </p>
          <PublicKeyHelp />
        </div>
        <p id="lock-dialog-status" role="status" class="min-h-5 text-sm" data-lock-status>
          <span v-if="openerless" class="text-destructive" data-lock-no-opener>{{ reason }}</span>
          <span v-else-if="!hasTime" class="flex items-start gap-2" data-lock-no-time>
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{{ untimedWarning }}</span>
          </span>
        </p>
        <!-- While busy, the controls look disabled but keep focus, as `aria-disabled` says. -->
        <div class="flex flex-wrap justify-end gap-2" :class="{ 'opacity-50': busy }">
          <Button
            type="submit"
            class="min-h-11"
            :disabled="!busy && !canLock"
            :aria-disabled="busy ? 'true' : undefined"
            :aria-describedby="openerless ? 'lock-dialog-status' : undefined"
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
          <div class="justify-self-start" :class="{ 'opacity-50': busy }">
            <Button
              type="button"
              variant="outline"
              class="min-h-11"
              :aria-disabled="busy ? 'true' : undefined"
              data-unlock-retry
              @click="tryAgain"
            >
              {{ busy && started === "retry" ? "Opening…" : "Try again" }}
            </Button>
          </div>
        </div>
        <div v-if="dialog.ageText !== null" class="grid gap-2" data-unlock-age>
          <label for="unlock-dialog-age" class="text-sm font-medium"
            >Send this to the owner of the private key</label
          >
          <Textarea
            id="unlock-dialog-age"
            ref="ageField"
            :model-value="dialog.ageText"
            readonly
            rows="3"
            spellcheck="false"
            variant="code"
            class="max-h-40"
            data-unlock-age-text
          />
          <div class="flex flex-wrap items-center gap-2" :class="{ 'opacity-50': busy }">
            <Button
              type="button"
              variant="outline"
              class="min-h-11"
              :aria-disabled="busy ? 'true' : undefined"
              data-unlock-age-copy
              @click="copyAge"
            >
              <Copy />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              class="min-h-11"
              :aria-disabled="busy ? 'true' : undefined"
              data-unlock-age-download
              @click="downloadAge"
            >
              <Download />
              Download
            </Button>
          </div>
          <p role="status" class="min-h-5 text-sm" data-unlock-age-status>
            {{
              copyStatus === "copied"
                ? "Copied."
                : copyStatus === "failed"
                  ? "Could not copy. The text is selected, so copy it by hand or use Download."
                  : ""
            }}
          </p>
          <PublicKeyHelp />
          <div class="grid gap-1.5">
            <label for="unlock-dialog-key" class="text-sm font-medium">Unlock key</label>
            <Input
              id="unlock-dialog-key"
              ref="keyField"
              v-model="keyText"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :readonly="busy"
              :aria-invalid="dialog.notice === 'wrongKey' ? 'true' : undefined"
              aria-describedby="unlock-dialog-key-status"
              data-unlock-key
            />
            <p
              id="unlock-dialog-key-status"
              role="status"
              class="min-h-5 text-sm text-destructive"
              data-unlock-key-error
            >
              {{ dialog.notice === "wrongKey" ? "That key does not open it." : "" }}
            </p>
          </div>
        </div>
        <PasswordField
          v-if="dialog.password"
          ref="passwordField"
          v-model="password"
          label="Password"
          :busy="busy"
          :error="dialog.notice === 'wrongPassword' ? invalidAnswerMessage('wrongPassword') : null"
          data-unlock-password
        />
        <p v-if="openingByItself" role="status" class="text-sm" data-unlock-opening>Opening…</p>
        <div class="flex flex-wrap justify-end gap-2" :class="{ 'opacity-50': busy }">
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            class="min-h-11"
            :aria-disabled="busy ? 'true' : undefined"
            data-unlock-cancel
            @click="cancel"
          >
            Cancel
          </Button>
          <Button
            v-if="dialog.password || dialog.ageText !== null"
            type="submit"
            class="min-h-11"
            :disabled="!busy && !dialog.password && keyText.trim() === ''"
            :aria-disabled="busy ? 'true' : undefined"
            data-unlock-submit
          >
            {{ busy && started === "unlock" ? "Opening…" : "Unlock" }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
