// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";
import {Multicallable} from "./Multicallable.sol";

/**
 * @title BaseGame
 * @notice Abstract base for all games in the ecosystem. Encapsulates:
 *         - ERC20 token management
 *         - PaymentHandler integration (player -> game -> handler flow)
 *         - Exposure locking for pending bets
 *         - Pause switch (gates bet inflow; payouts continue when paused)
 *         - Emergency withdrawal (only when paused, to prevent silent rug)
 */
abstract contract BaseGame is Ownable2Step, ReentrancyGuard, Pausable, Multicallable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    IERC20 public immutable evaToken;
    IPaymentHandlerMinimal public paymentHandler;
    uint256 public lockedExposure;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error LiquidityShortfall(uint256 available, uint256 required);
    error PaymentHandlerMisconfigured();

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address token, address handler) {
        if (token == address(0) || handler == address(0)) {
            revert PaymentHandlerMisconfigured();
        }
        evaToken = IERC20(token);
        paymentHandler = IPaymentHandlerMinimal(handler);
        IERC20(token).safeApprove(handler, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setPaymentHandler(address newHandler) external onlyOwner {
        require(newHandler != address(0), "Invalid handler");
        address oldHandler = address(paymentHandler);
        if (oldHandler != address(0)) {
            evaToken.safeApprove(oldHandler, 0);
        }
        paymentHandler = IPaymentHandlerMinimal(newHandler);
        evaToken.safeApprove(newHandler, type(uint256).max);
        emit PaymentHandlerUpdated(oldHandler, newHandler);
    }

    event PaymentHandlerUpdated(address indexed oldHandler, address indexed newHandler);

    /// @notice Halt all bet inflow. Existing pending bets continue to settle.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume bet inflow.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              FUND MOVEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev Pull tokens from the player into this contract.
     *      Player must have approved this game contract.
     *      Reverts when the game is paused so no funds can enter during incident response.
     */
    function _collectBet(address player, uint256 amount) internal {
        _requireNotPaused();
        // `player` is never arbitrary: direct entries pass msg.sender and the `*For` entries
        // pass the signer recovered by AuthHub._verifyAndConsume (session key + nonce +
        // deadline), so tokens can only be pulled from a wallet that approved this game
        // and authorised this exact bet.
        // slither-disable-next-line arbitrary-send-erc20
        evaToken.safeTransferFrom(player, address(this), amount);
    }

    /**
     * @dev Forward a bet through the PaymentHandler (fees, referrals).
     *      The handler pulls tokens from this contract via its allowance.
     *      Reverts when the game is paused.
     * @return netStake The amount remaining after handler deductions.
     */
    function _processBet(address bettor, address referrer, uint256 amount) internal returns (uint256 netStake) {
        _requireNotPaused();
        netStake = paymentHandler.processDirectBetFromGame(bettor, referrer, amount);
    }

    /**
     * @dev Convenience: pull from player and process in one step.
     * @return netStake The amount remaining after handler deductions.
     */
    function _collectAndProcessBet(address player, address referrer, uint256 amount) internal returns (uint256 netStake) {
        _collectBet(player, amount);
        netStake = _processBet(player, referrer, amount);
    }

    /**
     * @dev Transfer tokens to a player (winnings, refunds).
     */
    function _payPlayer(address player, uint256 amount) internal {
        evaToken.safeTransfer(player, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EXPOSURE
    // ═══════════════════════════════════════════════════════════════════════

    function _lockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 proposedLocked = lockedExposure + maxPayout + jackpotContribution;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < proposedLocked) revert LiquidityShortfall(balance, proposedLocked);
        lockedExposure = proposedLocked;
    }

    function _unlockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 reduction = maxPayout + jackpotContribution;
        if (lockedExposure < reduction) {
            lockedExposure = 0;
        } else {
            lockedExposure -= reduction;
        }
    }

    /// @dev Virtual so games with extra reserves (e.g. CrashGame's operatorBond)
    ///      can override to subtract those too.
    function availableLiquidity() external view virtual returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance <= lockedExposure) return 0;
        return balance - lockedExposure;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency withdraw all or part of the token balance.
     *
     * @dev    Platform invariant: emergency exits are total, observable, and reset state.
     *         - Requires the contract to be paused first (whenPaused) so an emergency
     *           withdrawal is always preceded by an observable Paused event.
     *         - ALWAYS zeros `lockedExposure`, regardless of the withdrawn amount. The
     *           contract is exiting normal operation; the owner is taking responsibility
     *           for any pending bets out-of-band, and the accounting must be blank-slate
     *           on exit. Games CANNOT override this to keep exposure intact.
     *         - Game-specific overrides are NOT supported (function is non-virtual).
     *
     * @param to     Recipient. Must be non-zero.
     * @param amount Amount to withdraw; 0 = full balance.
     */
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner whenPaused nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        // Reset exposure FIRST so any reentrancy (defensive — nonReentrant already guards) sees clean state.
        uint256 clearedExposure = lockedExposure;
        lockedExposure = 0;
        evaToken.safeTransfer(to, amt);
        emit EmergencyWithdraw(to, amt, clearedExposure);
    }

    /// @notice Emergency exit. `lockedExposureCleared` is the value that
    ///         `lockedExposure` held before being zeroed (platform invariant).
    event EmergencyWithdraw(address indexed to, uint256 amount, uint256 lockedExposureCleared);
}
