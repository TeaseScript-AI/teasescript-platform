// O4 stage 2b: the members of string receivers (§5.4).
// A placeholder of the starting commit: the slice delegated to Opus 5.5 fills it in; the lead edits no further line here.
import type { MemberRules } from "./views.js";

const RULES: MemberRules = {
  kinds: ["string"],
  property: () => undefined,
  method: () => undefined,
};

export const MEMBER_RULES: MemberRules = Object.freeze(RULES);
