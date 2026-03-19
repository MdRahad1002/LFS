require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../.env" });

const PRIV_KEY   = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "";
const ETHERSCAN   = process.env.ETHERSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },

  networks: {
    // ── Local dev ──────────────────────────────────────────
    hardhat: {
      forking: ALCHEMY_KEY
        ? { url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, blockNumber: 21_000_000 }
        : undefined,
      chainId: 31337,
    },

    // ── Testnets ───────────────────────────────────────────
    sepolia: {
      url: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      accounts: [PRIV_KEY],
      chainId: 11155111,
      gasPrice: "auto",
    },
    "polygon-amoy": {
      url: `https://polygon-amoy.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      accounts: [PRIV_KEY],
      chainId: 80002,
    },
    "arbitrum-sepolia": {
      url: `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      accounts: [PRIV_KEY],
      chainId: 421614,
    },

    // ── Mainnet ────────────────────────────────────────────
    mainnet: {
      url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      accounts: [PRIV_KEY],
      chainId: 1,
      gasPrice: "auto",
    },
    arbitrum: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      accounts: [PRIV_KEY],
      chainId: 42161,
    },
  },

  etherscan: {
    apiKey: {
      mainnet:          ETHERSCAN,
      sepolia:          ETHERSCAN,
      arbitrumOne:      process.env.ARBISCAN_API_KEY || "",
      polygon:          process.env.POLYGONSCAN_API_KEY || "",
    },
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.CMC_API_KEY || "",
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};
