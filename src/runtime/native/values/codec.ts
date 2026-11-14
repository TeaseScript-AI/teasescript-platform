import type {
  SerializableRuntimeDictEntry,
  SerializableRuntimeProperty,
  SerializableRuntimeValue,
} from "../../values/serializable-values.js";
import {
  NativeDict,
  NativeObject,
  type NativeComposite,
  type NativeLeaf,
  type NativeValue,
} from "./native-value.js";
import { NativeSet } from "./native-set.js";

// The two directions between canonical values (`SerializableRuntimeValue`, the form snapshots, checkpoints and hosts
// use) and native values (`native-value.ts`). Neither direction validates: `fromCanonical` takes a value that was
// captured and validated where it entered, and `toCanonical` writes a valid one from valid native data. Neither shares a
// mutable part with its input, and neither recurses on the JavaScript call stack, so values of any depth convert.

/** The native value of a validated canonical value; leaf records are copied and frozen. */
export function fromCanonical(value: SerializableRuntimeValue): NativeValue {
  if (value === null || typeof value !== "object") return value;
  type Source = Exclude<SerializableRuntimeValue, null | string | number | boolean>;
  const work: Array<readonly [Source, NativeComposite]> = [];
  const convert = (source: Source): NativeValue => {
    let target: NativeComposite;
    switch (source.kind) {
      case "list":
        target = [];
        break;
      case "set":
        target = new NativeSet();
        break;
      case "object":
        target = new NativeObject();
        break;
      case "dict":
        target = new NativeDict();
        break;
      case "range":
      case "duration":
      case "calendarDuration":
      case "angle":
      case "date":
      case "time":
      case "datetime":
      case "absoluteDateTime":
      case "timerHandle":
      case "mediaHandle":
      case "permanentButtonHandle":
      case "messageHandle":
      case "cameraView":
      case "speakerReference":
      case "script":
      case "regex":
        return Object.freeze({ ...source });
      default:
        // A new kind of value is classified here and in `NativeLeaf` before a native value can hold it.
        source satisfies never;
        throw new Error("A canonical value of an unknown kind has no native form.");
    }
    work.push([source, target]);
    return target;
  };
  const part = (child: SerializableRuntimeValue): NativeValue =>
    child === null || typeof child !== "object" ? child : convert(child);
  const root = convert(value);
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    // `convert` paired each source with a target of its kind; the casts below name that pairing.
    switch (source.kind) {
      case "list": {
        // EVIDENCE: invariant: `convert` pairs a list with a new list.
        const items = target as NativeValue[];
        for (const item of source.items) items.push(part(item));
        break;
      }
      case "set": {
        // EVIDENCE: invariant: `convert` pairs a set with a new `NativeSet`; a valid set's items are unique.
        const set = target as NativeSet;
        for (const item of source.items) set.appendUnindexed(part(item));
        break;
      }
      case "object": {
        // EVIDENCE: invariant: `convert` pairs an object with a new `NativeObject`.
        const properties = (target as NativeObject).properties;
        for (const property of source.properties)
          properties.set(property.name, part(property.value));
        break;
      }
      case "dict": {
        // EVIDENCE: invariant: `convert` pairs a dict with a new `NativeDict`.
        const entries = (target as NativeDict).entries;
        for (const entry of source.entries) entries.set(entry.key, part(entry.value));
        break;
      }
      default:
        break;
    }
  }
  return root;
}

/** The canonical value of a native value: new records throughout, in the native value's order. */
export function toCanonical(value: NativeValue): SerializableRuntimeValue {
  if (value === null || typeof value !== "object") return value;
  type Target = Exclude<SerializableRuntimeValue, null | string | number | boolean>;
  const work: Array<readonly [NativeComposite, Target]> = [];
  const convert = (source: NativeValue & object): Target => {
    let target: Target;
    if (Array.isArray(source)) target = { kind: "list", items: [] };
    else if (source instanceof NativeSet) target = { kind: "set", items: [] };
    else if (source instanceof NativeObject) target = { kind: "object", properties: [] };
    else if (source instanceof NativeDict) target = { kind: "dict", entries: [] };
    else return leafRecord(source);
    work.push([source, target]);
    return target;
  };
  const part = (child: NativeValue): SerializableRuntimeValue =>
    child === null || typeof child !== "object" ? child : convert(child);
  const root = convert(value);
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    if (Array.isArray(source) || source instanceof NativeSet) {
      const items = Array.isArray(source) ? source : source.items;
      // EVIDENCE: invariant: `convert` pairs a list with a new canonical list and a set with a new canonical set.
      const into = (target as { readonly items: SerializableRuntimeValue[] }).items;
      for (const item of items) into.push(part(item));
    } else if (source instanceof NativeObject) {
      // EVIDENCE: invariant: `convert` pairs a `NativeObject` with a new canonical object.
      const into = (target as { readonly properties: SerializableRuntimeProperty[] }).properties;
      for (const [name, item] of source.properties) into.push({ name, value: part(item) });
    } else {
      // EVIDENCE: invariant: `convert` pairs a `NativeDict` with a new canonical dict.
      const into = (target as { readonly entries: SerializableRuntimeDictEntry[] }).entries;
      for (const [key, item] of source.entries) into.push({ key, value: part(item) });
    }
  }
  return root;
}

/** A new, unfrozen copy of a leaf record. */
function leafRecord(
  leaf: NativeLeaf,
): Exclude<SerializableRuntimeValue, null | string | number | boolean> {
  return { ...leaf };
}
