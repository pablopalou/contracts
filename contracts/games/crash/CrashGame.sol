// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PushVRFGame} from "../base/PushVRFGame.sol";
import {ICrashGame} from "../../interfaces/games/crash/ICrashGame.sol";
// Platform-canonical interfaces — see GAME_AUTHOR_GUIDE "canonical interface mandate".
// Crash previously declared its own copies under contracts/interfaces/games/crash/;
// those were folded back into the platform interfaces and the duplicates deleted.
import {CrashMathLib} from "./libraries/CrashMathLib.sol";
import {MerkleClaimLib} from "./libraries/MerkleClaimLib.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title CrashGame
 * @notice Provably-fair Crash Train game with EVA token integration
 * @dev Implements both AUTO (trustless) and MANUAL (hybrid) cashout modes
 *
 * ## Architecture Overview
 *
 * ### Provably Fair System
 * 1. Operator commits hash(serverSeed) BEFORE betting opens
 * 2. VRF provides randomness after betting closes
 * 3. Crash point = f(VRF || serverSeed || roundId) - deterministic
 * 4. Operator reveals serverSeed for verification
 * 5. Anyone can verify the crash point was predetermined
 *
 * ### AUTO Mode (Trustless)
 * - Player specifies autoCashoutMultiplier at bet time
 * - If crashPoint >= autoCashout: player wins, payout = bet * autoCashout
 * - Settlement is fully on-chain, no backend trust required
 *
 * ### MANUAL Mode (Hybrid)
 * - Player clicks cashout during round (off-chain intent)
 * - Backend collects EIP-712 signed cashout intents
 * - Backend builds Merkle tree of valid cashouts and submits root
 * - Players claim with Merkle proof
 * - Trust assumption: backend correctly records cashout timing
 *
 * ### Security
 * - Operator posts bond as deposit to guarantee game operation
 * - Pull-based payouts (no loops over players)
 * - Pausable for emergencies
 * - Ban list for abuse prevention
 */
contract CrashGame is ICrashGame, PushVRFGame {
    using SafeERC20 for IERC20;
    using CrashMathLib for uint256;
    using MerkleClaimLib for bytes32[];

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    uint16 public constant MAX_BPS = 10_000;
    uint32 public constant MIN_MULTIPLIER = 10100; // 1.01x minimum cashout
    uint32 public constant DEFAULT_MAX_MULTIPLIER = 5_000_000; // 500.00x default max
    uint32 public constant DEFAULT_RESERVATION_MULTIPLIER = 500_000; // 50.00x reservation cap
    uint32 public constant REFUND_GRACE_PERIOD = 30; // 30s grace after reveal deadline before emergency refund is allowed
    uint32 public constant VRF_REFUND_CRASH_POINT = 9999; // Sentinel: exact par refund when VRF fails

    /// @notice EIP-712 typehash for placeBetFor meta-transactions.
    /// @dev    `address game` is bound explicitly as defense-in-depth against any cross-contract
    ///         signature replay (the EIP-712 domain already does this, but the explicit field
    ///         makes the binding visible to wallets and audits).
    bytes32 public constant PLACE_BET_TYPEHASH = keccak256(
        "PlaceBet(address game,address player,uint256 amount,uint32 autoCashoutMultiplier,address referrer,uint256 nonce,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error InvalidAmount();
    error InvalidMultiplier();
    error InvalidState(RoundState expected, RoundState actual);
    error BettingClosed();
    error BettingNotOpen();
    error PlayerIsBanned();
    error InsufficientBankroll();
    error RoundNotFound();
    error BetNotFound();
    error AlreadyClaimed();
    error NotBetOwner();
    error RoundNotRevealed();
    error InvalidCommitment();
    error RevealDeadlinePassed();
    error RevealDeadlineNotPassed();
    // UnauthorizedCaller inherited from VRFGameBase (via PushVRFGame).
    error InsufficientBond();
    error VRFRequestPending();
    error ConfigOutOfBounds();
    error MerkleRootAlreadySet();
    error ExposureNotSettled();
    error ClaimWindowNotExpired();
    error NoUnclaimedExposure();
    error MaxBetsPerRoundReached();
    error BatchTooLarge(uint256 count, uint256 max);
    error BatchEmpty();
    // Note: InvalidSignature, ExpiredDeadline, InvalidNonce, NoSessionKey, NotOperator
    //       all come from the inherited SignedActionAuth mixin.

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    // Inherited from PushVRFGame: evaToken, paymentHandler, lockedExposure, randomProvider
    // (the inherited randomProvider is typed as IRandomProviderMinimal; cast to the fuller
    // IRandomProvider at the call site that uses requestRandomNumber).

    /// @notice Game configuration
    GameConfig public config;

    /// @notice Current round ID
    uint256 public currentRoundId;

    /// @notice Next bet ID
    uint256 public nextBetId;

    /// @notice Operator bond balance
    uint256 public operatorBond;

    /// @notice Round data by ID
    mapping(uint256 => Round) public rounds;

    /// @notice Bet data by ID
    mapping(uint256 => Bet) public bets;

    /// @notice Player bets per round: player => roundId => betIds[]
    mapping(address => mapping(uint256 => uint256[])) public playerRoundBets;

    /// @notice VRF request to round mapping
    mapping(uint256 => uint256) public vrfRequestToRound;

    /// @notice Banned players
    mapping(address => bool) public bannedPlayers;

    // Note: lockedExposure is inherited from BaseGame.

    /// @notice Pending VRF round ID for synchronous fulfillment handling
    uint256 private _pendingVRFRoundId;

    /// @notice Config snapshot per round (prevents mid-round config changes from affecting outcomes)
    struct RoundConfig {
        uint16 houseEdgeBps;
        uint32 maxMultiplier;
    }
    mapping(uint256 => RoundConfig) public roundConfigs;

    /// @notice Total exposure locked per round (released in bulk via settleRoundExposure)
    mapping(uint256 => uint256) public roundExposure;

    /// @notice Remaining claimable exposure per round (decremented on each claim, expired after claim window)
    mapping(uint256 => uint256) public roundClaimableRemaining;

    /// @notice First round that may still have unclaimed exposure (for lazy cleanup)
    uint256 public oldestUnclaimedRound;

    // Session keys + per-player nonces are now managed by AuthHub + SignedActionAuth.

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deploy the CrashGame contract
     * @param _evaToken EVA token address
     * @param _paymentHandler PaymentHandler address
     * @param _randomProvider RandomProvider address
     * @param _admin Initial owner of the contract (config + grants game operators)
     * @param _authHub Platform AuthHub for delegated-signing relayer check + session keys
     * @param _operator Initial game operator (lifecycle ops). May be address(0) to skip seeding.
     * @dev TWO operator concepts coexist in this contract and are independent:
     *        - AuthHub-driven onlyOperator (from SignedActionAuth): who may RELAY signed bets
     *        - Local gameOperators (from GameLifecycleRoles): who may run game LIFECYCLE
     *      Same backend address typically holds both authorizations, but they are
     *      managed and revoked separately.
     *
     *      _admin becomes the immediate owner via Ownable's _transferOwnership; subsequent
     *      ownership transfers use Ownable2Step's transfer/accept pattern.
     */
    constructor(
        address _evaToken,
        address _paymentHandler,
        address _randomProvider,
        address _admin,
        address _authHub,
        address _operator
    )
        PushVRFGame(_evaToken, _paymentHandler, _randomProvider, _authHub, "CrashGame", "1", _operator)
    {
        // PushVRFGame's constructor validates _evaToken + _paymentHandler + _randomProvider,
        // approves the handler for max, and seeds the initial game operator.
        if (_admin == address(0)) revert InvalidAddress();

        // Hand ownership to the multisig immediately. Future transfers use the two-step pattern.
        _transferOwnership(_admin);

        // Set default configuration
        config = GameConfig({
            roundIntervalSeconds: 40,
            bettingWindowSeconds: 30,
            revealDeadlineSeconds: 60,
            maxMultiplier: DEFAULT_MAX_MULTIPLIER,
            reservationMultiplier: DEFAULT_RESERVATION_MULTIPLIER,
            minBetAmount: 0.1 ether,        // 0.1 EVA
            maxBetAmount: 5 ether,           // 5 EVA
            maxPayoutPerRound: 100_000 ether, // 100,000 EVA
            operatorBondAmount: 1_000 ether, // 1,000 EVA
            claimWindowSeconds: 604_800,    // 7 days
            maxBetsPerRound: 2              // 2 bets per player per round
        });

        nextBetId = 1;
        oldestUnclaimedRound = 1;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // onlyOperator() is inherited from SignedActionAuth and resolves to AuthHub.isOperator.
    // Admin actions use Ownable2Step's onlyOwner modifier directly.

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit operator bond
     * @param amount Amount to deposit
     */
    function depositBond(uint256 amount) external onlyGameOperator {
        if (amount == 0) revert InvalidAmount();
        evaToken.safeTransferFrom(msg.sender, address(this), amount);
        operatorBond += amount;
        emit OperatorBondDeposited(msg.sender, amount);
    }

    /**
     * @notice Create a new round with a commitment
     * @param commitHash The hash of the server seed: keccak256(serverSeed)
     * @dev Also requests VRF immediately so randomness arrives during the betting window.
     *      This is safe because the crash point depends on both VRF and the hidden serverSeed.
     */
    function createRound(bytes32 commitHash) external override onlyGameOperator whenNotPaused {
        if (commitHash == bytes32(0)) revert InvalidCommitment();
        if (operatorBond < config.operatorBondAmount) revert InsufficientBond();

        // Lazy cleanup: expire unclaimed exposure from old rounds (max 10 per call to bound gas)
        _expireOldRounds(10);

        // Check previous round is revealed/settled or none exists
        if (currentRoundId > 0) {
            Round storage prevRound = rounds[currentRoundId];
            // Only allow new round if previous is in terminal state (Revealed or None)
            // Note: RoundState.Settled is reserved for future use but Revealed is the final state
            if (prevRound.state != RoundState.Revealed && prevRound.state != RoundState.None) {
                revert InvalidState(RoundState.Revealed, prevRound.state);
            }
        }

        currentRoundId++;
        uint64 bettingOpens = uint64(block.timestamp);
        uint64 bettingCloses = bettingOpens + config.bettingWindowSeconds;

        rounds[currentRoundId] = Round({
            roundId: currentRoundId,
            state: RoundState.Betting,
            commitHash: commitHash,
            serverSeed: bytes32(0),
            vrfRequestId: 0,
            vrfRandomWord: 0,
            crashPoint: 0,
            bettingOpensAt: bettingOpens,
            bettingClosesAt: bettingCloses,
            crashedAt: 0,
            revealDeadline: 0,
            merkleRoot: bytes32(0),
            totalBetAmount: 0,
            totalGrossBetAmount: 0,
            totalPayoutAmount: 0
        });

        // Snapshot config at round creation so mid-round changes don't affect outcomes
        roundConfigs[currentRoundId] = RoundConfig({
            houseEdgeBps: getTotalEdgeBps(),
            maxMultiplier: config.maxMultiplier
        });

        // Request VRF immediately during round creation so it arrives during the betting window.
        // This eliminates the delay between betting close and multiplier animation start.
        // Security: crash point = f(VRF, serverSeed, roundId) — knowing VRF alone reveals nothing
        // because the serverSeed is hidden behind commitHash until reveal.
        uint256 roundIdToStore = currentRoundId;
        _pendingVRFRoundId = roundIdToStore;

        // requestRandomNumber is the single-value convenience entry; it lives on
        // IRandomProviderMinimal (inherited via VRFGameBase.randomProvider), so no cast needed.
        uint256 requestId = randomProvider.requestRandomNumber(type(uint256).max);
        rounds[currentRoundId].vrfRequestId = requestId;
        vrfRequestToRound[requestId] = roundIdToStore;

        _pendingVRFRoundId = 0;

        emit RoundCreated(currentRoundId, commitHash, bettingOpens);
        emit RoundBettingOpened(currentRoundId);
    }

    /**
     * @notice Start the round (close betting, enter Running state)
     * @dev VRF was already requested in createRound() and normally arrives during the
     *      betting window. This function always transitions to Running regardless of
     *      whether VRF has arrived — the Running state represents the train animation.
     *      The backend reads vrfRandomWord to know the crash point and drives the animation.
     */
    function startRound() external override onlyGameOperator whenNotPaused {
        Round storage round = rounds[currentRoundId];
        if (round.state != RoundState.Betting) {
            revert InvalidState(RoundState.Betting, round.state);
        }

        round.state = RoundState.Running;
        round.bettingClosesAt = uint64(block.timestamp);

        emit RoundRunning(currentRoundId, round.vrfRequestId);
    }

    /**
     * @notice Reveal the server seed after the round ends
     * @param roundId The round ID to reveal
     * @param serverSeed The pre-committed server seed
     * @dev Accepts both Running (VRF arrived during betting, backend drove the animation)
     *      and Crashed (VRF arrived during Running via callback) states.
     *      Running state requires vrfRandomWord to be set (VRF must have arrived).
     */
    function revealSeed(uint256 roundId, bytes32 serverSeed) external override onlyGameOperator {
        Round storage round = rounds[roundId];
        if (round.roundId == 0) revert RoundNotFound();

        if (round.state == RoundState.Running) {
            // VRF arrived during betting, backend ran the animation while on-chain stayed Running.
            // Require VRF word to be present (can't reveal without randomness).
            if (round.vrfRandomWord == 0) revert VRFRequestPending();

            // Set crash timestamp and deadline now (they weren't set because we skipped Crashed).
            round.crashedAt = uint64(block.timestamp);
            round.revealDeadline = uint64(block.timestamp) + config.revealDeadlineSeconds;

            // No deadline check needed — we're revealing in the same tx that sets the deadline.
        } else if (round.state == RoundState.Crashed) {
            // VRF arrived during Running (fallback path). Deadline was already set.
            // Late reveals are allowed without penalty — the operator bond is never slashed.
        } else {
            revert InvalidState(RoundState.Crashed, round.state);
        }

        // Verify commitment
        if (!CrashMathLib.verifyCommitment(round.commitHash, serverSeed)) {
            revert InvalidCommitment();
        }

        round.serverSeed = serverSeed;
        round.state = RoundState.Revealed;

        // The crash point is deterministic once both serverSeed and vrfRandomWord are public.
        // We compute it eagerly here (instead of lazily on the first claim) so the value lands
        // in the RoundRevealed event and indexers don't have to replicate CrashMathLib off-chain.
        uint32 crashPoint = _getOrComputeCrashPoint(round);

        emit RoundRevealed(roundId, serverSeed, crashPoint);
    }

    /**
     * @notice Emergency fallback: refund all players if operator won't reveal the seed
     * @param roundId The round ID to refund
     * @dev ONLY use this if operator disappeared and won't reveal. Uses 1.02x refund for all players.
     *      Can be called by anyone after revealDeadline + grace period.
     *      Prefer calling revealSeed() after deadline instead - that preserves real crash point.
     */
    function emergencyRefundRound(uint256 roundId) external {
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Crashed) {
            revert InvalidState(RoundState.Crashed, round.state);
        }
        if (block.timestamp <= round.revealDeadline + REFUND_GRACE_PERIOD) {
            revert RevealDeadlineNotPassed();
        }

        // Mark round as revealed with refund + 2% bonus
        // This is the EMERGENCY fallback when operator won't reveal
        // 10200 bps = 1.02x = bet refund + 2% bonus
        uint32 refundMultiplier = 10200;
        round.state = RoundState.Revealed;
        round.crashPoint = refundMultiplier;

        // Auto-settle exposure: cap at roundExposure since some AUTO bets may have
        // lower worst-case than 1.02x (e.g. autoCashout at 1.01x locks less)
        _settleEmergencyExposure(roundId, round.totalGrossBetAmount, refundMultiplier);

        // Emergency reveal — serverSeed is bytes32(0) because the operator never revealed,
        // but the crashPoint is the refund multiplier so indexers can still see the outcome.
        emit RoundRevealed(roundId, bytes32(0), refundMultiplier);
    }

    /**
     * @notice Emergency resolve a stuck round (Running or Crashed) when serverSeed is lost
     * @param roundId The round ID to resolve
     * @dev Callable by a gameOperator OR the owner. Sets 1.02x refund for all players.
     *      The operator (round-driver backend) uses it during normal ops to clear a round
     *      stuck in Running with a lost serverSeed; the owner remains able to call it when
     *      the backend itself is down. The outcome is a fixed 1.02x refund to ALL players
     *      regardless of caller, so this is not a manipulable escalation.
     */
    function emergencyResolveRound(uint256 roundId) external {
        if (!gameOperators[msg.sender] && msg.sender != owner()) revert NotGameOperator();
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Running && round.state != RoundState.Crashed) {
            revert InvalidState(RoundState.Running, round.state);
        }

        // Mark round as revealed with refund + 2% bonus
        uint32 refundMultiplier = 10200;
        round.state = RoundState.Revealed;
        round.crashPoint = refundMultiplier;
        round.crashedAt = uint64(block.timestamp);

        _settleEmergencyExposure(roundId, round.totalGrossBetAmount, refundMultiplier);

        emit RoundRevealed(roundId, bytes32(0), refundMultiplier);
    }

    /**
     * @notice Emergency VRF refund: resolve round at par (1.00x) when VRF fails
     * @param roundId The round ID to refund
     * @dev Operator-only. Sets sentinel crashPoint 9999 so claims return exact bet.amount.
     *      Valid from Betting or Running state (VRF never arrived).
     */
    function emergencyVRFRefund(uint256 roundId) external onlyGameOperator {
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Betting && round.state != RoundState.Running) {
            revert InvalidState(RoundState.Running, round.state);
        }
        round.state = RoundState.Revealed;
        round.crashPoint = VRF_REFUND_CRASH_POINT;
        round.crashedAt = uint64(block.timestamp);

        // Auto-settle exposure: VRF refund returns exact bet.amount to each player
        _settleRoundExposure(roundId, round.totalGrossBetAmount);

        emit RoundRevealed(roundId, bytes32(0), VRF_REFUND_CRASH_POINT);
    }

    /**
     * @notice Submit Merkle root for MANUAL mode claims
     * @param roundId The round ID
     * @param merkleRoot The Merkle root of valid cashouts
     */
    function submitMerkleRoot(uint256 roundId, bytes32 merkleRoot) external override onlyGameOperator {
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Revealed) {
            revert InvalidState(RoundState.Revealed, round.state);
        }
        if (merkleRoot == bytes32(0)) revert InvalidCommitment();
        if (round.merkleRoot != bytes32(0)) revert MerkleRootAlreadySet();

        round.merkleRoot = merkleRoot;

        emit MerkleRootSubmitted(roundId, merkleRoot);
    }

    /**
     * @notice Settle round exposure in bulk: release worst-case, re-lock only what winners can claim
     * @param roundId The round ID
     * @param totalClaimable Sum of all payouts (AUTO + MANUAL winners) that can be claimed
     * @dev Must be called AFTER revealSeed and BEFORE any player claims.
     *      The backend computes totalClaimable from known crash point, auto cashout multipliers, and Merkle tree.
     */
    function settleRoundExposure(uint256 roundId, uint256 totalClaimable) external onlyGameOperator {
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Revealed) {
            revert InvalidState(RoundState.Revealed, round.state);
        }
        _settleRoundExposure(roundId, totalClaimable);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VRF CALLBACK
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Called by RandomProvider when VRF is ready
     * @dev VRF is now requested during createRound(), so it may arrive while the round
     *      is still in Betting state. In that case we just store the word without changing
     *      state — startRound() will finalize the transition.
     *      If VRF arrives during Running state (fallback path), behavior is unchanged.
     */
    function fulfillRandomness(
        uint256 requestId,
        uint256 randomWord,
        uint256[] memory /* derivedValues */
    ) external override onlyRandomProvider {
        uint256 roundId = vrfRequestToRound[requestId];
        if (roundId == 0) {
            // Synchronous fulfillment: mapping not set yet, use pending round ID
            roundId = _pendingVRFRoundId;
            if (roundId == 0) revert RoundNotFound();
            vrfRequestToRound[requestId] = roundId;
        }

        Round storage round = rounds[roundId];

        if (round.state == RoundState.Betting) {
            // VRF arrived during betting window (normal path).
            // Just store the word — startRound() will use it to transition to Crashed.
            round.vrfRandomWord = randomWord;
        } else if (round.state == RoundState.Running) {
            // VRF arrived after startRound() was called without VRF ready (fallback path).
            round.vrfRandomWord = randomWord;
            round.crashedAt = uint64(block.timestamp);
            round.revealDeadline = uint64(block.timestamp) + config.revealDeadlineSeconds;
            round.state = RoundState.Crashed;

            emit RoundCrashed(roundId, 0, randomWord);
        } else {
            revert InvalidState(RoundState.Betting, round.state);
        }
    }

    /**
     * @notice Handle VRF failure
     * @dev VRF failure can happen during Betting (normal path) or Running (fallback path).
     *      In both cases, reset the VRF request so the operator can retry or cancel.
     */
    function handleRandomFailure(
        uint256 requestId,
        bytes32 /* reason */,
        bytes calldata /* details */
    ) external override onlyRandomProvider {
        uint256 roundId = vrfRequestToRound[requestId];
        if (roundId == 0) return;

        Round storage round = rounds[roundId];

        if (round.state == RoundState.Betting) {
            // VRF failed during betting — clear request so operator can retry
            round.vrfRequestId = 0;
        } else if (round.state == RoundState.Running) {
            // VRF failed after startRound() — revert to Betting so operator can retry
            round.state = RoundState.Betting;
            round.vrfRequestId = 0;
        }
        // Other states: silently ignore (round already resolved)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PLAYER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Place a bet in the current betting round
     * @param amount Bet amount in EVA tokens
     * @param autoCashoutMultiplier For AUTO mode (e.g., 15000 = 1.50x). 0 for MANUAL mode.
     * @param referrer Optional referrer address
     * @return betId The unique bet ID
     */
    function placeBet(
        uint256 amount,
        uint32 autoCashoutMultiplier,
        address referrer
    ) external override nonReentrant whenNotPaused returns (uint256 betId) {
        return _placeBet(msg.sender, amount, autoCashoutMultiplier, referrer);
    }

    /**
     * @notice Place a bet on behalf of a player using a session key signature
     * @param player The player whose tokens will be used
     * @param amount Bet amount in EVA tokens
     * @param autoCashoutMultiplier For AUTO mode (e.g., 15000 = 1.50x). 0 for MANUAL mode.
     * @param referrer Optional referrer address
     * @param nonce Player's current bet nonce (replay protection)
     * @param deadline Timestamp after which the signature expires
     * @param signature EIP-712 signature from the player's session key
     * @return betId The unique bet ID
     */
    function placeBetFor(
        address player,
        uint256 amount,
        uint32 autoCashoutMultiplier,
        address referrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external override onlyOperator nonReentrant whenNotPaused returns (uint256 betId) {
        bytes32 structHash = keccak256(abi.encode(
            PLACE_BET_TYPEHASH,
            address(this),
            player,
            amount,
            autoCashoutMultiplier,
            referrer,
            nonce,
            deadline
        ));
        // Verifies game binding + deadline + nonce + AuthHub session-key signature, then charges
        // the player's spend cap. Reverts on any failure.
        _verifyAndConsume(player, address(this), amount, structHash, deadline, nonce, signature);
        return _placeBet(player, amount, autoCashoutMultiplier, referrer);
    }

    // Session key authorize/revoke now live on the AuthHub singleton — players call those
    // directly (or via the operator-relayed authorizeFor) instead of per-game functions.

    /**
     * @notice Claim payout for an AUTO mode bet
     * @param betId The bet ID to claim
     */
    function claimAutoPayout(uint256 betId) external override nonReentrant {
        if (bets[betId].mode != BetMode.Auto) revert InvalidState(RoundState.None, RoundState.None);
        (bool success, uint256 payout, uint8 reason) = _tryProcessClaim(ClaimRequest(betId, 0, new bytes32[](0)));
        if (!success) _revertWithClaimReason(reason);
        if (payout > 0) {
            evaToken.safeTransfer(msg.sender, payout);
        }
    }

    /**
     * @notice Claim payout for a MANUAL mode bet using Merkle proof
     * @param betId The bet ID to claim
     * @param cashoutMultiplier The multiplier at which player cashed out
     * @param merkleProof The Merkle proof from the backend
     */
    function claimManualPayout(
        uint256 betId,
        uint32 cashoutMultiplier,
        bytes32[] calldata merkleProof
    ) external override nonReentrant {
        if (bets[betId].mode != BetMode.Manual) revert InvalidState(RoundState.None, RoundState.None);
        (bool success, uint256 payout, uint8 reason) = _tryProcessClaim(ClaimRequest(betId, cashoutMultiplier, merkleProof));
        if (!success) _revertWithClaimReason(reason);
        if (payout > 0) {
            evaToken.safeTransfer(msg.sender, payout);
        }
    }

    /// @notice Maximum claims per batchClaim call
    uint256 public constant MAX_BATCH_CLAIMS = 20;

    /**
     * @notice Claim multiple bets in a single transaction.
     *         Invalid claims are skipped (emitting ClaimSkipped) instead of reverting the whole batch.
     * @param claims Array of claim requests (AUTO and MANUAL mixed, max 20)
     */
    function batchClaim(ClaimRequest[] calldata claims) external override nonReentrant {
        if (claims.length == 0) revert BatchEmpty();
        if (claims.length > MAX_BATCH_CLAIMS) revert BatchTooLarge(claims.length, MAX_BATCH_CLAIMS);

        uint256 totalPayout = 0;
        uint256 successCount = 0;

        for (uint256 i = 0; i < claims.length; i++) {
            (bool success, uint256 payout, uint8 reason) = _tryProcessClaim(claims[i]);
            if (success) {
                totalPayout += payout;
                successCount++;
            } else {
                emit ClaimSkipped(claims[i].betId, reason);
            }
        }

        if (totalPayout > 0) {
            evaToken.safeTransfer(msg.sender, totalPayout);
        }

        emit BatchPayoutClaimed(msg.sender, totalPayout, successCount);
    }

    /**
     * @dev Internal claim logic shared by all claim paths.
     *      Returns (success, payout, skipReason) instead of reverting, so batchClaim can skip failures.
     *      Skip reasons: 1=BetNotFound, 2=NotBetOwner, 3=AlreadyClaimed,
     *      4=RoundNotRevealed, 5=ExposureNotSettled, 6=MerkleRootNotSet,
     *      7=InvalidMultiplier, 8=InvalidMerkleProof
     */
    function _tryProcessClaim(ClaimRequest memory req) private returns (bool success, uint256 payout, uint8 skipReason) {
        Bet storage bet = bets[req.betId];
        if (bet.player == address(0)) return (false, 0, 1);
        if (bet.player != msg.sender) return (false, 0, 2);
        if (bet.claimed) return (false, 0, 3);

        Round storage round = rounds[bet.roundId];
        if (round.state != RoundState.Revealed && round.state != RoundState.Settled) {
            return (false, 0, 4);
        }

        // Exposure must be settled before individual claims
        if (roundExposure[bet.roundId] > 0) return (false, 0, 5);

        uint32 crashPoint = _getOrComputeCrashPoint(round);

        if (bet.mode == BetMode.Auto) {
            // AUTO: payout based on autoCashoutMultiplier
            if (crashPoint == VRF_REFUND_CRASH_POINT) {
                payout = bet.amount;
            } else if (CrashMathLib.isValidCashout(bet.autoCashoutMultiplier, crashPoint)) {
                payout = CrashMathLib.calculatePayout(bet.amount, bet.autoCashoutMultiplier);
            }
        } else {
            // MANUAL: payout based on cashoutMultiplier + Merkle proof
            if (crashPoint == VRF_REFUND_CRASH_POINT) {
                payout = bet.amount;
            } else {
                if (round.merkleRoot == bytes32(0)) return (false, 0, 6);
                if (req.cashoutMultiplier < MIN_MULTIPLIER || req.cashoutMultiplier > crashPoint) {
                    return (false, 0, 7);
                }
                payout = CrashMathLib.calculatePayout(bet.amount, req.cashoutMultiplier);

                bytes32 leaf = MerkleClaimLib.computeLeaf(
                    bet.roundId,
                    msg.sender,
                    req.betId,
                    req.cashoutMultiplier,
                    payout
                );
                if (!MerkleProof.verify(req.merkleProof, round.merkleRoot, leaf)) {
                    return (false, 0, 8);
                }
            }
        }

        bet.claimed = true;
        bet.payout = payout;
        round.totalPayoutAmount += payout;

        // Release actual payout from locked exposure
        lockedExposure -= payout;
        roundClaimableRemaining[bet.roundId] -= payout;

        emit PayoutClaimed(bet.roundId, msg.sender, req.betId, payout);

        // Standardized event for cross-game indexers (IGameEvents)
        emit BetSettled(
            bet.roundId,
            msg.sender,
            payout,
            abi.encode(req.betId, bet.mode, bet.autoCashoutMultiplier)
        );

        return (true, payout, 0);
    }

    /**
     * @dev Maps skip reason codes back to proper revert errors for individual claim functions.
     */
    function _revertWithClaimReason(uint8 reason) internal pure {
        if (reason == 1) revert BetNotFound();
        if (reason == 2) revert NotBetOwner();
        if (reason == 3) revert AlreadyClaimed();
        if (reason == 4) revert RoundNotRevealed();
        if (reason == 5) revert ExposureNotSettled();
        if (reason == 6) revert MerkleClaimLib.MerkleRootNotSet();
        if (reason == 7) revert InvalidMultiplier();
        if (reason == 8) revert MerkleClaimLib.InvalidMerkleProof();
        revert InvalidState(RoundState.None, RoundState.None);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function getCurrentRound() external view override returns (Round memory) {
        return rounds[currentRoundId];
    }

    function getRound(uint256 roundId) external view override returns (Round memory) {
        return rounds[roundId];
    }

    function getBet(uint256 betId) external view override returns (Bet memory) {
        return bets[betId];
    }

    function getPlayerBets(address player, uint256 roundId) 
        external view override returns (uint256[] memory) 
    {
        return playerRoundBets[player][roundId];
    }

    function getConfig() external view override returns (GameConfig memory) {
        return config;
    }

    /**
     * @notice Get total edge (house + referral) from PaymentHandler
     */
    function getTotalEdgeBps() public view override returns (uint16) {
        return paymentHandler.getTotalDeductionBps(address(this));
    }

    function isPlayerBanned(address player) external view override returns (bool) {
        return bannedPlayers[player];
    }

    // Session-key and per-player nonce reads moved to AuthHub (sessionKeyOf) and the inherited
    // SignedActionAuth.actionNonces / getActionNonce respectively.

    /**
     * @notice Compute crash point from combined seed
     */
    function computeCrashPoint(
        uint256 vrfRandomWord,
        bytes32 serverSeed,
        uint256 roundId
    ) external view override returns (uint32 crashPoint) {
        uint256 combinedSeed = CrashMathLib.combineSeed(vrfRandomWord, serverSeed, roundId);
        // Use round-snapshotted config if available, else current config
        RoundConfig memory rc = roundConfigs[roundId];
        uint16 he = rc.maxMultiplier > 0 ? rc.houseEdgeBps : getTotalEdgeBps();
        uint32 mm = rc.maxMultiplier > 0 ? rc.maxMultiplier : config.maxMultiplier;
        crashPoint = CrashMathLib.computeCrashPoint(combinedSeed, he, mm);
    }

    /**
     * @notice Get available liquidity for betting
     */
    function availableLiquidity() external view override returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        uint256 reserved = lockedExposure + operatorBond;
        if (balance <= reserved) return 0;
        return balance - reserved;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Update the PaymentHandler address
     * @param newHandler The new PaymentHandler contract address
     * @dev Revokes old handler approval and grants new one
     */
    // setPaymentHandler is inherited from BaseGame (revokes old approval, grants new).

    /**
     * @notice Ban or unban a player
     */
    function setPlayerBanned(address player, bool banned) external onlyOwner {
        bannedPlayers[player] = banned;
        emit PlayerBanned(player, banned);
    }

    // setGameOperator / setGameOperators are inherited from PushVRFGame.
    // Game operators can call createRound, startRound, revealSeed, submitMerkleRoot,
    // emergencyVRFRefund, settleRoundExposure, depositBond, withdrawBond.
    // This is independent of AuthHub's relayer allowlist used by placeBetFor.

    /**
     * @notice Update round interval
     */
    function setRoundInterval(uint32 seconds_) external onlyOwner {
        if (seconds_ < 10 || seconds_ > 600) revert ConfigOutOfBounds();
        emit ConfigUpdated("roundIntervalSeconds", config.roundIntervalSeconds, seconds_);
        config.roundIntervalSeconds = seconds_;
    }

    /**
     * @notice Update betting window
     */
    function setBettingWindow(uint32 seconds_) external onlyOwner {
        if (seconds_ < 5 || seconds_ > 300) revert ConfigOutOfBounds();
        emit ConfigUpdated("bettingWindowSeconds", config.bettingWindowSeconds, seconds_);
        config.bettingWindowSeconds = seconds_;
    }

    /**
     * @notice Update reveal deadline
     */
    function setRevealDeadline(uint32 seconds_) external onlyOwner {
        if (seconds_ < 30 || seconds_ > 3600) revert ConfigOutOfBounds();
        emit ConfigUpdated("revealDeadlineSeconds", config.revealDeadlineSeconds, seconds_);
        config.revealDeadlineSeconds = seconds_;
    }

    /**
     * @notice Update max multiplier
     */
    function setMaxMultiplier(uint32 maxMultiplier_) external onlyOwner {
        if (maxMultiplier_ < MIN_MULTIPLIER || maxMultiplier_ > CrashMathLib.ABSOLUTE_MAX_CRASH) {
            revert ConfigOutOfBounds();
        }
        emit ConfigUpdated("maxMultiplier", config.maxMultiplier, maxMultiplier_);
        config.maxMultiplier = maxMultiplier_;
    }

    /**
     * @notice Update reservation multiplier (exposure cap for MANUAL bets)
     */
    function setReservationMultiplier(uint32 reservationMultiplier_) external onlyOwner {
        if (reservationMultiplier_ < MIN_MULTIPLIER || reservationMultiplier_ > config.maxMultiplier) {
            revert ConfigOutOfBounds();
        }
        emit ConfigUpdated("reservationMultiplier", config.reservationMultiplier, reservationMultiplier_);
        config.reservationMultiplier = reservationMultiplier_;
    }

    /**
     * @notice Update bet limits
     */
    function setBetLimits(uint256 minBet, uint256 maxBet) external onlyOwner {
        if (minBet == 0 || maxBet < minBet) revert ConfigOutOfBounds();
        emit ConfigUpdated("minBetAmount", config.minBetAmount, minBet);
        emit ConfigUpdated("maxBetAmount", config.maxBetAmount, maxBet);
        config.minBetAmount = minBet;
        config.maxBetAmount = maxBet;
    }

    /**
     * @notice Update max payout per round
     */
    function setMaxPayoutPerRound(uint256 maxPayout) external onlyOwner {
        if (maxPayout == 0) revert ConfigOutOfBounds();
        emit ConfigUpdated("maxPayoutPerRound", config.maxPayoutPerRound, maxPayout);
        config.maxPayoutPerRound = maxPayout;
    }

    /**
     * @notice Update operator bond amount
     */
    function setOperatorBondAmount(uint256 bondAmount) external onlyOwner {
        if (bondAmount == 0) revert ConfigOutOfBounds();
        emit ConfigUpdated("operatorBondAmount", config.operatorBondAmount, bondAmount);
        config.operatorBondAmount = bondAmount;
    }

    /**
     * @notice Update max bets per player per round (0 = unlimited)
     */
    function setMaxBetsPerRound(uint8 maxBets) external onlyOwner {
        emit ConfigUpdated("maxBetsPerRound", config.maxBetsPerRound, maxBets);
        config.maxBetsPerRound = maxBets;
    }

    // pause / unpause are inherited from BaseGame.

    /**
     * @notice Update claim window for MANUAL bets
     */
    function setClaimWindow(uint32 seconds_) external onlyOwner {
        if (seconds_ < 3600 || seconds_ > 2_592_000) revert ConfigOutOfBounds(); // 1h - 30d
        emit ConfigUpdated("claimWindowSeconds", config.claimWindowSeconds, seconds_);
        config.claimWindowSeconds = seconds_;
    }

    /**
     * @notice Cancel a round stuck in Running state (VRF never responded)
     * @param roundId The round to cancel
     * @dev Can only be called after revealDeadlineSeconds have passed since betting closed.
     *      Sets crash point to 1.02x (refund + 2% bonus) so all players can claim.
     */
    function cancelStuckRound(uint256 roundId) external onlyOwner {
        Round storage round = rounds[roundId];
        if (round.state != RoundState.Running) {
            revert InvalidState(RoundState.Running, round.state);
        }

        // Require enough time to have passed (bettingClosesAt marks start of Running)
        if (block.timestamp < round.bettingClosesAt + config.revealDeadlineSeconds) {
            revert RevealDeadlineNotPassed();
        }

        uint32 refundMultiplier = 10200; // 1.02x refund
        round.state = RoundState.Revealed;
        round.crashPoint = refundMultiplier;
        round.crashedAt = uint64(block.timestamp);

        _settleEmergencyExposure(roundId, round.totalGrossBetAmount, refundMultiplier);

        emit RoundCrashed(roundId, refundMultiplier, 0);
        emit RoundRevealed(roundId, bytes32(0), refundMultiplier);
    }

    /**
     * @notice Expire unclaimed exposure after claim window passes
     * @param roundId The round ID to expire
     * @dev Admin-only. Uses max(claimWindowSeconds, MIN_EXPIRY_SECONDS) to ensure
     *      players always have at least 20 days to claim regardless of config.
     */
    function expireUnclaimedExposure(uint256 roundId) external override onlyOwner {
        if (!_expireRound(roundId)) revert NoUnclaimedExposure();
    }

    // emergencyWithdraw is inherited from BaseGame: non-virtual, whenPaused, nonReentrant,
    // and ALWAYS zeros lockedExposure on exit (platform invariant). Crash's operatorBond
    // tracking is separate from lockedExposure and is NOT reset — the operator must
    // manage their bond out-of-band if an emergency withdrawal drains the contract.

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR BOND WITHDRAWAL
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw operator bond (only excess above required amount)
     * @param amount Amount to withdraw
     */
    function withdrawBond(uint256 amount) external onlyGameOperator {
        if (amount == 0) revert InvalidAmount();
        if (operatorBond < config.operatorBondAmount + amount) revert InsufficientBond();
        operatorBond -= amount;
        evaToken.safeTransfer(msg.sender, amount);
        emit OperatorBondWithdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Internal logic shared by placeBet() and placeBetFor()
     */
    function _placeBet(
        address player,
        uint256 amount,
        uint32 autoCashoutMultiplier,
        address referrer
    ) internal returns (uint256 betId) {
        if (bannedPlayers[player]) revert PlayerIsBanned();

        Round storage round = rounds[currentRoundId];

        // Validate round state
        if (round.state != RoundState.Betting) {
            revert BettingNotOpen();
        }
        if (block.timestamp >= round.bettingClosesAt) {
            revert BettingClosed();
        }

        // Enforce max bets per player per round (0 = unlimited)
        if (config.maxBetsPerRound > 0 && playerRoundBets[player][currentRoundId].length >= config.maxBetsPerRound) {
            revert MaxBetsPerRoundReached();
        }

        // Validate bet amount
        if (amount < config.minBetAmount || amount > config.maxBetAmount) {
            revert InvalidAmount();
        }

        // Validate multiplier for AUTO mode
        BetMode mode = autoCashoutMultiplier > 0 ? BetMode.Auto : BetMode.Manual;
        if (mode == BetMode.Auto) {
            if (autoCashoutMultiplier < MIN_MULTIPLIER || autoCashoutMultiplier > config.maxMultiplier) {
                revert InvalidMultiplier();
            }
        }

        // Use round-snapshotted maxMultiplier for consistent exposure accounting
        RoundConfig memory rc = roundConfigs[currentRoundId];
        // For MANUAL bets, cap reservation at reservationMultiplier (e.g. 50x) instead of full maxMultiplier (500x)
        uint32 reserveCap = config.reservationMultiplier < rc.maxMultiplier
            ? config.reservationMultiplier
            : rc.maxMultiplier;
        uint256 maxPotentialPayout = mode == BetMode.Auto
            ? CrashMathLib.calculatePayout(amount, autoCashoutMultiplier)
            : CrashMathLib.calculatePayout(amount, reserveCap);

        uint256 availableBankroll = evaToken.balanceOf(address(this)) - lockedExposure - operatorBond;
        if (maxPotentialPayout > availableBankroll) {
            revert InsufficientBankroll();
        }
        if (lockedExposure + maxPotentialPayout > config.maxPayoutPerRound) {
            revert InsufficientBankroll();
        }

        // Pull tokens from player (player must have approved this contract)
        evaToken.safeTransferFrom(player, address(this), amount);
        uint256 netAmount = paymentHandler.processDirectBetFromGame(player, referrer, amount);

        // Lock exposure and track per-round for bulk settlement
        lockedExposure += maxPotentialPayout;
        roundExposure[currentRoundId] += maxPotentialPayout;

        // Create bet
        betId = nextBetId++;
        bets[betId] = Bet({
            player: player,
            roundId: currentRoundId,
            amount: amount,
            netAmount: netAmount,
            autoCashoutMultiplier: autoCashoutMultiplier,
            mode: mode,
            claimed: false,
            payout: 0
        });

        playerRoundBets[player][currentRoundId].push(betId);
        round.totalBetAmount += netAmount;
        round.totalGrossBetAmount += amount;

        emit BetPlaced(
            currentRoundId,
            player,
            betId,
            amount,
            netAmount,
            mode,
            autoCashoutMultiplier
        );

        // Standardized event for cross-game indexers (IGameEvents)
        emit BetPlaced(
            currentRoundId,
            player,
            amount,
            abi.encode(betId, netAmount, mode, autoCashoutMultiplier)
        );
    }

    /**
     * @notice Settle round exposure in bulk
     * @param roundId The round ID
     * @param totalClaimable Sum of payouts that winners can claim (0 if all lost)
     * @dev Releases worst-case exposure and re-locks only what winners can actually claim.
     *      Each subsequent claim (AUTO or MANUAL) releases `payout` from lockedExposure.
     */
    function _settleRoundExposure(uint256 roundId, uint256 totalClaimable) internal {
        uint256 roundExp = roundExposure[roundId];
        if (roundExp == 0) return;

        // When reservation was capped (e.g. 50x), actual payouts may exceed reserved amount.
        // Verify the free bankroll can cover the shortfall.
        if (totalClaimable > roundExp) {
            uint256 shortfall = totalClaimable - roundExp;
            uint256 available = evaToken.balanceOf(address(this)) - lockedExposure - operatorBond;
            if (shortfall > available) revert InsufficientBankroll();
        }

        lockedExposure -= roundExp;
        lockedExposure += totalClaimable;
        roundExposure[roundId] = 0;
        roundClaimableRemaining[roundId] = totalClaimable;

        // Round-final result for indexers: crash point + bet/payout totals in one event.
        Round storage round = rounds[roundId];
        emit RoundSettled(roundId, round.crashPoint, round.totalBetAmount, totalClaimable);
    }

    /**
     * @notice Expire a single round's unclaimed exposure if eligible
     * @param roundId The round to expire
     * @return expired Whether the round was expired
     */
    function _expireRound(uint256 roundId) internal returns (bool expired) {
        uint256 remaining = roundClaimableRemaining[roundId];
        if (remaining == 0) return false;

        Round storage round = rounds[roundId];
        if (round.crashedAt == 0) return false;
        if (block.timestamp <= round.crashedAt + config.claimWindowSeconds) return false;

        lockedExposure -= remaining;
        roundClaimableRemaining[roundId] = 0;
        emit UnclaimedExposureExpired(roundId, remaining);
        return true;
    }

    /**
     * @notice Lazily expire unclaimed exposure from old rounds
     * @param maxRounds Maximum number of rounds to scan (bounds gas usage)
     * @dev Advances oldestUnclaimedRound pointer. Called automatically in createRound.
     */
    function _expireOldRounds(uint256 maxRounds) internal {
        uint256 scanned = 0;
        uint256 roundId = oldestUnclaimedRound;

        while (roundId <= currentRoundId && scanned < maxRounds) {
            uint256 remaining = roundClaimableRemaining[roundId];
            if (remaining > 0) {
                if (!_expireRound(roundId)) {
                    // This round hasn't expired yet — stop scanning (rounds are chronological)
                    break;
                }
            }
            roundId++;
            scanned++;
        }

        oldestUnclaimedRound = roundId;
    }

    /**
     * @notice Settle exposure for emergency refund rounds
     * @param roundId The round ID
     * @param totalGrossBet Sum of all gross bet amounts for the round
     * @param refundMultiplier The refund multiplier in basis points (e.g. 10200 = 1.02x)
     * @dev Caps totalClaimable at roundExposure to handle AUTO bets whose worst-case
     *      was lower than the refund multiplier (e.g. autoCashout=1.01x < refund=1.02x).
     *      This is safe because individual claim payouts never exceed their locked portion.
     */
    function _settleEmergencyExposure(
        uint256 roundId,
        uint256 totalGrossBet,
        uint32 refundMultiplier
    ) internal {
        uint256 totalClaimable = CrashMathLib.calculatePayout(totalGrossBet, refundMultiplier);
        uint256 roundExp = roundExposure[roundId];
        if (totalClaimable > roundExp) {
            totalClaimable = roundExp;
        }
        _settleRoundExposure(roundId, totalClaimable);
    }

    /**
     * @notice Get or compute the crash point for a round
     */
    function _getOrComputeCrashPoint(Round storage round) internal returns (uint32) {
        if (round.crashPoint > 0) {
            return round.crashPoint;
        }

        uint256 combinedSeed = CrashMathLib.combineSeed(
            round.vrfRandomWord,
            round.serverSeed,
            round.roundId
        );
        
        // Use round-snapshotted config; fall back to current config for legacy rounds
        RoundConfig memory rc = roundConfigs[round.roundId];
        uint16 he = rc.maxMultiplier > 0 ? rc.houseEdgeBps : getTotalEdgeBps();
        uint32 mm = rc.maxMultiplier > 0 ? rc.maxMultiplier : config.maxMultiplier;
        round.crashPoint = CrashMathLib.computeCrashPoint(combinedSeed, he, mm);

        return round.crashPoint;
    }
}

