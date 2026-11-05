// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPredictionMarket, IMarketRegistry} from "./IPredictionMarket.sol";

/// @title ResolutionManager
/// @notice Evidence-backed market resolution with an UMA-INSPIRED optimistic path. TEST TOKENS ONLY.
///
/// Three ways a verdict gets proposed (all emit the same `ResolutionProposed` event):
///   Stage 1/2  `propose`        a RESOLVER_ROLE account, no bond, window = `challengeWindow` (may be 0).
///   Stage 3    `proposeBonded`  ANYONE, posts `bondAmount` test tokens, window = `bondedChallengeWindow` (> 0).
/// Then, during the window, anyone except the proposer may `dispute` by posting a matching bond and their
/// own evidence. An undisputed proposal is finalized by anyone after the window (bond returned). A disputed
/// one is decided by a named ARBITER, and the LOSER'S BOND GOES TO THE WINNER.
///
/// TRUST MODEL, stated plainly (see docs/oracle-design.md):
///  * This is NOT UMA and NOT a decentralized oracle. UMA escalates disputes to a token-holder vote (the DVM);
///    here a disputed result is decided by a single trusted arbiter account. Bonds only deter *careless or
///    frivolous* assertions; they do not make the final decision trustless.
///  * An undisputed false proposal is accepted: safety relies on at least one honest, watching challenger.
///  * RESOLVER_ROLE proposals carry no bond. With `challengeWindow == 0` they cannot be disputed at all
///    (dev mode); use a non-zero window anywhere that matters.
///  * DEFAULT_ADMIN_ROLE manages roles and parameters and may cancel an UNDISPUTED proposal.
/// Liveness: a dispute the arbiter never decides can be unwound after `ARBITER_TIMEOUT` (`releaseBonds`),
/// and a market nobody resolves is voided by `PredictionMarket.invalidateExpired`.
/// The evidence bundle stays off-chain; only its hash is stored, the URI is emitted in the event.
contract ResolutionManager is AccessControl, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    uint64 public constant MAX_CHALLENGE_WINDOW = 7 days;
    uint64 public constant ARBITER_TIMEOUT = 14 days;
    uint256 public constant MIN_BOND = 1 ether;
    uint256 public constant MAX_BOND = 10_000 ether;

    enum Verdict {
        Yes,
        No,
        Invalid
    }

    /// @dev Values are append-only: the first four match the Stage 1 contract.
    enum ProposalState {
        None,
        Proposed,
        Finalized,
        Cancelled,
        Disputed
    }

    struct Proposal {
        Verdict verdict;
        ProposalState state;
        address proposer;
        uint64 proposedAt;
        uint64 challengeDeadline;
        bytes32 evidenceHash;
        uint256 bond; // posted by the proposer (0 for RESOLVER_ROLE proposals)
        uint256 disputeBond; // the matching bond a disputer must post (snapshot at proposal time)
        address disputer;
        uint64 disputedAt;
        bytes32 disputeEvidenceHash;
    }

    IERC20 public immutable token;
    IMarketRegistry public registry;
    uint64 public challengeWindow;
    uint64 public bondedChallengeWindow;
    uint256 public bondAmount;
    /// @notice Test tokens currently escrowed here. Invariant: equals this contract's token balance.
    uint256 public totalLockedBonds;
    mapping(address => Proposal) public proposals;

    event RegistrySet(address indexed registry);
    event ChallengeWindowSet(uint64 window);
    event BondParametersSet(uint64 bondedWindow, uint256 bondAmount);
    event ResolutionProposed(
        address indexed market,
        Verdict verdict,
        bytes32 evidenceHash,
        string evidenceURI,
        address indexed proposer,
        uint64 challengeDeadline,
        uint256 bond
    );
    event ResolutionDisputed(
        address indexed market, address indexed disputer, bytes32 evidenceHash, string evidenceURI, uint256 bond
    );
    event DisputeResolved(
        address indexed market, address indexed arbiter, Verdict verdict, bytes32 rationaleHash, bool proposerWon
    );
    event BondsReleased(address indexed market, uint256 proposerRefund, uint256 disputerRefund);
    event ResolutionCancelled(address indexed market, address indexed cancelledBy);
    event ResolutionFinalized(address indexed market, Verdict verdict, bytes32 evidenceHash);

    error ZeroAddress();
    error RegistryAlreadySet();
    error UnknownMarket();
    error MarketNotResolvable();
    error CreatorCannotResolve();
    error EmptyEvidence();
    error ProposalExists();
    error NoPendingProposal();
    error ChallengeWindowActive(uint64 challengeDeadline);
    error ChallengeWindowOver();
    error WindowTooLong();
    error InvalidBond();
    error InvalidBondedWindow();
    error CannotDisputeOwnProposal();
    error NotDisputed();
    error ArbiterConflict();
    error NothingToRelease();
    error DisputedProposalNeedsArbiter();

    constructor(address admin, IERC20 token_, uint64 challengeWindow_, uint64 bondedChallengeWindow_, uint256 bondAmount_) {
        if (admin == address(0) || address(token_) == address(0)) revert ZeroAddress();
        if (challengeWindow_ > MAX_CHALLENGE_WINDOW) revert WindowTooLong();
        _checkBondParameters(bondedChallengeWindow_, bondAmount_);
        token = token_;
        challengeWindow = challengeWindow_;
        bondedChallengeWindow = bondedChallengeWindow_;
        bondAmount = bondAmount_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ configuration

    /// @notice One-time wiring of the MarketFactory (the market registry).
    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(registry) != address(0)) revert RegistryAlreadySet();
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IMarketRegistry(registry_);
        emit RegistrySet(registry_);
    }

    function setChallengeWindow(uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (window > MAX_CHALLENGE_WINDOW) revert WindowTooLong();
        challengeWindow = window;
        emit ChallengeWindowSet(window);
    }

    /// @notice Applies to proposals made AFTER the change; open proposals keep the bond they were made with.
    function setBondParameters(uint64 bondedWindow, uint256 bond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _checkBondParameters(bondedWindow, bond);
        bondedChallengeWindow = bondedWindow;
        bondAmount = bond;
        emit BondParametersSet(bondedWindow, bond);
    }

    function _checkBondParameters(uint64 bondedWindow, uint256 bond) private pure {
        if (bondedWindow == 0 || bondedWindow > MAX_CHALLENGE_WINDOW) revert InvalidBondedWindow();
        if (bond < MIN_BOND || bond > MAX_BOND) revert InvalidBond();
    }

    // ------------------------------------------------------------------ proposing

    /// @notice Stage 1/2: a trusted resolver proposes an outcome with evidence (no bond).
    function propose(address market, Verdict verdict, bytes32 evidenceHash, string calldata evidenceURI)
        external
        onlyRole(RESOLVER_ROLE)
        nonReentrant
    {
        _propose(market, verdict, evidenceHash, evidenceURI, 0, challengeWindow);
    }

    /// @notice Stage 3: anyone proposes by escrowing `bondAmount` test tokens. Returned if the proposal stands,
    ///         lost to the disputer if an arbiter rules against it.
    function proposeBonded(address market, Verdict verdict, bytes32 evidenceHash, string calldata evidenceURI)
        external
        nonReentrant
    {
        uint256 bond = bondAmount;
        _propose(market, verdict, evidenceHash, evidenceURI, bond, bondedChallengeWindow);
        totalLockedBonds += bond;
        token.safeTransferFrom(msg.sender, address(this), bond);
    }

    function _propose(
        address market,
        Verdict verdict,
        bytes32 evidenceHash,
        string calldata evidenceURI,
        uint256 bond,
        uint64 window
    ) private {
        if (!registry.isMarket(market)) revert UnknownMarket();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();

        IPredictionMarket m = IPredictionMarket(market);
        if (m.status() != IPredictionMarket.Status.Active || block.timestamp < m.tradingClose()) {
            revert MarketNotResolvable();
        }
        if (m.creator() == msg.sender) revert CreatorCannotResolve();

        ProposalState current = proposals[market].state;
        if (current == ProposalState.Proposed || current == ProposalState.Finalized || current == ProposalState.Disputed) {
            revert ProposalExists();
        }

        uint64 deadline = uint64(block.timestamp) + window;
        proposals[market] = Proposal({
            verdict: verdict,
            state: ProposalState.Proposed,
            proposer: msg.sender,
            proposedAt: uint64(block.timestamp),
            challengeDeadline: deadline,
            evidenceHash: evidenceHash,
            bond: bond,
            disputeBond: bondAmount,
            disputer: address(0),
            disputedAt: 0,
            disputeEvidenceHash: bytes32(0)
        });
        emit ResolutionProposed(market, verdict, evidenceHash, evidenceURI, msg.sender, deadline, bond);
    }

    // ------------------------------------------------------------------ disputing and deciding

    /// @notice Challenge a pending proposal before its window ends, posting a matching bond and your evidence.
    function dispute(address market, bytes32 evidenceHash, string calldata evidenceURI) external nonReentrant {
        Proposal storage p = proposals[market];
        if (p.state != ProposalState.Proposed) revert NoPendingProposal();
        if (block.timestamp >= p.challengeDeadline) revert ChallengeWindowOver();
        if (msg.sender == p.proposer) revert CannotDisputeOwnProposal();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();

        uint256 bond = p.disputeBond;
        p.state = ProposalState.Disputed;
        p.disputer = msg.sender;
        p.disputedAt = uint64(block.timestamp);
        p.disputeEvidenceHash = evidenceHash;
        totalLockedBonds += bond;

        token.safeTransferFrom(msg.sender, address(this), bond);
        emit ResolutionDisputed(market, msg.sender, evidenceHash, evidenceURI, bond);
    }

    /// @notice The arbiter decides a disputed proposal. The loser's bond goes to the winner; the market is
    ///         then resolved with the arbiter's verdict (which may differ from both parties' claims).
    function arbitrate(address market, Verdict verdict, bytes32 rationaleHash) external onlyRole(ARBITER_ROLE) nonReentrant {
        Proposal storage p = proposals[market];
        if (p.state != ProposalState.Disputed) revert NotDisputed();
        if (rationaleHash == bytes32(0)) revert EmptyEvidence();

        IPredictionMarket m = IPredictionMarket(market);
        if (msg.sender == p.proposer || msg.sender == p.disputer || msg.sender == m.creator()) revert ArbiterConflict();

        bool proposerWon = verdict == p.verdict;
        address proposer = p.proposer;
        address disputer = p.disputer;
        uint256 proposerBond = p.bond;
        uint256 disputeBond = p.disputeBond;
        bytes32 evidenceHash = p.evidenceHash;

        p.state = ProposalState.Finalized; // effects first
        totalLockedBonds -= proposerBond + disputeBond;
        emit DisputeResolved(market, msg.sender, verdict, rationaleHash, proposerWon);

        // loser's bond to the winner; the winner's own bond is returned
        if (proposerWon) {
            token.safeTransfer(proposer, proposerBond + disputeBond);
        } else {
            token.safeTransfer(disputer, proposerBond + disputeBond);
        }
        _apply(market, verdict);
        emit ResolutionFinalized(market, verdict, evidenceHash);
    }

    // ------------------------------------------------------------------ finalizing and unwinding

    /// @notice Permissionless once an UNDISPUTED proposal's window has elapsed. Returns the proposer's bond.
    function finalize(address market) external nonReentrant {
        Proposal storage p = proposals[market];
        if (p.state == ProposalState.Disputed) revert DisputedProposalNeedsArbiter();
        if (p.state != ProposalState.Proposed) revert NoPendingProposal();
        if (block.timestamp < p.challengeDeadline) revert ChallengeWindowActive(p.challengeDeadline);

        Verdict verdict = p.verdict;
        address proposer = p.proposer;
        uint256 bond = p.bond;
        bytes32 evidenceHash = p.evidenceHash;

        p.state = ProposalState.Finalized; // effects before the external calls
        if (bond > 0) {
            totalLockedBonds -= bond;
            token.safeTransfer(proposer, bond);
        }
        _apply(market, verdict);
        emit ResolutionFinalized(market, verdict, evidenceHash);
    }

    /// @notice Admin can withdraw a mistaken UNDISPUTED proposal; a bonded proposer is refunded in full.
    function cancelProposal(address market) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Proposal storage p = proposals[market];
        if (p.state == ProposalState.Disputed) revert DisputedProposalNeedsArbiter();
        if (p.state != ProposalState.Proposed) revert NoPendingProposal();
        p.state = ProposalState.Cancelled;
        if (p.bond > 0) {
            totalLockedBonds -= p.bond;
            token.safeTransfer(p.proposer, p.bond);
        }
        emit ResolutionCancelled(market, msg.sender);
    }

    /// @notice Unwind escrowed bonds without a ruling, returning each party's own bond. Allowed when
    ///         (a) the market was already settled some other way (e.g. voided at its deadline), or
    ///         (b) a dispute has waited `ARBITER_TIMEOUT` without an arbiter decision.
    function releaseBonds(address market) external nonReentrant {
        Proposal storage p = proposals[market];
        if (p.state != ProposalState.Proposed && p.state != ProposalState.Disputed) revert NothingToRelease();
        bool settledElsewhere = IPredictionMarket(market).status() != IPredictionMarket.Status.Active;
        bool arbiterTimedOut = p.state == ProposalState.Disputed && block.timestamp >= uint256(p.disputedAt) + ARBITER_TIMEOUT;
        if (!settledElsewhere && !arbiterTimedOut) revert NothingToRelease();

        address proposer = p.proposer;
        address disputer = p.disputer;
        uint256 proposerRefund = p.bond;
        uint256 disputerRefund = p.state == ProposalState.Disputed ? p.disputeBond : 0;
        p.state = ProposalState.Cancelled;
        totalLockedBonds -= proposerRefund + disputerRefund;
        if (proposerRefund > 0) token.safeTransfer(proposer, proposerRefund);
        if (disputerRefund > 0) token.safeTransfer(disputer, disputerRefund);
        emit BondsReleased(market, proposerRefund, disputerRefund);
    }

    function _apply(address market, Verdict verdict) private {
        if (verdict == Verdict.Invalid) {
            IPredictionMarket(market).invalidate();
        } else {
            IPredictionMarket(market).resolve(
                verdict == Verdict.Yes ? IPredictionMarket.Outcome.Yes : IPredictionMarket.Outcome.No
            );
        }
    }
}
