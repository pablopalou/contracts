// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {PullVRFGame} from "../base/PullVRFGame.sol";
import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";
import {IBlackjackGame} from "../../interfaces/games/blackjack/IBlackjackGame.sol";
import {BlackjackEngineLib} from "./libraries/BlackjackEngineLib.sol";

/**
 * @title BlackjackGame
 * @notice Single-player blackjack against the house on the PullVRFGame base.
 *
 *         Provably fair, per round:
 *           1. The backend publishes `commit = keccak256(serverSeed ‖ player)`.
 *           2. The player bets (`startRound`) — the contract requests ONE Chainlink
 *              VRF word; the requestId is the round id.
 *           3. Cards come from `seed = keccak256(serverSeed ‖ vrfWord ‖ requestId ‖ this)`
 *              through a keccak-driven Fisher-Yates over six decks
 *              (BlackjackEngineLib). The backend deals off-chain from the same seed.
 *           4. Extra money (double / split / insurance) is pulled on-chain with
 *              `addWager` before the corresponding card is dealt.
 *           5. The player signs the action log (EIP-712 ConfirmRound) and the
 *              operator settles: the contract checks the commit, the VRF word and
 *              the signature, REPLAYS the round itself and pays. The operator can
 *              never misreport a payout — only refuse to settle, which the timeouts
 *              (resolveAbandoned / cancelExpired) bound.
 *
 *         Payouts are computed on GROSS wagers. PaymentHandler fees are paid by
 *         the game out of its rules edge, not by the player on top of the stake.
 */
contract BlackjackGame is PullVRFGame, IBlackjackGame {
    using ECDSA for bytes32;

    bytes32 public constant START_ROUND_TYPEHASH = keccak256(
        "StartRound(address game,address player,uint128 stake,uint128 sideBet,address potentialReferrer,bytes32 commit,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant ADD_WAGER_TYPEHASH = keccak256(
        "AddWager(address game,address player,uint256 requestId,uint8 kind,uint256 nonce,uint256 deadline)"
    );

    /// @dev Player attestation of the action log. Not a relayed action: no nonce
    ///      (single use — bound to the requestId, which settles once).
    bytes32 public constant CONFIRM_ROUND_TYPEHASH = keccak256(
        "ConfirmRound(address game,address player,uint256 requestId,bytes32 actionsHash)"
    );

    uint8 public constant RULES_VERSION = BlackjackEngineLib.RULES_VERSION;
    uint16 internal constant BPS = 10_000;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error GameDisabled();
    error InvalidCommit();
    error ActiveRoundExists(uint256 requestId);
    error BetTooLow(uint256 provided, uint256 min);
    error BetTooHigh(uint256 provided, uint256 max);
    error SideBetTooHigh(uint256 provided, uint256 max);
    error InvalidRequest();
    error Unauthorized();
    error RandomNotReady();
    error RandomAlreadyFulfilled();
    error WagerAlreadyAdded();
    error WagerConflict();
    error InvalidPlayerSignature();
    error PayoutExceedsLock(uint256 payout, uint256 locked);
    error TimeoutNotReached();
    error InvalidConfig();
    error InsufficientFreeLiquidity(uint256 available, uint256 requested);

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    TableConfig public tableConfig;
    mapping(uint256 => Round) internal _rounds;
    mapping(address => uint256) public activeRoundOf;

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address eva,
        address handler,
        address provider,
        address authHub,
        address initialOperator
    ) PullVRFGame(eva, handler, provider, authHub, "BlackjackGame", "1", initialOperator) {
        tableConfig = TableConfig({
            enabled: false,
            minBet: 0,
            maxBet: 0,
            maxSideBet: 0,
            settleTimeout: 10 minutes,
            refundTimeout: 1 hours
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setTableConfig(TableConfig calldata cfg) external onlyOwner {
        if (cfg.minBet == 0 || cfg.maxBet < cfg.minBet) revert InvalidConfig();
        if (cfg.settleTimeout == 0 || cfg.refundTimeout < cfg.settleTimeout) revert InvalidConfig();
        tableConfig = cfg;
        emit TableConfigUpdated(cfg.enabled, cfg.minBet, cfg.maxBet, cfg.maxSideBet, cfg.settleTimeout, cfg.refundTimeout);
    }

    /// @notice Withdraw bankroll that is not reserved for live rounds (house profit).
    function withdrawHouseFunds(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 balance = evaToken.balanceOf(address(this));
        uint256 free = balance > lockedExposure ? balance - lockedExposure : 0;
        if (amount > free) revert InsufficientFreeLiquidity(free, amount);
        _payPlayer(to, amount);
        emit HouseFundsWithdrawn(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              START ROUND
    // ═══════════════════════════════════════════════════════════════════════

    function startRound(
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        bytes32 commit
    ) external nonReentrant returns (uint256 requestId) {
        return _startRoundInternal(msg.sender, stake, sideBet, potentialReferrer, commit);
    }

    function startRoundFor(
        address player,
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        bytes32 commit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant returns (uint256 requestId) {
        bytes32 structHash = keccak256(
            abi.encode(START_ROUND_TYPEHASH, address(this), player, stake, sideBet, potentialReferrer, commit, nonce, deadline)
        );
        _verifyAndConsume(player, address(this), uint256(stake) + uint256(sideBet), structHash, deadline, nonce, signature);
        return _startRoundInternal(player, stake, sideBet, potentialReferrer, commit);
    }

    function _startRoundInternal(
        address bettor,
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        bytes32 commit
    ) internal returns (uint256 requestId) {
        TableConfig memory cfg = tableConfig;
        if (!cfg.enabled) revert GameDisabled();
        if (commit == bytes32(0)) revert InvalidCommit();
        if (stake < cfg.minBet) revert BetTooLow(stake, cfg.minBet);
        if (stake > cfg.maxBet) revert BetTooHigh(stake, cfg.maxBet);
        if (sideBet > cfg.maxSideBet) revert SideBetTooHigh(sideBet, cfg.maxSideBet);

        uint256 prev = activeRoundOf[bettor];
        if (prev != 0 && _rounds[prev].status == RoundStatus.Active) revert ActiveRoundExists(prev);

        (, address payoutTarget, , , , ) = paymentHandler.getGameConfig(address(this));
        if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

        uint256 gross = uint256(stake) + uint256(sideBet);
        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, gross);
        require(netStake > 0, "net zero");

        // Natural pays 3:2 on top of the returned stake; Perfect Pairs 25:1 plus the side bet.
        uint256 locked = (uint256(stake) * 5) / 2 + uint256(sideBet) * 26;
        _lockExposure(locked, 0);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(BPS)});
        requestId = randomProvider.requestRandomNumbers(ranges);
        if (_rounds[requestId].status != RoundStatus.None) revert InvalidRequest();

        _rounds[requestId] = Round({
            player: bettor,
            startedAt: uint40(block.timestamp),
            status: RoundStatus.Active,
            doubled: false,
            split: false,
            insured: false,
            stake: stake,
            sideBet: sideBet,
            locked: locked,
            commit: commit
        });
        activeRoundOf[bettor] = requestId;

        emit RoundStarted(requestId, bettor, stake, sideBet, commit, locked);
        // Standard envelope (IGameEvents). data = abi.encode(stake, sideBet, commit, locked)
        emit BetPlaced(requestId, bettor, gross, abi.encode(uint256(stake), uint256(sideBet), commit, locked));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADD WAGER
    // ═══════════════════════════════════════════════════════════════════════

    function addWager(uint256 requestId, WagerKind kind) external nonReentrant {
        _addWagerInternal(msg.sender, requestId, kind);
    }

    function addWagerFor(
        address player,
        uint256 requestId,
        WagerKind kind,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        bytes32 structHash = keccak256(
            abi.encode(ADD_WAGER_TYPEHASH, address(this), player, requestId, uint8(kind), nonce, deadline)
        );
        uint256 amount = _wagerAmount(_rounds[requestId].stake, kind);
        _verifyAndConsume(player, address(this), amount, structHash, deadline, nonce, signature);
        _addWagerInternal(player, requestId, kind);
    }

    function _wagerAmount(uint128 stake, WagerKind kind) internal pure returns (uint256) {
        return kind == WagerKind.Insurance ? uint256(stake) / 2 : uint256(stake);
    }

    function _addWagerInternal(address player, uint256 requestId, WagerKind kind) internal {
        Round storage r = _rounds[requestId];
        if (r.status != RoundStatus.Active) revert InvalidRequest();
        if (r.player != player) revert Unauthorized();

        if (kind == WagerKind.Double) {
            if (r.doubled) revert WagerAlreadyAdded();
            if (r.split) revert WagerConflict();
            r.doubled = true;
        } else if (kind == WagerKind.Split) {
            if (r.split) revert WagerAlreadyAdded();
            if (r.doubled) revert WagerConflict();
            r.split = true;
        } else {
            if (r.insured) revert WagerAlreadyAdded();
            r.insured = true;
        }

        uint256 amount = _wagerAmount(r.stake, kind);
        // The referral was attributed at startRound; extra wagers carry no referrer.
        uint256 net = _collectAndProcessBet(player, address(0), amount);
        require(net > 0, "net zero");

        // Double: max return 2.5× → 4×. Split: two 1:1 hands → 4×. Insurance: +1.5× on a dealer natural.
        uint256 extraLock = (uint256(r.stake) * 3) / 2;
        _lockExposure(extraLock, 0);
        r.locked += extraLock;

        emit WagerAdded(requestId, player, kind, amount, r.locked);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              SETTLE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Settle a finished round. Operator-only; the player's signature over
     *         the action log proves the operator did not invent the play.
     */
    function settle(
        uint256 requestId,
        bytes32 serverSeed,
        bytes calldata actions,
        bytes calldata playerSignature
    ) external onlyGameOperator nonReentrant {
        Round memory r = _rounds[requestId];
        if (r.status != RoundStatus.Active) revert InvalidRequest();

        bytes32 structHash = keccak256(
            abi.encode(CONFIRM_ROUND_TYPEHASH, address(this), r.player, requestId, keccak256(actions))
        );
        address signer = _hashTypedDataV4(structHash).recover(playerSignature);
        if (signer != r.player && signer != authHub.sessionKeyOf(r.player)) revert InvalidPlayerSignature();

        _settleInternal(requestId, r, serverSeed, actions, false);
    }

    /**
     * @notice Resolve a round the player walked away from (no signature) once
     *         `settleTimeout` has passed. The engine declines insurance and stands
     *         every open hand — it never hits on the player's behalf.
     */
    function resolveAbandoned(
        uint256 requestId,
        bytes32 serverSeed,
        bytes calldata actions
    ) external onlyGameOperator nonReentrant {
        Round memory r = _rounds[requestId];
        if (r.status != RoundStatus.Active) revert InvalidRequest();
        if (block.timestamp < uint256(r.startedAt) + uint256(tableConfig.settleTimeout)) revert TimeoutNotReached();
        _settleInternal(requestId, r, serverSeed, actions, true);
    }

    function _settleInternal(
        uint256 requestId,
        Round memory r,
        bytes32 serverSeed,
        bytes calldata actions,
        bool abandoned
    ) internal {
        if (serverSeed == bytes32(0) || keccak256(abi.encodePacked(serverSeed, r.player)) != r.commit) {
            revert InvalidCommit();
        }
        uint256 vrfWord = _readRandomWord(requestId);
        if (vrfWord == 0) revert RandomNotReady();

        bytes32 seed = keccak256(abi.encodePacked(serverSeed, vrfWord, requestId, address(this)));
        BlackjackEngineLib.Result memory res = BlackjackEngineLib.play(
            seed,
            BlackjackEngineLib.Input({
                stake: r.stake,
                sideBet: r.sideBet,
                doubled: r.doubled,
                split: r.split,
                insured: r.insured,
                abandoned: abandoned
            }),
            actions
        );
        if (res.payout > r.locked) revert PayoutExceedsLock(res.payout, r.locked);

        _rounds[requestId].status = RoundStatus.Settled;
        _unlockExposure(r.locked, 0);
        if (activeRoundOf[r.player] == requestId) activeRoundOf[r.player] = 0;

        if (res.payout > 0) _payPlayer(r.player, res.payout);

        bytes memory outcome = abi.encode(res);
        emit RoundSettled(requestId, r.player, serverSeed, vrfWord, actions, res.payout, abandoned, outcome);
        // Standard envelope (IGameEvents). data = abi.encode(serverSeed, vrfWord, actions, abandoned, outcome)
        emit BetSettled(requestId, r.player, res.payout, abi.encode(serverSeed, vrfWord, actions, abandoned, outcome));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              REFUND
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Refund every gross wager of a round the operator never settled.
     *         Anyone after `refundTimeout`; a game operator after `settleTimeout`
     *         when the VRF word never arrived. Fees already distributed by the
     *         PaymentHandler are absorbed by the house.
     */
    function cancelExpired(uint256 requestId) external nonReentrant {
        Round memory r = _rounds[requestId];
        if (r.status != RoundStatus.Active) revert InvalidRequest();

        uint256 startedAt = uint256(r.startedAt);
        if (block.timestamp < startedAt + uint256(tableConfig.refundTimeout)) {
            bool operatorPath = gameOperators[msg.sender] &&
                block.timestamp >= startedAt + uint256(tableConfig.settleTimeout);
            if (!operatorPath) revert TimeoutNotReached();
            if (_readRandomWord(requestId) != 0) revert RandomAlreadyFulfilled();
        }

        uint256 refund = totalWagered(requestId);
        _rounds[requestId].status = RoundStatus.Refunded;
        _unlockExposure(r.locked, 0);
        if (activeRoundOf[r.player] == requestId) activeRoundOf[r.player] = 0;

        _payPlayer(r.player, refund);

        emit RoundRefunded(requestId, r.player, refund);
        emit BetFailed(requestId, r.player, bytes32("EXPIRED"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function getRound(uint256 requestId) external view returns (Round memory) {
        return _rounds[requestId];
    }

    /// @notice Gross EVA the player has put into the round so far.
    function totalWagered(uint256 requestId) public view returns (uint256 total) {
        Round memory r = _rounds[requestId];
        total = uint256(r.stake) + uint256(r.sideBet);
        if (r.doubled) total += uint256(r.stake);
        if (r.split) total += uint256(r.stake);
        if (r.insured) total += uint256(r.stake) / 2;
    }

    /// @notice Replay a round against the stored wagers — what `settle` would pay.
    ///         For auditors, the backend pre-flight and the client verifier.
    function previewRound(
        uint256 requestId,
        bytes32 serverSeed,
        bytes calldata actions,
        bool abandoned
    ) external view returns (BlackjackEngineLib.Result memory) {
        Round memory r = _rounds[requestId];
        if (r.status == RoundStatus.None) revert InvalidRequest();
        uint256 vrfWord = _readRandomWord(requestId);
        if (vrfWord == 0) revert RandomNotReady();
        bytes32 seed = keccak256(abi.encodePacked(serverSeed, vrfWord, requestId, address(this)));
        return BlackjackEngineLib.play(
            seed,
            BlackjackEngineLib.Input({
                stake: r.stake,
                sideBet: r.sideBet,
                doubled: r.doubled,
                split: r.split,
                insured: r.insured,
                abandoned: abandoned
            }),
            actions
        );
    }

    /// @notice Pure replay from an explicit seed (no stored round needed).
    function replay(
        bytes32 seed,
        BlackjackEngineLib.Input calldata input,
        bytes calldata actions
    ) external pure returns (BlackjackEngineLib.Result memory) {
        return BlackjackEngineLib.play(seed, input, actions);
    }
}
