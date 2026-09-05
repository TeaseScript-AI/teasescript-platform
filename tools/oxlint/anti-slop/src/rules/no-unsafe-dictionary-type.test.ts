import { RuleTester } from "oxlint/plugins-dev";

import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unsafeDictionary" };

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
	valid: [
		"type Payload = Record<string, unknown>;",
		"type Payload = { [key: string]: unknown };",
		"type Payload = { [K in PropertyKey]: unknown };",
		"interface Payload { [key: string]: unknown }",
		"type UnknownValue = unknown; type Payload = Record<string, UnknownValue>;",
		"type UnknownValue = string | unknown; type Payload = Record<string, UnknownValue>;",
		"type Validated = unknown & { readonly raw: string }; type Payload = Record<string, Validated>;",
		"type Commands = Record<string, Command>;",
		"type Commands = { [key: string]: Command };",
		"type Permissions = Record<'read' | 'write', boolean>;",
		"type Index<T> = Record<string, T>; type Commands = Index<Command>;",
		"type WithSchema<T extends Record<string, unknown>> = (schema: T) => void;",
		"function run<T extends Record<string, unknown>>(input: T): T { return input; }",
		"type Payload = Record<string, { readonly raw: unknown }>;",
		"type Payload = Map<string, any>;",
		"import { Record } from './local'; type Payload = Record<string, any>;",
		"type Record<K, V> = { key: K; value: V }; type Payload = Record<string, any>;",
	],
	invalid: [
		{ code: "type Payload = Record<string, any>;", errors: [error] },
		{ code: "type Payload = Record<string, object>;", errors: [error] },
		{ code: "type Payload = Record<string, {}>;", errors: [error] },
		{ code: "type Payload = { [key: string]: any };", errors: [error] },
		{ code: "type Payload = { [K in PropertyKey]: object };", errors: [error] },
		{ code: "interface Empty {} type Payload = Record<string, Empty>;", errors: [error] },
		{ code: "type Empty = {}; type Payload = Record<string, Empty>;", errors: [error] },
		{ code: "type Escape = any; type Payload = Record<string, Escape>;", errors: [error] },
		{ code: "type Escape = object; type Payload = Record<string, Escape>;", errors: [error] },
		{ code: "type Escape = unknown & object; type Payload = Record<string, Escape>;", errors: [error] },
		{ code: "type Escape = object & unknown; type Payload = Record<string, Escape>;", errors: [error] },
		{ code: "type Payload = Record<string, string | any>;", errors: [error] },
		{ code: "type Payload = Record<string, string | object>;", errors: [error] },
		{ code: "type Payload = Record<string, string | {}>;", errors: [error] },
		{
			code: "type Index<T> = Record<string, T>; type Payload = Index<any>;",
			errors: 1,
		},
		{
			code: "type Index<T = object> = Record<string, T>; type Payload = Index;",
			errors: 1,
		},
		{
			code: "function local() { type Record<K, V> = { key: K; value: V }; type A = Record<string, any>; } function global() { type A = Record<string, any>; }",
			errors: 1,
		},
	],
});
