// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SD59x18, sd, unwrap, exp, ln, mul, div} from "@prb/math/src/SD59x18.sol";

/// @title LMSRMath
/// @notice Fixed-point Logarithmic Market Scoring Rule maths for a binary market.
/// @dev All quantities (shares, tokens, the liquidity parameter `b`) are 18-decimal
///      fixed point ("WAD"): 1 share == 1e18 and redeems for exactly 1e18 token-wei.
///
///      C(qY, qN) = b * ln(e^(qY/b) + e^(qN/b))
///
///      is evaluated in the overflow-safe log-sum-exp form
///
///      C = max(qY, qN) + b * ln(1 + e^(-|qY - qN| / b))
///
///      so the exponent is always <= 0 and `exp` can never overflow.
///      exp/ln come from PRBMath (SD59x18). They are approximations, so callers must
///      round in the market's favour and add `margin(b)` (see PredictionMarket).
library LMSRMath {
    uint256 internal constant WAD = 1e18;

    /// @dev ln(2) in WAD, rounded down. The subsidy is rounded up separately.
    uint256 internal constant LN2_WAD = 693147180559945309;

    /// @dev Prices stay within ~2e-9 of 0/1 at this ratio, far above fixed-point noise.
    uint256 internal constant MAX_DIVERGENCE_RATIO = 20;

    /// @dev Sanity bound on outstanding shares (1e12 whole shares) so int256 casts are safe.
    uint256 internal constant MAX_SHARES = 1e12 * WAD;

    /// @dev Safety margin divisor, see `margin`.
    uint256 internal constant MARGIN_DIVISOR = 1e12;

    error SharesTooLarge();
    error DivergenceTooLarge();
    error InvalidLiquidity();

    /// @notice LMSR cost function C(qYes, qNo), rounded down to wei by the underlying ops.
    function cost(uint256 qYes, uint256 qNo, uint256 b) internal pure returns (uint256) {
        if (b == 0) revert InvalidLiquidity();
        if (qYes > MAX_SHARES || qNo > MAX_SHARES) revert SharesTooLarge();

        (uint256 hi, uint256 lo) = qYes >= qNo ? (qYes, qNo) : (qNo, qYes);
        // ratio = (hi - lo) / b in WAD; <= MAX_DIVERGENCE_RATIO when bounds are enforced.
        SD59x18 ratio = div(sd(int256(hi - lo)), sd(int256(b)));
        SD59x18 decay = exp(sd(-unwrap(ratio)));
        SD59x18 logTerm = ln(sd(int256(WAD) + unwrap(decay)));
        uint256 spread = uint256(unwrap(mul(sd(int256(b)), logTerm)));
        return hi + spread;
    }

    /// @notice Implied YES price in WAD: 1 / (1 + e^(-(qYes - qNo) / b)).
    function priceYes(uint256 qYes, uint256 qNo, uint256 b) internal pure returns (uint256) {
        if (b == 0) revert InvalidLiquidity();
        if (qYes > MAX_SHARES || qNo > MAX_SHARES) revert SharesTooLarge();

        SD59x18 diff = div(sd(int256(qYes) - int256(qNo)), sd(int256(b)));
        SD59x18 denom = sd(int256(WAD) + unwrap(exp(sd(-unwrap(diff)))));
        return uint256(unwrap(div(sd(int256(WAD)), denom)));
    }

    /// @notice Reverts when |qYes - qNo| exceeds MAX_DIVERGENCE_RATIO * b.
    function checkBounds(uint256 qYes, uint256 qNo, uint256 b) internal pure {
        uint256 d = qYes >= qNo ? qYes - qNo : qNo - qYes;
        if (d > MAX_DIVERGENCE_RATIO * b) revert DivergenceTooLarge();
    }

    /// @notice Extra wei charged on buys and withheld on sells to absorb the approximation
    ///         error of exp/ln, so the market's collateral never falls below the true cost.
    /// @dev Relative to `b` because absolute error of b*ln(.) scales with b. The value is
    ///      validated against a 50-digit reference in the test suite.
    function margin(uint256 b) internal pure returns (uint256) {
        return b / MARGIN_DIVISOR + 1;
    }

    /// @notice Collateral the market creator must deposit: ceil(b * ln 2) + margin.
    /// @dev ln(2) is truncated in LN2_WAD, so add 1 wei to guarantee rounding up.
    function initialSubsidy(uint256 b) internal pure returns (uint256) {
        return (b * LN2_WAD) / WAD + 1 + margin(b);
    }
}
