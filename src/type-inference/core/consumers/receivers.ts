import type { PlaceId, SourceSite } from "../../graph.js";
import { concrete, isExternal, isOpaque } from "../admission.js";
import { joinParts, joinSteps, keepText, pathText } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { MEMBER_KINDS, REFERENCE } from "../contract.js";
import { keyOf, keyPath, keyPlace, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { firstWriter, makeItem, REASON, type Item, type ItemTag, type Writer } from "../items.js";
import { propertyName } from "../program.js";
import { offendingKinds, type DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { defaultNull } from "./fallbacks.js";
import { finishingKeyRead } from "./finishing.js";
import { hasMethod } from "./kinds.js";
import type { Offending } from "./model.js";
import { keyLabel, ownSpan, quietKinds, receiverKinds } from "./names.js";
import { nullWarning, obligation, propertiesOf } from "./warnings.js";

// C5a–c, F19a: a method's or a member's receiver, and the receiver of every store through a member and every add.

/** C5a, C5b, F19a: a method call's receiver, `get` and `clear` as any other; ADR 1.5's null default first. */
export function methodReceiver(
  walk: Consumers,
  site: SourceSite,
  node: FlowNode,
  receiver: PlaceId,
  name: string,
): void {
  // §3.3: a receiver that is never null and has the method (a reference's method is F19a's)
  const quiet = quietKinds(walk, receiver);
  if (
    quiet !== null &&
    quiet.every((tag) => tag !== "null" && !REFERENCE.has(tag) && hasMethod(tag, name))
  ) {
    walk.skip(receiver);
    return;
  }
  const kinds = receiverKinds(walk, receiver, node);
  const label = keyLabel(walk, receiver);
  // C9: the receiver's external data brings its boundary checks, whichever member check follows
  walk.admission.boundariesAt(
    kinds,
    obligation(
      "null-check",
      ownSpan(walk, receiver, site),
      label,
      ["non-null"],
      `check that ${label} is a value with .${name} before the call`,
    ),
  );
  defaultNull(walk, receiver, node, site, `.${name}()`, "call");
  memberChecks(
    walk,
    site,
    label,
    kinds,
    (tag) => hasMethod(tag, name),
    `.${name}()`,
    "call",
    walk.pass.program.textAt(ownSpan(walk, receiver, site)),
    `.${name}()`,
    [],
    receiver,
  );
}

/**
 * C5a–c, F19a, §4: a member access's receiver kinds at the whole access's span (§3.4). An error when every kind is
 * definite and null, or definite and without the member; else one warning and member obligation per offending kind:
 * a possible null, each kind without the member, each reference, an unknown receiver (its `on` names the kinds that
 * have the member, A7 r4.10), and the `extra` ones (an object without the property, an object's own selection).
 */
export function memberChecks(
  walk: Consumers,
  site: SourceSite,
  label: string,
  kinds: readonly Item[],
  takes: (tag: ItemTag) => boolean,
  what: string,
  use: "read" | "call" | "store",
  receiver: string,
  member: string,
  extra: readonly Offending[] = [],
  receiverPlace?: PlaceId,
  elements?: readonly ItemTag[],
): void {
  const rule: DiagnosticRule = {
    rule: "member",
    receiver,
    member,
    use,
    ...(elements === undefined ? {} : { elements }),
  };
  const detail = {
    text: receiver,
    kinds: kinds.map((item) => item.tag),
    member: member.replace(/^\.|\(\)$/g, ""),
  };
  const nulls = kinds.filter((item) => item.tag === "null");
  const others = kinds.filter((item) => item.tag !== "null");
  const lacking = others.filter(
    (item) => concrete(item) && !REFERENCE.has(item.tag) && !takes(item.tag),
  );
  const definite = (items: readonly Item[]): boolean =>
    items.length > 0 && items.length === kinds.length && items.every((item) => item.cert === "def");
  if (definite(nulls) || definite(lacking)) {
    error(
      walk,
      "member-read",
      site,
      rule,
      (definite(nulls) ? nulls : lacking).map((item) => item.tag),
    );
    return;
  }
  const has = `has ${what} before the ${use}`;
  const offending: Offending[] = [
    ...nulls.slice(0, 1).map((item): Offending => [item, `is not null before the ${use}`]),
    ...offendingKinds(lacking).map(({ item }): Offending => [item, has]),
    // F19a: a reference's member is the runtime's, `unmodelled` first (§3.4)
    ...offendingKinds(others.filter((item) => REFERENCE.has(item.tag))).map(
      ({ item }): Offending => [{ ...item, context: "unmodelled" }, has],
    ),
    ...others
      .filter((item) => isOpaque(item) || isExternal(item))
      .slice(0, 1)
      .map((item): Offending => [
        item,
        `is a ${MEMBER_KINDS.filter((kind) => takes(kind)).join("|") || "value"} with ${what} before the ${use}`,
      ]),
  ];
  // (a reference's members are the runtime's: a speaker or handle is a kind a test narrows to, with no fallback)
  const having = others.filter((item) => REFERENCE.has(item.tag) || takes(item.tag));
  for (const [item, on] of [...offending, ...extra])
    nullWarning(
      walk,
      "member-read",
      site,
      item,
      `check that ${label} ${on}`,
      label,
      rule,
      having,
      ["non-null"],
      detail,
      receiverPlace,
    );
}

/**
 * C5c for a store: whether the receiver's sources have the property, once per receiver key and property: `none` (every
 * known source lacks it), `some`, `all`; the sources are those the contract reads at the property's path, and the
 * earliest literal that lacks it, where the store's error points (ADR 1.4).
 */
function propertyPresence(
  walk: Consumers,
  receiver: Key,
  property: string,
): { readonly state: "none" | "some" | "all"; readonly literal: Writer | null } {
  const { program, contract } = walk.pass;
  const memoKey = joinParts(receiver, property);
  const known = walk.presence.get(memoKey);
  if (known !== undefined) return known;
  const path = keyPath(receiver);
  let lacks = false;
  let has = false;
  let literal: Writer | null = null;
  // a source without the property gives `missing`; an unknown value of a present property says nothing of it
  const see = (all: readonly Item[]): void => {
    // an empty source supplies no object
    const items = withoutEmpty(all);
    if (items.length === 0) return;
    for (const item of items)
      if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
        lacks = true;
        literal = firstWriter(literal, item.writer);
      }
    if (items.some((item) => !(item.tag === "unknown" && item.reasons === REASON.missing)))
      has = true;
  };
  for (let length = path.length; length >= 0 && !(lacks && has); length -= 1) {
    program.work.charge("checks");
    const stored = contract.prefixStores(keyOf(keyPlace(receiver), path.slice(0, length)));
    const below = joinSteps(path.slice(length), [property]);
    for (const entry of stored.list)
      if (!(lacks && has)) see(walk.run(contract.entryAt(entry, below)));
    for (const sub of contract.relevantSubs(stored, below))
      if (!(lacks && has)) see(walk.run(contract.subAt(sub.key, below)));
  }
  const presence = { state: lacks ? (has ? "some" : "none") : "all", literal } as const;
  keepText(program.work, memoKey.length);
  walk.presence.set(memoKey, presence);
  return presence;
}

/** Every store through a member and every add: its receiver (C5a–c, F19a). */
export function receivers(walk: Consumers): void {
  const { program, definitions, values } = walk.pass;
  walk.enter(2);
  for (const d of walk.order(
    definitions.storeDefs.filter(
      (found) => found.recv !== null && (found.kind === "whole" || found.kind === "add"),
    ),
  )) {
    if (!walk.runs(d.site)) continue;
    walk.reading = d.prep ?? d.node;
    const receiver = withoutEmpty(
      walk.finishing
        ? finishingKeyRead(walk, d.recv!, d.prep ?? d.node)
        : walk.run(values.keyItems(d.recv!, d.prep ?? d.node), () =>
            walk.pass.contract.contractOf(d.recv!),
          ),
    );
    const owner = d.into === undefined ? undefined : program.projOf.get(d.into)?.owner;
    // §3.4: the whole member or element access, including a mutator's call.
    const at = d.into !== undefined ? ownSpan(walk, d.into, d.site) : d.site;
    const recvPath = keyPath(d.recv!);
    const label =
      owner !== undefined
        ? keyLabel(walk, owner)
        : program.place(d.place).label +
          (recvPath.length > 0 ? `.${pathText(recvPath.map(propertyName))}` : "");
    // C9: the receiver's external data brings its boundary checks, whichever member check follows
    walk.admission.boundariesAt(
      receiver,
      obligation("null-check", at, label, ["non-null"], `check that ${label} accepts the store`),
    );
    // what the store needs of its receiver: a property store an object, an element store a list or a dict, an add
    // its method (C5b: `x.missing = 2` with x a whole number fails at runtime)
    const property = d.kind === "whole" ? (d.path.at(-1) ?? null) : null;
    const method =
      d.kind === "add"
        ? d.how === "element"
          ? "add"
          : d.how === "elements"
            ? "addAll"
            : undefined
        : undefined;
    const takes = (tag: ItemTag): boolean =>
      d.kind === "add"
        ? method === undefined || hasMethod(tag, method)
        : property === "element"
          ? tag === "list" || tag === "dict"
          : tag === "object";
    const what =
      d.kind === "add"
        ? `.${method}()`
        : property === "element"
          ? "an element store"
          : `a store of .${property === null ? property : propertyName(property)}`;
    // D1: the receiver in its own text, and the member as the access writes it
    const receiverText = owner !== undefined ? program.textAt(ownSpan(walk, owner, d.site)) : label;
    const member =
      d.kind === "add"
        ? `.${method ?? "add"}()`
        : property === "element"
          ? "[i]"
          : `.${property === null ? "" : propertyName(property)}`;
    // C5c, ADR 1.4: a store of a property into objects: every known source lacks it, an error at the literal; some
    // lacks it, its member obligation; every source has it, nothing
    const extra: Offending[] = [];
    if (
      property !== null &&
      property !== "element" &&
      receiver.some((item) => item.tag === "object")
    ) {
      const presence = propertyPresence(walk, d.recv!, property);
      const alone = receiver.every((item) => item.tag === "object");
      // never an error under a guard of the receiver (§3.2)
      if (presence.state === "none" && alone && !receiver.some((item) => item.guarded === true)) {
        error(
          walk,
          "member-read",
          presence.literal ?? d.site,
          {
            rule: "absent",
            receiver: receiverText,
            property: propertyName(property),
            store: presence.literal === null ? null : at,
            properties: [...propertiesOf(walk, { key: d.recv! })],
          },
          [],
        );
        continue;
      }
      if (presence.state !== "all")
        extra.push([
          makeItem("unknown", null, { reasons: REASON.missing, context: "missing", cert: "pos" }),
          `has .${propertyName(property)} before the store`,
        ]);
    }
    memberChecks(
      walk,
      at,
      label,
      receiver,
      takes,
      what,
      "store",
      receiverText,
      member,
      extra,
      owner,
    );
  }
}
