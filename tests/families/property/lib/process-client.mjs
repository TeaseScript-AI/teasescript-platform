import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Exactly one bounded subprocess; shared-machine admission belongs to sx-queue, not this pilot. */
export class ProcessClient {
  constructor(
    build,
    { timeoutMs = 15000, worker = fileURLToPath(new URL("./worker.mjs", import.meta.url)) } = {},
  ) {
    this.build = build;
    this.timeoutMs = timeoutMs;
    this.worker = worker;
    this.child = null;
    this.waiting = null;
    this.stderr = "";
  }
  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  async start(timeoutMs = this.timeoutMs) {
    if (this.child?.connected) return;
    this.stderr = "";
    await new Promise((resolve, reject) => {
      const child = fork(this.worker, [this.build], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        detached: process.platform !== "win32",
      });
      this.child = child;
      child.stderr.on("data", (data) => {
        this.stderr = (this.stderr + data).slice(-12000);
      });
      const timer = setTimeout(() => {
        this.stop();
        reject(Object.assign(new Error("Adapter startup timed out"), { name: "StartupTimeout" }));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
        this.failPending("ERROR", error.message, child);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        const detail = `Worker exit code=${code} signal=${signal}: ${this.stderr}`;
        reject(new Error(detail));
        this.failPending("ERROR", detail, child);
      });
      child.on("message", (message) => {
        if (message?.kind === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (message?.kind === "startup-error") {
          clearTimeout(timer);
          reject(new Error(message.error.message));
        } else if (message?.kind === "result" && this.waiting) {
          const pending = this.waiting;
          if (pending.child !== child) return;
          this.waiting = null;
          clearTimeout(pending.timer);
          if (message.id !== pending.config.id || message.result?.id !== pending.config.id)
            pending.resolve(this.errorRow(pending.config, "ERROR", "IPC result identity mismatch"));
          else pending.resolve(message.result);
        }
      });
    });
  }
  errorRow(config, status, reason) {
    return {
      id: config.id,
      caseId: config.case.id,
      sourceHash: config.case.sourceHash,
      mode: config.mode.id,
      policy: config.policy,
      status,
      reason,
      assertions: 0,
      executions: 0,
    };
  }
  failPending(status, reason, origin = null) {
    if (!this.waiting || (origin && this.waiting.child !== origin)) return;
    const pending = this.waiting;
    this.waiting = null;
    clearTimeout(pending.timer);
    pending.resolve(this.errorRow(pending.config, status, reason));
  }
  async run(config, remainingMs = Infinity) {
    const start = performance.now();
    try {
      await this.start(Math.min(this.timeoutMs, remainingMs));
    } catch (error) {
      this.stop();
      return this.errorRow(
        config,
        error.name === "StartupTimeout" ? "TIMEOUT" : "ERROR",
        error.message,
      );
    }
    remainingMs -= performance.now() - start;
    if (remainingMs <= 0) {
      this.stop();
      return this.errorRow(config, "TIMEOUT", "Campaign budget exhausted during adapter startup");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.failPending(
            "TIMEOUT",
            `Per-configuration deadline ${Math.min(this.timeoutMs, remainingMs)} ms`,
          );
          this.stop();
        },
        Math.min(this.timeoutMs, remainingMs),
      );
      this.waiting = { config, resolve, timer, child: this.child };
      const child = this.child;
      child.send({ kind: "run", config }, (error) => {
        if (error) this.failPending("ERROR", error.message, child);
      });
    });
  }
  cancel() {
    this.failPending("CANCELLED", "Caller interrupted the campaign");
    this.stop();
  }
}
