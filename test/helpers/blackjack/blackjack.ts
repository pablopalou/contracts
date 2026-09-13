// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/blackjack.ts.
// Kept byte-identical by the shared golden vectors (test/fixtures/blackjack-golden-rounds.json).
import {
  handValue,
  isAce,
  isRed,
  isTwentyOneOnTwo,
  rankOf,
  suitOf,
  valueOf,
  type Card,
  type HandValue,
} from "./cards.js";
import { Action, type ActionCode } from "./actions.js";
import { RULES, blackjackPayout, insuranceAmount } from "./rules.js";
import type { Shoe } from "./shoe.js";

/** Gross amounts in wei, exactly as recorded on-chain. */
export interface RoundInput {
  stake: bigint;
  sideBet: bigint;
}

export type Phase = "insurance" | "player" | "finished";

export interface HandState {
  cards: Card[];
  /** Wager riding on this hand (stake, or 2× stake after a double). */
  bet: bigint;
  fromSplit: boolean;
  doubled: boolean;
  done: boolean;
  bust: boolean;
}

export type HandOutcome = "blackjack" | "win" | "push" | "lose" | "bust";
export type SideBetOutcome = "none" | "mixed" | "colored" | "perfect";

export interface HandResult {
  cards: Card[];
  value: HandValue;
  bet: bigint;
  outcome: HandOutcome;
  payout: bigint;
}

export interface RoundResult {
  /** Total EVA (wei) the contract pays the player for this round (incl. `wagerRefund`). */
  payout: bigint;
  /** Extra wagers (double / split / insurance) paid on-chain but never used in the play. */
  wagerRefund: bigint;
  hands: HandResult[];
  dealerCards: Card[];
  dealerValue: HandValue;
  dealerNatural: boolean;
  playerNatural: boolean;
  insuranceTaken: boolean;
  insurancePayout: bigint;
  sideBetOutcome: SideBetOutcome;
  sideBetPayout: bigint;
  cardsDrawn: number;
}

/** What a client is allowed to see mid-round (the dealer's hole card stays hidden). */
export interface RoundView {
  phase: Phase;
  activeHand: number;
  hands: Array<{ cards: Card[]; value: HandValue; bet: bigint; fromSplit: boolean; doubled: boolean; done: boolean; bust: boolean }>;
  dealerUp: Card;
  /** Filled only once the round is finished. */
  dealerCards: Card[] | null;
  legalActions: ActionCode[];
  insuranceOffered: boolean;
  insuranceTaken: boolean;
  split: boolean;
  sideBetOutcome: SideBetOutcome;
  playerNatural: boolean;
  actions: ActionCode[];
}

export class IllegalActionError extends Error {
  constructor(
    public readonly action: ActionCode,
    public readonly legal: readonly ActionCode[],
    public readonly phase: Phase,
  ) {
    super(`illegal action ${action} in phase ${phase} (legal: ${legal.join(",")})`);
    this.name = "IllegalActionError";
  }
}

export class IncompleteRoundError extends Error {
  constructor(public readonly phase: Phase) {
    super(`round not finished (phase ${phase})`);
    this.name = "IncompleteRoundError";
  }
}

export function evalPerfectPairs(a: Card, b: Card): SideBetOutcome {
  if (rankOf(a) !== rankOf(b)) return "none";
  if (suitOf(a) === suitOf(b)) return "perfect";
  if (isRed(a) === isRed(b)) return "colored";
  return "mixed";
}

/**
 * One blackjack round as a stepper. The same class drives live play on the
 * backend, the simulator, the golden-vector generator and the browser
 * verifier, and it mirrors `BlackjackEngineLib.sol` step for step.
 *
 * Deal order: player, dealer (up), player, dealer (hole). With an ace up the
 * insurance decision comes first, then the dealer peeks; with a ten up the
 * dealer peeks silently. A dealer natural ends the round before any player
 * action. A player natural (initial two cards) ends the round too.
 *
 * Hands auto-complete at 21 and on bust — a STAND is never needed there, so
 * the action log is unambiguous. After a split, hand 0 receives its second card
 * at once and is played out; hand 1 receives its second card when its turn
 * comes. Split aces get exactly one card each.
 */
export class RoundRun {
  readonly hands: HandState[] = [];
  readonly actions: ActionCode[] = [];
  readonly dealerUp: Card;
  readonly playerNatural: boolean;
  readonly dealerNatural: boolean;
  readonly sideBetOutcome: SideBetOutcome;
  readonly insuranceOffered: boolean;
  phase: Phase;
  activeHand = 0;
  insuranceTaken = false;
  split = false;
  private readonly dealerHole: Card;
  private dealerCards: Card[] | null = null;
  private result: RoundResult | null = null;

  constructor(
    private readonly shoe: Shoe,
    readonly input: RoundInput,
  ) {
    if (input.stake <= 0n || input.sideBet < 0n) throw new RangeError("invalid round input");
    const p0 = shoe.draw();
    const up = shoe.draw();
    const p1 = shoe.draw();
    const hole = shoe.draw();
    this.hands.push({ cards: [p0, p1], bet: input.stake, fromSplit: false, doubled: false, done: false, bust: false });
    this.dealerUp = up;
    this.dealerHole = hole;
    this.playerNatural = isTwentyOneOnTwo([p0, p1]);
    this.dealerNatural = isTwentyOneOnTwo([up, hole]);
    this.sideBetOutcome = evalPerfectPairs(p0, p1);
    this.insuranceOffered = isAce(up);
    if (this.insuranceOffered) {
      this.phase = "insurance";
    } else {
      this.phase = "player";
      this.afterPeek();
    }
  }

  /** Dealer peek + naturals. Reached directly with a ten up, or after the insurance decision with an ace up. */
  private afterPeek(): void {
    if (this.dealerNatural || this.playerNatural) {
      this.hands[0]!.done = true;
      this.phase = "finished";
      return;
    }
    this.phase = "player";
  }

  canDouble(hand: HandState): boolean {
    if (hand.cards.length !== 2) return false;
    if (hand.fromSplit && !RULES.doubleAfterSplit) return false;
    const hard = handValue(hand.cards).hard;
    return hard >= RULES.doubleHardMin && hard <= RULES.doubleHardMax;
  }

  canSplit(hand: HandState): boolean {
    if (hand.cards.length !== 2 || this.hands.length >= RULES.maxHands) return false;
    return valueOf(hand.cards[0]!) === valueOf(hand.cards[1]!);
  }

  legalActions(): ActionCode[] {
    if (this.phase === "insurance") return [Action.INSURE_YES, Action.INSURE_NO];
    if (this.phase === "finished") return [];
    const hand = this.hands[this.activeHand]!;
    const out: ActionCode[] = [Action.HIT, Action.STAND];
    if (this.canDouble(hand)) out.push(Action.DOUBLE);
    if (this.canSplit(hand)) out.push(Action.SPLIT);
    return out;
  }

  apply(action: ActionCode): void {
    const legal = this.legalActions();
    if (!legal.includes(action)) throw new IllegalActionError(action, legal, this.phase);
    this.actions.push(action);
    switch (action) {
      case Action.INSURE_YES:
        this.insuranceTaken = true;
        this.afterPeek();
        return;
      case Action.INSURE_NO:
        this.afterPeek();
        return;
      case Action.HIT: {
        const hand = this.hands[this.activeHand]!;
        hand.cards.push(this.shoe.draw());
        this.settleHandProgress(hand);
        return;
      }
      case Action.STAND: {
        this.hands[this.activeHand]!.done = true;
        this.advance();
        return;
      }
      case Action.DOUBLE: {
        const hand = this.hands[this.activeHand]!;
        hand.bet = hand.bet * 2n;
        hand.doubled = true;
        // A double is only legal on a hard 9-11, so one more card can never bust (max 21).
        hand.cards.push(this.shoe.draw());
        hand.done = true;
        this.advance();
        return;
      }
      case Action.SPLIT: {
        const hand = this.hands[this.activeHand]!;
        const [c0, c1] = hand.cards as [Card, Card];
        this.split = true;
        hand.cards = [c0];
        hand.fromSplit = true;
        this.hands.splice(this.activeHand + 1, 0, {
          cards: [c1],
          bet: this.input.stake,
          fromSplit: true,
          doubled: false,
          done: false,
          bust: false,
        });
        this.advance();
        return;
      }
    }
  }

  /** After a card lands on a hand: bust and 21 auto-complete it. */
  private settleHandProgress(hand: HandState): void {
    const v = handValue(hand.cards);
    if (v.hard > 21) {
      hand.bust = true;
      hand.done = true;
    } else if (v.total === 21) {
      hand.done = true;
    }
    if (hand.done) this.advance();
  }

  /** Move to the next unfinished hand, dealing a split hand its second card when its turn comes. */
  private advance(): void {
    while (this.activeHand < this.hands.length && this.hands[this.activeHand]!.done) this.activeHand++;
    if (this.activeHand >= this.hands.length) {
      this.phase = "finished";
      return;
    }
    const hand = this.hands[this.activeHand]!;
    if (hand.cards.length === 1) {
      hand.cards.push(this.shoe.draw());
      if (isAce(hand.cards[0]!) && RULES.splitAcesOneCard) {
        hand.done = true;
        this.advance();
        return;
      }
      if (handValue(hand.cards).total === 21) {
        hand.done = true;
        this.advance();
      }
    }
  }

  /** Abandoned-round completion: decline insurance and stand every open hand. Never hits. */
  autoComplete(): void {
    if (this.phase === "insurance") this.apply(Action.INSURE_NO);
    while (this.phase === "player") this.apply(Action.STAND);
  }

  /** Plays the dealer (if needed) and computes the payout. Idempotent. */
  finish(): RoundResult {
    if (this.phase !== "finished") throw new IncompleteRoundError(this.phase);
    if (this.result) return this.result;

    const dealerCards: Card[] = [this.dealerUp, this.dealerHole];
    const anyLive = this.hands.some((h) => !h.bust);
    if (!this.dealerNatural && !this.playerNatural && anyLive) {
      for (;;) {
        const v = handValue(dealerCards);
        if (v.total > 17) break;
        if (v.total === 17 && !(v.soft && RULES.dealerHitsSoft17)) break;
        dealerCards.push(this.shoe.draw());
      }
    }
    this.dealerCards = dealerCards;
    const dealerValue = handValue(dealerCards);
    const dealerBust = dealerValue.hard > 21;

    let payout = 0n;
    const hands: HandResult[] = this.hands.map((h) => {
      const value = handValue(h.cards);
      let outcome: HandOutcome;
      let handPayout: bigint;
      if (this.dealerNatural) {
        outcome = this.playerNatural ? "push" : "lose";
        handPayout = this.playerNatural ? h.bet : 0n;
      } else if (this.playerNatural) {
        outcome = "blackjack";
        handPayout = blackjackPayout(h.bet);
      } else if (h.bust) {
        outcome = "bust";
        handPayout = 0n;
      } else if (dealerBust || value.total > dealerValue.total) {
        outcome = "win";
        handPayout = h.bet * 2n;
      } else if (value.total === dealerValue.total) {
        outcome = "push";
        handPayout = h.bet;
      } else {
        outcome = "lose";
        handPayout = 0n;
      }
      payout += handPayout;
      return { cards: [...h.cards], value, bet: h.bet, outcome, payout: handPayout };
    });

    let insurancePayout = 0n;
    if (this.insuranceTaken && this.dealerNatural) {
      insurancePayout = insuranceAmount(this.input.stake) * BigInt(RULES.insurancePays + 1);
    }
    payout += insurancePayout;

    let sideBetPayout = 0n;
    if (this.input.sideBet > 0n && this.sideBetOutcome !== "none") {
      const mult = RULES.perfectPairs[this.sideBetOutcome];
      sideBetPayout = this.input.sideBet * BigInt(mult + 1);
    }
    payout += sideBetPayout;

    this.result = {
      payout,
      wagerRefund: 0n,
      hands,
      dealerCards,
      dealerValue,
      dealerNatural: this.dealerNatural,
      playerNatural: this.playerNatural,
      insuranceTaken: this.insuranceTaken,
      insurancePayout,
      sideBetOutcome: this.sideBetOutcome,
      sideBetPayout,
      cardsDrawn: this.shoe.drawn,
    };
    return this.result;
  }

  view(): RoundView {
    return {
      phase: this.phase,
      activeHand: this.activeHand,
      hands: this.hands.map((h) => ({
        cards: [...h.cards],
        value: handValue(h.cards),
        bet: h.bet,
        fromSplit: h.fromSplit,
        doubled: h.doubled,
        done: h.done,
        bust: h.bust,
      })),
      dealerUp: this.dealerUp,
      dealerCards: this.dealerCards ? [...this.dealerCards] : null,
      legalActions: this.legalActions(),
      insuranceOffered: this.insuranceOffered,
      insuranceTaken: this.insuranceTaken,
      split: this.split,
      sideBetOutcome: this.sideBetOutcome,
      playerNatural: this.playerNatural,
      actions: [...this.actions],
    };
  }
}

/** On-chain record of which extra wagers the player paid for. */
export interface WagerFlags {
  doubled: boolean;
  split: boolean;
  insured: boolean;
}

export class UnfundedActionError extends Error {
  constructor(public readonly action: ActionCode) {
    super(`action ${action} was played without its on-chain wager`);
    this.name = "UnfundedActionError";
  }
}

export function flagsFromActions(actions: readonly ActionCode[]): WagerFlags {
  return {
    doubled: actions.includes(Action.DOUBLE),
    split: actions.includes(Action.SPLIT),
    insured: actions.includes(Action.INSURE_YES),
  };
}

/**
 * Reconcile the on-chain wager flags with the play, exactly like the contract:
 * an action that costs money without its wager is fatal (UnfundedAction); a
 * wager whose action never happened is refunded on top of the payout.
 */
export function applyWagerFlags(result: RoundResult, input: RoundInput, actions: readonly ActionCode[], flags: WagerFlags): RoundResult {
  const played = flagsFromActions(actions);
  if (played.doubled && !flags.doubled) throw new UnfundedActionError(Action.DOUBLE);
  if (played.split && !flags.split) throw new UnfundedActionError(Action.SPLIT);
  if (played.insured && !flags.insured) throw new UnfundedActionError(Action.INSURE_YES);
  let refund = 0n;
  if (flags.doubled && !played.doubled) refund += input.stake;
  if (flags.split && !played.split) refund += input.stake;
  if (flags.insured && !played.insured) refund += insuranceAmount(input.stake);
  return { ...result, wagerRefund: refund, payout: result.payout + refund };
}

/**
 * Full replay from a shoe + action log — what the contract and the browser
 * verifier do. In `abandoned` mode the round is auto-completed (insurance
 * declined, open hands stood) when the log ends early; otherwise the log must
 * finish the round exactly. When `flags` are given the on-chain wagers are
 * reconciled (see `applyWagerFlags`).
 */
export function replayRound(
  shoe: Shoe,
  input: RoundInput,
  actions: readonly ActionCode[],
  opts: { abandoned?: boolean; flags?: WagerFlags } = {},
): RoundResult {
  const run = new RoundRun(shoe, input);
  for (const a of actions) run.apply(a);
  if (opts.abandoned) run.autoComplete();
  const result = run.finish();
  return opts.flags ? applyWagerFlags(result, input, actions, opts.flags) : result;
}
