// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMarketRegistry} from "./IPredictionMarket.sol";
import {PredictionMarket} from "./PredictionMarket.sol";
import {TestToken} from "./TestToken.sol";
import {LMSRMath} from "./lib/LMSRMath.sol";

/// @title MarketFactory
/// @notice Creates and registers PredictionMarket clones. TEST TOKENS ONLY.
/// @dev Only addresses with CREATOR_ROLE may create markets (anti-spam / anti-ambiguity in the
///      MVP). The creator funds the LMSR subsidy (~b*ln2) with test tokens and recovers what is
///      unspent after settlement. Market question/description live off-chain; only their hash is
///      stored on-chain (`metadataHash`), and each hash can be used once.
contract MarketFactory is AccessControl, IMarketRegistry {
    using SafeERC20 for IERC20;

    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    /// @notice Allowed categories: 0 Economy, 1 Weather, 2 Sports, 3 Technology.
    uint8 public constant MAX_CATEGORY = 3;
    uint256 public constant MIN_LIQUIDITY = 10 ether;
    uint256 public constant MAX_LIQUIDITY = 100_000 ether;

    TestToken public immutable token;
    address public immutable implementation;
    address public immutable resolutionManager;
    /// @notice Minimum time between creation and trading close.
    uint64 public immutable minTradingWindow;

    uint256 public marketCount;
    mapping(uint256 => address) public marketById;
    mapping(address => bool) public isMarket;
    mapping(bytes32 => bool) public metadataUsed;

    struct MarketParams {
        bytes32 metadataHash;
        uint8 category;
        uint64 tradingClose;
        uint64 resolutionDeadline;
        uint256 liquidityB;
    }

    event MarketCreated(
        uint256 indexed id,
        address indexed market,
        address indexed creator,
        bytes32 metadataHash,
        uint8 category,
        uint64 tradingClose,
        uint64 resolutionDeadline,
        uint256 liquidityB,
        uint256 subsidy
    );

    error ZeroAddress();
    error InvalidMetadataHash();
    error DuplicateMetadata();
    error InvalidCategory();
    error InvalidLiquidity();
    error InvalidTimes();

    constructor(
        address admin,
        TestToken token_,
        address implementation_,
        address resolutionManager_,
        uint64 minTradingWindow_
    ) {
        if (
            admin == address(0) || address(token_) == address(0) || implementation_ == address(0)
                || resolutionManager_ == address(0)
        ) revert ZeroAddress();
        token = token_;
        implementation = implementation_;
        resolutionManager = resolutionManager_;
        minTradingWindow = minTradingWindow_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Creates a market and pulls the subsidy from the caller's test-token balance.
    function createMarket(MarketParams calldata p) external onlyRole(CREATOR_ROLE) returns (uint256 id, address market) {
        if (p.metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (metadataUsed[p.metadataHash]) revert DuplicateMetadata();
        if (p.category > MAX_CATEGORY) revert InvalidCategory();
        if (p.liquidityB < MIN_LIQUIDITY || p.liquidityB > MAX_LIQUIDITY) revert InvalidLiquidity();
        if (
            p.tradingClose < block.timestamp + minTradingWindow || p.resolutionDeadline <= p.tradingClose
        ) revert InvalidTimes();

        metadataUsed[p.metadataHash] = true;
        id = ++marketCount;
        market = Clones.clone(implementation);
        marketById[id] = market;
        isMarket[market] = true;

        // Deploy + fund + initialize atomically: no window to front-run initialize().
        token.registerMarket(market);
        uint256 subsidy = LMSRMath.initialSubsidy(p.liquidityB);
        IERC20(address(token)).safeTransferFrom(msg.sender, market, subsidy);
        PredictionMarket(market).initialize(
            address(token), msg.sender, resolutionManager, p.metadataHash, p.tradingClose, p.resolutionDeadline, p.liquidityB
        );

        emit MarketCreated(
            id, market, msg.sender, p.metadataHash, p.category, p.tradingClose, p.resolutionDeadline, p.liquidityB, subsidy
        );
    }
}
