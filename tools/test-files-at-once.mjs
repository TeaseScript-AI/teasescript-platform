import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";

// How many test files the full suite runs at once: one per core but one, as `node --test` runs them, and under the
// job's memory (`jobMemoryMib`: the queue's reservation or a cgroup limit, the smaller) no more than fit in it.
// Measured on 2026-11-13 (desktop, main 35e266737, the full compiled suite at a fixed number of files at once, three
// runs a point, the job's own memory as the kernel's `memory.peak`): the largest of three peaks was 3,312, 5,436,
// 7,104, 9,733 and 10,857 MiB at 2, 4, 8, 12 and 15 files at once, and one file at a time, in one run, 2,522 MiB, the
// floor, about 700 MiB under a straight line through the rest. Runs of one point differ by 9 to 31 %, up to 1,292 MiB:
// the files start in the same order, and the likely cause is the machine's other work, which stretched the heavy files'
// runs unevenly (by 20 to 28 % in the highest run) and so moves which of them are at their peak together (the jobs keep
// no memory series to show it). So a single run does not measure a point. The limit here allows 4 GiB plus 576 MiB a
// file, at least 800 MiB over the largest of three runs at every point (964 MiB at 4 files, the least): a margin sized
// to the whole spread would run one file fewer at once at 6, 8 and 12 GiB, and a job that exceeds its cap is rerun
// larger. Remeasure when a test file's memory changes much.
export const RESERVE_MIB = 4 * 1024;
export const PER_FILE_MIB = 576;

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
