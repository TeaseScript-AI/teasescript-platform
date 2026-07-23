import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnostic,
  DiagnosticSeverity,
} from "../src/diagnostics.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";

test("creates an immutable structured diagnostic", () => {
  const span = createSourceSpan(
    createSourcePosition(4, 0, 4),
    createSourcePosition(7, 0, 7),
  );
  const diagnostic = createDiagnostic(
    DiagnosticSeverity.Error,
    "TS1001",
    "Expected a speaker identifier.",
    span,
  );

  assert.deepEqual(diagnostic, {
    severity: "error",
    code: "TS1001",
    message: "Expected a speaker identifier.",
    span,
  });
  assert.equal(Object.isFrozen(diagnostic), true);
  assert.equal(Object.isFrozen(diagnostic.span), true);
});

test("supports warning severity without output behavior", () => {
  const position = createSourcePosition(0, 0, 0);
  const diagnostic = createDiagnostic(
    DiagnosticSeverity.Warning,
    "TS2001",
    "Example warning.",
    createSourceSpan(position, position),
  );

  assert.equal(diagnostic.severity, "warning");
});
