// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// @title TerritoryMarket
/// @notice Fixed-price P2P listing order book for territory slots.
///         Sellers list slots → buyers fill at listed price.
///         2% market fee deducted from seller proceeds.
///         Transfers are blocked during the lock window (handled by TerritoryToken).
contract TerritoryMarket is Ownable, ReentrancyGuard, Pausable, ERC1155Holder {
    // ─────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────
    uint256 public constant MARKET_FEE_BPS = 200;  // 2%
    uint256 public constant BPS_DENOM      = 10_000;

    // ─────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────
    IERC1155 public immutable territory;
    address  public houseWallet;

    uint256 public nextListingId = 1;

    struct Listing {
        address seller;
        uint256 territoryId;
        uint256 qty;           // slots remaining in this listing
        uint256 pricePerSlot;  // wei per slot
        bool    active;
    }

    mapping(uint256 => Listing) public listings;

    // Seller => listingId[] for easy enumeration off-chain
    mapping(address => uint256[]) public sellerListings;

    // ─────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────
    event Listed(uint256 indexed listingId, address indexed seller, uint256 territoryId, uint256 qty, uint256 pricePerSlot);
    event Filled(uint256 indexed listingId, address indexed buyer, uint256 qty, uint256 paid);
    event Cancelled(uint256 indexed listingId, address indexed seller);
    event PriceUpdated(uint256 indexed listingId, uint256 oldPrice, uint256 newPrice);

    // ─────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────
    constructor(address _territory, address _houseWallet) Ownable(msg.sender) {
        territory   = IERC1155(_territory);
        houseWallet = _houseWallet;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────
    function setHouseWallet(address _hw) external onlyOwner {
        require(_hw != address(0), "Market: zero address");
        houseWallet = _hw;
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────
    //  LIST
    // ─────────────────────────────────────────────────────────
    /// @notice Escrow `qty` slots from territoryId into this contract and create a listing.
    function list(uint256 territoryId, uint256 qty, uint256 pricePerSlot)
        external whenNotPaused nonReentrant returns (uint256 listingId)
    {
        require(qty > 0, "Market: qty = 0");
        require(pricePerSlot > 0, "Market: price = 0");

        // Transfer slots from seller to market escrow
        territory.safeTransferFrom(msg.sender, address(this), territoryId, qty, "");

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller:       msg.sender,
            territoryId:  territoryId,
            qty:          qty,
            pricePerSlot: pricePerSlot,
            active:       true
        });
        sellerListings[msg.sender].push(listingId);

        emit Listed(listingId, msg.sender, territoryId, qty, pricePerSlot);
    }

    // ─────────────────────────────────────────────────────────
    //  BUY
    // ─────────────────────────────────────────────────────────
    /// @notice Buy `qty` slots from an active listing.
    function buy(uint256 listingId, uint256 qty)
        external payable whenNotPaused nonReentrant
    {
        Listing storage l = listings[listingId];
        require(l.active, "Market: listing not active");
        require(qty > 0 && qty <= l.qty, "Market: qty out of range");

        uint256 total    = l.pricePerSlot * qty;
        require(msg.value >= total, "Market: insufficient ETH");

        // Fee calc
        uint256 fee      = (total * MARKET_FEE_BPS) / BPS_DENOM;
        uint256 proceeds = total - fee;

        l.qty -= qty;
        if (l.qty == 0) l.active = false;

        // Transfer tokens from escrow to buyer
        territory.safeTransferFrom(address(this), msg.sender, l.territoryId, qty, "");

        // Pay seller + house
        (bool s,) = l.seller.call{value: proceeds}("");
        (bool h,) = houseWallet.call{value: fee}("");
        require(s && h, "Market: payment failed");

        // Refund excess ETH
        if (msg.value > total) {
            (bool r,) = msg.sender.call{value: msg.value - total}("");
            require(r, "Market: refund failed");
        }

        emit Filled(listingId, msg.sender, qty, total);
    }

    // ─────────────────────────────────────────────────────────
    //  CANCEL
    // ─────────────────────────────────────────────────────────
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "Market: already inactive");
        require(l.seller == msg.sender || msg.sender == owner(), "Market: not seller");

        l.active = false;
        territory.safeTransferFrom(address(this), l.seller, l.territoryId, l.qty, "");
        emit Cancelled(listingId, l.seller);
    }

    // ─────────────────────────────────────────────────────────
    //  UPDATE PRICE
    // ─────────────────────────────────────────────────────────
    function updatePrice(uint256 listingId, uint256 newPrice) external {
        Listing storage l = listings[listingId];
        require(l.active, "Market: listing not active");
        require(l.seller == msg.sender, "Market: not seller");
        require(newPrice > 0, "Market: zero price");
        emit PriceUpdated(listingId, l.pricePerSlot, newPrice);
        l.pricePerSlot = newPrice;
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW
    // ─────────────────────────────────────────────────────────
    function getListing(uint256 id)
        external view
        returns (address seller, uint256 territoryId, uint256 qty, uint256 pricePerSlot, bool active)
    {
        Listing storage l = listings[id];
        return (l.seller, l.territoryId, l.qty, l.pricePerSlot, l.active);
    }

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return sellerListings[seller];
    }

    /// @dev Required for ERC1155Holder
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155Holder)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
