export interface RandomSource {
  next(): number;
}

export const XORSHIFT32_ALGORITHM = "xorshift32-v1";
export const DEFAULT_PLAYGROUND_SEED = 0x6d2b79f5;

export interface XorShift32State {
  readonly algorithm: typeof XORSHIFT32_ALGORITHM;
  state: number;
}

export function createXorShift32State(
  seed = DEFAULT_PLAYGROUND_SEED,
): XorShift32State {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("The xorshift32 seed must be an unsigned 32-bit integer.");
  }
  return { algorithm: XORSHIFT32_ALGORITHM, state: seed >>> 0 };
}

/** Advances the serializable deterministic RNG and returns a value in [0, 1). */
export function nextXorShift32(random: XorShift32State): number {
  if (
    random.algorithm !== XORSHIFT32_ALGORITHM ||
    !Number.isInteger(random.state) ||
    random.state < 0 ||
    random.state > 0xffff_ffff
  ) {
    throw new TypeError("Malformed xorshift32 state.");
  }
  let state = random.state >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  random.state = state >>> 0;
  return random.state / 0x1_0000_0000;
}
