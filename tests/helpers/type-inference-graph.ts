import { CORE_RUNTIME_BUILTINS } from "../../src/compiler.js";
import { parse } from "../../src/parser.js";
import { validateProjectSemantics } from "../../src/semantic.js";
import type { TypeAnalysisRequest } from "../../src/type-inference/backend.js";
import type {
  ChoiceElementEvidence,
  ConstraintGraph,
  PlaceId,
  RegionRef,
  SyntaxEvidence,
  TypeTerm,
} from "../../src/type-inference/graph.js";
import { registryView } from "../../src/type-inference/registry-view.js";

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
    services: { valueKinds: registryView() },
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

/** The places syntax evidence refers to: every written element, descriptor part and choice object. */
function evidencePlaces(evidence: SyntaxEvidence | undefined): (PlaceId | null)[] {
  const element = (entry: ChoiceElementEvidence): (PlaceId | null)[] => [
    entry.place,
    ...(entry.object === null ? [] : [entry.object.value, entry.object.text]),
  ];
  switch (evidence?.kind) {
    case "form":
      if (evidence.fields === "computed") return [];
      return evidence.fields.entries.flatMap((field) => {
        const written = field.written;
        switch (written.kind) {
          case "object":
            return [
              field.place,
              written.value,
              written.min,
              written.max,
              ...(written.options === null
                ? []
                : [written.options.place, ...(written.options.elements ?? []).flatMap(element)]),
            ];
          case "list":
            return [field.place, ...written.elements.flatMap(element)];
          default:
            return [field.place];
        }
      });
    case "choice":
      return evidence.options.flatMap((option) => [
        option.place,
        ...(option.content.kind === "object"
          ? [option.content.object.value, option.content.object.text]
          : option.content.kind === "other"
            ? []
            : option.content.elements.flatMap(element)),
      ]);
    default:
      return [];
  }
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
