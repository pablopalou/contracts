// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/rules.ts.
// Kept byte-identical by the shared golden vectors (test/fixtures/blackjack-golden-rounds.json).
import { keccak256, stringToBytes, type Hex } from "viem";
import { canonicalJson } from "./engineConfig.js";

/**
 * Table rules, version 1. These are CONSTANTS mirrored in
 * `BlackjackEngineLib.sol`; changing any of them is a new contract version.
 *
 * Summary (closed with Pablo 2026-09-12): 6 decks reshuffled every round,
 * blackjack pays 3:2 (initial two cards only), dealer hits soft 17, double only
 * on a hard 9/10/11 two-card hand, no double after split, split once (max two
 * hands) on equal VALUE, split aces receive one card, 21 after a split pays 1:1,
 * no surrender, dealer peeks for blackjack with an ace (after insurance) or a
 * ten up, insurance pays 2:1, Perfect Pairs pays 25/12/6.
 */
export const RULES = {
  version: 1,
  decks: 6,
  shoeSize: 312,
  dealerHitsSoft17: true,
  blackjackPays: { num: 3, den: 2 },
  doubleHardMin: 9,
  doubleHardMax: 11,
  doubleAfterSplit: false,
  maxHands: 2,
  splitAcesOneCard: true,
  dealerPeeks: true,
  insurancePays: 2,
  perfectPairs: { perfect: 25, colored: 12, mixed: 6 },
  surrender: false,
} as const;

export const RULES_VERSION = RULES.version;

/** keccak256 of the canonical JSON of the rules — informational (rules are code). */
export function rulesHash(): Hex {
  return keccak256(stringToBytes(canonicalJson(RULES)));
}

/**
 * Exposure the contract locks when a round starts: 2.5× the stake (natural pays
 * 3:2 on top of the returned stake) plus 26× the side bet (Perfect Pairs 25:1
 * plus the returned side bet).
 */
export function initialLock(stake: bigint, sideBet: bigint): bigint {
  return (stake * 5n) / 2n + sideBet * 26n;
}

/**
 * Extra exposure locked by every additional wager (double, split, insurance):
 * 1.5× the stake. Double: max return goes 2.5× → 4×. Split: two 1:1 hands →
 * 4×. Insurance: half the stake at 2:1 returns 1.5× on top of a pushed stake.
 */
export function addWagerLock(stake: bigint): bigint {
  return (stake * 3n) / 2n;
}

/** Insurance costs exactly half the main stake (integer division in wei). */
export function insuranceAmount(stake: bigint): bigint {
  return stake / 2n;
}

/** Natural blackjack payout: stake returned plus 3:2. */
export function blackjackPayout(stake: bigint): bigint {
  return stake + (stake * BigInt(RULES.blackjackPays.num)) / BigInt(RULES.blackjackPays.den);
}
