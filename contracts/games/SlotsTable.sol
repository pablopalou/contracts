// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {PushVRFGame} from "contracts/games/base/PushVRFGame.sol";
import {IRandomConsumer} from "contracts/interfaces/core/IRandomConsumer.sol";
import {RandomDeriveLib} from "contracts/libraries/RandomDeriveLib.sol";

/**
 * @title SlotsTable
 * @notice Outcome-table slots game on the EVA platform.
 *
 * STORAGE MODEL
 *   Tier tables are stored as immutable bytecode of throwaway "blob" contracts (SSTORE2
 *   pattern). Each blob is `0x00 || packed_records` where each record is 12 bytes:
 *     [uint64 cumUpper | uint32 multHundredths]    (big-endian, MSB-first)
 *   `cumUpper` is the EXCLUSIVE upper bound of the tier's roll band against the running
 *   cumulative sum of probabilities. The LAST record's cumUpper == PROBABILITY_DENOMINATOR.
 *
 *   A roll r resolves to the smallest tier index i where cumUpper[i] > r — binary search.
 *
 * APPEND-ONLY VERSIONING + RE-POINTABLE SLOTS (Path B)
 *   `configVersions[]` is an append-only catalogue of (immutable) blob+metadata records.
 *   `activeVersion[slot]` maps a public slot to the currently-active version index.
 *   `setConfig(slot, ...)` deploys a new blob, pushes a new version, and re-points the slot.
 *   `placeBet(slot, ...)` SNAPSHOTS `activeVersion[slot]` into PendingSpin.versionIndex —
 *   in-flight VRF callbacks resolve against the version that was active at bet time, even
 *   if `setConfig(slot, ...)` is called before the callback lands.
 *
 *   Slots are user-facing identifiers (e.g. "1-line / 3-line / 5-line" for Tigrinho).
 *   The contract itself is agnostic — it just hosts N independent tables on one deployment.
 *
 * GAS ENVELOPE (with binary search + EXTCODECOPY-into-memory)
 *   setConfig:        ~3-4M gas for a 1300-tier table (one CREATE + validation loop).
 *   fulfillRandomness: ~6-8k gas regardless of tier count (one EXTCODECOPY + ~11 MLOADs).
 *
 * PROBABILITY SCALE
 *   `PROBABILITY_DENOMINATOR == 1e18`. Each tier's `probability` is a share of 1e18;
 *   Σ probability MUST == 1e18. uint64 holds 1e18 with ~18× headroom (max 2^64-1 ≈ 1.8e19).
 */
contract SlotsTable is PushVRFGame {
    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Probability scale: each tier's `probability` is a share of 1e18; Σ MUST == 1e18.
    uint256 public constant PROBABILITY_DENOMINATOR = 1e18;

    /// @notice Bytes per packed tier record in the SSTORE2 blob: uint64 cumUpper + uint32 mult.
    uint256 internal constant RECORD_SIZE = 12;

    /// @notice First byte of every SSTORE2 blob is 0x00 (STOP) so the blob can't be invoked.
    uint256 internal constant BLOB_PREFIX_BYTES = 1;

    /// @notice EIP-712 typehash for operator-relayed placeBetFor. Binds (game, player, slot,
    ///         wager, referrer, nonce, deadline) so signatures can't be replayed across slots
    ///         or contracts.
    bytes32 public constant PLACE_BET_TYPEHASH = keccak256(
        "PlaceBet(address game,address player,uint32 configIndex,uint256 wager,address referrer,uint256 nonce,uint256 deadline)"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Input tier — what admin/solver provides to setConfig. NOT how it's stored.
    ///         probability uses uint64 to hold 1e18 with ~18× headroom.
    struct PayoutTier {
        uint64 probability;
        uint32 payoutMultiplierHundredths;
    }

    /// @notice Wager-bound config. `cachedRtpBps` and `maxMultiplierHundredths` are DERIVED.
    struct TableConfig {
        bool enabled;
        uint256 minWager;
        uint256 maxWager; // 0 = unlimited
        uint32 maxMultiplierHundredths; // DERIVED = max(tier.payoutMultiplierHundredths)
        uint16 cachedRtpBps; // DERIVED = Σ probability_i * multHundredths_i / 1e16
    }

    /// @notice One immutable version in the append-only catalogue. `tierBlobPtr` is the
    ///         address of an SSTORE2 contract whose bytecode is `0x00 || packed_records`.
    struct ConfigVersion {
        address tierBlobPtr;
        uint32 tierCount;
        uint32 maxMultiplierHundredths;
        uint16 cachedRtpBps;
        bool enabled;
        uint256 minWager;
        uint256 maxWager;
    }

    /// @notice In-flight spin record, keyed by VRF requestId. `versionIndex` is the snapshot
    ///         into `configVersions[]` captured at placeBet time.
    struct PendingSpin {
        address player;
        uint256 wager;
        uint256 netStake;
        uint256 maxPayout;
        uint32 versionIndex;
        bool exists;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Append-only catalogue. Indexed by versionIndex.
    ConfigVersion[] public configVersions;

    /// @notice Public slot -> currently active versionIndex. Re-pointable via setConfig.
    mapping(uint32 => uint32) public activeVersion;

    /// @notice Whether a slot has been initialized at least once.
    mapping(uint32 => bool) public slotInitialized;

    /// @notice In-flight spins keyed by VRF requestId.
    mapping(uint256 => PendingSpin) public pendingSpins;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event ConfigUpdated(
        uint32 indexed configIndex,
        uint32 indexed versionIndex,
        address tierBlobPtr,
        uint16 cachedRtpBps,
        uint32 maxMultiplierHundredths,
        uint32 tierCount
    );

    event SpinStarted(
        uint256 indexed requestId,
        address indexed player,
        uint32 indexed configIndex,
        uint32 versionIndex,
        uint256 wager,
        uint256 netStake,
        uint256 maxPayout
    );

    event SpinResolved(
        uint256 indexed requestId,
        address indexed player,
        uint32 tierIndex,
        uint32 multiplierHundredths,
        uint256 payout,
        uint256 randomWord
    );

    event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error EmptyTable();
    error ProbabilitySumMismatch(uint256 sum);
    error ZeroProbabilityTier(uint256 index);
    error TiersNotDescending(uint256 index);
    error RtpExceedsNetStake(uint16 rtpBps, uint16 netStakeBps);
    error SlotNotInitialized(uint32 configIndex);
    error TableDisabled();
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error SolvencyViolation(uint16 cachedRtpBps, uint16 netStakeBps);
    error UnknownSpin(uint256 requestId);
    error BlobDeployFailed();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address handler, address provider, address eva, address authHub)
        PushVRFGame(eva, handler, provider, authHub, "SlotsTable", "1", address(0))
    {}

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: setConfig
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Append a new payout-table version under `configIndex` and re-point the slot.
     * @dev Validates tier shape (Σ probability == 1e18, descending, all positive), derives
     *      maxMult + cachedRtpBps, deploys an SSTORE2 blob of packed (cumUpper, mult) records,
     *      pushes the version to `configVersions[]`, and updates `activeVersion[configIndex]`.
     *      In-flight bets that snapshotted the prior version are unaffected.
     * @param configIndex   Public slot identifier (e.g. 0=1-line, 1=3-line, 2=5-line).
     * @param cfg           Wager bounds + enabled flag; derived fields are overwritten.
     * @param tiers_        DESCENDING by probability, all probability > 0, Σ probability == 1e18.
     */
    function setConfig(uint32 configIndex, TableConfig memory cfg, PayoutTier[] memory tiers_)
        external
        onlyOwner
    {
        uint256 n = tiers_.length;
        if (n == 0) revert EmptyTable();

        // Validate + compute cumulative + derived fields in one pass.
        // Records are written into `blob` packed as 12 bytes each: cumUpper (8) || mult (4).
        bytes memory blob = new bytes(BLOB_PREFIX_BYTES + n * RECORD_SIZE);
        // blob[0] left zero (STOP) — the SSTORE2 prefix that makes the blob un-callable.

        uint256 cumulative = 0;
        uint256 weightedSum = 0;
        uint32 maxMult = 0;

        for (uint256 i = 0; i < n; i++) {
            uint64 p = tiers_[i].probability;
            if (p == 0) revert ZeroProbabilityTier(i);
            if (i + 1 < n && p < tiers_[i + 1].probability) revert TiersNotDescending(i);

            uint32 m = tiers_[i].payoutMultiplierHundredths;
            cumulative += p;
            weightedSum += uint256(p) * uint256(m);
            if (m > maxMult) maxMult = m;

            // Write [cumUpper:8B BE][mult:4B BE] at blob[1 + i*12 ..].
            uint256 offset = BLOB_PREFIX_BYTES + i * RECORD_SIZE;
            uint64 cumUpper = uint64(cumulative);
            assembly {
                let dst := add(add(blob, 0x20), offset)
                // First 8 bytes: cumUpper big-endian.
                mstore(dst, shl(192, cumUpper))
                // Next 4 bytes: mult big-endian. Write at dst+8.
                mstore(add(dst, 8), shl(224, m))
            }
        }

        if (cumulative != PROBABILITY_DENOMINATOR) revert ProbabilitySumMismatch(cumulative);

        // rtpBps = Σ probability_i * multHundredths_i / 1e16. Denominator = 1e18 / 1e2 (mult
        // hundredths) / 1e4 (bps) = 1e16.
        uint16 rtpBps = uint16(weightedSum / 1e16);

        uint16 netStakeBps = paymentHandler.getNetStakeBps(address(this));
        if (rtpBps > netStakeBps) revert RtpExceedsNetStake(rtpBps, netStakeBps);

        // Deploy the blob as an immutable contract via CREATE (SSTORE2).
        address ptr = _deployBlob(blob);

        cfg.maxMultiplierHundredths = maxMult;
        cfg.cachedRtpBps = rtpBps;

        uint32 newVersion = uint32(configVersions.length);
        configVersions.push(
            ConfigVersion({
                tierBlobPtr: ptr,
                tierCount: uint32(n),
                maxMultiplierHundredths: maxMult,
                cachedRtpBps: rtpBps,
                enabled: cfg.enabled,
                minWager: cfg.minWager,
                maxWager: cfg.maxWager
            })
        );
        activeVersion[configIndex] = newVersion;
        slotInitialized[configIndex] = true;

        emit ConfigUpdated(configIndex, newVersion, ptr, rtpBps, maxMult, uint32(n));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The cached analytic RTP (in bps) of the active table at `configIndex`.
    function getRtpBps(uint32 configIndex) external view returns (uint16) {
        if (!slotInitialized[configIndex]) revert SlotNotInitialized(configIndex);
        return configVersions[activeVersion[configIndex]].cachedRtpBps;
    }

    /// @notice Number of tiers in the active version of `configIndex`.
    function tierCount(uint32 configIndex) external view returns (uint256) {
        if (!slotInitialized[configIndex]) revert SlotNotInitialized(configIndex);
        return configVersions[activeVersion[configIndex]].tierCount;
    }

    /// @notice Read tier `i` from the active version of `configIndex` by decoding the blob.
    ///         For analytics / test mirrors; not used on the hot path.
    function tierAt(uint32 configIndex, uint256 i)
        external
        view
        returns (uint64 cumUpper, uint32 multHundredths)
    {
        if (!slotInitialized[configIndex]) revert SlotNotInitialized(configIndex);
        ConfigVersion storage v = configVersions[activeVersion[configIndex]];
        require(i < v.tierCount, "tier index OOB");
        return _readRecord(v.tierBlobPtr, i);
    }

    /// @notice Read tier `i` from a SPECIFIC `versionIndex` (in-flight snapshot inspection).
    function tierAtVersion(uint32 versionIndex, uint256 i)
        external
        view
        returns (uint64 cumUpper, uint32 multHundredths)
    {
        ConfigVersion storage v = configVersions[versionIndex];
        require(i < v.tierCount, "tier index OOB");
        return _readRecord(v.tierBlobPtr, i);
    }

    /// @notice Number of versions in the append-only catalogue.
    function versionCount() external view returns (uint256) {
        return configVersions.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bet lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Player calls directly to spin the active table at `configIndex`.
    function placeBet(uint32 configIndex, uint256 wager, address referrer)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        return _startSpinInternal(msg.sender, configIndex, wager, referrer);
    }

    /// @notice Operator-relayed entry. Verifies the player's session-key signature, then runs
    ///         the identical internal flow as placeBet.
    function placeBetFor(
        address player,
        uint32 configIndex,
        uint256 wager,
        address referrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external onlyOperator nonReentrant returns (uint256 requestId) {
        bytes32 structHash = keccak256(
            abi.encode(
                PLACE_BET_TYPEHASH,
                address(this),
                player,
                configIndex,
                wager,
                referrer,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), wager, structHash, deadline, nonce, sig);
        return _startSpinInternal(player, configIndex, wager, referrer);
    }

    /// @dev Shared spin logic. Snapshots `activeVersion[configIndex]` into PendingSpin so
    ///      in-flight bets are immune to subsequent setConfig calls on the same slot.
    function _startSpinInternal(
        address player,
        uint32 configIndex,
        uint256 wager,
        address referrer
    ) internal returns (uint256 requestId) {
        if (!slotInitialized[configIndex]) revert SlotNotInitialized(configIndex);
        uint32 versionIndex = activeVersion[configIndex];
        ConfigVersion memory v = configVersions[versionIndex];

        if (!v.enabled) revert TableDisabled();
        if (v.minWager > 0 && wager < v.minWager) revert WagerTooLow(wager, v.minWager);
        if (v.maxWager > 0 && wager > v.maxWager) revert WagerTooHigh(wager, v.maxWager);

        // Solvency re-check at bet entry: cached RTP must still fit inside net stake (fees
        // could have risen since setConfig).
        uint16 netStakeBps = paymentHandler.getNetStakeBps(address(this));
        if (v.cachedRtpBps > netStakeBps) revert SolvencyViolation(v.cachedRtpBps, netStakeBps);

        uint256 netStake = _collectAndProcessBet(player, referrer, wager);
        uint256 maxPayout = wager * v.maxMultiplierHundredths / 100;
        _lockExposure(maxPayout, 0);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(PROBABILITY_DENOMINATOR)});
        requestId = randomProvider.requestRandomNumbers(ranges);

        pendingSpins[requestId] = PendingSpin({
            player: player,
            wager: wager,
            netStake: netStake,
            maxPayout: maxPayout,
            versionIndex: versionIndex,
            exists: true
        });

        emit SpinStarted(
            requestId, player, configIndex, versionIndex, wager, netStake, maxPayout
        );
        // Standard envelope (IGameEvents). data = abi.encode(netStake, maxPayout, configIndex, versionIndex)
        emit BetPlaced(
            requestId, player, wager, abi.encode(netStake, maxPayout, configIndex, versionIndex)
        );
    }

    /// @inheritdoc IRandomConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord, uint256[] memory derivedValues)
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        PendingSpin memory s = pendingSpins[requestId];
        if (!s.exists) revert UnknownSpin(requestId);

        // Binary-search the snapshot version's tier table.
        uint256 roll = derivedValues[0];
        ConfigVersion storage v = configVersions[s.versionIndex];
        (uint32 tierIndex, uint32 mult) = _resolveTier(v.tierBlobPtr, v.tierCount, roll);

        _unlockExposure(s.maxPayout, 0);
        delete pendingSpins[requestId];

        uint256 payout = s.wager * mult / 100;
        if (payout > 0) {
            _payPlayer(s.player, payout);
        }

        emit SpinResolved(requestId, s.player, tierIndex, mult, payout, randomWord);
        // Standard envelope (IGameEvents). data = abi.encode(tierIndex, mult, randomWord)
        emit BetSettled(requestId, s.player, payout, abi.encode(tierIndex, mult, randomWord));
    }

    /// @inheritdoc IRandomConsumer
    /// @dev NO refund on VRF failure: net stake stays in the bankroll, locked exposure
    ///      released. Idempotent on unknown requestIds.
    function handleRandomFailure(uint256 requestId, bytes32 reason, bytes calldata)
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        PendingSpin memory s = pendingSpins[requestId];
        if (!s.exists) return;

        _unlockExposure(s.maxPayout, 0);
        delete pendingSpins[requestId];

        emit SpinFailed(requestId, s.player, reason);
        emit BetFailed(requestId, s.player, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SSTORE2 helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Deploy `blob` as the runtime code of a new contract via CREATE.
     *      Init code (10 bytes) prepended:
     *        61 XX XX     PUSH2 runtimeSize
     *        3D           RETURNDATASIZE (push 0)
     *        81           DUP2  (duplicate runtimeSize for RETURN)
     *        60 0A        PUSH1 0x0A (offset of runtime within init code)
     *        3D           RETURNDATASIZE (push 0)
     *        39           CODECOPY (dst=0, offset=0x0A, size=runtimeSize)
     *        F3           RETURN (offset=0, size=runtimeSize)
     *      Then `blob` (which starts with 0x00 STOP so the deployed contract is un-callable).
     *
     *      Copy strategy: full 32-byte chunks, then byte-by-byte tail. This avoids the
     *      neighbouring-allocation corruption that naive bulk-copy would cause when
     *      `runtimeSize` isn't a multiple of 32.
     */
    function _deployBlob(bytes memory blob) internal returns (address ptr) {
        uint256 runtimeSize = blob.length;
        // Allocate init = 10-byte header + blob.
        bytes memory init = new bytes(10 + runtimeSize);
        assembly {
            // Header: 0x61 XX XX 3D 81 60 0A 3D 39 F3 — write big-endian 16-bit runtimeSize.
            let p := add(init, 0x20)
            mstore8(p, 0x61)
            mstore8(add(p, 1), byte(30, runtimeSize)) // high byte of uint16
            mstore8(add(p, 2), byte(31, runtimeSize)) // low byte of uint16
            mstore8(add(p, 3), 0x3D)
            mstore8(add(p, 4), 0x81)
            mstore8(add(p, 5), 0x60)
            mstore8(add(p, 6), 0x0A)
            mstore8(add(p, 7), 0x3D)
            mstore8(add(p, 8), 0x39)
            mstore8(add(p, 9), 0xF3)
            // Copy blob into init[10..10+runtimeSize] in two phases.
            let src := add(blob, 0x20)
            let dst := add(p, 10)
            let fullChunkBytes := and(runtimeSize, not(31)) // runtimeSize - (runtimeSize % 32)
            for { let i := 0 } lt(i, fullChunkBytes) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            // Tail: copy remaining bytes one at a time to avoid overrun.
            for { let i := fullChunkBytes } lt(i, runtimeSize) { i := add(i, 1) } {
                mstore8(add(dst, i), byte(0, mload(add(src, i))))
            }
            ptr := create(0, add(init, 0x20), mload(init))
        }
        if (ptr == address(0)) revert BlobDeployFailed();
    }

    /**
     * @dev Find the tier index for `roll` via binary search over the blob's cumUpper field.
     *      Returns the smallest i where cumUpper[i] > roll. Also returns that tier's mult.
     *
     *      We EXTCODECOPY only the cumUpper byte ranges we touch (one per probe). For 1286
     *      tiers that's ~11 probes × ~30 gas/EXTCODECOPY-word + arithmetic ≈ 6-8k gas total.
     *      Avoiding the bulk copy keeps memory expansion negligible for large tables.
     */
    function _resolveTier(address ptr, uint256 nTiers, uint256 roll)
        internal
        view
        returns (uint32 tierIndex, uint32 multHundredths)
    {
        uint256 lo = 0;
        uint256 hi = nTiers;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            uint64 cumUpper = _readCumUpper(ptr, mid);
            if (uint256(cumUpper) <= roll) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        // Clamp to last tier defensively. With Σ probability == 1e18 and roll < 1e18 the
        // binary search always finds a strict winner; this guards against any future bug
        // where the blob is inconsistent.
        if (lo >= nTiers) lo = nTiers - 1;
        tierIndex = uint32(lo);
        (, multHundredths) = _readRecord(ptr, lo);
    }

    /// @dev Read just the 8-byte cumUpper of record `i` via EXTCODECOPY. Big-endian.
    function _readCumUpper(address ptr, uint256 i) internal view returns (uint64 cumUpper) {
        uint256 offset = BLOB_PREFIX_BYTES + i * RECORD_SIZE;
        assembly {
            // Copy 8 bytes from ptr[offset..offset+8] into scratch memory.
            let scratch := mload(0x40)
            extcodecopy(ptr, scratch, offset, 8)
            cumUpper := shr(192, mload(scratch))
        }
    }

    /// @dev Read the full record `i` (cumUpper, mult). 12 bytes via EXTCODECOPY. Big-endian.
    function _readRecord(address ptr, uint256 i)
        internal
        view
        returns (uint64 cumUpper, uint32 multHundredths)
    {
        uint256 offset = BLOB_PREFIX_BYTES + i * RECORD_SIZE;
        assembly {
            let scratch := mload(0x40)
            extcodecopy(ptr, scratch, offset, 12)
            let word := mload(scratch)
            cumUpper := shr(192, word)
            // mult lives at bytes [8..12]; mask after right-shift.
            multHundredths := and(shr(160, word), 0xffffffff)
        }
    }
}
