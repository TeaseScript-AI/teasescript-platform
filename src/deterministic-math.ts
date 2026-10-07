/**
 * Engine-independent binary64 elementary functions. Only IEEE-754 basic
 * operations and correctly rounded sqrt are used; no host transcendentals.
 * Inputs and sampler parameters are finite and already domain-validated.
 *
 * Draws are observable: normal always consumes 2, including spread === 0.
 * Beta samples two independent Marsaglia–Tsang gamma variates. Each gamma
 * attempt consumes 3 draws, with at most 64 attempts; shape < 1 consumes one
 * additional draw for its power transform. Thus beta consumes 6..384 draws
 * plus one per shape below 1 (maximum 386). After 64 rejected attempts the
 * gamma variate is its shape, a deterministic fallback. PERT uses the same
 * beta rule, with shapes in [1, 5]; min === max still samples Beta(3, 3).
 * There is no cached normal variate or mutable module state.
 * Series-tail bounds below are analytic; the roughly 100 useful DD bits
 * are an engineering estimate, not an exhaustive rounding proof.
 */

type DD = readonly [hi: number, lo: number];
const LN2_HI = 0.6931471805599453;
const LN2_LO = 2.3190468138462996e-17;
const LN10_HI = 2.302585092994046;
const LN10_LO = -2.1707562233822494e-16;
const RAD_HI = 0.017453292519943295;
const RAD_LO = 2.9486522708701687e-19;
const DEG_HI = 57.29577951308232;
const DEG_LO = -1.9878495670576283e-15;
const TINY = 9.094947017729282e-13; // 2^-40
const MIN_NORMAL = 2.2250738585072014e-308;
const MIN_VALUE = 5e-324;
const GAMMA_LIMIT = 64;
const MIN_BOOST_SCALE = 7.458340731200207e-155; // 2^-512

// BEGIN GENERATED COEFFICIENTS
// Exact rational Taylor coefficients split into nearest hi and residual lo.
// Reproduce with generate-constants.py (mpmath, 100 decimal digits).
const EXP_COEFFICIENTS: readonly DD[] = [
  [1.0, 0.0],
  [1.0, 0.0],
  [0.5, 0.0],
  [0.16666666666666666, 9.25185853854297e-18],
  [0.041666666666666664, 2.3129646346357427e-18],
  [0.008333333333333333, 1.1564823173178714e-19],
  [0.001388888888888889, -5.300543954373577e-20],
  [0.0001984126984126984, 1.7209558293420705e-22],
  [2.48015873015873e-5, 2.1511947866775882e-23],
  [2.7557319223985893e-6, -1.858393274046472e-22],
  [2.755731922398589e-7, 2.3767714622250297e-23],
  [2.505210838544172e-8, -1.448814070935912e-24],
  [2.08767569878681e-9, -1.20734505911326e-25],
  [1.6059043836821613e-10, 1.2585294588752098e-26],
  [1.1470745597729725e-11, 2.0655512752830745e-28],
  [7.647163731819816e-13, 7.03872877733453e-30],
  [4.779477332387385e-14, 4.399205485834081e-31],
  [2.8114572543455206e-15, 1.6508842730861433e-31],
  [1.5619206968586225e-16, 1.1910679660273754e-32],
  [8.22063524662433e-18, 2.2141894119604265e-34],
  [4.110317623312165e-19, 1.4412973378659527e-36],
  [1.9572941063391263e-20, -1.3643503830087908e-36],
  [8.896791392450574e-22, -7.911402614872376e-38],
  [3.868170170630684e-23, -8.843177655482344e-40],
  [1.6117375710961184e-24, -3.6846573564509766e-41],
  [6.446950284384474e-26, -1.9330404233703465e-42],
  [2.4795962632247976e-27, -1.2953730964765229e-43],
];
const SIN_COEFFICIENTS: readonly DD[] = [
  [1.0, 0.0],
  [0.16666666666666666, 9.25185853854297e-18],
  [0.008333333333333333, 1.1564823173178714e-19],
  [0.0001984126984126984, 1.7209558293420705e-22],
  [2.7557319223985893e-6, -1.858393274046472e-22],
  [2.505210838544172e-8, -1.448814070935912e-24],
  [1.6059043836821613e-10, 1.2585294588752098e-26],
  [7.647163731819816e-13, 7.03872877733453e-30],
  [2.8114572543455206e-15, 1.6508842730861433e-31],
  [8.22063524662433e-18, 2.2141894119604265e-34],
  [1.9572941063391263e-20, -1.3643503830087908e-36],
  [3.868170170630684e-23, -8.843177655482344e-40],
  [6.446950284384474e-26, -1.9330404233703465e-42],
  [9.183689863795546e-29, 1.4303150396787322e-45],
  [1.1309962886447716e-31, 1.0498015412959506e-47],
  [1.216125041553518e-34, 5.586290567888806e-51],
  [1.151633562077195e-37, -6.09957445788454e-54],
  [9.67759295863189e-41, 3.202295548645562e-57],
];
const COS_COEFFICIENTS: readonly DD[] = [
  [1.0, 0.0],
  [0.5, 0.0],
  [0.041666666666666664, 2.3129646346357427e-18],
  [0.001388888888888889, -5.300543954373577e-20],
  [2.48015873015873e-5, 2.1511947866775882e-23],
  [2.755731922398589e-7, 2.3767714622250297e-23],
  [2.08767569878681e-9, -1.20734505911326e-25],
  [1.1470745597729725e-11, 2.0655512752830745e-28],
  [4.779477332387385e-14, 4.399205485834081e-31],
  [1.5619206968586225e-16, 1.1910679660273754e-32],
  [4.110317623312165e-19, 1.4412973378659527e-36],
  [8.896791392450574e-22, -7.911402614872376e-38],
  [1.6117375710961184e-24, -3.6846573564509766e-41],
  [2.4795962632247976e-27, -1.2953730964765229e-43],
  [3.279889237069838e-30, 1.5117542744029879e-46],
  [3.7699876288159054e-33, 2.5870347832750324e-49],
  [3.8003907548547434e-36, 1.7457158024652518e-52],
  [3.387157535521162e-39, 5.09056148151085e-56],
];
const ODD_RECIPROCALS: readonly DD[] = [
  [1.0, 0.0],
  [0.3333333333333333, 1.850371707708594e-17],
  [0.2, -1.1102230246251566e-17],
  [0.14285714285714285, 7.93016446160826e-18],
  [0.1111111111111111, 6.1679056923619804e-18],
  [0.09090909090909091, -2.523234146875356e-18],
  [0.07692307692307693, -4.270088556250602e-18],
  [0.06666666666666667, 9.251858538542971e-19],
  [0.058823529411764705, 8.163404592832033e-19],
  [0.05263157894736842, 2.921639538487254e-18],
  [0.047619047619047616, 2.64338815386942e-18],
  [0.043478260869565216, 1.206764157201257e-18],
  [0.04, -8.326672684688674e-19],
  [0.037037037037037035, 2.05596856412066e-18],
  [0.034482758620689655, 4.785444071660157e-19],
  [0.03225806451612903, 8.953411488912552e-19],
  [0.030303030303030304, -8.410780489584519e-19],
  [0.02857142857142857, 8.921435019309293e-19],
  [0.02702702702702703, -1.50030138462859e-18],
  [0.02564102564102564, 8.896017825522087e-19],
  [0.024390243902439025, -8.46206573647223e-19],
  [0.023255813953488372, 3.2273925134452225e-19],
  [0.022222222222222223, -8.480870326997723e-19],
  [0.02127659574468085, 5.167261417803255e-19],
  [0.02040816326530612, 1.6285159162231251e-18],
  [0.0196078431372549, 2.7211348642773444e-19],
  [0.018867924528301886, 7.20073895688486e-19],
  [0.01818181818181818, 8.831319514063744e-19],
  [0.017543859649122806, 9.73879846162418e-19],
  [0.01694915254237288, 5.880418562633244e-20],
  [0.01639344262295082, -8.531426931033477e-19],
  [0.015873015873015872, 8.8112938462314e-19],
  [0.015384615384615385, -8.540177112501205e-19],
  [0.014925373134328358, 2.8480534680216236e-19],
  [0.014492753623188406, -1.7598643959185e-19],
  [0.014084507042253521, -3.17625425178852e-19],
  [0.0136986301369863, 7.604267291953127e-19],
  [0.013333333333333334, -8.557969148152249e-19],
  [0.012987012987012988, -8.5609729983271e-19],
  [0.012658227848101266, 1.9762672511128181e-19],
];
// END GENERATED COEFFICIENTS

// Knuth two-sum and Dekker two-product. Operands of two-product are scaled
// into a moderate range by callers, avoiding split overflow and underflow.
function sum(a: number, b: number): DD {
  const hi = a + b;
  const back = hi - a;
  return [hi, a - (hi - back) + (b - back)];
}

function product(a: number, b: number): DD {
  const hi = a * b;
  const sa = 134217729 * a;
  const ah = sa - (sa - a);
  const al = a - ah;
  const sb = 134217729 * b;
  const bh = sb - (sb - b);
  const bl = b - bh;
  return [hi, ah * bh - hi + ah * bl + al * bh + al * bl];
}

function add(a: DD, b: DD): DD {
  const s = sum(a[0], b[0]);
  const t = sum(a[1], b[1]);
  const u = sum(s[0], s[1] + t[0]);
  return sum(u[0], u[1] + t[1]);
}

function negate(a: DD): DD {
  return [-a[0], -a[1]];
}
function subtract(a: DD, b: DD): DD {
  return add(a, negate(b));
}
function multiply(a: DD, b: DD): DD {
  const p = product(a[0], b[0]);
  return sum(p[0], p[1] + a[0] * b[1] + a[1] * b[0] + a[1] * b[1]);
}

function divide(a: DD, b: DD): DD {
  const q = a[0] / b[0];
  const r = subtract(a, multiply([q, 0], b));
  const q2 = (r[0] + r[1]) / b[0];
  const r2 = subtract(r, multiply([q2, 0], b));
  return add(sum(q, q2), [(r2[0] + r2[1]) / b[0], 0]);
}

function squareRoot(a: DD): DD {
  const root = Math.sqrt(a[0]);
  if (root === 0) return [0, 0];
  const r = subtract(a, product(root, root));
  return sum(root, (r[0] + r[1]) / (2 * root));
}

/** Horner evaluation; all private callers use a fixed degree <= 39. */
function polynomial(coefficients: readonly DD[], x: DD, degree: number): DD {
  let result = coefficients[degree]!;
  for (let n = degree - 1; n >= 0; n -= 1) result = add(coefficients[n]!, multiply(result, x));
  return result;
}

/** Exact 2^exponent for a normal power of two; DataView is explicitly BE. */
function powerOfTwo(exponent: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, (exponent + 1023) * 1048576, false);
  view.setUint32(4, 0, false);
  return view.getFloat64(0, false);
}

/** Positive finite x = mantissa * 2^exponent, mantissa in [1, 2). */
function decompose(x: number): readonly [number, number] {
  const subnormal = x < MIN_NORMAL;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, subnormal ? x * 4503599627370496 : x, false);
  const top = view.getUint32(0, false);
  const exponent = Math.floor(top / 1048576) - 1023 - (subnormal ? 52 : 0);
  view.setUint32(0, (top % 1048576) + 1072693248, false);
  return [view.getFloat64(0, false), exponent];
}

/** Scale a double while keeping its intermediate value normal when possible. */
function scale(x: number, exponent: number): number {
  if (exponent > 1023) return x * powerOfTwo(exponent - 1023) * powerOfTwo(1023);
  if (exponent < -1022) return x * powerOfTwo(exponent + 1022) * MIN_NORMAL;
  return x * powerOfTwo(exponent);
}

/** Round a DD * 2^exponent once, including ties and the subnormal boundary. */
function rounded(a: DD, exponent = 0): number | undefined {
  if (a[0] === 0) return a[1] === 0 ? 0 : rounded([a[1], 0], exponent);
  const sign = a[0] < 0 ? -1 : 1;
  const [mantissa, adjustment] = decompose(Math.abs(a[0]));
  const low = scale(sign * a[1], -adjustment);
  const e = exponent + adjustment;
  if (e < -1075) return sign * 0;
  if (e > 1024 || (e === 1024 && (mantissa !== 1 || low >= 0))) return undefined;
  if (e < -1022) {
    // Round in integer units of 2^-1074. Rounding hi before scaling would
    // introduce a second rounding and can choose the wrong subnormal.
    const units = mantissa * powerOfTwo(e + 1074);
    const tail = low * powerOfTwo(e + 1074);
    const whole = Math.floor(units);
    const fraction = add([units - whole, 0], [tail, 0]);
    const above = fraction[0] > 0.5 || (fraction[0] === 0.5 && fraction[1] > 0);
    const tie = fraction[0] === 0.5 && fraction[1] === 0;
    return sign * (whole + (above || (tie && whole % 2 !== 0) ? 1 : 0)) * MIN_VALUE;
  }
  const result = sign * scale(mantissa + low, e);
  return Number.isFinite(result) ? result : undefined;
}

/** exp(x): ln(2) reduction, then a degree-26 Taylor polynomial on |r| <= ln(2)/2.
 * The first omitted term is < 2^-132; DD arithmetic contributes ~2^-100
 * relative error, aiming at faithful rounding with rare hard-to-round cases. */
export function exp(x: number): number | undefined {
  if (x > 710) return undefined;
  if (x < -746) return 0;
  return expDD([x, 0]);
}

function expDD(x: DD): number | undefined {
  const k = Math.round(x[0] / LN2_HI);
  const r = subtract(x, multiply([k, 0], [LN2_HI, LN2_LO]));
  const total = polynomial(EXP_COEFFICIENTS, r, 26);
  return rounded(total, k);
}

/** ln: binary exponent extraction, mantissa in [sqrt(1/2), sqrt(2)],
 * and ln(m) = 2 sum(s^(2n+1)/(2n+1)), s=(m-1)/(m+1).
 * 26 terms leave < 2^-136 absolute error on the reduced interval. */
function logarithm(x: number): DD {
  let [m, k] = decompose(x);
  if (m > 1.4142135623730951) {
    m *= 0.5;
    k += 1;
  }
  const s = divide([m - 1, 0], sum(m, 1));
  const s2 = multiply(s, s);
  const total = multiply(s, polynomial(ODD_RECIPROCALS, s2, 25));
  return add(multiply([2, 0], total), multiply([k, 0], [LN2_HI, LN2_LO]));
}

export function ln(x: number): number | undefined {
  if (x <= 0) return undefined;
  const r = logarithm(x);
  return r[0] + r[1];
}

export function log10(x: number): number | undefined {
  if (x <= 0) return undefined;
  const r = divide(logarithm(x), [LN10_HI, LN10_LO]);
  const value = r[0] + r[1];
  const integer = Math.round(value);
  // A power of ten as written, such as 0.001, has its exact logarithm: ECMAScript reads `1e${integer}` as the double
  // nearest that power on every engine, and only that double, not its neighbours, gives the whole number.
  if (x === Number(`1e${integer}`)) return integer;
  return value;
}

/** Exact degree remainder, then nearest-quadrant reduction to [-45, 45].
 * No huge radian multiplication or approximate pi-based range reduction. */
function degreeReduction(x: number): readonly [number, number] {
  const r = x % 360;
  const q = Math.round(r / 90);
  return [r - q * 90, ((q % 4) + 4) % 4];
}

/** Linear small-angle limit, scaled first to retain subnormal low bits.
 * For |x| < 2^-40, the omitted relative cubic term is < 2^-80. */
function linearDegrees(x: number, inverse: boolean): number {
  if (x === 0) return x;
  const [m, e] = decompose(Math.abs(x));
  const factor: DD = inverse ? [DEG_HI, DEG_LO] : [RAD_HI, RAD_LO];
  return rounded(multiply([x < 0 ? -m : m, 0], factor), e)!;
}

/** sin/cos Taylor polynomials after reduction. Eighteen terms give
 * truncation below 2^-133 on |r| <= pi/4; DD retains ~100 useful bits. */
function degreeTrig(x: number, cosine: boolean): number {
  const [d, q] = degreeReduction(x);
  const sine = cosine ? q % 2 !== 0 : q % 2 === 0;
  const negative = cosine ? q === 1 || q === 2 : q >= 2;
  let value: number;
  if (d === 0) value = sine ? d : 1;
  else if (Math.abs(d) < TINY) value = sine ? linearDegrees(d, false) : 1;
  else if (sine && Math.abs(d) === 30) value = d < 0 ? -0.5 : 0.5;
  else {
    const r = multiply([d, 0], [RAD_HI, RAD_LO]);
    const negativeSquare = negate(multiply(r, r));
    const p = sine
      ? multiply(r, polynomial(SIN_COEFFICIENTS, negativeSquare, 17))
      : polynomial(COS_COEFFICIENTS, negativeSquare, 17);
    value = p[0] + p[1];
  }
  return negative ? -value : value;
}

function sinCosReduced(d: number): readonly [DD, DD] {
  const r = multiply([d, 0], [RAD_HI, RAD_LO]);
  const negativeSquare = negate(multiply(r, r));
  const s = multiply(r, polynomial(SIN_COEFFICIENTS, negativeSquare, 17));
  const c = polynomial(COS_COEFFICIENTS, negativeSquare, 17);
  return [s, c];
}

export function sinDegrees(x: number): number {
  return degreeTrig(x, false);
}
export function cosDegrees(x: number): number {
  return degreeTrig(x, true);
}

export function tanDegrees(x: number): number | undefined {
  const [d, q] = degreeReduction(x);
  const odd = q % 2 !== 0;
  if (d === 0) return odd ? undefined : d;
  if (Math.abs(d) === 45) return odd ? (d < 0 ? 1 : -1) : d < 0 ? -1 : 1;
  if (Math.abs(d) < TINY && !odd) return linearDegrees(d, false);
  const [s, c] = sinCosReduced(d);
  const r = odd ? negate(divide(c, s)) : divide(s, c);
  return rounded(r);
}

/** atan(a), 0 <= a <= 1. Two half-angle reductions put t <= tan(pi/16).
 * 25 terms of Gregory's alternating series leave < 2^-124 error; the
 * sqrt and divisions are corrected in DD before conversion to degrees. */
function atanUnit(a: DD): DD {
  let t = a;
  for (let n = 0; n < 2; n += 1) {
    t = divide(t, add([1, 0], squareRoot(add([1, 0], multiply(t, t)))));
  }
  const negativeSquare = negate(multiply(t, t));
  const total = multiply(t, polynomial(ODD_RECIPROCALS, negativeSquare, 24));
  return multiply(multiply(total, [4, 0]), [DEG_HI, DEG_LO]);
}

function atanMagnitude(x: number): DD {
  if (x > 1) return subtract([90, 0], atanUnit(divide([1, 0], [x, 0])));
  return atanUnit([x, 0]);
}

export function atanDegrees(x: number): number {
  if (Math.abs(x) < TINY) return linearDegrees(x, true);
  // At large x, atan is 90 less a tiny angle, which rounds to 90 itself from about 2^52 on.
  if (Math.abs(x) > 1 / TINY) return (x < 0 ? -1 : 1) * (90 - linearDegrees(1 / Math.abs(x), true));
  const r = atanMagnitude(Math.abs(x));
  return (x < 0 ? -1 : 1) * (r[0] + r[1]);
}

export function asinDegrees(x: number): number | undefined {
  if (Math.abs(x) > 1) return undefined;
  if (Math.abs(x) < TINY) return linearDegrees(x, true);
  if (Math.abs(x) === 1) return x * 90;
  if (Math.abs(x) === 0.5) return x * 60;
  const a = Math.abs(x);
  const root = squareRoot(multiply(sum(1, -a), sum(1, a)));
  const ratio = a <= root[0] ? divide([a, 0], root) : divide(root, [a, 0]);
  const angle = a <= root[0] ? atanUnit(ratio) : subtract([90, 0], atanUnit(ratio));
  return (x < 0 ? -1 : 1) * (angle[0] + angle[1]);
}

export function acosDegrees(x: number): number | undefined {
  if (Math.abs(x) > 1) return undefined;
  if (x === 1) return 0;
  if (x === -1) return 180;
  if (x === 0) return 90;
  if (x === 0.5) return 60;
  if (x === -0.5) return 120;
  const a = Math.abs(x);
  const root = squareRoot(multiply(sum(1, -a), sum(1, a)));
  const ratio = a <= root[0] ? divide([a, 0], root) : divide(root, [a, 0]);
  let angle = a <= root[0] ? subtract([90, 0], atanUnit(ratio)) : atanUnit(ratio);
  if (x < 0) angle = subtract([180, 0], angle);
  return angle[0] + angle[1];
}

export function atan2Degrees(y: number, x: number): number {
  if (y === 0) return x < 0 ? 180 : 0;
  if (x === 0) return y < 0 ? -90 : 90;
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  const steep = ay > ax;
  const [m1, e1] = decompose(steep ? ax : ay);
  const [m2, e2] = decompose(steep ? ay : ax);
  const ratio = divide([m1, 0], [m2, 0]);
  const exponent = e1 - e2;
  let angle: DD;
  if (exponent < -40) {
    // Ratio can underflow before the degrees conversion. Keep its exponent
    // separate until multiplication by 180/pi has been rounded once.
    angle = [rounded(multiply(ratio, [DEG_HI, DEG_LO]), exponent)!, 0];
  } else {
    angle = atanUnit([scale(ratio[0], exponent), scale(ratio[1], exponent)]);
  }
  if (steep) angle = subtract([90, 0], angle);
  if (x < 0) angle = subtract([180, 0], angle);
  const result = (y < 0 ? -1 : 1) * (angle[0] + angle[1]);
  return result === -180 ? 180 : result;
}

/** Box–Muller with exactly two uniforms, including degenerate spread.
 * 1-u excludes log(0) on the session's 2^-32 grid. */
function standardNormal(draw: () => number): number {
  const radius = Math.sqrt(-2 * ln(1 - draw())!);
  return radius * cosDegrees(360 * draw());
}

/** Scaled DD affine sum avoids intermediate overflow during cancellation. */
export function randomNormal(mean: number, spread: number, draw: () => number): number | undefined {
  const z = standardNormal(draw);
  if (spread === 0 || z === 0) return mean;
  const magnitude = Math.abs(mean) > spread ? Math.abs(mean) : spread;
  const [, e] = decompose(magnitude);
  const m = scale(mean, -e);
  const s = scale(spread, -e);
  return rounded(add([m, 0], multiply([s, 0], [z, 0])), e);
}

interface GammaLog {
  readonly base: DD;
  readonly boost: DD;
}

/** ln(1+t) for |t| <= 1/2, with the input's low bits retained.
 * Atanh series has |s| <= 1/3; 40 terms leave < 2^-132. Smaller
 * intervals need fewer terms; every selected tail is below 2^-110. */
function logOnePlus(t: number): DD {
  if (Math.abs(t) > 0.5) return logarithm(1 + t);
  const s = divide([t, 0], sum(2, t));
  const s2 = multiply(s, s);
  const size = Math.abs(t);
  const degree = size <= 0.01 ? 8 : size <= 0.1 ? 12 : size <= 0.25 ? 24 : 39;
  const total = multiply(s, polynomial(ODD_RECIPROCALS, s2, degree));
  return multiply([2, 0], total);
}

/** Marsaglia & Tsang (2000), gamma(shape,1), held in logarithmic form.
 * Shape boosting gamma(a)=gamma(a+1)*U^(1/a) avoids alpha<1 rejection.
 * Logarithmic ratios avoid overflow/underflow of the individual variates. */
function gammaLog(shape: number, draw: () => number): GammaLog {
  const a = shape < 1 ? shape + 1 : shape;
  const d = a - 1 / 3;
  const root = Math.sqrt(d);
  const c = 1 / 3 / root;
  let base: DD | undefined;
  for (let attempt = 0; attempt < GAMMA_LIMIT; attempt += 1) {
    const z = standardNormal(draw);
    const u = draw(); // Draw even when v <= 0; zero always accepts a positive cube.
    const t = c * z;
    const vroot = 1 + t;
    if (vroot <= 0) continue;
    const z2 = z * z;
    let accept = u === 0 || u < 1 - 0.0331 * z2 * z2;
    const logv = multiply([3, 0], logOnePlus(t));
    if (!accept) {
      let correction: number;
      if (Math.abs(t) < 0.01) {
        // (3*ln(1+t) - ((1+t)^3-1))/t^2. Factoring t^2
        // prevents cancellation and underflow for very large shapes.
        let rest = 0;
        let power = t * t;
        for (let n = 4; n <= 14; n += 1) {
          rest += ((n % 2 === 0 ? -3 : 3) * power) / n;
          power *= t;
        }
        const rt = root * t;
        correction = rt * rt * (-4.5 + rest);
      } else {
        const v = vroot * vroot * vroot;
        correction = d * (1 - v + (logv[0] + logv[1]));
      }
      accept = ln(u)! < 0.5 * z2 + correction;
    }
    if (accept) {
      base = add(logarithm(d), logv);
      break;
    }
  }
  // Consume the boost draw on both paths. On exhaustion the fallback is
  // the original shape's mean, so it must not receive a random power boost.
  const boost: DD = shape < 1 ? logarithm(1 - draw()) : [0, 0];
  return base === undefined ? { base: logarithm(shape), boost: [0, 0] } : { base, boost };
}

export function randomBeta(alpha: number, beta: number, draw: () => number): number {
  const left = gammaLog(alpha, draw);
  const right = gammaLog(beta, draw);
  const smaller = alpha < beta ? alpha : beta;
  // A normal floor prevents a subsequent division from magnifying subnormal
  // rounding. Boosted shapes are <1 and >=2^-1074, so s/shape <=2^562;
  // grid uniforms give either boost=0 or |boost|>=2^-32. Nonzero products
  // therefore stay between 2^-544 and 2^567, safe for Dekker splitting.
  const s = smaller < MIN_BOOST_SCALE ? MIN_BOOST_SCALE : smaller < 1 ? smaller : 1;
  const leftBoost =
    left.boost[0] === 0 ? ([0, 0] as const) : multiply(divide([s, 0], [alpha, 0]), left.boost);
  const rightBoost =
    right.boost[0] === 0 ? ([0, 0] as const) : multiply(divide([s, 0], [beta, 0]), right.boost);
  const boosts = subtract(rightBoost, leftBoost);
  const base = subtract(right.base, left.base);
  // Compute the dangerous divisions after subtraction, so tiny equal shapes
  // do not create an indeterminate difference of two negative infinities.
  const approximateBoost = boosts[0] / s;
  // Every base logarithm is in [-745, 714] on the draw grid, including
  // fallback shapes. Beyond 4096, even its largest correction leaves the
  // logistic tail below half the smallest subnormal. Avoid huge quotients.
  if (approximateBoost > 4096) return 0;
  if (approximateBoost < -4096) return 1;
  const delta = add(base, divide(boosts, [s, 0]));
  const positive = delta[0] >= 0;
  const magnitude = positive ? delta : negate(delta);
  if (magnitude[0] > 746) return positive ? 0 : 1;
  const small = expDD(negate(magnitude))!;
  const ratio = positive ? divide([small, 0], sum(1, small)) : divide([1, 0], sum(1, small));
  return ratio[0] + ratio[1];
}

/** Classic Beta-PERT, lambda=4. Scaled convex interpolation keeps finite
 * endpoints finite even when max-min itself overflows. */
export function randomPert(
  min: number,
  mostLikely: number,
  max: number,
  draw: () => number,
): number {
  if (min === max) {
    randomBeta(3, 3, draw);
    return min;
  }
  const magnitude = Math.abs(min) > Math.abs(max) ? Math.abs(min) : Math.abs(max);
  const [, e] = decompose(magnitude);
  const low = scale(min, -e);
  const high = scale(max, -e);
  const mode = scale(mostLikely, -e);
  const width = high - low;
  const alpha = 1 + 4 * ((mode - low) / width);
  const beta = 1 + 4 * ((high - mode) / width);
  const b = randomBeta(alpha, beta, draw);
  const result = rounded(add(multiply([low, 0], sum(1, -b)), product(high, b)), e);
  // Convexity guarantees a finite result in range. Protect its endpoints
  // against any final one-ulp excursion introduced by the DD approximation.
  if (result === undefined || result > max) return max;
  if (result < min) return min;
  return result;
}
