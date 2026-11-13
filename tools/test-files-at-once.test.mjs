import assert from "node:assert/strict";
import { test } from "node:test";
import { filesAtOnce, jobMemoryMib, memoryLimitMib } from "./test-files-at-once.mjs";

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

test("files at once: one per core but one without a limit, as many as fit at 4 GiB plus 576 MiB a file under one", () => {
  for (const [cores, limitMib, expected, what] of [
    [3, null, 3, "CI: 4 cores, no limit"],
    [15, null, 15, "desktop, no limit"],
    [15, 16384, 15, "desktop, --mem 16G"],
    [15, 12288, 14, "desktop, --mem 12G"],
    [15, 8192, 7, "desktop, --mem 8G"],
    [15, 6144, 3, "desktop, --mem 6G"],
    [15, 4096, 1, "desktop, --mem 4G"],
    [15, 2048, 1, "below the reserve: still one"],
    [0, null, 1, "a single core: one"],
  ])
    assert.equal(filesAtOnce({ cores, limitMib }), expected, what);
});

test("the job's memory: SX_MEM_MIB and a visible cgroup limit, the smaller, so the variable never raises a cap (#2154)", () => {
  const env = (value) => ({ SX_MEM_MIB: value });
  // (the variable smaller: a 6 GiB reservation on a worker whose only visible limit is the container's 40 GiB)
  assert.equal(jobMemoryMib({ env: env("6144"), cgroupMib: 40960 }), 6144);
  assert.equal(
    filesAtOnce({ cores: 15, limitMib: jobMemoryMib({ env: env("6144"), cgroupMib: 40960 }) }),
    3,
  );
  // (the cgroup smaller: a cap the runner can see wins over a larger reservation)
  assert.equal(jobMemoryMib({ env: env("16384"), cgroupMib: 6144 }), 6144);
  // (one of them alone, or neither)
  assert.equal(jobMemoryMib({ env: env("6144"), cgroupMib: null }), 6144);
  assert.equal(jobMemoryMib({ env: {}, cgroupMib: 8192 }), 8192);
  assert.equal(jobMemoryMib({ env: {}, cgroupMib: null }), null);
  assert.equal(jobMemoryMib({ env: env("06144"), cgroupMib: null }), 6144);
  for (const value of ["0", "00", "-1", "6G", "", "6144.5", " 6144", "9".repeat(400)])
    assert.throws(
      () => jobMemoryMib({ env: env(value), cgroupMib: null }),
      /SX_MEM_MIB/u,
      JSON.stringify(value),
    );
});

test("filesAtOnce's default sizes from SX_MEM_MIB, whatever the cgroup this runs in (#2154)", (t) => {
  // (1 MiB is below the reserve whatever the visible cgroup limit is, so the default gives one file at once, as only a
  // default that reads the variable can)
  const before = process.env.SX_MEM_MIB;
  t.after(() =>
    before === undefined ? delete process.env.SX_MEM_MIB : (process.env.SX_MEM_MIB = before),
  );
  process.env.SX_MEM_MIB = "1";
  assert.equal(filesAtOnce({ cores: 15 }), 1);
});
