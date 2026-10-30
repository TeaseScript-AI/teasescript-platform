import { loadCompiler, observe } from "../adapters/compiler.mjs";
const build = process.argv[2];
let api;
try {
  api = await loadCompiler(build);
  process.send?.({ kind: "ready" });
} catch (error) {
  process.send?.({
    kind: "startup-error",
    error: { name: error.name, message: error.message, stack: error.stack },
  });
  process.exitCode = 2;
  process.disconnect?.();
}
if (api)
  process.on("message", (message) => {
    if (message?.kind !== "run") return;
    try {
      process.send?.({
        kind: "result",
        id: message.config.id,
        result: observe(api, message.config),
      });
    } catch (error) {
      process.send?.({
        kind: "result",
        id: message.config.id,
        result: {
          id: message.config.id,
          caseId: message.config.case.id,
          sourceHash: message.config.case.sourceHash,
          reason: error.message,
          mode: message.config.mode.id,
          policy: message.config.policy,
          status: "ERROR",
          executions: 0,
          assertions: 0,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        },
      });
    }
  });
