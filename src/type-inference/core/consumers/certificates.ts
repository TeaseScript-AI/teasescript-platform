import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import { typePlan } from "../../../type-plans.js";
import { SCALAR } from "../admission/kinds.js";
import { UNKNOWN_TYPE } from "../../../static-types.js";
import { certificateRequirement } from "../admission/requirements.js";
import { allowanceFor, CapReached, joinSteps, keepText, type WorkLedger } from "../budget.js";
import { Consumers, type CompletedWarning } from "../consumers.js";
import { Contract, hostAt, writtenOf } from "../contract.js";
import { keyContract } from "../contract/key-contract.js";
import { type Rest } from "../contract/key-ids.js";
import {
  ContractDescriptors,
  epochOf,
  typeOfKinds,
  type ContractResult,
} from "../contract-descriptors.js";
import { keyOf, keyPlace, keyPath, type Definition } from "../definitions.js";
import type { CorePass } from "../answers.js";
import { ReceivingDomain } from "../inherited/receiving-domain.js";
import type { FlowNode } from "../flow-graph.js";
import { makeItem, spelledBy, type Item, type ItemTag } from "../items.js";
import type { Work } from "../solver.js";
import { LITERALS } from "./kinds.js";
import { candidateVisitor } from "./stores.js";

// Scratch #2080 measurement only. Its unsupported facts decline, never become NoCheck.
export interface CertificateFacts {
  read(value: PlaceId, node: FlowNode | null, rest: Rest): readonly Item[];
  run<T>(work: Work<T>): T;
  unresolved(reason: UnresolvedReason): never;
}

export type CertificateMode = "off" | "capped" | "reference";
export interface CertificateOptions {
  readonly mode: CertificateMode;
  readonly k: number | null;
  readonly share: number | null;
}
export type CertificateOutcome =
  | "nocheck"
  | "required"
  | "unresolved-semantic"
  | "unresolved-total"
  | "rejected"
  | "ceiling"
  | "unseen";
export interface CertificateLedger extends CertificateOptions {
  readonly cap: number | null;
  readonly marked: number;
  readonly stores: {
    readonly site: readonly [number, number];
    readonly file: number;
    readonly path: readonly string[];
    readonly uid: number;
    readonly units: number;
    readonly outcome: CertificateOutcome;
    readonly reason?: UnresolvedReason;
  }[];
}
export interface StopCertificate {
  readonly uid: number;
  readonly value: PlaceId | undefined;
  readonly site: SourceSite;
  readonly place: PlaceId;
  readonly path: readonly string[];
  readonly epoch: number;
  readonly outcome: CertificateOutcome;
  readonly required?: Extract<ContractResult, { state: "complete" }>;
  readonly extent: "complete";
}
/** Why a store's certificate is Unresolved: the shape the scratch derivation refuses (#2080's reach table). */
export type UnresolvedReason =
  | "prior rejection"
  | "nested part"
  | "transfer or other store form"
  | "host destination"
  | "stopped destination key"
  | "projection"
  | "narrowed read"
  | "host the program writes"
  | "copy of an inferred place"
  | "copy of a written non-scalar place"
  | "compound value"
  | "solver demand"
  | "contract of another place"
  | "published domain"
  | "non-scalar contract"
  | "nested contract"
  | "inherited proof"
  | "inherited read";
class Unresolved extends Error {
  constructor(readonly reason: UnresolvedReason) {
    super(reason);
  }
}
class Rejected extends Error {}

/** Read once per analysis; `none` removes that term of the aggregate bound. */
export function certificateOptions(): CertificateOptions {
  const env = typeof process === "undefined" ? {} : process.env;
  const mode = env.TS2080_MODE ?? "off";
  if (mode !== "off" && mode !== "capped" && mode !== "reference")
    throw new Error("Invalid TS2080_MODE.");
  const k = env.TS2080_K === undefined || env.TS2080_K === "none" ? null : Number(env.TS2080_K);
  const share =
    env.TS2080_SHARE === undefined || env.TS2080_SHARE === "none" ? null : Number(env.TS2080_SHARE);
  if (k !== null && (!Number.isSafeInteger(k) || k < 0)) throw new Error("Invalid TS2080_K.");
  if (share !== null && (!Number.isFinite(share) || share < 0 || share > 1))
    throw new Error("Invalid TS2080_SHARE.");
  return { mode, k, share };
}

/** One pass over immediate facts. No yielded producer, solver memo, inferred-copy graph or A4 proof runs. */
class ImmediateFacts implements CertificateFacts {
  readonly contracts = new Map<string, readonly Item[]>();
  making = false;
  constructor(
    readonly pass: CorePass,
    readonly place: PlaceId,
  ) {}
  unresolved(reason: UnresolvedReason): never {
    throw new Unresolved(reason);
  }
  read(value: PlaceId, node: FlowNode | null, rest: Rest): readonly Item[] {
    const { program, contract, definitions } = this.pass;
    const work = program.work;
    work.charge("stopCertificates");
    if (rest.length !== 0) return this.unresolved("projection");
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      if (node !== null && this.pass.guards.narrowed(keyOf(binding, []), node))
        return this.unresolved("narrowed read");
      if (program.isHost(binding)) {
        // A host that this program writes needs value/order inference, not its ingress alone.
        if (
          definitions.storeDefs.some((d) => {
            work.charge("stopCertificates");
            return d.place === binding;
          })
        )
          return this.unresolved("host the program writes");
        return contract.entered(value, hostAt([]));
      }
      const term = writtenOf(program.place(binding).kind);
      if (term === null) return this.unresolved("copy of an inferred place");
      const tags = scalarTags(work, term);
      work.charge("stopCertificates", tags.length + 1);
      return tags.map((tag) => makeItem(tag, null, { cert: "pos", ...spelledBy(tags) }));
    }
    const place = program.places[value]?.kind;
    const has = program.hasOf.get(value);
    if (
      place?.kind !== "value" ||
      !LITERALS.has(place.node) ||
      has?.length !== 1 ||
      has[0]!.type.kind !== "atom"
    )
      return this.unresolved("compound value");
    const tag = has[0]!.type.name;
    if (!SCALAR.has(tag) && tag !== "null") return this.unresolved("compound value");
    work.charge("stopCertificates");
    return [makeItem(tag, null, { cert: "def" })];
  }
  run<T>(work: Work<T>): T {
    const ledger = this.pass.program.work;
    try {
      let step = work.next();
      while (!step.done) {
        ledger.charge("stopCertificates");
        const demand = step.value;
        if (!("key" in demand) || demand.proves === true || !demand.key.startsWith("c|"))
          return this.unresolved("solver demand");
        const key = demand.key.slice(2);
        if (keyPlace(key) !== this.place || keyPath(key).length !== 0 || this.making)
          return this.unresolved("contract of another place");
        let items = this.contracts.get(key);
        if (items === undefined) {
          this.making = true;
          try {
            // keyContract -> contractAlong -> the immediate contractOfValueAt adapter.
            items = this.run(keyContract(this.pass.contract, key));
            ledger.charge("stopCertificates", items.length + 1);
            keepText(ledger, key.length);
            this.contracts.set(key, items);
          } finally {
            this.making = false;
          }
        }
        step = work.next(items);
      }
      return step.value;
    } finally {
      // EVIDENCE: closing a discarded generator only unwinds it; its return value is never read.
      work.return?.(undefined as never);
    }
  }
}

function scalarTags(work: WorkLedger, term: TypeTerm): ItemTag[] {
  const pending = [term];
  const tags = new Set<ItemTag>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    work.charge("stopCertificates");
    if (next.kind === "union") {
      for (const member of next.members) {
        work.charge("stopCertificates");
        pending.push(member);
      }
    } else if (next.kind !== "atom" || (!SCALAR.has(next.name) && next.name !== "null"))
      throw new Unresolved("copy of a written non-scalar place");
    else tags.add(next.name);
  }
  return [...tags];
}

/** All stores are recorded, even after the one aggregate budget cuts a derivation. */
export function deriveCertificates(
  walk: Consumers,
  options: CertificateOptions,
  rejected: ReadonlyMap<number, unknown>,
): void {
  if (options.mode === "off") return;
  const { program, definitions } = walk.pass;
  const work = program.work;
  const epoch = epochOf(walk.pass);
  const stores = [...definitions.storeDefs, ...definitions.transferDefs]
    .filter((d) => walk.marked.has(d.uid))
    .map((d) => ({ d, path: d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path }));
  stores.sort(
    (a, b) =>
      a.d.site.file - b.d.site.file ||
      a.d.site.start - b.d.site.start ||
      a.d.site.end - b.d.site.end ||
      a.d.place - b.d.place ||
      comparePath(a.path, b.path) ||
      a.d.uid - b.d.uid,
  );
  const allowance = allowanceFor(program.syntaxNodes);
  const cap =
    options.mode === "reference"
      ? allowance
      : Math.min(
          options.k === null ? Infinity : options.k * stores.length,
          options.share === null ? Infinity : options.share * allowance,
        );
  const ledger: CertificateLedger = {
    ...options,
    cap: Number.isFinite(cap) ? cap : null,
    marked: stores.length,
    stores: [],
  };
  walk.certificateLedger = ledger;
  const start = work.certificateUnits;
  let cut = false;
  let byPlace: Map<PlaceId, Definition[]> | undefined;
  for (const { d, path } of stores) {
    const before = work.certificateUnits;
    let outcome: CertificateOutcome = cut
      ? options.mode === "reference"
        ? "unseen"
        : "unresolved-total"
      : "unresolved-semantic";
    let required: StopCertificate["required"];
    let reason: UnresolvedReason | undefined;
    if (!cut) {
      try {
        const result = work.certificateWork(Math.max(0, cap - (before - start)), () => {
          // Descriptor, identity, result and ledger-entry construction are included, before allocation.
          work.charge("stopCertificates", 12 + path.length);
          if (byPlace === undefined) {
            const index = new Map<PlaceId, Definition[]>();
            for (const store of [...definitions.storeDefs, ...definitions.transferDefs]) {
              work.charge("stopCertificates", 2);
              const list = index.get(store.place);
              if (list === undefined) index.set(store.place, [store]);
              else list.push(store);
            }
            byPlace = index;
          }
          // The scratch slice deliberately refuses non-root, transfer and compound cases.
          if (rejected.size !== 0) throw new Unresolved("prior rejection");
          if (d.kind !== "whole" || d.path.length !== 0) throw new Unresolved("nested part");
          if (d.how !== "initializer" && d.how !== "assignment")
            throw new Unresolved("transfer or other store form");
          if (program.isHost(d.place)) throw new Unresolved("host destination");
          if (walk.pass.contract.keyStopped(keyOf(d.place, [])))
            throw new Unresolved("stopped destination key");
          if (!walk.pass.lists.live(d)) return { outcome: "nocheck" as const };
          work.charge("stopCertificates", program.constraints.length);
          // Discard all admission/contract state with this store; share only source indexes and facts.
          const pass: CorePass = {
            ...walk.pass,
            receivingDomain: new ReceivingDomain(),
            get contract() {
              return contract;
            },
          };
          const contract = new Contract(pass);
          const facts = new ImmediateFacts(pass, d.place);
          contract.certificateValue = (value, rest) => facts.read(value, null, rest);
          const local = new Consumers(
            pass,
            new Map(),
            new Set(),
            true,
            true,
            false,
            undefined,
            null,
            facts,
          );
          const contributions = byPlace.get(d.place) ?? [];
          for (const candidate of contributions) {
            work.charge("stopCertificates");
            if (
              candidate.kind !== "whole" ||
              candidate.path.length !== 0 ||
              candidate.value === undefined ||
              (candidate.how !== "initializer" && candidate.how !== "assignment")
            )
              throw new Unresolved(
                candidate.kind !== "whole" || candidate.path.length !== 0
                  ? "nested part"
                  : "transfer or other store form",
              );
            facts.read(candidate.value, candidate.node, []);
          }
          const term = certificateRequirement(local.admission, d.place, []);
          if (term !== null) scalarTags(work, term);
          const decision = local.admission.decide({ root: d.place, path: [] });
          if (decision === null) return { outcome: "nocheck" as const };
          if (decision.published) throw new Unresolved("published domain");
          {
            let candidate = false;
            for (const entry of decision.candidates) {
              work.charge("stopCertificates");
              if (entry.d === d) candidate = true;
              for (const member of entry.members ?? []) {
                work.charge("stopCertificates");
                if (member === d) candidate = true;
              }
            }
            if (!candidate) return { outcome: "nocheck" as const };
          }
          // A rejection is a certificate refusal; never restart A6 or retain partial findings.
          local.admission.hearingRejections(
            () => {
              throw new Rejected();
            },
            () => candidateVisitor(local, { root: d.place, path: [] }, decision!)(d, []),
          );
          const warnings: CompletedWarning[] = [...local.diagnostics, ...local.deferred].filter(
            (item): item is CompletedWarning =>
              item.class === "warning-runtime-check" &&
              "obligation" in item &&
              !item.obligation.boundary,
          );
          work.charge(
            "stopCertificates",
            local.diagnostics.length + local.deferred.length + warnings.length + 2,
          );
          if (local.admission.rejections !== 0) throw new Rejected();
          if (warnings.length === 0) return { outcome: "nocheck" as const };
          // Only complete scalar contracts enter this slice. Nothing is truncated below them.
          const tags = local.admission.admitted(d.place, []);
          for (const tag of tags) {
            work.charge("stopCertificates");
            if (!SCALAR.has(tag) && tag !== "null") throw new Unresolved("non-scalar contract");
          }
          work.charge("stopCertificates", 8 + tags.length * 4);
          const descriptors = new ContractDescriptors<null>(
            {
              level: () => {
                throw new Unresolved("nested contract");
              },
              properties: () => {
                throw new Unresolved("nested contract");
              },
            },
            () => {
              throw new Unresolved("nested contract");
            },
            epoch,
            true,
          );
          const resultContract = descriptors.written(
            typePlan(typeOfKinds(tags, UNKNOWN_TYPE)),
            d.place,
            [],
          );
          if (resultContract.state !== "complete") throw new Unresolved("nested contract");
          // Publication is staged until every charged step of this store succeeds.
          work.charge("stopCertificates", warnings.length + 4);
          return { outcome: "required" as const, contract: resultContract, warnings };
        });
        outcome = result.outcome;
        if (result.outcome === "required") {
          required = result.contract;
          walk.completedWarnings.push(...result.warnings);
          walk.completedChecks.add(`${d.site.file}:${d.site.start}:${d.site.end}`);
          walk.receiving.push({
            obligation: {
              slot: { site: d.site, role: "store", store: `${d.kind}/${d.how ?? ""}` },
              epoch,
              place: d.place,
              path,
              extent: "complete",
            },
            result: required,
          });
        }
      } catch (error) {
        if (error instanceof CapReached) {
          cut = true;
          outcome = options.mode === "reference" ? "ceiling" : "unresolved-total";
        } else if (error instanceof Rejected) outcome = "rejected";
        else if (error instanceof Unresolved) reason = error.reason;
        else throw error;
      }
    }
    walk.certificates.push({
      uid: d.uid,
      value: d.value,
      site: d.site,
      place: d.place,
      path,
      epoch,
      outcome,
      ...(required === undefined ? {} : { required }),
      extent: "complete",
    });
    ledger.stores.push({
      site: [d.site.start, d.site.end],
      file: d.site.file,
      path,
      uid: d.uid,
      units: work.certificateUnits - before,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
function comparePath(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1)
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}
