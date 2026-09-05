import { RuleTester } from "oxlint/plugins-dev";

import { requireSafetyCommentForTypeAssertionRule } from "./require-safety-comment-for-type-assertion.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingSafetyComment" };

tester.run(
  "anti-slop/require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "const values = [1, 2] as const;",
      "const value = <const>{ id: 'one' };",
      "// EVIDENCE: The parser established the UserId invariant.\nconst id = value as UserId;",
      "const id = /* EVIDENCE: Validation established the invariant. */ value as UserId;",
      "const id =\n  /* EVIDENCE: Validation established the invariant. */\n  value as\n  UserId;",
      "function parse(): UserId {\n// EVIDENCE: Validation above established the UserId invariant.\nreturn value as UserId;\n}",
      "// EVIDENCE: The parser established the exported UserId invariant.\nexport const id = value as UserId;",
      "/* EVIDENCE:\n * The parser established the exported UserId invariant.\n */\nexport const id = value as UserId;",
      "// EVIDENCE: The guard receives a value validated by the fixture.\nif (value as boolean) run();",
			"const result = {\n// EVIDENCE: validation.valid proves capture.value is an InstructionPlan.\nplan: validation.valid ? capture.value as InstructionPlan : null,\n};",
      "// oxlint-disable-next-line no-explicit-any -- EVIDENCE: The fixture validates the input before this assertion.\nconst id = value as UserId;",
      {
        code: "// INVARIANT: The parser established the UserId invariant.\nconst id = value as UserId;",
        options: [{ markers: ["INVARIANT"] }],
      },
    ],
    invalid: [
      { code: "const id = value as UserId;", errors: [error] },
      { code: "const id = <UserId>value;", errors: [error] },
      { code: "const id = value as UserId; // EVIDENCE: This comment is too late.", errors: [error] },
      { code: "// EVIDENCE:\nconst id = value as UserId;", errors: [error] },
      { code: "// EVIDENCE: ...\nconst id = value as UserId;", errors: [error] },
      { code: "const id = /* EVIDENCE: */ value as UserId;", errors: [error] },
      {
        code: "// EVIDENCE: This applies to the old declaration.\nconst old = 1;\nconst id = value as UserId;",
        errors: [error],
      },
      {
        code: "// EVIDENCE: This function has historical evidence only.\nfunction f() { if (1 as number) return true; }",
        errors: [error],
      },
      {
        code: "// EVIDENCE: This block has historical evidence only.\n{ const id = value as UserId; }",
        errors: [error],
      },
      {
        code: "// SAFETY: This is not the configured marker.\nconst id = value as UserId;",
        errors: [error],
      },
    ],
  },
);
