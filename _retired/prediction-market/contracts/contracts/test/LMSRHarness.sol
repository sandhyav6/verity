// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LMSRMath} from "../lib/LMSRMath.sol";

/// @dev TEST-ONLY wrapper exposing the internal LMSRMath library so tests can compare it with
///      the independent mpmath reference. Never deployed outside the test suite.
contract LMSRHarness {
    function cost(uint256 qYes, uint256 qNo, uint256 b) external pure returns (uint256) {
        return LMSRMath.cost(qYes, qNo, b);
    }

    function priceYes(uint256 qYes, uint256 qNo, uint256 b) external pure returns (uint256) {
        return LMSRMath.priceYes(qYes, qNo, b);
    }

    function margin(uint256 b) external pure returns (uint256) {
        return LMSRMath.margin(b);
    }

    function initialSubsidy(uint256 b) external pure returns (uint256) {
        return LMSRMath.initialSubsidy(b);
    }
}
