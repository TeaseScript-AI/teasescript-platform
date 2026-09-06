import { RuleTester } from "oxlint/plugins-dev";

import { noKnownValueWideningRule } from "./no-known-value-widening.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "widening" };
const prelude = "type Command = () => void; const startCommand = () => {};";

tester.run("anti-slop/no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    `${prelude} const commands: Record<string, Command> = { start: startCommand };`,
    `${prelude} const commands: { [key: string]: Command } = { start: startCommand };`,
    `${prelude} const commands: { readonly start: Command } = { start: startCommand };`,
    `${prelude} function create(): { readonly start: Command } { return { start: startCommand }; }`,
    `${prelude} type Commands = { readonly start: Command }; const commands: Commands = { start: startCommand };`,
    `${prelude} type Index<T> = Record<string, T>; const commands: Index<Command> = { start: startCommand };`,
    "type Counts = Record<string, number>; const counts: Counts = { x: 1 };",
    "type Counts = { [key: string]: number }; const counts: Counts = { x: 1 };",
    "type Counts = { [key in string]: number }; const counts: Counts = { x: 1 };",
    `${prelude} type Key = 'start' | 'stop'; const commands: Record<Key, Command> = { start: startCommand, stop: startCommand };`,
    `${prelude} const commands: Readonly<Record<string, Command>> = { start: startCommand };`,
    `${prelude} let commands: Record<string, Command> = {};`,
    "let boundary: unknown = null; boundary = readExternalValue();",
    "let boundary: unknown = undefined; boundary = readExternalValue();",
    "let boundary: unknown = void 0; boundary = readExternalValue();",
    "function isString(value: unknown): value is string { return typeof value === 'string'; } const known: string = 'known'; isString(known);",
    "const isUser = (value: unknown): value is User => true; declare const known: User; isUser(known);",
    "declare function isUser(value: unknown): value is User; declare const known: User; isUser(known);",
    "type Record<K, V> = { key: K; value: V }; const value: Record<string, unknown> = { key: 'id', value: 1 };",
    "interface Value {} function local() { interface Value { id: string } const values: Record<string, Value> = { known: { id: 'x' } }; }",
    "interface Value {} interface Value { id: string } const values: Record<string, Value> = { known: { id: 'x' } };",
  ],
  invalid: [
    { code: "const value: unknown = {};", errors: [error] },
    { code: "const value: any = 1;", errors: [error] },
    { code: "const value: object = [];", errors: [error] },
    { code: "const value: unknown | string = 'known';", errors: [error] },
    { code: "const value: any | string = 'known';", errors: [error] },
    { code: "type Broad = unknown; const value: Broad = {};", errors: [error] },
    { code: "type Identity<T> = T; const value: Identity<unknown> = {};", errors: [error] },
    { code: "const value = {} as unknown;", errors: [error] },
    { code: "function create(): unknown { return {}; }", errors: [error] },
    { code: "const create = (): any => 1;", errors: [error] },
    { code: "const value: unknown = null;", errors: [error] },
    { code: "let value: unknown; value = {};", errors: [error] },
    {
      code: "type Index<T> = Record<string, T>; const values: Index<unknown> = { known: 1 };",
      errors: [error],
    },
    {
      code: "type Values = { [key: string]: object }; const values: Values = { known: {} };",
      errors: [error],
    },
    {
      code: "type Values = Readonly<Record<string, any>>; const values: Values = { known: 1 };",
      errors: [error],
    },
    {
      code: "interface Value { id: string } function local() { interface Value {} const values: Record<string, Value> = { known: {} }; }",
      errors: [error],
    },
    {
      code: "interface Value {} interface Value {} const values: Record<string, Value> = { known: {} };",
      errors: [error],
    },
  ],
});
