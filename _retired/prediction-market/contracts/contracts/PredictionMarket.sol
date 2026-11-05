// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPredictionMarket} from "./IPredictionMarket.sol";
import {LMSRMath} from "./lib/LMSRMath.sol";

/// @title PredictionMarket
/// @notice One binary (YES/NO) LMSR market with its own collateral. TEST TOKENS ONLY: the
///         token has no monetary value and nothing here can be redeemed for money.
/// @dev Deployed as an EIP-1167 clone by MarketFactory. This contract is the authority for
///      prices, positions and settlement; no off-chain component can alter them.
///
///      Collateral/treasury accounting lives here (see docs/architecture.md section 4.2):
///        collateral = initial subsidy + sum(buy costs) - sum(sell proceeds)
///      Solvency invariant: collateral >= C(qYes, qNo) >= max(qYes, qNo), so every winning
///      share can always be paid exactly 1 token.
///
///      Closure is derived from `tradingClose`; no transaction is needed to stop trading.
contract PredictionMarket is IPredictionMarket, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Bumped when event layouts change so the indexer can version its decoders.
    uint256 public constant EVENT_SCHEMA_VERSION = 1;
    /// @notice Smallest tradable size (1e-6 share) to block dust trades.
    uint256 public constant MIN_TRADE = 1e12;
    /// @notice After resolutionDeadline + this grace, anyone may void an unresolved market.
    uint64 public constant INVALID_GRACE = 7 days;

    // --- configuration (set once in initialize) ---
    IERC20 public token;
    address public factory;
    address public creator;
    address public resolutionManager;
    bytes32 public metadataHash;
    uint64 public tradingClose;
    uint64 public resolutionDeadline;
    uint256 public liquidityB;

    // --- market state ---
    uint256 public qYes;
    uint256 public qNo;
    uint256 public collateral;
    Status public status;
    Outcome public winningOutcome;
    bool public closedEmitted;
    bool public residualClaimed;

    // --- positions ---
    mapping(address => uint256) public yesShares;
    mapping(address => uint256) public noShares;
    /// @dev Net tokens a user paid in (buys - sells); negative if they sold at a profit.
    mapping(address => int256) public costBasis;
    uint256 public sumPositiveBasis;
    /// @dev Set when the market is voided: WAD fraction of positive cost basis that is refunded.
    uint256 public refundScale;
    /// @dev Tokens still owed to winners (Resolved) or refund claimants (Invalid). The creator's
    ///      residual is `collateral - reservedClaims`; it shrinks as users claim.
    uint256 public reservedClaims;

    event SharesPurchased(
        address indexed trader,
        Outcome indexed outcome,
        uint256 shares,
        uint256 cost,
        uint256 qYes,
        uint256 qNo,
        uint256 priceYes
    );
    event SharesSold(
        address indexed trader,
        Outcome indexed outcome,
        uint256 shares,
        uint256 proceeds,
        uint256 qYes,
        uint256 qNo,
        uint256 priceYes
    );
    event MarketClosed(uint256 qYes, uint256 qNo);
    event MarketResolved(Outcome outcome);
    event MarketInvalidated(uint256 refundScale);
    event SharesRedeemed(address indexed trader, uint256 shares, uint256 payout);
    event SharesRefunded(address indexed trader, uint256 amount);
    event ResidualClaimed(address indexed creator, uint256 amount);

    error NotResolutionManager();
    error NotCreator();
    error NotFactory();
    error TradingClosed();
    error TradingNotClosed();
    error MarketNotActive();
    error DeadlineExpired();
    error TradeTooSmall();
    error TradeTooLarge();
    error SlippageExceeded(uint256 actual, uint256 limit);
    error InsufficientShares();
    error NothingToRedeem();
    error WrongStatus();
    error ResidualAlreadyClaimed();
    error NotYetExpired();
    error InsufficientSubsidy();
    error ZeroAddress();

    modifier onlyResolutionManager() {
        if (msg.sender != resolutionManager) revert NotResolutionManager();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers(); // the implementation itself can never be used as a market
    }

    /// @notice Called once by the factory in the same transaction that clones this contract.
    /// @dev The factory must already have transferred the subsidy to this address.
    function initialize(
        address token_,
        address creator_,
        address resolutionManager_,
        bytes32 metadataHash_,
        uint64 tradingClose_,
        uint64 resolutionDeadline_,
        uint256 liquidityB_
    ) external initializer {
        // Found by Slither (missing-zero-check): the factory always passes valid values, but a market
        // with a zero creator or resolution manager could never be settled, so refuse it outright.
        if (token_ == address(0) || creator_ == address(0) || resolutionManager_ == address(0)) revert ZeroAddress();
        if (liquidityB_ == 0) revert LMSRMath.InvalidLiquidity();
        factory = msg.sender;
        token = IERC20(token_);
        creator = creator_;
        resolutionManager = resolutionManager_;
        metadataHash = metadataHash_;
        tradingClose = tradingClose_;
        resolutionDeadline = resolutionDeadline_;
        liquidityB = liquidityB_;

        uint256 subsidy = LMSRMath.initialSubsidy(liquidityB_);
        if (IERC20(token_).balanceOf(address(this)) < subsidy) revert InsufficientSubsidy();
        collateral = subsidy;
    }

    // ---------------------------------------------------------------------
    // Views / quotes (authoritative)
    // ---------------------------------------------------------------------

    function priceYes() public view returns (uint256) {
        return LMSRMath.priceYes(qYes, qNo, liquidityB);
    }

    function priceNo() public view returns (uint256) {
        return LMSRMath.WAD - priceYes();
    }

    function quoteBuy(Outcome outcome, uint256 shares) public view returns (uint256 cost) {
        (cost, , ) = _buyCost(outcome, shares);
    }

    function quoteSell(Outcome outcome, uint256 shares) public view returns (uint256 proceeds) {
        (proceeds, , ) = _sellProceeds(outcome, shares);
    }

    /// @notice Tokens that would be paid to the creator right now by `claimResidual`.
    function residual() public view returns (uint256) {
        if (status == Status.Active) return 0;
        return collateral > reservedClaims ? collateral - reservedClaims : 0;
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Buy exactly `shares` of `outcome`. Reverts if the LMSR cost exceeds `maxCost`.
    function buy(Outcome outcome, uint256 shares, uint256 maxCost, uint256 deadline) external nonReentrant {
        _requireTradable(deadline);
        (uint256 cost, uint256 newYes, uint256 newNo) = _buyCost(outcome, shares);
        if (cost > maxCost) revert SlippageExceeded(cost, maxCost);

        // effects
        qYes = newYes;
        qNo = newNo;
        collateral += cost;
        if (outcome == Outcome.Yes) yesShares[msg.sender] += shares;
        else noShares[msg.sender] += shares;
        _addBasis(msg.sender, int256(cost));

        // interactions
        token.safeTransferFrom(msg.sender, address(this), cost);

        emit SharesPurchased(msg.sender, outcome, shares, cost, newYes, newNo, LMSRMath.priceYes(newYes, newNo, liquidityB));
    }

    /// @notice Sell `shares` of `outcome` back to the market. Reverts if proceeds < `minProceeds`.
    function sell(Outcome outcome, uint256 shares, uint256 minProceeds, uint256 deadline) external nonReentrant {
        _requireTradable(deadline);
        uint256 held = outcome == Outcome.Yes ? yesShares[msg.sender] : noShares[msg.sender];
        if (shares > held) revert InsufficientShares();
        (uint256 proceeds, uint256 newYes, uint256 newNo) = _sellProceeds(outcome, shares);
        if (proceeds < minProceeds) revert SlippageExceeded(proceeds, minProceeds);

        qYes = newYes;
        qNo = newNo;
        collateral -= proceeds;
        if (outcome == Outcome.Yes) yesShares[msg.sender] -= shares;
        else noShares[msg.sender] -= shares;
        _addBasis(msg.sender, -int256(proceeds));

        token.safeTransfer(msg.sender, proceeds);

        emit SharesSold(msg.sender, outcome, shares, proceeds, newYes, newNo, LMSRMath.priceYes(newYes, newNo, liquidityB));
    }

    /// @notice Permissionless: records closure for the indexer. Trading is already blocked by time.
    function closeMarket() external {
        if (block.timestamp < tradingClose) revert TradingNotClosed();
        _emitClosed();
    }

    // ---------------------------------------------------------------------
    // Resolution (called by ResolutionManager only, except invalidateExpired)
    // ---------------------------------------------------------------------

    function resolve(Outcome outcome) external onlyResolutionManager {
        _requireResolvable();
        status = Status.Resolved;
        winningOutcome = outcome;
        reservedClaims = outcome == Outcome.Yes ? qYes : qNo;
        _emitClosed();
        emit MarketResolved(outcome);
    }

    function invalidate() external onlyResolutionManager {
        _requireResolvable();
        _invalidate();
    }

    /// @notice Liveness escape hatch: anyone may void a market nobody resolved in time.
    function invalidateExpired() external {
        if (status != Status.Active) revert MarketNotActive();
        if (block.timestamp < uint256(resolutionDeadline) + INVALID_GRACE) revert NotYetExpired();
        _invalidate();
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Redeem winning shares 1:1. Losing shares are worth nothing and cannot be redeemed.
    function redeem() external nonReentrant returns (uint256 payout) {
        if (status != Status.Resolved) revert WrongStatus();
        payout = winningOutcome == Outcome.Yes ? yesShares[msg.sender] : noShares[msg.sender];
        if (payout == 0) revert NothingToRedeem();

        yesShares[msg.sender] = 0; // burns winning and losing positions: no double redemption
        noShares[msg.sender] = 0;
        collateral -= payout;
        reservedClaims -= payout;

        token.safeTransfer(msg.sender, payout);
        emit SharesRedeemed(msg.sender, payout, payout);
    }

    /// @notice Refund after the market was voided: positive net cost basis, pro-rated if short.
    function refund() external nonReentrant returns (uint256 amount) {
        if (status != Status.Invalid) revert WrongStatus();
        int256 basis = costBasis[msg.sender];
        if (basis <= 0) revert NothingToRedeem();

        amount = (uint256(basis) * refundScale) / LMSRMath.WAD;
        costBasis[msg.sender] = 0;
        yesShares[msg.sender] = 0;
        noShares[msg.sender] = 0;
        collateral -= amount;
        reservedClaims -= amount;

        token.safeTransfer(msg.sender, amount);
        emit SharesRefunded(msg.sender, amount);
    }

    /// @notice Creator recovers the unspent subsidy after settlement/void. One-shot.
    function claimResidual() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        if (status == Status.Active) revert WrongStatus();
        if (residualClaimed) revert ResidualAlreadyClaimed();
        residualClaimed = true;
        amount = residual();
        collateral -= amount;
        if (amount > 0) token.safeTransfer(creator, amount);
        emit ResidualClaimed(creator, amount);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _requireTradable(uint256 deadline) private view {
        if (status != Status.Active) revert MarketNotActive();
        if (block.timestamp >= tradingClose) revert TradingClosed();
        if (block.timestamp > deadline) revert DeadlineExpired();
    }

    function _requireResolvable() private view {
        if (status != Status.Active) revert MarketNotActive();
        if (block.timestamp < tradingClose) revert TradingNotClosed();
    }

    function _emitClosed() private {
        if (closedEmitted) return;
        closedEmitted = true;
        emit MarketClosed(qYes, qNo);
    }

    function _invalidate() private {
        status = Status.Invalid;
        refundScale = sumPositiveBasis == 0
            ? LMSRMath.WAD
            : _min(LMSRMath.WAD, (collateral * LMSRMath.WAD) / sumPositiveBasis);
        reservedClaims = (sumPositiveBasis * refundScale) / LMSRMath.WAD;
        _emitClosed();
        emit MarketInvalidated(refundScale);
    }

    function _addBasis(address user, int256 delta) private {
        int256 oldBasis = costBasis[user];
        int256 newBasis = oldBasis + delta;
        costBasis[user] = newBasis;
        uint256 oldPos = oldBasis > 0 ? uint256(oldBasis) : 0;
        uint256 newPos = newBasis > 0 ? uint256(newBasis) : 0;
        sumPositiveBasis = sumPositiveBasis + newPos - oldPos;
    }

    /// @dev Buys are capped at one `b` of shares per trade; sells may exit a whole position at once
    ///      (they only reduce the divergence of the dominant side or are bounded by holdings).
    function _checkSize(uint256 shares, bool isBuy) private view {
        if (shares < MIN_TRADE) revert TradeTooSmall();
        if (isBuy && shares > liquidityB) revert TradeTooLarge();
    }

    /// @dev Rounds up in the market's favour: cost = (C(new) - C(old)) + margin(b).
    function _buyCost(Outcome outcome, uint256 shares)
        private
        view
        returns (uint256 cost, uint256 newYes, uint256 newNo)
    {
        _checkSize(shares, true);
        newYes = outcome == Outcome.Yes ? qYes + shares : qYes;
        newNo = outcome == Outcome.No ? qNo + shares : qNo;
        LMSRMath.checkBounds(newYes, newNo, liquidityB);

        uint256 cNew = LMSRMath.cost(newYes, newNo, liquidityB);
        uint256 cOld = LMSRMath.cost(qYes, qNo, liquidityB);
        cost = (cNew > cOld ? cNew - cOld : 0) + LMSRMath.margin(liquidityB);
    }

    /// @dev Rounds down in the market's favour: proceeds = (C(old) - C(new)) - margin(b), floored at 0.
    function _sellProceeds(Outcome outcome, uint256 shares)
        private
        view
        returns (uint256 proceeds, uint256 newYes, uint256 newNo)
    {
        _checkSize(shares, false);
        uint256 supply = outcome == Outcome.Yes ? qYes : qNo;
        if (shares > supply) revert InsufficientShares();
        newYes = outcome == Outcome.Yes ? qYes - shares : qYes;
        newNo = outcome == Outcome.No ? qNo - shares : qNo;

        uint256 cOld = LMSRMath.cost(qYes, qNo, liquidityB);
        uint256 cNew = LMSRMath.cost(newYes, newNo, liquidityB);
        uint256 gross = cOld > cNew ? cOld - cNew : 0;
        uint256 m = LMSRMath.margin(liquidityB);
        proceeds = gross > m ? gross - m : 0;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
