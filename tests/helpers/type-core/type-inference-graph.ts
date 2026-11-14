import { CORE_RUNTIME_BUILTINS } from "../../../src/compiler.js";
import { parse } from "../../../src/parser.js";
import { validateProjectSemantics } from "../../../src/semantic.js";
import type { TypeAnalysisRequest } from "../../../src/type-inference/backend.js";
import type {
  ChoiceElementEvidence,
  Constraint,
  ConstraintGraph,
  NamedPlace,
  Place,
  PlaceId,
  RegionRef,
  SourceSite,
  SyntaxEvidence,
  TestShape,
  TypeTerm,
} from "../../../src/type-inference/graph.js";

/**
 * The request the compiler would make for these files, after name checking; `null` when they do not parse or
 * resolve. Shared by the graph tests and the deep-shape probe.
 */
export function request(
  files: readonly { readonly path: string; readonly source: string }[],
  globals: readonly string[] = [],
  builtins: readonly string[] = [],
): TypeAnalysisRequest | null {
  const results = files.map((file) => parse(file.source));
  if (results.some((result) => result.diagnostics.length > 0)) return null;
  const parsed = files.map((file, index) => ({
    path: file.path,
    program: results[index]!.program,
  }));
  const options = { builtins: [...CORE_RUNTIME_BUILTINS, ...builtins], globals };
  const names = validateProjectSemantics(parsed, options);
  if (
    names.some((result) => result.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
  )
    return null;
  return {
    files: parsed,
    options: {
      ...options,
      sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
      written: {
        lets: new Set(names.flatMap((result) => [...result.writtenLets])),
        globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
      },
      speakers: new Map(names.flatMap((result) => [...result.speakers])),
    },
  };
}

/** The places a term refers to, at any depth, found with a worklist: a term nests as deep as it is written. */
function termPlaces(term: TypeTerm | null): PlaceId[] {
  const places: PlaceId[] = [];
  const work: TypeTerm[] = term === null ? [] : [term];
  while (work.length > 0) {
    const item = work.pop()!;
    switch (item.kind) {
      case "ref":
        places.push(item.place);
        break;
      case "list":
      case "set":
      case "dict":
        work.push(item.element);
        break;
      case "object":
        for (const property of item.properties ?? []) work.push(property.type);
        break;
      case "union":
        for (const member of item.members) work.push(member);
        break;
      default:
        break;
    }
  }
  return places;
}

/** The places syntax evidence refers to: every written element and choice object. */
function evidencePlaces(evidence: SyntaxEvidence | undefined): (PlaceId | null)[] {
  const element = (entry: ChoiceElementEvidence): (PlaceId | null)[] => [
    entry.place,
    ...(entry.object === null ? [] : [entry.object.value, entry.object.text]),
  ];
  if (evidence === undefined) return [];
  return evidence.options.flatMap((option) =>
    option.content.kind === "object"
      ? [option.content.object.value, option.content.object.text]
      : option.content.kind === "other"
        ? []
        : option.content.elements.flatMap(element),
  );
}

/**
 * Whether every place, function and handler the graph refers to exists: in a place's kind, a function's signature,
 * a handler's creating region, and a constraint's fields, region, term and evidence.
 */
export function referencesExist(graph: ConstraintGraph): boolean {
  const place = (id: number | null): boolean =>
    id === null || (id >= 0 && id < graph.places.length);
  const fn = (id: number): boolean => id >= 0 && id < graph.functions.length;
  const handler = (id: number): boolean => id >= 0 && id < graph.handlers.length;
  const region = (ref: RegionRef): boolean =>
    ref.kind === "function" ? fn(ref.fn) : ref.kind === "handler" ? handler(ref.handler) : true;
  const signatures = graph.functions.every(
    (signature) => signature.parameters.every(place) && place(signature.result),
  );
  const regions =
    graph.handlers.every((entry) => region(entry.created)) &&
    graph.constraints.every((constraint) => region(constraint.region));
  const named = (entries: readonly { readonly value: number }[]): boolean =>
    entries.every((entry) => place(entry.value));
  const kinds = graph.places.every((owned) => {
    const kind = owned.kind;
    switch (kind.kind) {
      case "cell":
      case "property":
        return place(kind.owner);
      case "parameter":
      case "result":
        return fn(kind.fn) && termPlaces(kind.written).every(place);
      case "binding":
        return termPlaces(kind.written).every(place);
      default:
        return true;
    }
  });
  return (
    kinds &&
    signatures &&
    regions &&
    graph.constraints.every((constraint) => {
      switch (constraint.kind) {
        case "has":
          return place(constraint.place) && termPlaces(constraint.type).every(place);
        case "store":
          return place(constraint.value) && place(constraint.into);
        case "project":
          return place(constraint.owner) && place(constraint.into);
        case "read":
          return place(constraint.binding) && place(constraint.occurrence);
        case "assign":
          return place(constraint.binding) && place(constraint.value);
        case "mutate":
          return place(constraint.binding);
        case "test":
          return (
            place(constraint.subject) &&
            (constraint.shape.kind !== "type" || termPlaces(constraint.shape.type).every(place))
          );
        case "operation":
          return (
            place(constraint.receiver) &&
            constraint.arguments.every(place) &&
            named(constraint.named) &&
            place(constraint.result) &&
            evidencePlaces(constraint.evidence).every(place)
          );
        case "get":
          return (
            place(constraint.receiver) &&
            place(constraint.key) &&
            place(constraint.fallback) &&
            place(constraint.result)
          );
        case "fallback":
          return place(constraint.left) && place(constraint.right) && place(constraint.result);
        case "call":
          return (
            fn(constraint.fn) &&
            constraint.arguments.every(place) &&
            named(constraint.named) &&
            place(constraint.result)
          );
        case "return":
          return fn(constraint.fn) && place(constraint.value);
        case "exit":
          return fn(constraint.fn);
        case "load":
          return (
            place(constraint.view) &&
            termPlaces(constraint.receiver).every(place) &&
            place(constraint.fallback) &&
            place(constraint.result)
          );
        case "save":
        case "speakerStore":
          return place(constraint.value);
        case "speakerRead":
        case "knownValue":
          return place(constraint.occurrence);
      }
    })
  );
}

/** The graph as a text, one line per place, function, handler, and constraint, the same for the same graph. */
export function graphText(graph: ConstraintGraph): string {
  const lines: string[] = [];
  for (const place of graph.places)
    lines.push(`${placeName(graph, place.id)}: ${placeKindText(graph, place)}`);
  for (const fn of graph.functions)
    lines.push(
      `fn ${fn.name}#${fn.id}${fn.global ? " global" : ""} (${fn.parameters.map((id) => placeName(graph, id)).join(", ")}) -> ${placeName(graph, fn.result)} @${siteText(fn.site)}`,
    );
  for (const handler of graph.handlers)
    lines.push(
      `handler#${handler.id} @${siteText(handler.site)} in ${regionText(handler.created)}${handler.selfHandle === null ? "" : ` as ${handler.selfHandle}`}`,
    );
  for (const constraint of graph.constraints) lines.push(constraintText(graph, constraint));
  return lines.join("\n");
}

/** The text of a term, written with an explicit stack: a term nests as deep as its annotation or literal. */
function typeTermText(term: TypeTerm, graph?: ConstraintGraph): string {
  const out: string[] = [];
  // Pending terms and the text between them, in reverse order of appearance.
  const work: (TypeTerm | string)[] = [term];
  while (work.length > 0) {
    const item = work.pop()!;
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    switch (item.kind) {
      case "atom":
        out.push(item.name);
        break;
      case "never":
        out.push("never");
        break;
      case "dynamic":
        out.push(`dynamic(${item.why})`);
        break;
      case "list":
      case "set":
      case "dict":
        work.push(">", item.element, `${item.kind}<`);
        break;
      case "object":
        if (item.properties === null) {
          out.push("object");
          break;
        }
        work.push("}");
        for (let index = item.properties.length - 1; index >= 0; index -= 1) {
          const property = item.properties[index]!;
          work.push(property.type, `${index === 0 ? "" : ", "}${property.name}: `);
        }
        work.push("{");
        break;
      case "union":
        work.push(")");
        for (let index = item.members.length - 1; index >= 0; index -= 1) {
          work.push(item.members[index]!);
          if (index > 0) work.push(" | ");
        }
        work.push("(");
        break;
      case "restricted":
        out.push(`${item.name}{${item.values.map((value) => JSON.stringify(value)).join("|")}}`);
        break;
      case "ref":
        out.push(graph === undefined ? `ref#${item.place}` : `ref ${placeName(graph, item.place)}`);
        break;
    }
  }
  return out.join("");
}

/** How a dump names a place: its label and its id. */
function placeName(graph: ConstraintGraph, id: PlaceId): string {
  return `${graph.places[id]!.label}#${id}`;
}

function siteText(site: SourceSite): string {
  return `${site.file}:${site.start}-${site.end}`;
}

function regionText(region: RegionRef): string {
  switch (region.kind) {
    case "start":
      return "start";
    case "file":
      return `file ${region.file}`;
    case "function":
      return `fn#${region.fn}`;
    case "handler":
      return `handler#${region.handler}`;
  }
}

function placeKindText(graph: ConstraintGraph, place: Place): string {
  const kind = place.kind;
  const at = place.site === null ? "" : ` @${siteText(place.site)}`;
  switch (kind.kind) {
    case "binding":
      return `${kind.declared} ${kind.name}${kind.written === null ? "" : `: ${typeTermText(kind.written, graph)}`}${at}`;
    case "value":
      return `value ${kind.node}${at}`;
    case "target":
      return `target ${kind.node}${at}`;
    case "cell":
      return `${kind.step} of ${placeName(graph, kind.owner)}${at}`;
    case "property":
      return `property ${kind.name} of ${placeName(graph, kind.owner)}${at}`;
    case "speakerProperty":
      return `speaker ${kind.speaker}.${kind.name}${at}`;
    case "parameter":
      return `parameter ${kind.index} ${kind.name} of fn#${kind.fn}${kind.written === null ? "" : `: ${typeTermText(kind.written, graph)}`}${at}`;
    case "result":
      return `result of fn#${kind.fn}${kind.written === null ? "" : `: ${typeTermText(kind.written, graph)}`}${at}`;
    case "storageKey":
      return `storage key ${JSON.stringify(kind.key)}`;
    case "loadView":
      return `load view of ${kind.key === null ? "a computed key" : JSON.stringify(kind.key)}${at}`;
  }
}

function constraintText(graph: ConstraintGraph, constraint: Constraint): string {
  const name = (id: PlaceId): string => placeName(graph, id);
  const named = (places: readonly NamedPlace[]): string =>
    places.map((entry) => `, ${entry.name}: ${name(entry.value)}`).join("");
  const where = ` @${siteText(constraint.site)} ${constraint.role} in ${regionText(constraint.region)}`;
  switch (constraint.kind) {
    case "has":
      return `has ${name(constraint.place)} ${typeTermText(constraint.type, graph)}${where}`;
    case "store":
      return `store ${name(constraint.value)} -> ${name(constraint.into)} ${constraint.how}${where}`;
    case "project":
      return `project ${name(constraint.owner)}${typeof constraint.step === "string" ? `[${constraint.step}]` : `.${constraint.step.property}`} -> ${name(constraint.into)}${where}`;
    case "read":
      return `read ${name(constraint.binding)} -> ${name(constraint.occurrence)} at ${siteText(constraint.point.site)}${where}`;
    case "assign":
      return `assign ${name(constraint.value)} -> ${name(constraint.binding)} at ${siteText(constraint.point.site)}${where}`;
    case "mutate":
      return `mutate ${name(constraint.binding)} at ${siteText(constraint.point.site)}${where}`;
    case "test":
      return `test ${name(constraint.subject)} ${testShapeText(graph, constraint.shape)} at ${siteText(constraint.point.site)}${where}`;
    case "operation":
      return `operation ${constraint.contract.family}.${constraint.contract.name}(${constraint.receiver === null ? "" : `${name(constraint.receiver)}; `}${constraint.arguments.map(name).join(", ")}${named(constraint.named)}) -> ${name(constraint.result)}${constraint.evidence === undefined ? "" : ` ${JSON.stringify(constraint.evidence)}`}${where}`;
    case "get":
      return `get ${name(constraint.receiver)}${constraint.key === null ? "" : `[${name(constraint.key)}]`} default ${name(constraint.fallback)} -> ${name(constraint.result)}${where}`;
    case "fallback":
      return `fallback ${name(constraint.left)} otherwise ${name(constraint.right)} -> ${name(constraint.result)}${where}`;
    case "call":
      return `call fn#${constraint.fn}(${constraint.arguments.map(name).join(", ")}${named(constraint.named)}) -> ${name(constraint.result)}${where}`;
    case "return":
      return `return ${constraint.value === null ? "nothing" : name(constraint.value)} from fn#${constraint.fn}${where}`;
    case "exit":
      return `exit fn#${constraint.fn}${where}`;
    case "load":
      return `load ${constraint.key === null ? "computed key" : JSON.stringify(constraint.key)} view ${name(constraint.view)}${constraint.receiver === null ? "" : ` as ${typeTermText(constraint.receiver, graph)}`}${constraint.fallback === null ? "" : ` default ${name(constraint.fallback)}`} -> ${name(constraint.result)}${where}`;
    case "save":
      return `save ${name(constraint.value)} as ${constraint.key === null ? "computed key" : JSON.stringify(constraint.key)}${where}`;
    case "speakerStore":
      return `speaker store ${constraint.speaker ?? "?"}.${constraint.property} <- ${name(constraint.value)}${where}`;
    case "speakerRead":
      return `speaker read ${constraint.speaker ?? "?"}.${constraint.property} -> ${name(constraint.occurrence)}${where}`;
    case "knownValue":
      return `known ${name(constraint.occurrence)} from ${siteText(constraint.initializer)}${where}`;
  }
}

function testShapeText(graph: ConstraintGraph, shape: TestShape): string {
  const not = shape.negated ? "not " : "";
  switch (shape.kind) {
    case "type":
      return `${not}is ${typeTermText(shape.type, graph)}`;
    case "null":
      return `${not}null`;
  }
}
