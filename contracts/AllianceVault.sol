// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title AllianceVault
/// @notice Manages alliance membership, bonuses, and jackpot share distribution.
///         Max 8 members per alliance. Alliance leader earns an extra 0.5% of winnings.
///         All alliance bonuses are funded from the house's 3% fee share.
contract AllianceVault is Ownable, ReentrancyGuard {
    // ─────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────
    uint256 public constant MAX_MEMBERS  = 8;
    uint256 public constant BONUS_BPS    = 500;   // 5% of member's winnings shared to alliance
    uint256 public constant LEADER_EXTRA = 50;    // +0.5% for leader
    uint256 public constant BPS_DENOM    = 10_000;

    // ─────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────
    address public gameContract;

    struct Alliance {
        string  name;
        address leader;
        address[] members;
        uint256 totalWinnings;  // lifetime ETH won
        bool    active;
    }

    mapping(bytes32 => Alliance) public alliances;  // keccak256(name) => Alliance
    mapping(address => bytes32)  public memberOf;   // wallet => alliance key

    bytes32[] public allianceKeys;

    // ─────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────
    event AllianceCreated(bytes32 indexed key, string name, address leader);
    event MemberJoined(bytes32 indexed key, address member);
    event MemberLeft(bytes32 indexed key, address member);
    event BonusDistributed(bytes32 indexed key, uint256 amount);

    // ─────────────────────────────────────────────────────────
    //  MODIFIERS
    // ─────────────────────────────────────────────────────────
    modifier onlyGame() {
        require(msg.sender == gameContract, "Alliance: caller is not game");
        _;
    }

    // ─────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {}

    // ─────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────
    function setGameContract(address _game) external onlyOwner {
        gameContract = _game;
    }

    // ─────────────────────────────────────────────────────────
    //  ALLIANCE MANAGEMENT
    // ─────────────────────────────────────────────────────────
    function createAlliance(string calldata name) external {
        require(memberOf[msg.sender] == bytes32(0), "Alliance: already in one");
        bytes32 key = keccak256(abi.encodePacked(name));
        require(!alliances[key].active, "Alliance: name taken");

        alliances[key].name   = name;
        alliances[key].leader = msg.sender;
        alliances[key].active = true;
        alliances[key].members.push(msg.sender);
        memberOf[msg.sender] = key;
        allianceKeys.push(key);

        emit AllianceCreated(key, name, msg.sender);
        emit MemberJoined(key, msg.sender);
    }

    function joinAlliance(bytes32 key) external {
        require(memberOf[msg.sender] == bytes32(0), "Alliance: already in one");
        Alliance storage a = alliances[key];
        require(a.active, "Alliance: not found");
        require(a.members.length < MAX_MEMBERS, "Alliance: full");

        a.members.push(msg.sender);
        memberOf[msg.sender] = key;

        emit MemberJoined(key, msg.sender);
    }

    function leaveAlliance() external {
        bytes32 key = memberOf[msg.sender];
        require(key != bytes32(0), "Alliance: not in one");

        Alliance storage a = alliances[key];

        // Remove from members array
        address[] storage m = a.members;
        for (uint256 i; i < m.length; i++) {
            if (m[i] == msg.sender) {
                m[i] = m[m.length - 1];
                m.pop();
                break;
            }
        }

        // If leader left, promote first remaining member
        if (a.leader == msg.sender && m.length > 0) {
            a.leader = m[0];
        }

        if (m.length == 0) a.active = false;

        memberOf[msg.sender] = bytes32(0);
        emit MemberLeft(key, msg.sender);
    }

    // ─────────────────────────────────────────────────────────
    //  BONUS DISTRIBUTION  (called by game contract)
    // ─────────────────────────────────────────────────────────
    /// @notice Distribute alliance bonus pot equally among surviving members.
    function distributeBonuses(
        bytes32[] calldata keys,
        uint256[] calldata amounts
    ) external payable onlyGame nonReentrant {
        require(keys.length == amounts.length, "Alliance: length mismatch");

        uint256 totalNeeded;
        for (uint256 i; i < amounts.length; i++) totalNeeded += amounts[i];
        require(msg.value >= totalNeeded, "Alliance: insufficient ETH");

        for (uint256 i; i < keys.length; i++) {
            Alliance storage a = alliances[keys[i]];
            if (!a.active || a.members.length == 0) continue;

            uint256 share = amounts[i] / a.members.length;
            a.totalWinnings += amounts[i];

            for (uint256 j; j < a.members.length; j++) {
                (bool ok,) = a.members[j].call{value: share}("");
                require(ok, "Alliance: transfer failed");
            }
            emit BonusDistributed(keys[i], amounts[i]);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW
    // ─────────────────────────────────────────────────────────
    function getAlliance(bytes32 key)
        external view
        returns (string memory name, address leader, address[] memory members, uint256 totalWinnings, bool active)
    {
        Alliance storage a = alliances[key];
        return (a.name, a.leader, a.members, a.totalWinnings, a.active);
    }

    function getMemberAlliance(address wallet) external view returns (bytes32) {
        return memberOf[wallet];
    }
}
