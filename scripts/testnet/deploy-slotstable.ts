/**
 * Incremental testnet deploy — adds SlotsTable to the EXISTING Arbitrum
 * Sepolia stack. Does NOT touch any already-deployed game.
 *
 *   npx hardhat run scripts/testnet/deploy-slotstable.ts --network arbitrumSepolia
 *
 * Prerequisites: scripts/testnet/deploy.ts has already run at least once
 * (deployments/arbitrumSepolia.json exists with core + other games).
 */

import { network } from "hardhat";
import { parseEther } from "viem";

import { loadDeployment, saveDeployment, type Deployment } from "./lib.js";

type Addr = `0x${string}`;

// Same split every other game uses (registerGame requires it to total < 10000).
const HOUSE_BPS = 200;    // 2%
const REFERRAL_BPS = 200; // 2%
const JACKPOT_BPS = 100;  // 1%
// netStakeBps = 10000 - 200 - 200 - 100 = 9500. All three Tigrinho fixture
// RTPs (9164 / 9127 / 9124 bps) are below this, so setConfig's
// RtpExceedsNetStake check (contracts/games/SlotsTable.sol:238) will pass.

const GAME_BANKROLL = parseEther("2000"); // matches GAME_BANKROLL in deploy.ts

function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
function step(s: string) {
  console.log(`\n→ ${s}`);
}
function ok(s: string) {
  console.log(`  ✓ ${s}`);
}

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(
      `This script targets arbitrumSepolia; got "${networkName}".`,
    );
  }

  const deployment = await loadDeployment(networkName);
  if (deployment.contracts.slotsTable) {
    throw new Error(
      `SlotsTable already deployed at ${deployment.contracts.slotsTable}. ` +
        `This script is one-shot; edit deployments/arbitrumSepolia.json manually if you really need to redeploy.`,
    );
  }

  const [deployer] = await viem.getWalletClients();

  banner("Incremental deploy — SlotsTable (Arbitrum Sepolia)");
  console.log("PaymentHandler:  ", deployment.contracts.paymentHandler);
  console.log("RandomProvider:  ", deployment.contracts.randomProvider);
  console.log("EverValueCoin:   ", deployment.contracts.evaToken);
  console.log("AuthHub:         ", deployment.contracts.authHub);
  console.log("Deployer:        ", deployer.account.address);

  const paymentHandler = await viem.getContractAt(
    "PaymentHandler",
    deployment.contracts.paymentHandler,
  );
  const randomProvider = await viem.getContractAt(
    "RandomProvider",
    deployment.contracts.randomProvider,
  );
  const authHub = await viem.getContractAt("AuthHub", deployment.contracts.authHub);
  const token = await viem.getContractAt("EverValueCoin", deployment.contracts.evaToken);

  step("Deploying SlotsTable");
  const slotsTable = await viem.deployContract("SlotsTable", [
    deployment.contracts.paymentHandler as Addr,
    deployment.contracts.randomProvider as Addr,
    deployment.contracts.evaToken as Addr,
    deployment.contracts.authHub as Addr,
  ]);
  ok(`SlotsTable: ${slotsTable.address}`);

  step("Registering as RandomProvider consumer (1 range per bet)");
  let tx = await randomProvider.write.setConsumerStatus([slotsTable.address, true, 1n]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Consumer registered");

  step("Registering in PaymentHandler (2% house / 2% referral / 1% jackpot)");
  tx = await paymentHandler.write.registerGame([
    slotsTable.address,
    slotsTable.address,
    deployment.wallets.feeRecipient as Addr,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Registered in PaymentHandler");

  step("Registering as AuthHub spend tracker");
  tx = await authHub.write.setSpendTracker([slotsTable.address, true]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Spend tracker registered");

  step(`Bankrolling with ${GAME_BANKROLL} wei EVA`);
  tx = await token.write.transfer([slotsTable.address, GAME_BANKROLL]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Bankrolled");

  const updated: Deployment = {
    ...deployment,
    contracts: {
      ...deployment.contracts,
      slotsTable: slotsTable.address,
    },
  };
  const savedPath = await saveDeployment(updated);
  ok(`Deployment updated → ${savedPath}`);

  banner("DONE");
  console.log("Next: npx hardhat run scripts/testnet/configure-slotstable.ts --network arbitrumSepolia");
}

main().catch((e) => {
  console.error("\n✖ Deploy failed:", e);
  process.exit(1);
});
