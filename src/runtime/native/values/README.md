# Native values

The values the native engine holds while it runs (#1694), and their canonical form at the edges. `native-value.ts`
states the representation and the ownership rule.

- `native-value.ts`: the representation: primitives, lists as arrays, `NativeObject`, `NativeDict`, sets, and frozen
  leaf records.
- `codec.ts`: `fromCanonical` and `toCanonical`, between canonical values and native ones.
- `copy.ts`: independent copies.
- `equality.ts`: `==`.
- `value-key.ts`: a value's key, the text `valueKey` gives its canonical form.
- `native-set.ts`: `NativeSet`, whose members and index only its methods change.
