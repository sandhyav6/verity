// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../contracts/TestToken.sol";
import {ResolutionManager} from "../contracts/ResolutionManager.sol";
import {PredictionMarket} from "../contracts/PredictionMarket.sol";
import {MarketFactory} from "../contracts/MarketFactory.sol";
import {IPredictionMarket} from "../contracts/IPredictionMarket.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LMSRMath} from "../contracts/lib/LMSRMath.sol";

/// @dev Drives random buys/sells from several actors. Foundry-style invariants then run after
///      every call. Solidity-native tests in Hardhat 3 (no separate Foundry install).
contract MarketHandler is Test {
    PredictionMarket public immutable market;
    address[] public actors;
    uint256 public buys;
    uint256 public sells;

    constructor(PredictionMarket market_, address[] memory actors_) {
        market = market_;
        actors = actors_;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function buy(uint256 actorSeed, uint256 outcomeSeed, uint256 sharesSeed) external {
        address actor = actors[actorSeed % actors.length];
        IPredictionMarket.Outcome o = IPredictionMarket.Outcome(outcomeSeed % 2);
        uint256 shares = bound(sharesSeed, market.MIN_TRADE(), market.liquidityB());
        vm.prank(actor);
        try market.buy(o, shares, type(uint256).max, block.timestamp) {
            buys++;
        } catch {} // rejected (e.g. divergence cap): state must be unchanged, invariants still checked
    }

    function sell(uint256 actorSeed, uint256 outcomeSeed, uint256 sharesSeed) external {
        address actor = actors[actorSeed % actors.length];
        IPredictionMarket.Outcome o = IPredictionMarket.Outcome(outcomeSeed % 2);
        uint256 held = o == IPredictionMarket.Outcome.Yes ? market.yesShares(actor) : market.noShares(actor);
        if (held < market.MIN_TRADE()) return;
        uint256 shares = bound(sharesSeed, market.MIN_TRADE(), held);
        vm.prank(actor);
        try market.sell(o, shares, 0, block.timestamp) {
            sells++;
        } catch {}
    }
}

contract SolvencyInvariantTest is Test {
    TestToken token;
    PredictionMarket market;
    MarketHandler handler;
    uint256 constant B = 100 ether;

    function setUp() public {
        token = new TestToken(address(this));
        ResolutionManager rm = new ResolutionManager(address(this), IERC20(address(token)), 0, 1 hours, 100 ether);
        PredictionMarket impl = new PredictionMarket();
        MarketFactory factory = new MarketFactory(address(this), token, address(impl), address(rm), 1 hours);
        token.setFactory(address(factory));
        rm.setRegistry(address(factory));
        factory.grantRole(factory.CREATOR_ROLE(), address(this));
        token.adminMint(address(this), 1_000 ether);

        (, address m) = factory.createMarket(
            MarketFactory.MarketParams({
                metadataHash: keccak256("invariant-market"),
                category: 1,
                tradingClose: uint64(block.timestamp + 30 days),
                resolutionDeadline: uint64(block.timestamp + 40 days),
                liquidityB: B
            })
        );
        market = PredictionMarket(m);

        address[] memory actors = new address[](4);
        for (uint256 i = 0; i < actors.length; i++) {
            actors[i] = address(uint160(0xA11CE + i));
            token.adminMint(actors[i], 1_000_000 ether);
        }
        handler = new MarketHandler(market, actors);
        targetContract(address(handler));
    }

    /// collateral >= max(qYes, qNo): every winning share can be paid 1 token.
    function invariant_collateralCoversWorstCase() public view {
        uint256 q = market.qYes() > market.qNo() ? market.qYes() : market.qNo();
        assertGe(market.collateral(), q, "collateral < max(q)");
    }

    /// Internal accounting equals the real token balance (no donation or leak path).
    function invariant_accountingMatchesBalance() public view {
        assertEq(token.balanceOf(address(market)), market.collateral(), "balance != collateral");
    }

    /// Outstanding shares equal the sum of all users' positions.
    function invariant_sharesConserved() public view {
        uint256 y;
        uint256 n;
        for (uint256 i = 0; i < handler.actorsLength(); i++) {
            address a = handler.actors(i);
            y += market.yesShares(a);
            n += market.noShares(a);
        }
        assertEq(y, market.qYes(), "yes shares not conserved");
        assertEq(n, market.qNo(), "no shares not conserved");
    }

    /// Price is always a valid probability.
    function invariant_priceInUnitInterval() public view {
        uint256 p = market.priceYes();
        assertLe(p, 1 ether);
        assertEq(p + market.priceNo(), 1 ether);
    }

    /// Fuzz: a buy followed by selling the same shares never returns more than it cost.
    function testFuzz_roundTripNeverProfits(uint256 sharesSeed, uint8 side) public {
        address user = address(0xBEEF);
        token.adminMint(user, 1_000_000 ether);
        IPredictionMarket.Outcome o = IPredictionMarket.Outcome(side % 2);
        uint256 shares = bound(sharesSeed, market.MIN_TRADE(), B);
        uint256 start = token.balanceOf(user);
        vm.startPrank(user);
        market.buy(o, shares, type(uint256).max, block.timestamp);
        market.sell(o, shares, 0, block.timestamp);
        vm.stopPrank();
        assertLt(token.balanceOf(user), start, "round trip profited");
    }
}
