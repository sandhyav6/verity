// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestToken
/// @notice SIMULATED TEST CREDIT. It has NO monetary value, is not INR or any currency,
///         cannot be bought, sold, redeemed for money, goods or services, and exists only
///         to exercise a prediction-market simulation on a local or test network.
/// @dev Supply and minting:
///      - Hard cap `MAX_SUPPLY`, enforced on every mint.
///      - Anyone may call `faucet()` for `FAUCET_AMOUNT`, once per `FAUCET_COOLDOWN` per address.
///        The faucet can be sybil-farmed with many addresses; that is accepted because the token
///        is valueless.
///      - The owner may `adminMint` (e.g. to fund market creators) until `renounceMinting()`.
///      Transfers are RESTRICTED: a transfer must involve the factory or a registered market on
///      at least one side. There are no peer-to-peer transfers. Registered markets may pull tokens
///      without a per-market approval (implicit allowance); this is non-standard but safe because
///      only factory-deployed market clones of one fixed implementation (plus the factory and the
///      ResolutionManager, which escrows oracle bonds) can be privileged.
///      Whether these restrictions are legally sufficient is NOT established; legal review required.
contract TestToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    address public factory;
    /// @notice The ResolutionManager holds oracle bonds, so it is allowed to move tokens like the factory.
    address public resolutionManager;
    bool public mintingRenounced;
    mapping(address => bool) public isMarket;
    mapping(address => uint256) public lastFaucetClaim;

    event FaucetClaimed(address indexed account, uint256 amount);
    event FactorySet(address indexed factory);
    event ResolutionManagerSet(address indexed resolutionManager);
    event MarketRegistered(address indexed market);
    event MintingRenounced();

    error FaucetCooldown(uint256 availableAt);
    error MintingDisabled();
    error SupplyCapExceeded();
    error TransferRestricted();
    error FactoryAlreadySet();
    error ResolutionManagerAlreadySet();
    error NotFactory();
    error ZeroAddress();

    constructor(address initialOwner) ERC20("TEST Credit (no monetary value)", "TESTCR") Ownable(initialOwner) {}

    /// @notice Claim `FAUCET_AMOUNT` test credits (rate limited per address).
    function faucet() external {
        uint256 last = lastFaucetClaim[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner-controlled minting, used to fund market creators. Disabled after renounce.
    function adminMint(address to, uint256 amount) external onlyOwner {
        if (mintingRenounced) revert MintingDisabled();
        _mint(to, amount);
    }

    /// @notice Permanently disables `adminMint`. The faucet keeps working.
    function renounceMinting() external onlyOwner {
        mintingRenounced = true;
        emit MintingRenounced();
    }

    /// @notice One-time wiring of the MarketFactory.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice One-time wiring of the ResolutionManager (it escrows oracle bonds in test tokens).
    function setResolutionManager(address resolutionManager_) external onlyOwner {
        if (resolutionManager != address(0)) revert ResolutionManagerAlreadySet();
        if (resolutionManager_ == address(0)) revert ZeroAddress();
        resolutionManager = resolutionManager_;
        emit ResolutionManagerSet(resolutionManager_);
    }

    /// @notice Called by the factory for every market clone it deploys.
    function registerMarket(address market) external {
        if (msg.sender != factory) revert NotFactory();
        isMarket[market] = true;
        emit MarketRegistered(market);
    }

    function _isPrivileged(address account) internal view returns (bool) {
        return account == factory || account == resolutionManager || isMarket[account];
    }

    /// @inheritdoc ERC20
    function allowance(address owner_, address spender) public view override returns (uint256) {
        if (_isPrivileged(spender)) return type(uint256).max;
        return super.allowance(owner_, spender);
    }

    function _spendAllowance(address owner_, address spender, uint256 value) internal override {
        if (_isPrivileged(spender)) return;
        super._spendAllowance(owner_, spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            if (totalSupply() + value > MAX_SUPPLY) revert SupplyCapExceeded();
        } else if (!_isPrivileged(from) && !_isPrivileged(to)) {
            revert TransferRestricted();
        }
        super._update(from, to, value);
    }
}
