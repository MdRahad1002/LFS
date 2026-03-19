// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol";
import "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ILastFlagGame {
    function fulfillElimination(uint256 requestId, uint256 eliminatedTerritoryId) external;
}

/// @title LastFlagVRF
/// @notice Chainlink VRF v2 consumer. Requests randomness once per round,
///         maps the result to a living territory, and calls back the game contract.
///         Deploy one per chain; point to Chainlink's coordinator for that network.
contract LastFlagVRF is VRFConsumerBaseV2, Ownable {
    // ─────────────────────────────────────────────────────────
    //  CHAINLINK CONFIG  (values for Ethereum Mainnet — update per network)
    // ─────────────────────────────────────────────────────────
    VRFCoordinatorV2Interface immutable COORDINATOR;

    // Ethereum Mainnet coordinator: 0x271682DEB8C4E0901D1a1550aD2e64D568E69909
    // Polygon Mainnet:              0xAE975071Be8F8eE67addBC1A82488F1C24858067
    // Arbitrum One:                 0x41034678D6C633D8a95c75e1138A360a28bA15d1

    bytes32 public keyHash;        // gas lane key hash — 200 gwei lane on mainnet
    uint64  public subscriptionId; // Chainlink subscription ID
    uint32  public callbackGasLimit  = 200_000;
    uint16  public requestConfirmations = 3;
    uint32  public numWords = 1;   // one random word per elimination

    // ─────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────
    address public gameContract;

    struct RandomRequest {
        uint256 roundId;
        uint256[] livingTerritories;  // snapshot of living territories at request time
        bool fulfilled;
        uint256 result;               // mapped territory id
    }

    mapping(uint256 => RandomRequest) public requests;  // requestId => request

    // ─────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────
    event RandomnessRequested(uint256 indexed requestId, uint256 indexed roundId);
    event RandomnessFulfilled(
        uint256 indexed requestId,
        uint256 rawValue,
        uint256 eliminatedTerritoryId
    );

    // ─────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────
    constructor(
        address vrfCoordinator,
        bytes32 _keyHash,
        uint64  _subscriptionId
    ) VRFConsumerBaseV2(vrfCoordinator) Ownable(msg.sender) {
        COORDINATOR    = VRFCoordinatorV2Interface(vrfCoordinator);
        keyHash        = _keyHash;
        subscriptionId = _subscriptionId;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────
    function setGameContract(address _game) external onlyOwner {
        gameContract = _game;
    }

    function setKeyHash(bytes32 _kh)         external onlyOwner { keyHash = _kh; }
    function setSubscriptionId(uint64 _sid)  external onlyOwner { subscriptionId = _sid; }
    function setCallbackGasLimit(uint32 _g)  external onlyOwner { callbackGasLimit = _g; }
    function setConfirmations(uint16 _c)     external onlyOwner { requestConfirmations = _c; }

    // ─────────────────────────────────────────────────────────
    //  REQUEST RANDOMNESS
    // ─────────────────────────────────────────────────────────
    /// @notice Called by the game contract to request an elimination.
    /// @param roundId            Current game round ID.
    /// @param livingTerritories  Snapshot array of territory IDs still in play.
    /// @return requestId         Chainlink request ID for tracking.
    function requestElimination(
        uint256 roundId,
        uint256[] calldata livingTerritories
    ) external returns (uint256 requestId) {
        require(msg.sender == gameContract, "VRF: caller is not game");
        require(livingTerritories.length > 1, "VRF: need at least 2 territories");

        requestId = COORDINATOR.requestRandomWords(
            keyHash,
            subscriptionId,
            requestConfirmations,
            callbackGasLimit,
            numWords
        );

        requests[requestId] = RandomRequest({
            roundId:           roundId,
            livingTerritories: livingTerritories,
            fulfilled:         false,
            result:            0
        });

        emit RandomnessRequested(requestId, roundId);
    }

    // ─────────────────────────────────────────────────────────
    //  CHAINLINK CALLBACK
    // ─────────────────────────────────────────────────────────
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] memory randomWords
    ) internal override {
        RandomRequest storage req = requests[requestId];
        require(!req.fulfilled, "VRF: already fulfilled");

        uint256 raw  = randomWords[0];
        uint256 idx  = raw % req.livingTerritories.length;
        uint256 elimId = req.livingTerritories[idx];

        req.fulfilled = true;
        req.result    = elimId;

        emit RandomnessFulfilled(requestId, raw, elimId);

        // Notify game contract
        ILastFlagGame(gameContract).fulfillElimination(requestId, elimId);
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW
    // ─────────────────────────────────────────────────────────
    function getRequest(uint256 requestId)
        external view
        returns (uint256 roundId, bool fulfilled, uint256 result)
    {
        RandomRequest storage r = requests[requestId];
        return (r.roundId, r.fulfilled, r.result);
    }
}
