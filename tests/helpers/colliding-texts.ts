/**
 * Two texts whose keys share their 53-bit hash (cyrb53, `textHash` in `serializable-values.ts`), so every list, set,
 * object, or dict built the same way around each has the same print. Found by a search for two two-unit heads after
 * the key prefix `s3:` whose hash states differ by one XOR below 2^16 in both lanes, and a third unit that cancels it
 * (job 1106202303f867, 2026-11-06). A test that relies on the collision also asserts the exact comparison it causes,
 * so a changed hash fails there rather than passing silently.
 */
export const COLLIDING_A = String.fromCharCode(4851, 5601, 65);
export const COLLIDING_B = String.fromCharCode(2212, 2767, 60344);
