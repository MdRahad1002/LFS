// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol";
import "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title LotteryVault
/// @notice Weekly territory lottery. Players buy $20 tickets (priced in ETH via Chainlink price
///         feed) on any of the 195 world territories. After the round closes, Chainlink VRF
///         selects a winning territory weighted by ticket count. All ticket holders on the
///         winner territory split 97% of the jackpot proportionally to their ticket count.
///
/// @dev    Draw flow (trustless):
///         1. Owner calls requestDraw()  → Chainlink VRF request is sent.
///         2. Chainlink calls fulfillRandomWords()  → rawRandom stored, no ETH transfers.
///         3. Anyone calls finalizeWinner(roundId, claimedWinner)  → on-chain verification
///            proves the correct territory; winner + distributable amount locked.
///         4. Owner calls collectFees() once to claim house + reserve cut.
///         5. Winners call claimPayout() to pull their ETH share.
contract LotteryVault is VRFConsumerBaseV2, Ownable, ReentrancyGuard, Pausable {
    // ─────────────────────────────────────────────────────────────────────────
    //  CHAINLINK CONFIG
    //  Ethereum Mainnet VRF coordinator: 0x271682DEB8C4E0901D1a1550aD2e64D568E69909
    //  Sepolia testnet  VRF coordinator: 0x8103B0A8A00be2DDC778e6e7eaa21791Cd364625
    //  ETH/USD price feed (Mainnet):     0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
    //  ETH/USD price feed (Sepolia):     0x694AA1769357215DE4FAC081bf1f309aDC325306
    // ─────────────────────────────────────────────────────────────────────────
    VRFCoordinatorV2Interface immutable COORDINATOR;
    AggregatorV3Interface     immutable ETH_USD_FEED;

    bytes32 public keyHash;
    uint64  public subscriptionId;
    uint32  public callbackGasLimit     = 100_000; // Minimal: only stores rawRandom
    uint16  public requestConfirmations = 3;
    uint32  private constant NUM_WORDS  = 1;

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────
    uint256 public constant TICKET_PRICE_USD = 20;       // $20 per ticket
    uint256 public constant HOUSE_FEE_BPS    = 300;      // 3%
    uint256 public constant RESERVE_FEE_BPS  = 100;      // 1%
    uint256 public constant BPS_DENOM        = 10_000;
    uint8   public constant TERRITORY_COUNT  = 195;
    uint256 public constant PRICE_FEED_STALE = 1 hours;  // Reject stale oracle data
    uint256 public constant MAX_QTY_PER_TX   = 1_000;    // Anti-whale per tx

    // ─────────────────────────────────────────────────────────────────────────
    //  WALLETS
    // ─────────────────────────────────────────────────────────────────────────
    address public houseWallet;
    address public reserveWallet;

    // ─────────────────────────────────────────────────────────────────────────
    //  ROUND STATE
    // ─────────────────────────────────────────────────────────────────────────
    struct Round {
        uint256 startTime;
        uint256 endTime;
        uint256 jackpot;             // Total ETH deposited (wei)
        uint256 distributable;       // 97% of jackpot — set in finalizeWinner
        uint256 totalTickets;        // Running total across all territories
        uint8   winnerTerritoryId;   // 0 until finalized
        bool    drawRequested;
        bool    feesCollected;
    }

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;

    // territoryTickets[roundId][territoryId] = total tickets bought on that territory
    mapping(uint256 => mapping(uint8 => uint256)) public territoryTickets;

    // playerTickets[roundId][player][territoryId] = player's ticket count
    mapping(uint256 => mapping(address => mapping(uint8 => uint256))) public playerTickets;

    // hasClaimed[roundId][player]
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    // ─────────────────────────────────────────────────────────────────────────
    //  VRF STATE
    // ─────────────────────────────────────────────────────────────────────────
    struct DrawRequest {
        uint256 roundId;
        uint256 rawRandom;
        bool    fulfilled;
    }

    mapping(uint256 => DrawRequest) public drawRequests;   // requestId => request
    mapping(uint256 => uint256)     public roundVrfRequest; // roundId   => requestId

    // ─────────────────────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────────────────────
    event RoundCreated(uint256 indexed roundId, uint256 startTime, uint256 endTime);
    event TicketsPurchased(
        uint256 indexed roundId,
        address indexed buyer,
        uint8           territoryId,
        uint256         qty,
        uint256         paid
    );
    event DrawRequested(uint256 indexed roundId, uint256 vrfRequestId);
    event RandomnessReceived(uint256 indexed roundId, uint256 vrfRequestId, uint256 rawRandom);
    event WinnerFinalized(uint256 indexed roundId, uint8 winnerTerritoryId, uint256 jackpot);
    event PayoutClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event FeesCollected(uint256 indexed roundId, uint256 houseAmount, uint256 reserveAmount);

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────────────
    constructor(
        address vrfCoordinator,
        bytes32 _keyHash,
        uint64  _subscriptionId,
        address ethUsdFeed,
        address _houseWallet,
        address _reserveWallet
    ) VRFConsumerBaseV2(vrfCoordinator) Ownable(msg.sender) {
        require(_houseWallet   != address(0), "Lottery: zero house wallet");
        require(_reserveWallet != address(0), "Lottery: zero reserve wallet");
        COORDINATOR    = VRFCoordinatorV2Interface(vrfCoordinator);
        ETH_USD_FEED   = AggregatorV3Interface(ethUsdFeed);
        keyHash        = _keyHash;
        subscriptionId = _subscriptionId;
        houseWallet    = _houseWallet;
        reserveWallet  = _reserveWallet;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ROUND MANAGEMENT (owner)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create a new lottery round open for ticket purchases.
    /// @param durationSeconds  How long the ticket window stays open (min 60s).
    /// @return roundId         The newly created round ID.
    function createRound(uint256 durationSeconds)
        external
        onlyOwner
        returns (uint256 roundId)
    {
        require(durationSeconds >= 60, "Lottery: duration too short");
        roundId = ++currentRoundId;
        rounds[roundId] = Round({
            startTime:        block.timestamp,
            endTime:          block.timestamp + durationSeconds,
            jackpot:          0,
            distributable:    0,
            totalTickets:     0,
            winnerTerritoryId: 0,
            drawRequested:    false,
            feesCollected:    false
        });
        emit RoundCreated(roundId, block.timestamp, block.timestamp + durationSeconds);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TICKET PRICE ORACLE
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Current ticket price in wei, derived from Chainlink ETH/USD feed.
    ///         Price = TICKET_PRICE_USD * 1e26 / feedPrice  (feed has 8 decimals).
    function ticketPriceWei() public view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = ETH_USD_FEED.latestRoundData();
        require(price > 0, "Lottery: invalid price feed");
        require(block.timestamp - updatedAt <= PRICE_FEED_STALE, "Lottery: stale price feed");
        return (TICKET_PRICE_USD * 1e26) / uint256(price);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  BUY TICKETS
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Purchase `qty` tickets on `territoryId` for the given open round.
    ///         Overpayment is refunded. More tickets on a territory = higher win odds.
    /// @param roundId      The active lottery round ID.
    /// @param territoryId  Territory number 1–195.
    /// @param qty          Number of tickets (1–1000 per transaction).
    function buyTickets(uint256 roundId, uint8 territoryId, uint256 qty)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        require(roundId > 0 && roundId <= currentRoundId, "Lottery: invalid round");
        require(territoryId >= 1 && territoryId <= TERRITORY_COUNT, "Lottery: invalid territory");
        require(qty >= 1 && qty <= MAX_QTY_PER_TX, "Lottery: qty out of range");

        Round storage r = rounds[roundId];
        require(block.timestamp < r.endTime, "Lottery: round closed");
        require(!r.drawRequested,            "Lottery: draw already initiated");

        uint256 unitPrice = ticketPriceWei();
        uint256 required  = unitPrice * qty;
        require(msg.value >= required, "Lottery: insufficient ETH sent");

        // ── Effects ───────────────────────────────────────────────────────────
        territoryTickets[roundId][territoryId]              += qty;
        playerTickets[roundId][msg.sender][territoryId]     += qty;
        r.jackpot      += required;
        r.totalTickets += qty;

        emit TicketsPurchased(roundId, msg.sender, territoryId, qty, required);

        // ── Refund overpayment ────────────────────────────────────────────────
        uint256 excess = msg.value - required;
        if (excess > 0) {
            (bool ok, ) = msg.sender.call{value: excess}("");
            require(ok, "Lottery: refund failed");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  REQUEST DRAW (owner)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Request a Chainlink VRF random word to determine the winner.
    ///         Must be called after the round has ended and has at least 1 ticket.
    function requestDraw(uint256 roundId) external onlyOwner whenNotPaused {
        Round storage r = rounds[roundId];
        require(roundId > 0 && roundId <= currentRoundId, "Lottery: invalid round");
        require(block.timestamp >= r.endTime,  "Lottery: round still open");
        require(!r.drawRequested,              "Lottery: draw already requested");
        require(r.totalTickets > 0,            "Lottery: no tickets sold");

        r.drawRequested = true;

        uint256 requestId = COORDINATOR.requestRandomWords(
            keyHash,
            subscriptionId,
            requestConfirmations,
            callbackGasLimit,
            NUM_WORDS
        );

        drawRequests[requestId] = DrawRequest({
            roundId:   roundId,
            rawRandom: 0,
            fulfilled: false
        });
        roundVrfRequest[roundId] = requestId;

        emit DrawRequested(roundId, requestId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VRF CALLBACK  (internal — minimal work, no ETH transfers)
    // ─────────────────────────────────────────────────────────────────────────
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords)
        internal
        override
    {
        DrawRequest storage req = drawRequests[requestId];
        require(!req.fulfilled, "Lottery: already fulfilled");
        req.fulfilled = true;
        req.rawRandom = randomWords[0];
        emit RandomnessReceived(req.roundId, requestId, randomWords[0]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FINALIZE WINNER  (trustless — anyone can call after VRF fulfillment)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Verify and record the winning territory.
    ///         The result is fully provable: the winning ticket index is
    ///         rawRandom % totalTickets, and claimedWinner is the territory
    ///         whose cumulative ticket range contains that index.
    ///         Anyone can submit; if the claim is wrong, the tx reverts.
    /// @param roundId        The round to finalize.
    /// @param claimedWinner  Territory ID the caller asserts is the winner.
    function finalizeWinner(uint256 roundId, uint8 claimedWinner)
        external
        nonReentrant
    {
        Round storage r = rounds[roundId];
        require(r.drawRequested,          "Lottery: draw not yet requested");
        require(r.winnerTerritoryId == 0, "Lottery: already finalized");

        uint256 requestId = roundVrfRequest[roundId];
        DrawRequest storage req = drawRequests[requestId];
        require(req.fulfilled, "Lottery: VRF not yet fulfilled");

        require(claimedWinner >= 1 && claimedWinner <= TERRITORY_COUNT, "Lottery: invalid territory");
        require(territoryTickets[roundId][claimedWinner] > 0,           "Lottery: no tickets on territory");

        // Winning ticket index in range [0, totalTickets - 1]
        uint256 ticketIndex = req.rawRandom % r.totalTickets;

        // Compute cumulative tickets for territories 1..(claimedWinner - 1)
        uint256 lowerBound = 0;
        for (uint8 i = 1; i < claimedWinner; i++) {
            lowerBound += territoryTickets[roundId][i];
        }

        // Verify claimedWinner owns the winning ticket slot
        require(lowerBound <= ticketIndex,                                              "Lottery: lower bound violated");
        require(lowerBound + territoryTickets[roundId][claimedWinner] > ticketIndex,   "Lottery: upper bound violated");

        // Lock in winner and compute distributable amount (97% of jackpot)
        r.winnerTerritoryId = claimedWinner;
        uint256 houseCut   = (r.jackpot * HOUSE_FEE_BPS)   / BPS_DENOM;
        uint256 reserveCut = (r.jackpot * RESERVE_FEE_BPS) / BPS_DENOM;
        r.distributable    = r.jackpot - houseCut - reserveCut;

        emit WinnerFinalized(roundId, claimedWinner, r.jackpot);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  COLLECT HOUSE FEES  (owner, once per finalized round)
    // ─────────────────────────────────────────────────────────────────────────
    function collectFees(uint256 roundId) external onlyOwner nonReentrant {
        Round storage r = rounds[roundId];
        require(r.winnerTerritoryId != 0, "Lottery: round not finalized");
        require(!r.feesCollected,         "Lottery: fees already collected");

        r.feesCollected = true;

        uint256 houseCut   = (r.jackpot * HOUSE_FEE_BPS)   / BPS_DENOM;
        uint256 reserveCut = (r.jackpot * RESERVE_FEE_BPS) / BPS_DENOM;

        (bool h,  ) = houseWallet.call{value: houseCut}("");
        (bool rv, ) = reserveWallet.call{value: reserveCut}("");
        require(h && rv, "Lottery: fee transfer failed");

        emit FeesCollected(roundId, houseCut, reserveCut);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CLAIM PAYOUT  (pull pattern — winners call this)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Winning players call this to receive their share of the jackpot.
    ///         Share = distributable * (myTickets / totalWinnerTerrTickets).
    function claimPayout(uint256 roundId) external nonReentrant whenNotPaused {
        Round storage r = rounds[roundId];
        require(r.winnerTerritoryId != 0,            "Lottery: not yet finalized");
        require(!hasClaimed[roundId][msg.sender],     "Lottery: already claimed");

        uint8   winner    = r.winnerTerritoryId;
        uint256 myTickets = playerTickets[roundId][msg.sender][winner];
        require(myTickets > 0, "Lottery: no winning tickets");

        // ── Effects before interactions (CEI pattern) ─────────────────────────
        hasClaimed[roundId][msg.sender] = true;

        uint256 winnerTotal = territoryTickets[roundId][winner];
        uint256 payout      = (r.distributable * myTickets) / winnerTotal;

        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "Lottery: payout transfer failed");

        emit PayoutClaimed(roundId, msg.sender, payout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ADMIN SETTERS
    // ─────────────────────────────────────────────────────────────────────────
    function setHouseWallet(address _hw) external onlyOwner {
        require(_hw != address(0), "Lottery: zero address");
        houseWallet = _hw;
    }
    function setReserveWallet(address _rv) external onlyOwner {
        require(_rv != address(0), "Lottery: zero address");
        reserveWallet = _rv;
    }
    function setKeyHash(bytes32 _kh)        external onlyOwner { keyHash = _kh; }
    function setSubscriptionId(uint64 _sid) external onlyOwner { subscriptionId = _sid; }
    function setCallbackGasLimit(uint32 _g) external onlyOwner { callbackGasLimit = _g; }
    function setConfirmations(uint16 _c)    external onlyOwner { requestConfirmations = _c; }
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────────────────────────
    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function getPlayerTickets(uint256 roundId, address player, uint8 territoryId)
        external view returns (uint256)
    {
        return playerTickets[roundId][player][territoryId];
    }

    function getTerritoryTickets(uint256 roundId, uint8 territoryId)
        external view returns (uint256)
    {
        return territoryTickets[roundId][territoryId];
    }
}
