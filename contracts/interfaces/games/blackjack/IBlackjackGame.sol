// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IBlackjackGame
 * @notice Types and events of the Blackjack game (single player vs house, one
 *         Chainlink VRF request per round, server-seed commit/reveal, full
 *         on-chain replay of the round at settlement).
 */
interface IBlackjackGame {
    enum RoundStatus {
        None,
        Active,
        Settled,
        Refunded
    }

    /// @notice Extra wagers a player can add during a round.
    enum WagerKind {
        Double,    // +stake, one more card, hand completes
        Split,     // +stake, two hands
        Insurance  // +stake/2, pays 2:1 on a dealer natural (ace up only)
    }

    struct Round {
        address player;
        uint40 startedAt;
        RoundStatus status;
        bool doubled;
        bool split;
        bool insured;
        uint128 stake;    // gross main wager (payouts are computed on the gross amount)
        uint128 sideBet;  // gross Perfect Pairs wager
        uint256 locked;   // exposure reserved for this round
        bytes32 commit;   // keccak256(abi.encodePacked(serverSeed, player))
    }

    struct TableConfig {
        bool enabled;
        uint128 minBet;
        uint128 maxBet;
        uint128 maxSideBet;    // 0 = Perfect Pairs disabled
        uint32 settleTimeout;  // seconds after start when the operator may resolve an abandoned round
        uint32 refundTimeout;  // seconds after start when anyone may refund the player
    }

    event TableConfigUpdated(
        bool enabled,
        uint128 minBet,
        uint128 maxBet,
        uint128 maxSideBet,
        uint32 settleTimeout,
        uint32 refundTimeout
    );

    event RoundStarted(
        uint256 indexed requestId,
        address indexed player,
        uint256 stake,
        uint256 sideBet,
        bytes32 commit,
        uint256 locked
    );

    event WagerAdded(
        uint256 indexed requestId,
        address indexed player,
        WagerKind kind,
        uint256 amount,
        uint256 locked
    );

    /// @param actions   One byte per player action (0 hit, 1 stand, 2 double, 3 split, 4 insure, 5 decline).
    /// @param abandoned True when resolved by the operator without the player's signature.
    /// @param outcome   ABI-encoded BlackjackEngineLib.Result (cards, per-hand outcomes, side bets).
    event RoundSettled(
        uint256 indexed requestId,
        address indexed player,
        bytes32 serverSeed,
        uint256 vrfWord,
        bytes actions,
        uint256 payout,
        bool abandoned,
        bytes outcome
    );

    event RoundRefunded(uint256 indexed requestId, address indexed player, uint256 amount);

    event HouseFundsWithdrawn(address indexed to, uint256 amount);
}
