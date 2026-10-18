import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NULL_TYPE,
  NUMBER_TYPE,
  optional,
  PropertyTable,
  REGEX_TYPE,
  STRING_TYPE,
  union,
  type StaticType,
} from "../../src/static-types.js";
import type { OperandView } from "../../src/type-inference/adapters/relation.js";
import { closedView, dynamicView } from "./adapter-parity.js";

/**
 * An operand of each registry kind and of the compound shapes the adapters' rules read, as `let a` declares it in a
 * source and as its view holds it (O4 stage 2b, work note §6.3): the catalog the direct tests enumerate a contract's
 * arguments over.
 */
export interface Operand {
  readonly label: string;
  readonly declaration: string;
  readonly view: OperandView;
}

const scalar = (name: Extract<StaticType, { kind: "scalar" }>["name"]): StaticType => ({
  kind: "scalar",
  name,
});

function annotated(label: string, type: StaticType): Operand {
  return { label, declaration: `let a: ${label} = hostValue`, view: closedView(type) };
}

export const OPERANDS: readonly Operand[] = [
  annotated("integer", INTEGER_TYPE),
  annotated("number", NUMBER_TYPE),
  annotated("string", STRING_TYPE),
  annotated("boolean", BOOLEAN_TYPE),
  annotated("duration", scalar("duration")),
  annotated("calendarDuration", scalar("calendarDuration")),
  annotated("angle", scalar("angle")),
  annotated("date", scalar("date")),
  annotated("time", scalar("time")),
  annotated("datetime", scalar("datetime")),
  annotated("absoluteDateTime", scalar("absoluteDateTime")),
  annotated("script", scalar("script")),
  annotated("regex", REGEX_TYPE),
  annotated("range", { kind: "range" }),
  annotated("integer[]", { kind: "list", element: INTEGER_TYPE }),
  annotated("string[]", { kind: "list", element: STRING_TYPE }),
  annotated("integer set", { kind: "set", element: INTEGER_TYPE }),
  annotated("integer dict", { kind: "dict", element: INTEGER_TYPE }),
  annotated("string dict", { kind: "dict", element: STRING_TYPE }),
  {
    label: "object",
    declaration: "let a = { x: 1 }",
    view: closedView({ kind: "object", properties: new PropertyTable([["x", INTEGER_TYPE]]) }),
  },
  {
    label: "speaker",
    declaration: 'speaker guide {\n displayName: "Guide"\n}\nlet a = guide',
    view: closedView({ kind: "speaker" }),
  },
  annotated("timer", { kind: "timer" }),
  annotated("media", { kind: "media" }),
  { label: "camera", declaration: "let a = showCamera", view: closedView({ kind: "camera" }) },
  {
    label: "permanentButton",
    declaration: 'let a = showPermanentButton "B" { }',
    view: closedView({ kind: "permanentButton" }),
  },
  annotated("messageHandle", { kind: "messageHandle" }),
  { label: "null", declaration: "let a = null", view: closedView(NULL_TYPE) },
  { label: "host", declaration: "let a = hostValue", view: dynamicView("host") },
  annotated("integer?", optional(INTEGER_TYPE)),
  annotated("integer | string", union([INTEGER_TYPE, STRING_TYPE])),
];
