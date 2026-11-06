// The differential harness's shrinker (docs/TESTING.md "Differential harness"), migrated from the research kit of
// I-differential: it reduces a source while `preserves` holds, which the caller makes "still compiles and fails with
// the same signature". It deletes whole functions and line chunks, trims `min`/`max` arguments, simplifies positive
// integer literals to 1, and stops at the fixed point of single-line deletion: that minimality, not a global minimum.
export function shrink(source, preserves, { maxTrials = 10000 } = {}) {
  let trials = 0;
  const check = (s) =>
    s.length <= source.length && s !== source && trials++ < maxTrials && preserves(s);
  let removed = true;
  while (removed && trials < maxTrials) {
    removed = false;
    for (const match of source.matchAll(/^function[^\n]*\{(?:[^{}]|\{[^{}]*\})*\}\n/gm)) {
      const candidate = source.slice(0, match.index) + source.slice(match.index + match[0].length);
      if (check(candidate)) {
        source = candidate;
        removed = true;
        break;
      }
    }
  }
  let lines = source.trimEnd().split("\n"),
    granularity = 2;
  while (lines.length > 1 && trials < maxTrials) {
    const width = Math.ceil(lines.length / granularity);
    let reduced = false;
    for (let i = 0; i < lines.length; i += width) {
      const candidate = [...lines.slice(0, i), ...lines.slice(i + width)].join("\n") + "\n";
      if (check(candidate)) {
        source = candidate;
        lines = source.trimEnd().split("\n");
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= lines.length) break;
      granularity = Math.min(lines.length, granularity * 2);
    }
  }
  // Trim variadic calls by one argument, including the 17-argument boundary repro.
  let trimmed = true;
  while (trimmed && trials < maxTrials) {
    trimmed = false;
    for (const match of source.matchAll(/\b(min|max)\(([^()\n]*)\)/g)) {
      const argumentsList = match[2].split(",");
      for (let i = 0; i < argumentsList.length; i++) {
        const replacement =
          match[1] + "(" + argumentsList.filter((_, j) => i !== j).join(",") + ")";
        const candidate =
          source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
        if (check(candidate)) {
          source = candidate;
          trimmed = true;
          break;
        }
      }
      if (trimmed) break;
    }
  }
  let changed = true;
  while (changed && trials < maxTrials) {
    changed = false;
    for (const match of source.matchAll(/\b(?:[2-9]|[1-9][0-9]+)\b/g)) {
      const candidate =
        source.slice(0, match.index) + "1" + source.slice(match.index + match[0].length);
      if (check(candidate)) {
        source = candidate;
        changed = true;
        break;
      }
    }
  }
  // Literal reduction may admit further line deletions.
  let reduced = true;
  while (reduced && trials < maxTrials) {
    reduced = false;
    lines = source.trimEnd().split("\n");
    for (let i = 0; i < lines.length; i++) {
      const candidate = lines.filter((_, j) => j !== i).join("\n") + "\n";
      if (check(candidate)) {
        source = candidate;
        reduced = true;
        break;
      }
    }
  }
  return {
    source,
    trials,
    minimal: trials < maxTrials,
    notion: "single-line deletion and positive-integer-to-1, fixed point",
  };
}
