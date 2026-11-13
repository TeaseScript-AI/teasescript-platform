import assert from "node:assert/strict";

import {
  activePlayerRuntimeInteraction,
  type PlayerSessionView,
} from "../../../player/runtime/runtime-view.js";
import { loadPlayerModule } from "../player-modules.js";

/*
 * The Player's input chain (`player/vue/src/session/runtime-input.ts`), from the bundle the composables run in, for tests that
 * answer the presented interaction as one of the Player's controls does.
 */

/** What the input chain returns (`InputResult`). */
export interface InputResult {
  readonly kind: "retired" | "unavailable" | "unanswered" | "answered";
  readonly session?: PlayerSessionView;
  readonly outcome?: { readonly kind: string; readonly message?: string };
}

/** The input chain's module: the production intents, the chain, and the draft timer's store. */
export interface RuntimeInput {
  readonly RETIRED: symbol;
  readonly intents: {
    composer(text: string, input: string): Intent;
    choice(optionId: string | null, input: string): Intent;
    formStep(fieldId: string, draft: string | undefined): Intent;
    formSubmit(draft: string | undefined, input: string): Intent;
    formCancel(input: string): Intent;
    readonly formDismiss: Intent;
    readonly formClear: Intent;
    imageSkip(input: string): Intent;
    popupClose(input: string): Intent;
    exportClose(input: string): Intent;
    url(open: (session: PlayerSessionView) => boolean, input: string | null): Intent;
    readonly pacing: Intent;
  };
  runInput(
    section: unknown,
    presented: number | undefined,
    target: (session: PlayerSessionView) => number | undefined,
    intent: Intent,
  ): Promise<InputResult>;
  draftInput(
    section: unknown,
    target: { readonly actionId: number; readonly fieldId: string },
    text: string,
  ): Promise<PlayerSessionView | null>;
}

/** An intent of a control: opaque to the tests, which pass it from `intents` or a composable to the chain. */
export type Intent = (observed: never) => object | null;

let loaded: RuntimeInput | null = null;

/** The input chain's module from the bundle (`loadPlayerModule`). */
export async function runtimeInput(): Promise<RuntimeInput> {
  if (loaded !== null) return loaded;
  const module = await loadPlayerModule("player/vue/src/session/runtime-input.ts");
  assert.equal(typeof module.runInput, "function");
  assert.equal(typeof module.draftInput, "function");
  assert.equal(typeof module.RETIRED, "symbol");
  assert.equal(typeof module.intents, "object");
  loaded = {
    // EVIDENCE: validation: Vite loaded the real source module; each export's kind is checked above.
    RETIRED: module.RETIRED as symbol,
    // EVIDENCE: validation: as above, the module's table of the controls' intents.
    intents: module.intents as RuntimeInput["intents"],
    // EVIDENCE: validation: as above, a function of the module.
    runInput: module.runInput as RuntimeInput["runInput"],
    // EVIDENCE: validation: as above, a function of the module.
    draftInput: module.draftInput as RuntimeInput["draftInput"],
  };
  return loaded;
}

/** The presented interaction's action ID: the input chain's target for answers. */
export const presentedAction = (session: PlayerSessionView) =>
  activePlayerRuntimeInteraction(session.state)?.actionId;

/**
 * Answers the interaction `host` presents with `intent`, as a control does: through the input chain, in the composable's
 * input section, at the observed time.
 */
export async function answerWith(
  host: {
    readonly inputSection: unknown;
    readonly session: { readonly value: PlayerSessionView | null };
  },
  intent: Intent,
): Promise<InputResult> {
  const input = await runtimeInput();
  const shown = host.session.value;
  assert.ok(shown, "a session is shown");
  return input.runInput(host.inputSection, presentedAction(shown), presentedAction, intent);
}
