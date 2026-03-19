// scripts/deploy.js
// npx hardhat run scripts/deploy.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;

// ── CHAINLINK VRF v2 ADDRESSES ──────────────────────────────
// Update for target network:
// Ethereum Mainnet:    coordinator = 0x271682DEB8C4E0901D1a1550aD2e64D568E69909
//                      keyHash     = 0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805
// Sepolia Testnet:     coordinator = 0x8103B0A8A00be2DDC778e6e7eaa21791Cd364625
//                      keyHash     = 0x474e34a077df58807dbe9c96d3c009b23b3c6d0cce433e59bbf5b34f823bc56c
const VRF_CONFIG = {
  coordinator: process.env.VRF_COORDINATOR || "0x8103B0A8A00be2DDC778e6e7eaa21791Cd364625",
  keyHash:     process.env.VRF_KEY_HASH    || "0x474e34a077df58807dbe9c96d3c009b23b3c6d0cce433e59bbf5b34f823bc56c",
  subId:       process.env.VRF_SUB_ID      || "0",   // create at https://vrf.chain.link
};

const HOUSE_WALLET   = process.env.HOUSE_WALLET   || ethers.ZeroAddress;
const RESERVE_WALLET = process.env.RESERVE_WALLET || ethers.ZeroAddress;
const TERRITORY_URI  = process.env.TERRITORY_URI  || "https://api.lastflagstanding.io/metadata/";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n🚩 LAST FLAG STANDING — Contract Deployment");
  console.log("   Deployer:", deployer.address);
  console.log("   Network: ", hre.network.name);
  console.log("   Balance: ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ── 1. Vault ──────────────────────────────────────────────
  console.log("1/5  Deploying LastFlagVault...");
  const Vault = await ethers.getContractFactory("LastFlagVault");
  const vault = await Vault.deploy(HOUSE_WALLET, RESERVE_WALLET);
  await vault.waitForDeployment();
  console.log("     ✓ Vault:", await vault.getAddress());

  // ── 2. Territory Token ────────────────────────────────────
  console.log("2/5  Deploying TerritoryToken...");
  const Territory = await ethers.getContractFactory("TerritoryToken");
  const territory = await Territory.deploy(TERRITORY_URI);
  await territory.waitForDeployment();
  console.log("     ✓ Territory:", await territory.getAddress());

  // ── 3. VRF Consumer ───────────────────────────────────────
  console.log("3/5  Deploying LastFlagVRF...");
  const VRF = await ethers.getContractFactory("LastFlagVRF");
  const vrf = await VRF.deploy(VRF_CONFIG.coordinator, VRF_CONFIG.keyHash, VRF_CONFIG.subId);
  await vrf.waitForDeployment();
  console.log("     ✓ VRF:      ", await vrf.getAddress());

  // ── 4. Market ─────────────────────────────────────────────
  console.log("4/5  Deploying TerritoryMarket...");
  const Market = await ethers.getContractFactory("TerritoryMarket");
  const market = await Market.deploy(await territory.getAddress(), HOUSE_WALLET);
  await market.waitForDeployment();
  console.log("     ✓ Market:   ", await market.getAddress());

  // ── 5. Alliance Vault ─────────────────────────────────────
  console.log("5/5  Deploying AllianceVault...");
  const Alliance = await ethers.getContractFactory("AllianceVault");
  const alliance = await Alliance.deploy();
  await alliance.waitForDeployment();
  console.log("     ✓ Alliance: ", await alliance.getAddress());

  // ── Wire contracts ────────────────────────────────────────
  console.log("\n     Wiring contracts...");
  // NOTE: Game contract address (server-side orchestrator) set after server deploy.
  //       For now, set deployer as placeholder — update via setGameContract() after.
  await territory.setGameContract(deployer.address);
  await vrf.setGameContract(deployer.address);
  await alliance.setGameContract(deployer.address);
  console.log("     ✓ Game contract placeholder set to deployer");

  // ── Summary ───────────────────────────────────────────────
  const addresses = {
    vault:     await vault.getAddress(),
    territory: await territory.getAddress(),
    vrf:       await vrf.getAddress(),
    market:    await market.getAddress(),
    alliance:  await alliance.getAddress(),
  };

  console.log("\n✅  Deployment complete. Add these to your .env:\n");
  console.log(`CONTRACT_VAULT=${addresses.vault}`);
  console.log(`CONTRACT_TERRITORY=${addresses.territory}`);
  console.log(`CONTRACT_VRF=${addresses.vrf}`);
  console.log(`CONTRACT_MARKET=${addresses.market}`);
  console.log(`CONTRACT_ALLIANCE=${addresses.alliance}`);
  console.log("");

  // ── Verify on Etherscan ───────────────────────────────────
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("     Waiting 30s for Etherscan indexing...");
    await new Promise(r => setTimeout(r, 30_000));

    for (const [name, addr] of Object.entries(addresses)) {
      try {
        await hre.run("verify:verify", { address: addr, constructorArguments: [] });
        console.log(`     ✓ ${name} verified`);
      } catch (e) {
        console.log(`     ✗ ${name} verification failed:`, e.message);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
