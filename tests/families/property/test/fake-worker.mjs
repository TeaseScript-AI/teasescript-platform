// Process-boundary fault injection, never a compiler oracle.
process.send({ kind: "ready" });
process.on("message", (m) => {
  const action = m.config.case.source;
  if (action === "hang") return;
  if (action === "crash") process.exit(17);
  if (action === "error") {
    process.send({
      kind: "result",
      id: m.config.id,
      result: {
        id: m.config.id,
        status: "ERROR",
        reason: "identical exception",
        executions: 0,
        assertions: 0,
      },
    });
    return;
  }
  process.send({
    kind: "result",
    id: action === "wrong-id" ? "wrong" : m.config.id,
    result: { id: m.config.id, status: "PASS", executions: 1, assertions: 1 },
  });
});
