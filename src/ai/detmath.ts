/**
 * Deterministic trigonometry for the tick path of the bots.
 *
 * ECMAScript classifies Math.atan2 / Math.acos / Math.hypot as "implementation-approximated":
 * two conforming engines may return different bits for the same arguments, and the bots run on
 * V8 (Chrome, Edge, workerd, Node), SpiderMonkey (Firefox) and JavaScriptCore (Safari). The
 * physics is pinned by the wasm sha256; the bot math was not, and a P2P peer that computes a
 * different input byte desyncs the match.
 *
 * Everything here is built from + - * / and comparisons only, which the spec fixes to IEEE-754
 * binary64 (round to nearest, ties to even): the same inputs give the same bits on every
 * conforming engine, no matter the JIT or the platform. No Math.sqrt either: the reductions are
 * tangent additions, so this file has no approximate Math function at all.
 *
 * What is left elsewhere in the tick path is the square root of the distance helpers (v3len,
 * dist2D, ...). Math.sqrt is on the same "implementation-approximated" list, but unlike atan2 the
 * correctly rounded result is unique (IEEE-754 defines the operation exactly), so an engine can
 * only disagree by returning a result that is wrong, not merely different — every engine emits the
 * hardware instruction. That is an assumption about the engines, not a spec guarantee: the boot
 * canary in the PR description is the detector if it ever stops holding.
 *
 * Contract: finite inputs (the bots only read the sim buffer, which never holds NaN or Inf — the
 * mutators reject non-finite values). The sign of zero is not reproduced: atan2Det(-0, -1)
 * returns +pi where Math.atan2 gives -pi, which the bot never reaches (its callers special-case
 * the near-zero frame).
 */

const PI = 3.141592653589793;
const PIO2 = 1.5707963267948966;
const PIO4 = 0.7853981633974483;
const PIO16 = 0.19634954084936207;
const PIO32 = 0.09817477042468103;
const TAN_PI_8 = 0.4142135623730951;
const TAN_PI_16 = 0.198912367379658;
const TAN_PI_32 = 0.09849140335716425;

/**
 * atan(t) for 0 <= t <= 1, accurate to a couple of ULP.
 *
 * One reflection takes the argument into [-tan(pi/8), tan(pi/8)], two tangent-addition steps into
 * |h| <= tan(pi/32) = 0.0985, and the Taylor series there is truncated where the next term is below
 * 3e-18. Only + - * / and comparisons: the two reductions are tan(A - B), not the half-angle
 * identity, because that one needs a square root and Math.sqrt is approximated by the spec too.
 */
function atanUnit(t: number): number {
  // atan(t) = pi/4 + atan((t - 1) / (t + 1)) for the upper half.
  let offset = 0;
  if (t > TAN_PI_8) {
    t = (t - 1) / (t + 1);
    offset = PIO4;
  }
  // atan(t) = pi/16 + atan((t - tan(pi/16)) / (1 + t * tan(pi/16))), both signs.
  if (t > TAN_PI_16) {
    t = (t - TAN_PI_16) / (1 + t * TAN_PI_16);
    offset += PIO16;
  } else if (t < -TAN_PI_16) {
    t = (t + TAN_PI_16) / (1 - t * TAN_PI_16);
    offset -= PIO16;
  }
  if (t > TAN_PI_32) {
    t = (t - TAN_PI_32) / (1 + t * TAN_PI_32);
    offset += PIO32;
  } else if (t < -TAN_PI_32) {
    t = (t + TAN_PI_32) / (1 - t * TAN_PI_32);
    offset -= PIO32;
  }
  const h2 = t * t;
  // t - t^3/3 + t^5/5 - t^7/7 + t^9/9 - t^11/11 + t^13/13 - t^15/15, Horner in t^2.
  let s = -1 / 15;
  s = 1 / 13 + h2 * s;
  s = -1 / 11 + h2 * s;
  s = 1 / 9 + h2 * s;
  s = -1 / 7 + h2 * s;
  s = 1 / 5 + h2 * s;
  s = -1 / 3 + h2 * s;
  s = 1 + h2 * s;
  return offset + t * s;
}

/** Math.atan2 for the bot tick path: same accuracy, bit-stable across engines. */
export function atan2Det(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const a = ay > ax ? PIO2 - atanUnit(ax / ay) : atanUnit(ay / ax);
  if (x < 0) return y < 0 ? -PI + a : PI - a;
  return y < 0 ? -a : a;
}

// There is no acosDet: the only Math.acos in the tick path (firstReachable, the reach penalty) asks
// for the angle between two 2D vectors, which atan2 has well conditioned at every angle whereas
// acos(dot / |d|) loses half the digits next to +-1. Any future need for an angle between two
// directions should use the same (dot, cross) pair; a bare acos(c) would be
// atan2Det(Math.sqrt((1 - c) * (1 + c)), c) — (1 - c) * (1 + c), never 1 - c * c.
