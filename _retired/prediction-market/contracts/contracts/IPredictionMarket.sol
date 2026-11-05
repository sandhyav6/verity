// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal surface used by MarketFactory and ResolutionManager.
interface IPredictionMarket {
    enum Outcome {
        Yes,
        No
    }

    enum Status {
        Active, // trading open, or closed-but-unresolved (closure is derived from time)
        Resolved,
        Invalid
    }

    function creator() external view returns (address);

    function tradingClose() external view returns (uint64);

    function status() external view returns (Status);

    function resolve(Outcome outcome) external;

    function invalidate() external;
}

interface IMarketRegistry {
    function isMarket(address market) external view returns (bool);
}
