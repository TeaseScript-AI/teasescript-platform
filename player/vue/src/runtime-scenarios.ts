import askNumberSource from "./runtime-scenarios/ask-number.tease?raw";
import askTextSource from "./runtime-scenarios/ask-text.tease?raw";
import chooseSource from "./runtime-scenarios/choose.tease?raw";
import showButtonSource from "./runtime-scenarios/show-button.tease?raw";
import skippablePacingSource from "./runtime-scenarios/skippable-pacing.tease?raw";
import unskippablePacingSource from "./runtime-scenarios/unskippable-pacing.tease?raw";

export type PlayerRuntimeScenarioId =
  "show-button" | "choose" | "ask-text" | "ask-number" | "skippable-pacing" | "unskippable-pacing";

export interface PlayerRuntimeScenario {
  readonly id: PlayerRuntimeScenarioId;
  readonly label: string;
  readonly source: string;
}

export const PLAYER_RUNTIME_SCENARIOS: readonly PlayerRuntimeScenario[] = Object.freeze([
  Object.freeze({ id: "show-button", label: "showButton", source: showButtonSource }),
  Object.freeze({ id: "choose", label: "choose", source: chooseSource }),
  Object.freeze({ id: "ask-text", label: "askText", source: askTextSource }),
  Object.freeze({ id: "ask-number", label: "askNumber", source: askNumberSource }),
  Object.freeze({
    id: "skippable-pacing",
    label: "Skippable pacing",
    source: skippablePacingSource,
  }),
  Object.freeze({
    id: "unskippable-pacing",
    label: "Unskippable pacing",
    source: unskippablePacingSource,
  }),
]);
