import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

// How many test files the full suite runs at once: one per core but one, as `node --test` runs them, and under the job's
// memory (`jobMemoryMib`: the queue's reservation or a cgroup limit, the smaller) no more than fit in it. Measured on 2026-11-08 (desktop, main a7b8297ec, the full compiled suite at a
// fixed number of files at once, its job's own processes sampled): the anonymous-memory peak of the whole run was 3.3,
// 4.8, 7.1, 9.8 and 11.7 GB at 2, 4, 8, 12 and 15 files at once, close to 2.1 GB plus 0.64 GB a file; file cache
// stayed under 90 MiB. Most of the 2.1 GB is the heaviest file alone (`type-core-cells`, before its split, 2.7 to
// 2.9 GB). The limit here allows 3 GiB plus 640 MiB a file, at least 800 MiB over each measured peak, so that a run
// fits rather than being killed at its cap. Remeasure when a test file's memory changes much.
export const RESERVE_MIB = 3 * 1024;
export const PER_FILE_MIB = 640;

/**
 * The smallest `memory.max` of this process's cgroup (v2) and its parents, in MiB, or `null` when none sets one or it
 * cannot be read (no cgroup v2, as under cgroup v1 or outside Linux). `root` and `read` let a test give a cgroup tree.
 */
export function memoryLimitMib({
  root = "/sys/fs/cgroup",
  read = (path) => readFileSync(path, "utf8"),
} = {}) {
  let membership;
  try {
    membership = read("/proc/self/cgroup");
  } catch {
    return null;
  }
  const line = membership.split("\n").find((entry) => entry.startsWith("0::"));
  if (line === undefined) return null;
  let limit = null;
  for (let path = line.slice(3).trim() || "/"; ; path = dirname(path)) {
    try {
      const value = read(join(root, path, "memory.max")).trim();
      const mib = Number(value) / 2 ** 20;
      if (value !== "max" && Number.isFinite(mib))
        limit = limit === null ? mib : Math.min(limit, mib);
    } catch {
      // (the root cgroup has no `memory.max`, and a parent may not be readable)
    }
    if (path === "/") return limit;
  }
}

/**
 * The memory the suite sizes from, in MiB: the job's reservation (`SX_MEM_MIB`, which the queue sets) and the smallest
 * visible cgroup limit (`memoryLimitMib`), the smaller where both exist; either where one does; `null` with neither. The
 * reservation can only lower the figure, never raise it above a cap the runner can see: on a worker without a per-job
 * cgroup cap, the visible limit is the whole container's (#2154). A value that is not a positive whole number of MiB
 * throws, rather than leaving the figure to the container.
 */
export function jobMemoryMib({ env = process.env, cgroupMib = memoryLimitMib() } = {}) {
  const value = env.SX_MEM_MIB;
  if (value === undefined) return cgroupMib;
  const mib = /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(mib) || mib < 1)
    throw new Error(`SX_MEM_MIB is not a positive whole number of MiB: ${JSON.stringify(value)}`);
  return cgroupMib === null ? mib : Math.min(mib, cgroupMib);
}

/** The test files to run at once on `cores` (default: one per core but one) under `limitMib` (`null`: no limit). */
export function filesAtOnce({
  cores = availableParallelism() - 1,
  limitMib = jobMemoryMib(),
} = {}) {
  const most = Math.max(1, cores);
  if (limitMib === null) return most;
  return Math.min(most, Math.max(1, Math.floor((limitMib - RESERVE_MIB) / PER_FILE_MIB)));
}
