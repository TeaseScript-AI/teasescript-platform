// A run's result as the families runner (`run.mjs`) keeps it, and the judgment of the base's result against the
// head's: a difference, an exception, nodes left unanswered, or agreement.
import { createHash } from "node:crypto";
import { isRecordedReason, UNKNOWN_REASON } from "./run-contract.mjs";

/** An oracle's result as text (the publication's own text as it is: encoding it again would double a large one). */
const textOf = (value) => (typeof value === "string" ? value : JSON.stringify(value));

export const hash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * A publication's parts, each by its hash, in the whole's order (#1503), and the nodes its oracle left unanswered
 * (`unanswered`): the tree's `publicationHashes`, which hashes each part as it is made and never holds the whole, as
 * this library writes it or as a library before `unanswered` did (its parts alone), or an older library's
 * `publication` split into the same parts, with the count its fifth element holds where it has one; `null` when the
 * files do not parse or resolve. Why the oracle left nodes unanswered (`unansweredBy`: `questions`, `memory`,
 * `read-depth` or `stopped`, with the first node left or the binding where its answers' questions stopped) is the library's where it
 * gives one, else `unknown` (#1837's runner artefacts).
 */
export function partHashes(oracle, files, mode, globals) {
  if (typeof oracle.publicationHashes === "function") {
    const hashes = oracle.publicationHashes(files, mode, globals);
    return Array.isArray(hashes) ? { parts: hashes, unanswered: 0 } : withReason(hashes);
  }
  const whole = oracle.publication(files, mode, globals);
  if (whole === null) return null;
  const [answers, record, occurrences, route, stopped] = JSON.parse(whole);
  return withReason({
    parts: [answers, record, ...occurrences, route].map((part) => hash(JSON.stringify(part))),
    unanswered: stopped?.unanswered ?? 0,
  });
}

/**
 * A publication's hashes with why it left nodes unanswered: the oracle's reason with its first node left, or the
 * binding where its answers' questions stopped, in a form a record holds (`run-contract.mjs`), else `unknown` (no node
 * named).
 */
function withReason(hashes) {
  if (hashes === null || !(hashes.unanswered > 0)) return hashes;
  const by = hashes.unansweredBy;
  const where = Number.isInteger(by?.node)
    ? { node: by.node }
    : Number.isInteger(by?.binding)
      ? { binding: by.binding }
      : null;
  const named = where === null ? null : { reason: by?.reason, ...where };
  return {
    ...hashes,
    unansweredBy:
      named !== null && named.reason !== UNKNOWN_REASON && isRecordedReason(named)
        ? named
        : { reason: UNKNOWN_REASON, node: null },
  };
}

/**
 * A run's result by its hash (a publication's by its parts'), with a publication's part hashes (`parts`, each cut to 16
 * digits, which still place a difference and keep a stored run small) and unanswered nodes, and whether the files did
 * not parse; a stops run's decision stops too (`stops`, the oracle's `[pass, label, path, ordinal]`, #2355), which a
 * comparison classifies and a stored run never holds (`storable`).
 */
export const digest = (value) => ({
  hash: hash(textOf(value?.parts ?? value)),
  parts: value?.parts?.map((part) => part.slice(0, 16)) ?? null,
  unanswered: value?.unanswered ?? 0,
  ...(value?.unansweredBy === undefined ? {} : { unansweredBy: value.unansweredBy }),
  unparsed: value === null,
  ...(Array.isArray(value?.stops) ? { stops: value.stops } : {}),
});

/**
 * A run's result as a store keeps it: without a stops run's `stops` (#2355, the lead's ruling R12): a reader from before
 * #2355 refuses a stored run that holds them, and a `--needs-baseline` run reads through its own head's reader.
 */
export const storable = (result) => {
  if (result?.value?.stops === undefined) return result;
  const { stops: _, ...value } = result.value;
  return { ...result, value };
};

/** Whether `stops` is the oracle's decision stops (`stopSet`'s `stops`): `[pass, label, path, ordinal]` each. */
const decisionStops = (stops) =>
  Array.isArray(stops) &&
  stops.every(
    (stop) =>
      Array.isArray(stop) &&
      stop.length === 4 &&
      Number.isInteger(stop[0]) &&
      typeof stop[1] === "string" &&
      typeof stop[2] === "string" &&
      Number.isInteger(stop[3]),
  );

/**
 * Which decision stops two stops runs differ in (#2355), each stop known by its place (label and path) and its pass and
 * ordinal: at each place the stops identical on both trees pair first, and the rest pair in the oracle's order, a pair
 * at another pass or ordinal `moved` and a surplus on the head `added`, on the base `removed`, each with both trees'
 * `[pass, ordinal]` (`null` where that tree has none); `listsEqual` where the lists agree and the difference is in the
 * stop set's other fields. Known limit: which of a place's remaining stops pair is that order, not a fact the oracle
 * gives, so two stops of one place that both shift read as two moves in order. Where either side holds no list (a
 * stored run never does; an unparsed run or another oracle neither) or not the oracle's, `unavailable`, naming each
 * such side, never equal.
 */
function stopsApart(was, is) {
  const lacking = [
    ["base", was],
    ["head", is],
  ]
    .filter(([, value]) => !decisionStops(value?.stops))
    .map(([side, value]) =>
      value?.stops === undefined
        ? side === "base"
          ? "the base's run holds no stop list (a stored run never does): a run of the differing sources on two trees whose oracles list stops gives it"
          : "the head's run holds no stop list"
        : `the ${side}'s stop list is not the oracle's [pass, label, path, ordinal]`,
    );
  if (lacking.length > 0) return { stops: { unavailable: lacking.join("; ") } };
  const byPlace = (stops) => {
    const places = new Map();
    for (const [pass, label, path, ordinal] of stops) {
      const place = JSON.stringify([label, path]);
      if (!places.has(place)) places.set(place, []);
      places.get(place).push([pass, ordinal]);
    }
    return places;
  };
  /** `stops` without those `other` holds too, as a multiset, in their order. */
  const unpaired = (stops, other) => {
    const left = new Map();
    for (const stop of other) left.set(stop.join(" "), (left.get(stop.join(" ")) ?? 0) + 1);
    return stops.filter((stop) => {
      const count = left.get(stop.join(" ")) ?? 0;
      if (count > 0) left.set(stop.join(" "), count - 1);
      return count === 0;
    });
  };
  const [b, h] = [byPlace(was.stops), byPlace(is.stops)];
  const apart = { added: [], removed: [], moved: [] };
  for (const place of new Set([...b.keys(), ...h.keys()])) {
    const [label, path] = JSON.parse(place);
    const [onBase, onHead] = [b.get(place) ?? [], h.get(place) ?? []];
    // (no stop is left on both trees, so each remaining pair is at another pass or ordinal)
    const [before, after] = [unpaired(onBase, onHead), unpaired(onHead, onBase)];
    for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
      const [base, head] = [before[at] ?? null, after[at] ?? null];
      if (base === null) apart.added.push({ label, path, base, head });
      else if (head === null) apart.removed.push({ label, path, base, head });
      else apart.moved.push({ label, path, base, head });
    }
  }
  const none = Object.values(apart).every((list) => list.length === 0);
  return { stops: none ? { listsEqual: true } : apart };
}

/** Why a tree's result left nodes unanswered, or `null` where it left none; a stored run before #1837 says `unknown`. */
const reasonOf = (value) =>
  value === undefined || !(value.unanswered > 0)
    ? null
    : (value.unansweredBy ?? { reason: UNKNOWN_REASON, node: null });

/** Where two publications' parts first differ: the part's index in the whole's order and each one's count of parts. */
function firstPart(was, is) {
  if (was === null || is === null) return {};
  let part = 0;
  while (part < was.length && part < is.length && was[part] === is[part]) part += 1;
  return { part, parts: [was.length, is.length] };
}

/**
 * Whether two publications agree on what both answered, where either left nodes unanswered (#1837): the answers and the
 * record (unless either's answers stopped at a binding, where both are its stop's), each occurrence both answered, and
 * the route, by their hashes. `equal`; `{ differs }`, the first part that differs (its index, or `route`); or
 * `uncomparable` where either holds no parts (no base, or a stored base before #1503).
 */
function answeredPrefix(was, is) {
  const [base, head] = [was?.value?.parts, is.value.parts];
  if (!Array.isArray(base) || !Array.isArray(head)) return "uncomparable";
  const atBinding = [was.value, is.value].some(
    (value) => value.unansweredBy?.binding !== undefined,
  );
  const occurrences = Math.max(0, Math.min(base.length, head.length) - 3);
  const compared = [
    ...(atBinding ? [] : [0, 1]),
    ...Array.from({ length: occurrences }, (_, index) => 2 + index),
  ];
  const differs = compared.find((part) => base[part] !== head[part]);
  if (differs !== undefined) return { differs };
  return base.at(-1) === head.at(-1) ? "equal" : { differs: "route" };
}

/**
 * A run's outcome from the base's result (`was`, run or stored; none where the baseline has none) and the head's
 * (`is`): an exception on either, never compared (#1439); nodes left unanswered on either, agreement apart
 * (`unansweredAlike`, #1592) only where the base's result holds its parts and both trees left the same count
 * unanswered and published the same answered part (the parts up to the stop, by their hash), else `unanswered`, each
 * with whether what both answered agrees (`prefix`, `answeredPrefix`), a difference where it does not; with no base,
 * `uncompared`, never agreement; else a difference, or nothing where they agree. A stops `check`'s difference names its
 * stops (`stopsApart`).
 */
export function judged(was, is, check) {
  if (was?.thrown !== undefined || is.thrown !== undefined)
    return { thrown: { base: was?.thrown, head: is.thrown } };
  if (was?.value.unanswered > 0 || is.value.unanswered > 0) {
    const by = { base: reasonOf(was?.value), head: reasonOf(is.value) };
    const prefix = answeredPrefix(was, is);
    if (prefix.differs !== undefined)
      return {
        difference: {
          base: was.value.hash.slice(0, 16),
          head: is.value.hash.slice(0, 16),
          part: prefix.differs,
          parts: [was.value.parts.length, is.value.parts.length],
          unanswered: { base: was.value.unanswered, head: is.value.unanswered },
          by,
        },
      };
    return Array.isArray(was?.value.parts) &&
      was.value.unanswered === is.value.unanswered &&
      was.value.hash === is.value.hash
      ? { unansweredAlike: is.value.unanswered, by, prefix }
      : { unanswered: { base: was?.value.unanswered, head: is.value.unanswered }, by, prefix };
  }
  if (was === undefined) return { uncompared: true };
  if (was.value.hash === is.value.hash) return {};
  return {
    difference: {
      base: was.value.hash.slice(0, 16),
      head: is.value.hash.slice(0, 16),
      ...firstPart(was.value.parts, is.value.parts),
      ...(check.startsWith("stops ") ? stopsApart(was.value, is.value) : {}),
    },
  };
}
