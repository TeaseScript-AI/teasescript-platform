import assert from "node:assert/strict";
import { test } from "node:test";
import { filesAtOnce, memoryLimitMib } from "./test-files-at-once.mjs";

const GIB = 2 ** 30;

/** A cgroup tree: `/proc/self/cgroup`'s membership line, and each cgroup's `memory.max` (absent: no such file). */
function tree(membership, limits) {
  const files = new Map([["/proc/self/cgroup", membership]]);
  for (const [path, value] of Object.entries(limits))
    files.set(`/cg${path === "/" ? "" : path}/memory.max`, `${value}\n`);
  return {
    root: "/cg",
    read: (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files.get(path);
    },
  };
}

const job = "0::/user.slice/user-1000.slice/agent-heavy-normal-1.scope\n";

test("the limit is the smallest memory.max of the process's cgroup and its parents", () => {
  const scope = "/user.slice/user-1000.slice/agent-heavy-normal-1.scope";
  assert.equal(memoryLimitMib(tree(job, { [scope]: 8 * GIB, "/user.slice": "max" })), 8192);
  assert.equal(
    memoryLimitMib(tree(job, { [scope]: "max", "/user.slice/user-1000.slice": 6 * GIB })),
    6144,
  );
  assert.equal(memoryLimitMib(tree(job, { [scope]: 8 * GIB, "/user.slice": 6 * GIB })), 6144);
});

test("no limit: memory.max is max everywhere, missing, or there is no cgroup v2", () => {
  const scope = "/user.slice/user-1000.slice/agent-heavy-normal-1.scope";
  assert.equal(memoryLimitMib(tree(job, { [scope]: "max", "/user.slice": "max" })), null);
  assert.equal(memoryLimitMib(tree(job, {})), null);
  assert.equal(memoryLimitMib(tree("0::/\n", {})), null);
  // cgroup v1 only: no `0::` line
  assert.equal(memoryLimitMib(tree("12:memory:/user.slice\n", { "/user.slice": 8 * GIB })), null);
  assert.equal(
    memoryLimitMib({
      read: () => {
        throw new Error("ENOENT");
      },
    }),
    null,
  );
});

test("files at once: one per core but one without a limit, as many as fit at 3 GiB plus 640 MiB a file under one", () => {
  for (const [cores, limitMib, expected, what] of [
    [3, null, 3, "CI: 4 cores, no limit"],
    [15, null, 15, "desktop, no limit"],
    [15, 16384, 15, "desktop, --mem 16G"],
    [15, 12288, 14, "desktop, --mem 12G"],
    [15, 8192, 8, "desktop, --mem 8G"],
    [15, 6144, 4, "desktop, --mem 6G"],
    [15, 4096, 1, "desktop, --mem 4G"],
    [15, 2048, 1, "below the reserve: still one"],
    [0, null, 1, "a single core: one"],
  ])
    assert.equal(filesAtOnce({ cores, limitMib }), expected, what);
});
