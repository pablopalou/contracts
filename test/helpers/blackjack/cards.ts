// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/cards.ts.
// Kept byte-identical by the shared golden vectors (test/fixtures/blackjack-golden-rounds.json).
/**
 * Card primitives shared by backend, client verifier and (mirrored) Solidity.
 *
 * A card is an integer 0..51: rank = card % 13 (0 = Ace … 8 = Nine, 9 = Ten,
 * 10 = Jack, 11 = Queen, 12 = King), suit = floor(card / 13)
 * (0 = spades, 1 = hearts, 2 = diamonds, 3 = clubs).
 *
 * Everything here is integer arithmetic so the TypeScript and Solidity
 * implementations can be compared bit for bit through the golden vectors.
 */
export type Card = number;

export const CARDS_PER_DECK = 52;
export const SUIT_SYMBOLS = ["♠", "♥", "♦", "♣"] as const;
export const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export function assertCard(card: Card): void {
  if (!Number.isInteger(card) || card < 0 || card >= CARDS_PER_DECK) {
    throw new RangeError(`invalid card ${card}`);
  }
}

export function rankOf(card: Card): number {
  return card % 13;
}

export function suitOf(card: Card): number {
  return Math.floor(card / 13);
}

export function isAce(card: Card): boolean {
  return rankOf(card) === 0;
}

/** Ten, Jack, Queen and King all count 10. */
export function isTenValue(card: Card): boolean {
  return rankOf(card) >= 9;
}

/** Hearts and diamonds are red; spades and clubs are black. */
export function isRed(card: Card): boolean {
  const s = suitOf(card);
  return s === 1 || s === 2;
}

/** Blackjack value with the ace counted as 1 (the "hard" value of the card). */
export function valueOf(card: Card): number {
  const r = rankOf(card);
  if (r === 0) return 1;
  if (r >= 9) return 10;
  return r + 1;
}

export interface HandValue {
  /** Sum with every ace counted as 1. */
  hard: number;
  /** Best total: hard + 10 when an ace can be counted as 11 without busting. */
  total: number;
  /** True when the total uses an ace as 11. */
  soft: boolean;
}

export function handValue(cards: readonly Card[]): HandValue {
  let hard = 0;
  let aces = 0;
  for (const c of cards) {
    hard += valueOf(c);
    if (isAce(c)) aces++;
  }
  const soft = aces > 0 && hard + 10 <= 21;
  return { hard, total: soft ? hard + 10 : hard, soft };
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).hard > 21;
}

/** Two-card 21. Whether it PAYS as a natural is decided by the round (not after a split). */
export function isTwentyOneOnTwo(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function cardLabel(card: Card): string {
  assertCard(card);
  return `${RANK_LABELS[rankOf(card)]}${SUIT_SYMBOLS[suitOf(card)]}`;
}
