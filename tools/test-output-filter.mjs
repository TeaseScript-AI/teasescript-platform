import { spawn } from "node:child_process";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function isPassingTestLine(line) {
  const plain = line.replace(ANSI_ESCAPE_PATTERN, "").trimStart();
  return /^✔(?:\s|$)/u.test(plain);
}

const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=spec", ...process.argv.slice(2)],
  { stdio: ["inherit", "pipe", "inherit"] },
);

let pending = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;

  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline + 1);
    pending = pending.slice(newline + 1);
    if (!isPassingTestLine(line)) process.stdout.write(line);
  }
});

child.stdout.on("end", () => {
  if (pending.length > 0 && !isPassingTestLine(pending)) {
    process.stdout.write(pending);
  }
});

child.on("error", (error) => {
  console.error(`Unable to start Node tests: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
