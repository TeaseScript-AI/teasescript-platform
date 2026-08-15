import type {
  PlayerActionPresentation,
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerSpeakerPresentation,
} from "./model.js";

export interface PlayerRenderTargets {
  readonly player: HTMLElement;
  readonly transcript: HTMLElement;
  readonly actions: HTMLElement;
  readonly timerText: HTMLElement;
  readonly mediaFit: HTMLElement;
  readonly mediaCaption: HTMLElement;
}

export function renderPresentation(
  targets: PlayerRenderTargets,
  presentation: PlayerPresentation,
): void {
  targets.player.style.setProperty("--scene-ambient", presentation.media.ambientColor);
  targets.player.style.setProperty("--media-fit", presentation.media.fit);
  targets.player.dataset.mediaFit = presentation.media.fit;

  const progress = timerProgressPercent(presentation.timer.remainingSeconds, presentation.timer.totalSeconds);
  targets.player.style.setProperty("--timer-progress", `${progress}%`);
  targets.timerText.textContent = formatTimer(presentation.timer.remainingSeconds);

  targets.mediaFit.textContent = presentation.media.fit;
  targets.mediaCaption.textContent = presentation.media.caption;

  targets.transcript.replaceChildren(
    ...presentation.messages.map((message) => createMessage(message, presentation.speakers)),
  );

  targets.actions.replaceChildren(
    ...presentation.actions.map(createActionButton),
  );
}

export function timerProgressPercent(
  remainingSeconds: number,
  totalSeconds: number,
): number {
  if (!Number.isFinite(remainingSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }
  const remainingRatio = Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
  return Math.round((1 - remainingRatio) * 100);
}

export function formatTimer(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function createMessage(
  message: PlayerMessagePresentation,
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
): HTMLElement {
  const speaker = speakers[message.speakerId];
  if (speaker === undefined) {
    throw new Error(`Unknown demo speaker: ${message.speakerId}`);
  }

  const article = document.createElement("article");
  article.className = `message${message.speakerId === "user" ? " user" : ""}`;
  article.dataset.messageId = message.id;
  article.style.setProperty("--speaker-accent", speaker.accent);
  article.style.setProperty("--speaker-font", speaker.fontFamily);

  const row = document.createElement("div");
  row.className = "message-row";

  const avatar = document.createElement("div");
  avatar.className = "speaker-avatar";
  avatar.textContent = speaker.avatar;
  avatar.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  copy.className = "message-copy";

  const name = document.createElement("div");
  name.className = "speaker-name";
  name.textContent = speaker.name;

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.text;

  copy.append(name, body);
  row.append(...(message.speakerId === "user" ? [copy, avatar] : [avatar, copy]));
  article.append(row);
  return article;
}

function createActionButton(action: PlayerActionPresentation): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-button";
  button.dataset.actionId = action.id;
  button.textContent = action.label;
  return button;
}
