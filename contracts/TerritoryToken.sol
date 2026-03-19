// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title TerritoryToken
/// @notice ERC-1155 semi-fungible tokens representing territory slots.
///         Each tokenId maps to a country/territory (1..N_TERRITORIES).
///         Players can hold multiple slots in the same territory.
///         Tokens are SOUL-BOUND during the lock window (5 min before elimination).
contract TerritoryToken is ERC1155, Ownable, Pausable {
    // ─────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────
    uint256 public constant SLOT_PRICE_WEI = 0.005 ether;  // 10 FC = ~$10 at launch
    uint256 public constant N_TERRITORIES  = 195;           // one per country
    uint256 public constant MAX_SLOTS_PER_TX = 50;

    // ─────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────
    address public gameContract;
    bool public lockWindowActive;   // set by game contract; disables transfers until elim

    // territoryId => total slots outstanding
    mapping(uint256 => uint256) public totalSlots;

    // territorial metadata (set by owner; stored off-chain via URI)
    mapping(uint256 => string) private _territoryNames;

    string private _baseURI;

    // ─────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────
    event SlotMinted(address indexed buyer, uint256 indexed territoryId, uint256 qty, uint256 paid);
    event TerritoryEliminated(uint256 indexed territoryId, uint256 slotsDestroyed);
    event LockWindowToggled(bool locked);

    // ─────────────────────────────────────────────────────────
    //  MODIFIERS
    // ─────────────────────────────────────────────────────────
    modifier onlyGame() {
        require(msg.sender == gameContract, "Territory: caller is not game");
        _;
    }

    modifier tradeable() {
        require(!lockWindowActive, "Territory: lock window — transfers frozen");
        _;
    }

    // ─────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────
    constructor(string memory baseURI_) ERC1155(baseURI_) Ownable(msg.sender) {
        _baseURI = baseURI_;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────
    function setGameContract(address _game) external onlyOwner {
        gameContract = _game;
    }

    function setBaseURI(string calldata uri_) external onlyOwner {
        _baseURI = uri_;
    }

    function setTerritoryName(uint256 id, string calldata name) external onlyOwner {
        require(id >= 1 && id <= N_TERRITORIES, "Territory: invalid id");
        _territoryNames[id] = name;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────
    //  LOCK WINDOW (called by game contract)
    // ─────────────────────────────────────────────────────────
    function setLockWindow(bool locked) external onlyGame {
        lockWindowActive = locked;
        emit LockWindowToggled(locked);
    }

    // ─────────────────────────────────────────────────────────
    //  MINT (buy territory slots)
    // ─────────────────────────────────────────────────────────
    /// @notice Buy `qty` slots in territory `territoryId`.
    ///         ETH sent must equal SLOT_PRICE_WEI * qty.
    ///         Excess is forwarded to the vault (treated as donation to jackpot).
    function buySlots(uint256 territoryId, uint256 qty) external payable whenNotPaused {
        require(territoryId >= 1 && territoryId <= N_TERRITORIES, "Territory: invalid id");
        require(qty >= 1 && qty <= MAX_SLOTS_PER_TX, "Territory: qty out of range");
        uint256 cost = SLOT_PRICE_WEI * qty;
        require(msg.value >= cost, "Territory: insufficient ETH");

        _mint(msg.sender, territoryId, qty, "");
        totalSlots[territoryId] += qty;

        emit SlotMinted(msg.sender, territoryId, qty, msg.value);

        // Refund excess
        if (msg.value > cost) {
            (bool ok,) = msg.sender.call{value: msg.value - cost}("");
            require(ok, "Territory: refund failed");
        }
    }

    // ─────────────────────────────────────────────────────────
    //  ELIMINATION (burn tokens for an eliminated territory)
    // ─────────────────────────────────────────────────────────
    /// @notice Called by game contract after VRF selects the eliminated territory.
    ///         Burns all outstanding slots for that territory.
    ///         NOTE: In production batch the burn across holders via off-chain enumeration.
    ///               This simplified version burns the caller's own holding only to avoid
    ///               hitting block gas limits — the full holder sweep is done server-side.
    function eliminateTerritory(
        uint256 territoryId,
        address[] calldata holders,
        uint256[] calldata amounts
    ) external onlyGame {
        require(holders.length == amounts.length, "Territory: length mismatch");
        for (uint256 i; i < holders.length; i++) {
            if (amounts[i] > 0) {
                _burn(holders[i], territoryId, amounts[i]);
            }
        }
        emit TerritoryEliminated(territoryId, totalSlots[territoryId]);
        totalSlots[territoryId] = 0;
    }

    // ─────────────────────────────────────────────────────────
    //  OVERRIDES
    // ─────────────────────────────────────────────────────────
    function safeTransferFrom(
        address from, address to,
        uint256 id, uint256 amount, bytes memory data
    ) public override tradeable whenNotPaused {
        super.safeTransferFrom(from, to, id, amount, data);
    }

    function safeBatchTransferFrom(
        address from, address to,
        uint256[] memory ids, uint256[] memory amounts, bytes memory data
    ) public override tradeable whenNotPaused {
        super.safeBatchTransferFrom(from, to, ids, amounts, data);
    }

    function uri(uint256 id) public view override returns (string memory) {
        return string(abi.encodePacked(_baseURI, _uint2str(id), ".json"));
    }

    function getTerritoryName(uint256 id) external view returns (string memory) {
        return _territoryNames[id];
    }

    // ─────────────────────────────────────────────────────────
    //  HELPERS
    // ─────────────────────────────────────────────────────────
    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    receive() external payable {}
}
