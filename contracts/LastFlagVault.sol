// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title LastFlagVault
/// @notice Custodian for all player ETH deposits. Funds are held here until
///         the game contract triggers a payout distribution.
///         3% house fee is withheld on every payout.
contract LastFlagVault is Ownable, ReentrancyGuard, Pausable {
    // ─────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────
    uint256 public constant HOUSE_FEE_BPS   = 300;   // 3%
    uint256 public constant RESERVE_FEE_BPS = 100;   // 1% reserve for gas / VRF costs
    uint256 public constant BPS_DENOM       = 10_000;

    // ─────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────
    address public gameContract;          // only address allowed to trigger payouts
    address public houseWallet;           // receives 3% fee
    address public reserveWallet;         // receives 1% reserve

    uint256 public jackpot;               // running jackpot in wei
    uint256 public totalDeposited;
    uint256 public totalPaidOut;
    uint256 public roundId;

    mapping(address => uint256) public playerBalance;  // redeemable FC equiv in wei

    // ─────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────
    event Deposited(address indexed player, uint256 amount, uint256 roundId);
    event Payout(address indexed player, uint256 gross, uint256 net, uint256 roundId);
    event JackpotUpdated(uint256 newJackpot, uint256 roundId);
    event GameContractSet(address previous, address next);

    // ─────────────────────────────────────────────────────────
    //  MODIFIERS
    // ─────────────────────────────────────────────────────────
    modifier onlyGame() {
        require(msg.sender == gameContract, "Vault: caller is not game contract");
        _;
    }

    // ─────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────
    constructor(address _houseWallet, address _reserveWallet) Ownable(msg.sender) {
        require(_houseWallet != address(0) && _reserveWallet != address(0), "Vault: zero address");
        houseWallet   = _houseWallet;
        reserveWallet = _reserveWallet;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────
    function setGameContract(address _game) external onlyOwner {
        emit GameContractSet(gameContract, _game);
        gameContract = _game;
    }

    function setHouseWallet(address _hw) external onlyOwner {
        require(_hw != address(0), "Vault: zero address");
        houseWallet = _hw;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────
    //  DEPOSIT
    // ─────────────────────────────────────────────────────────
    /// @notice Players deposit ETH; value goes into the jackpot.
    function deposit() external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Vault: zero deposit");
        jackpot         += msg.value;
        totalDeposited  += msg.value;
        playerBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, roundId);
        emit JackpotUpdated(jackpot, roundId);
    }

    // ─────────────────────────────────────────────────────────
    //  PAYOUT  (called by game contract at round end)
    // ─────────────────────────────────────────────────────────
    /// @notice Distribute jackpot among winners. Array lengths must match.
    /// @param winners  Addresses of winning territory holders
    /// @param shares   Proportion (in basis points, must sum to 9600)
    function distributePayout(
        address[] calldata winners,
        uint256[] calldata shares
    ) external nonReentrant onlyGame whenNotPaused {
        require(winners.length == shares.length && winners.length > 0, "Vault: length mismatch");

        uint256 gross = jackpot;
        uint256 houseCut   = (gross * HOUSE_FEE_BPS) / BPS_DENOM;
        uint256 reserveCut = (gross * RESERVE_FEE_BPS) / BPS_DENOM;
        uint256 distributable = gross - houseCut - reserveCut;

        // Validate share sum = 10000 - 400 = 9600 bps of distributable
        uint256 shareSum;
        for (uint256 i; i < shares.length; i++) shareSum += shares[i];
        require(shareSum == BPS_DENOM, "Vault: shares must sum to 10000");

        // Send house + reserve cuts
        (bool h,) = houseWallet.call{value: houseCut}("");
        (bool r,) = reserveWallet.call{value: reserveCut}("");
        require(h && r, "Vault: fee transfer failed");

        // Pay winners
        for (uint256 i; i < winners.length; i++) {
            uint256 amount = (distributable * shares[i]) / BPS_DENOM;
            totalPaidOut += amount;
            emit Payout(winners[i], gross, amount, roundId);
            (bool ok,) = winners[i].call{value: amount}("");
            require(ok, "Vault: winner transfer failed");
        }

        jackpot = 0;
        roundId++;
        emit JackpotUpdated(0, roundId);
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW
    // ─────────────────────────────────────────────────────────
    function getJackpot() external view returns (uint256) { return jackpot; }
    function getRoundId() external view returns (uint256) { return roundId; }

    receive() external payable { jackpot += msg.value; }
}
