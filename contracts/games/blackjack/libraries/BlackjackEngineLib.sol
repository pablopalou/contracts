// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title BlackjackEngineLib
 * @notice Pure, deterministic replay of one blackjack round. Mirrors the
 *         TypeScript engine (`blackjackBackend/src/engine/deterministic`) step
 *         for step; both are pinned by the same golden vectors.
 *
 *         Rules v1: 6 decks shuffled per round, blackjack pays 3:2 (initial two
 *         cards only), dealer hits soft 17, double only on a two-card hard 9-11,
 *         no double after split, split once (max two hands) on equal value, split
 *         aces receive one card, 21 after a split pays 1:1, no surrender, dealer
 *         peeks (ace up: after insurance; ten up: silently), insurance pays 2:1,
 *         Perfect Pairs pays 25/12/6.
 *
 *         Cards are 0..51: rank = card % 13 (0 = ace … 9..12 = ten-valued),
 *         suit = card / 13 (0 spades, 1 hearts, 2 diamonds, 3 clubs).
 *
 *         Shoe: 312 slots initialised to `i % 52`; draw i performs one step of a
 *         Fisher-Yates driven by `s = keccak256(abi.encodePacked(s, uint16(i)))`,
 *         `j = i + uint256(s) % (312 - i)`. Only dealt cards are computed.
 */
library BlackjackEngineLib {
    uint8 internal constant RULES_VERSION = 1;
    uint16 internal constant SHOE_SIZE = 312;
    uint8 internal constant MAX_HAND_CARDS = 12; // 4 aces + 4 twos + 3 threes = 21 with 11 cards, +1 bust card
    uint8 internal constant MAX_HANDS = 2;

    // Actions (one byte each)
    uint8 internal constant HIT = 0;
    uint8 internal constant STAND = 1;
    uint8 internal constant DOUBLE = 2;
    uint8 internal constant SPLIT = 3;
    uint8 internal constant INSURE_YES = 4;
    uint8 internal constant INSURE_NO = 5;

    // Hand outcomes
    uint8 internal constant OUT_BLACKJACK = 0;
    uint8 internal constant OUT_WIN = 1;
    uint8 internal constant OUT_PUSH = 2;
    uint8 internal constant OUT_LOSE = 3;
    uint8 internal constant OUT_BUST = 4;

    // Perfect Pairs outcomes
    uint8 internal constant PP_NONE = 0;
    uint8 internal constant PP_MIXED = 1;
    uint8 internal constant PP_COLORED = 2;
    uint8 internal constant PP_PERFECT = 3;

    uint8 private constant PHASE_INSURANCE = 0;
    uint8 private constant PHASE_PLAYER = 1;
    uint8 private constant PHASE_FINISHED = 2;

    error IllegalAction(uint256 index, uint8 action);
    error IncompleteActions();
    error TrailingActions();
    /// @dev An action that costs money (double / split / insurance) was played without the matching on-chain wager.
    error UnfundedAction(uint8 action);
    error ShoeExhausted();

    struct Input {
        uint256 stake;    // gross main wager
        uint256 sideBet;  // gross Perfect Pairs wager
        bool doubled;     // on-chain wager flags: an action needs its flag (else UnfundedAction);
        bool split;       // a flag whose action was never played is refunded (wagerRefund)
        bool insured;
        bool abandoned;   // auto-complete (decline insurance, stand) when the log ends early
    }

    struct Result {
        uint256 payout;          // total to pay the player (stakes returned + winnings + wagerRefund)
        uint256 wagerRefund;     // extra wagers paid on-chain but never used in the play
        uint256 insurancePayout;
        uint256 sideBetPayout;
        uint8 sideBetOutcome;    // PP_*
        bool playerNatural;
        bool dealerNatural;
        uint8 handCount;
        uint8[2] handOutcomes;   // OUT_*
        uint256[2] handPayouts;
        bytes hand0Cards;
        bytes hand1Cards;
        bytes dealerCards;
        uint16 cardsDrawn;
    }

    struct Shoe {
        uint16[312] slots;
        bytes32 state;
        uint16 index;
    }

    struct Hand {
        uint8[12] cards;
        uint8 count;
        uint256 bet;
        bool fromSplit;
        bool doubled;
        bool done;
        bool bust;
    }

    struct State {
        Hand[2] hands;
        uint8 handCount;
        uint8 active;
        uint8 phase;
        bool anyDoubled;
        bool anySplit;
        bool insuranceTaken;
        bool playerNatural;
        bool dealerNatural;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CARDS
    // ═══════════════════════════════════════════════════════════════════════

    function rankOf(uint8 card) internal pure returns (uint8) {
        return card % 13;
    }

    function suitOf(uint8 card) internal pure returns (uint8) {
        return card / 13;
    }

    function isAce(uint8 card) internal pure returns (bool) {
        return card % 13 == 0;
    }

    function isRed(uint8 card) internal pure returns (bool) {
        uint8 s = card / 13;
        return s == 1 || s == 2;
    }

    /// @dev Ace counts 1 here; ten and faces count 10.
    function valueOf(uint8 card) internal pure returns (uint8) {
        uint8 r = card % 13;
        if (r == 0) return 1;
        if (r >= 9) return 10;
        return r + 1;
    }

    /// @return hard  sum with aces as 1
    /// @return total best total (hard + 10 when an ace can count 11)
    /// @return soft  whether an ace counts 11 in `total`
    function handValue(uint8[12] memory cards, uint8 count) internal pure returns (uint8 hard, uint8 total, bool soft) {
        uint8 aces;
        for (uint8 i = 0; i < count; i++) {
            hard += valueOf(cards[i]);
            if (isAce(cards[i])) aces++;
        }
        soft = aces > 0 && hard + 10 <= 21;
        total = soft ? hard + 10 : hard;
    }

    function twoCardValue(uint8 a, uint8 b) internal pure returns (uint8 total) {
        uint8 hard = valueOf(a) + valueOf(b);
        bool soft = (isAce(a) || isAce(b)) && hard + 10 <= 21;
        return soft ? hard + 10 : hard;
    }

    function perfectPairs(uint8 a, uint8 b) internal pure returns (uint8) {
        if (rankOf(a) != rankOf(b)) return PP_NONE;
        if (suitOf(a) == suitOf(b)) return PP_PERFECT;
        if (isRed(a) == isRed(b)) return PP_COLORED;
        return PP_MIXED;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              SHOE
    // ═══════════════════════════════════════════════════════════════════════

    function newShoe(bytes32 seed) internal pure returns (Shoe memory shoe) {
        for (uint16 i = 0; i < SHOE_SIZE; i++) {
            shoe.slots[i] = i % 52;
        }
        shoe.state = seed;
    }

    function draw(Shoe memory shoe) internal pure returns (uint8 card) {
        uint16 i = shoe.index;
        if (i >= SHOE_SIZE) revert ShoeExhausted();
        shoe.state = keccak256(abi.encodePacked(shoe.state, i));
        uint256 j = uint256(i) + (uint256(shoe.state) % uint256(SHOE_SIZE - i));
        uint16 tmp = shoe.slots[i];
        shoe.slots[i] = shoe.slots[j];
        shoe.slots[j] = tmp;
        shoe.index = i + 1;
        return uint8(shoe.slots[i]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              REPLAY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Replay a round from its seed and the player's action log.
     * @dev    Reverts on an illegal action, on a log that does not finish the
     *         round (unless `input.abandoned`), on trailing actions, and when the
     *         on-chain wager flags do not match the actions that were played.
     */
    function play(bytes32 seed, Input memory input, bytes calldata actions) internal pure returns (Result memory res) {
        Shoe memory shoe = newShoe(seed);
        State memory st;

        // Deal: player, dealer up, player, dealer hole.
        Hand memory h0 = st.hands[0];
        h0.cards[0] = draw(shoe);
        uint8 up = draw(shoe);
        h0.cards[1] = draw(shoe);
        uint8 hole = draw(shoe);
        h0.count = 2;
        h0.bet = input.stake;
        st.handCount = 1;
        st.playerNatural = twoCardValue(h0.cards[0], h0.cards[1]) == 21;
        st.dealerNatural = twoCardValue(up, hole) == 21;
        res.sideBetOutcome = perfectPairs(h0.cards[0], h0.cards[1]);

        uint256 ai = 0;
        if (isAce(up)) {
            st.phase = PHASE_INSURANCE;
            uint8 a;
            if (ai < actions.length) {
                a = uint8(actions[ai]);
                if (a != INSURE_YES && a != INSURE_NO) revert IllegalAction(ai, a);
                ai++;
            } else {
                if (!input.abandoned) revert IncompleteActions();
                a = INSURE_NO;
            }
            st.insuranceTaken = a == INSURE_YES;
        }
        _afterPeek(st);

        while (st.phase == PHASE_PLAYER) {
            uint8 a;
            uint256 index = ai;
            if (ai < actions.length) {
                a = uint8(actions[ai]);
                ai++;
            } else {
                if (!input.abandoned) revert IncompleteActions();
                a = STAND;
            }
            _apply(st, shoe, a, index);
        }
        if (ai != actions.length) revert TrailingActions();
        if (st.anyDoubled && !input.doubled) revert UnfundedAction(DOUBLE);
        if (st.anySplit && !input.split) revert UnfundedAction(SPLIT);
        if (st.insuranceTaken && !input.insured) revert UnfundedAction(INSURE_YES);

        _settle(st, shoe, up, hole, input, res);

        // Extra wagers collected on-chain that the play never consumed go back to the player.
        uint256 refund = 0;
        if (input.doubled && !st.anyDoubled) refund += input.stake;
        if (input.split && !st.anySplit) refund += input.stake;
        if (input.insured && !st.insuranceTaken) refund += input.stake / 2;
        res.wagerRefund = refund;
        res.payout += refund;
    }

    function _afterPeek(State memory st) private pure {
        if (st.dealerNatural || st.playerNatural) {
            st.hands[0].done = true;
            st.phase = PHASE_FINISHED;
        } else {
            st.phase = PHASE_PLAYER;
        }
    }

    function _canDouble(Hand memory h) private pure returns (bool) {
        if (h.count != 2 || h.fromSplit) return false;
        uint8 hard = valueOf(h.cards[0]) + valueOf(h.cards[1]);
        return hard >= 9 && hard <= 11;
    }

    function _canSplit(State memory st, Hand memory h) private pure returns (bool) {
        if (h.count != 2 || st.handCount >= MAX_HANDS) return false;
        return valueOf(h.cards[0]) == valueOf(h.cards[1]);
    }

    function _apply(State memory st, Shoe memory shoe, uint8 a, uint256 index) private pure {
        Hand memory h = st.hands[st.active];
        if (a == HIT) {
            _pushCard(h, draw(shoe));
            (uint8 hard, uint8 total, ) = handValue(h.cards, h.count);
            if (hard > 21) {
                h.bust = true;
                h.done = true;
            } else if (total == 21) {
                h.done = true;
            }
            if (h.done) _advance(st, shoe);
        } else if (a == STAND) {
            h.done = true;
            _advance(st, shoe);
        } else if (a == DOUBLE) {
            if (!_canDouble(h)) revert IllegalAction(index, a);
            h.bet = h.bet * 2;
            h.doubled = true;
            st.anyDoubled = true;
            // Only legal on a hard 9-11, so one more card can never bust.
            _pushCard(h, draw(shoe));
            h.done = true;
            _advance(st, shoe);
        } else if (a == SPLIT) {
            if (!_canSplit(st, h)) revert IllegalAction(index, a);
            uint8 c1 = h.cards[1];
            st.anySplit = true;
            h.count = 1;
            h.cards[1] = 0;
            h.fromSplit = true;
            Hand memory h1 = st.hands[1];
            h1.cards[0] = c1;
            h1.count = 1;
            h1.bet = h.bet;
            h1.fromSplit = true;
            st.handCount = 2;
            _advance(st, shoe);
        } else {
            revert IllegalAction(index, a);
        }
    }

    function _pushCard(Hand memory h, uint8 card) private pure {
        // MAX_HAND_CARDS is unreachable without busting first; kept as a hard bound.
        h.cards[h.count] = card;
        h.count++;
    }

    /// @dev Move to the next unfinished hand, dealing a split hand its second card when its turn comes.
    function _advance(State memory st, Shoe memory shoe) private pure {
        while (st.active < st.handCount && st.hands[st.active].done) st.active++;
        if (st.active >= st.handCount) {
            st.phase = PHASE_FINISHED;
            return;
        }
        Hand memory h = st.hands[st.active];
        if (h.count == 1) {
            _pushCard(h, draw(shoe));
            if (isAce(h.cards[0])) {
                h.done = true; // split aces receive exactly one card
                _advance(st, shoe);
                return;
            }
            (, uint8 total, ) = handValue(h.cards, h.count);
            if (total == 21) {
                h.done = true;
                _advance(st, shoe);
            }
        }
    }

    function _settle(
        State memory st,
        Shoe memory shoe,
        uint8 up,
        uint8 hole,
        Input memory input,
        Result memory res
    ) private pure {
        uint8[12] memory dealer;
        uint8 dcount = 2;
        dealer[0] = up;
        dealer[1] = hole;

        bool anyLive = false;
        for (uint8 i = 0; i < st.handCount; i++) {
            if (!st.hands[i].bust) anyLive = true;
        }
        if (!st.dealerNatural && !st.playerNatural && anyLive) {
            for (;;) {
                (, uint8 total, bool soft) = handValue(dealer, dcount);
                if (total > 17) break;
                if (total == 17 && !soft) break; // H17: hits soft 17
                dealer[dcount++] = draw(shoe);
            }
        }
        (uint8 dHard, uint8 dTotal, ) = handValue(dealer, dcount);
        bool dealerBust = dHard > 21;

        uint256 payout = 0;
        for (uint8 i = 0; i < st.handCount; i++) {
            Hand memory h = st.hands[i];
            (, uint8 total, ) = handValue(h.cards, h.count);
            uint8 outcome;
            uint256 hp;
            if (st.dealerNatural) {
                outcome = st.playerNatural ? OUT_PUSH : OUT_LOSE;
                hp = st.playerNatural ? h.bet : 0;
            } else if (st.playerNatural) {
                outcome = OUT_BLACKJACK;
                hp = h.bet + (h.bet * 3) / 2;
            } else if (h.bust) {
                outcome = OUT_BUST;
                hp = 0;
            } else if (dealerBust || total > dTotal) {
                outcome = OUT_WIN;
                hp = h.bet * 2;
            } else if (total == dTotal) {
                outcome = OUT_PUSH;
                hp = h.bet;
            } else {
                outcome = OUT_LOSE;
                hp = 0;
            }
            res.handOutcomes[i] = outcome;
            res.handPayouts[i] = hp;
            payout += hp;
        }

        if (st.insuranceTaken && st.dealerNatural) {
            res.insurancePayout = (input.stake / 2) * 3;
            payout += res.insurancePayout;
        }
        if (input.sideBet > 0 && res.sideBetOutcome != PP_NONE) {
            uint256 mult = res.sideBetOutcome == PP_PERFECT ? 25 : (res.sideBetOutcome == PP_COLORED ? 12 : 6);
            res.sideBetPayout = input.sideBet * (mult + 1);
            payout += res.sideBetPayout;
        }

        res.payout = payout;
        res.playerNatural = st.playerNatural;
        res.dealerNatural = st.dealerNatural;
        res.handCount = st.handCount;
        res.hand0Cards = _pack(st.hands[0].cards, st.hands[0].count);
        res.hand1Cards = st.handCount > 1 ? _pack(st.hands[1].cards, st.hands[1].count) : bytes("");
        res.dealerCards = _pack(dealer, dcount);
        res.cardsDrawn = shoe.index;
    }

    function _pack(uint8[12] memory cards, uint8 count) private pure returns (bytes memory out) {
        out = new bytes(count);
        for (uint8 i = 0; i < count; i++) {
            out[i] = bytes1(cards[i]);
        }
    }
}
