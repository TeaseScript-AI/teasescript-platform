export const MAX_PROPERTY_SEED = 0xffff_ffff;

export interface PropertyPrngState {
  readonly value: number;
}

export interface PropertyPrngStep {
  readonly state: PropertyPrngState;
  readonly value: number;
}

export function createPropertyPrng(seed: number): PropertyPrngState {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_PROPERTY_SEED) {
    throw new RangeError(
      `Property seed must be an integer from 1 through ${MAX_PROPERTY_SEED}.`,
    );
  }
  return Object.freeze({ value: seed >>> 0 });
}

export function nextPropertyUint32(
  input: PropertyPrngState,
): PropertyPrngStep {
  let value = input.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value >>>= 0;
  if (value === 0) value = 0x6d2b_79f5;
  return Object.freeze({
    state: Object.freeze({ value }),
    value,
  });
}

export function propertyIndex(value: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError("Property selection length must be a positive safe integer.");
  }
  return value % length;
}
