import {
  isScalarKind,
  union,
  UNKNOWN_TYPE,
  withValues,
  type ScalarValue,
  type StaticType,
} from "../../src/static-types.js";
import { PropertyTable } from "../../src/static-types/property-tables.js";
import { typeKey } from "../../src/storage-types.js";
import { VALUE_KIND_NAMES, type ValueKind } from "../../src/value-kinds.js";
import { structureOf } from "./adapter-parity.js";

/**
 * The type a fact's text stands for (`typeKey(type, true, true)`), for building a closed operand view from the legacy
 * oracle's facts (O4 stage 2b case tables). A held unknown (`!`), an open shape (`+`) or a slot that saw only null
 * (`?null`, undecided) is refused. An open slot nothing was stored into yet (`?`, as the element of a written `[]`)
 * is read as `never`: what the solver's view of such a part is to be at stage 3. A closed text is written back and
 * compared, so that a reading that differs from the writing fails here, not in a case; a text with open slots is
 * compared after a second reading of what was written.
 */
export function parseTypeText(text: string): StaticType {
  const type = read(text);
  const written = typeKey(type, true, true);
  const expected = structureOf(text).includes("?") ? typeKey(read(written), true, true) : text;
  if (written !== expected) throw new Error(`the type text ${text} reads back as ${written}`);
  return type;
}

function read(text: string): StaticType {
  const reader = new TypeTextReader(text);
  const type = reader.type();
  reader.end();
  return type;
}

class TypeTextReader {
  #at = 0;
  constructor(private readonly text: string) {}

  type(): StaticType {
    const next = this.#peek();
    if (next === "?") {
      this.#take("?");
      if (this.text.startsWith("null", this.#at))
        throw new Error(`an undecided null slot in ${this.text}`);
      return { kind: "never" };
    }
    if (next === "!") throw new Error(`a held unknown in ${this.text}`);
    if (next === "(") {
      this.#take("(");
      const members = [this.type()];
      while (this.#peek() === "|") {
        this.#take("|");
        members.push(this.type());
      }
      this.#take(")");
      return union(members);
    }
    if (next === "{") {
      this.#take("{");
      const properties = new PropertyTable();
      while (this.#peek() !== "}") {
        if (this.#peek() === "+") throw new Error(`an open shape in ${this.text}`);
        const name = this.#string();
        this.#take(":");
        properties.set(name, this.type());
        if (this.#peek() === ",") this.#take(",");
      }
      this.#take("}");
      return { kind: "object", properties };
    }
    const word = this.#word();
    switch (word) {
      case "unknown":
        return UNKNOWN_TYPE;
      case "never":
        return { kind: "never" };
      case "null":
        return { kind: "null" };
      case "object":
        return { kind: "object", properties: null };
      case "list":
      case "set":
      case "dict": {
        this.#take("<");
        const element = this.type();
        this.#take(">");
        return { kind: word, element };
      }
      case "range":
      case "speaker":
      case "timer":
      case "media":
      case "camera":
      case "permanentButton":
      case "messageHandle":
        return { kind: word };
      default: {
        const kind = VALUE_KIND_NAMES.find(
          (candidate): candidate is ValueKind => candidate === word,
        );
        if (kind === undefined || !isScalarKind(kind))
          throw new Error(`no type named ${word} in ${this.text}`);
        const scalar: StaticType = { kind: "scalar", name: kind };
        if (this.#peek() !== "{") return scalar;
        this.#take("{");
        const values: ScalarValue[] = [this.#value()];
        while (this.#peek() === "|") {
          this.#take("|");
          values.push(this.#value());
        }
        this.#take("}");
        return withValues(scalar, values);
      }
    }
  }

  end(): void {
    if (this.#at !== this.text.length) throw new Error(`text left after the type in ${this.text}`);
  }

  #peek(): string {
    return this.text[this.#at] ?? "";
  }

  #take(expected: string): void {
    if (this.#peek() !== expected)
      throw new Error(`expected ${expected} at ${this.#at} in ${this.text}`);
    this.#at += 1;
  }

  #word(): string {
    const match = /^[A-Za-z]+/.exec(this.text.slice(this.#at));
    if (match === null) throw new Error(`expected a name at ${this.#at} in ${this.text}`);
    this.#at += match[0].length;
    return match[0];
  }

  /** A JSON string: the name of an object property or a text value. */
  #string(): string {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(this.text.slice(this.#at));
    if (match === null) throw new Error(`expected a string at ${this.#at} in ${this.text}`);
    this.#at += match[0].length;
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "string") throw new Error(`not a string: ${match[0]}`);
    return parsed;
  }

  /** A JSON value of a restricted scalar: a string, a number, true or false. */
  #value(): ScalarValue {
    if (this.#peek() === '"') return this.#string();
    const match = /^(?:true|false|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(this.text.slice(this.#at));
    if (match === null) throw new Error(`expected a value at ${this.#at} in ${this.text}`);
    this.#at += match[0].length;
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "number" && typeof parsed !== "boolean")
      throw new Error(`not a scalar value: ${match[0]}`);
    return parsed;
  }
}
