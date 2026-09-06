import { RuleTester } from "oxlint/plugins-dev";

import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "widenThenAssert" };

tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
  valid: [
    "const source = { id: 'first' }; const widened: unknown = source;",
    "declare const input: unknown; const parsed = input as { readonly id: string };",
    "function local() { type Record<K, V> = { key: K; value: V }; const source = { key: 'id', value: 1 }; const widened: Record<string, unknown> = source; const parsed = widened as { readonly id: string }; }",
    "function local() { type Readonly<T> = T; const source = { id: 'first' }; const widened: Readonly<Record<string, unknown>> = source; const parsed = widened as { readonly id: string }; }",
    "function local() { type PropertyKey = 'id'; const source = { id: 'first' }; const widened: Record<PropertyKey, unknown> = source; const parsed = widened as { readonly id: string }; }",
    "const source = { id: 'first' }; const widened: Record<'id', unknown> = source; const parsed = widened as { readonly id: string };",
    "const source = { id: 'first' }; const widened: Record<string, string> = source; const parsed = widened as { readonly id: string };",
  ],
  invalid: [
    {
      code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
      errors: [error],
    },
    {
      code: "const source = { id: 'second' }; const widened: Record<string, unknown> = source; const parsed = widened as { readonly id: string };",
      errors: [error],
    },
    {
      code: "const source = { id: 'second' }; const widened: Readonly<Record<PropertyKey, any>> = source; const parsed = widened as Readonly<Record<'id', string>>;",
      errors: [error],
    },
    {
      code: "const source = { id: 'second' }; const widened: { [key: PropertyKey]: unknown } = source; const parsed = widened as { readonly id: string };",
      errors: [error],
    },
  ],
});
