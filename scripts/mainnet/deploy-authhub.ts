/**
 * Deploys AuthHub to Arbitrum mainnet.
 *
 * BLOCKER for SlotsTable/Tigerous: AuthHub has never been deployed to mainnet
 * — it's absent from every scripts/mainnet/deployments/*.json and from
 * index.json's platform.core list. Every game deployed to mainnet so far
 * (Roulette, Plinko, Mines, Slots, Crash) is a BaseGame that never needed it.
 * SlotsTable is a PushVRFGame, whose constructor takes an AuthHub address
 * directly (see contracts/games/SlotsTable.sol:175) — it cannot deploy
 * without one. This script must run once, before deploy-slotstable.ts.
 *
 * AuthHub is platform-wide infrastructure (operator allowlist + player
 * session keys for QuickBet), not per-game — future PushVRFGame-based games
 * reuse this same instance. It takes no constructor args.
 *
 *   CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/deploy-authhub.ts --network arbitrum
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import "dotenv/config";

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

const DEPLOYMENT_FILE = new URL("./deployments/arb-mainnet-authhub.json", import.meta.url);

async function main() {
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "Refusing to run against mainnet without CONFIRM_MAINNET=yes. " +
        "This deploys a real contract with real gas. Re-run as:\n" +
        "  CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/deploy-authhub.ts --network arbitrum",
    );
  }

  // One-shot guard — don't accidentally deploy a second AuthHub and split
  // the platform's session-key state across two instances.
  const existing = await fs.readFile(DEPLOYMENT_FILE, "utf8").catch(() => null);
  if (existing) {
    const parsed = JSON.parse(existing);
    throw new Error(
      `AuthHub already deployed at ${parsed.authHub} (${DEPLOYMENT_FILE.pathname}). ` +
        `This script is one-shot; delete that file first if you really need to redeploy.`,
    );
  }

  const conn = await network.connect();
  const viem = conn.viem;
  const publicClient = await viem.getPublicClient();

  const chainId = await publicClient.getChainId();
  if (chainId !== 42161) {
    throw new Error(`Expected Arbitrum One (chainId 42161); connected chainId is ${chainId}.`);
  }

  const [deployer] = await viem.getWalletClients();
  const deployerETH = await publicClient.getBalance({ address: deployer.account.address });

  banner("AuthHub — Arbitrum Mainnet");
  console.log("Deployer:    ", deployer.account.address);
  console.log("Deployer ETH:", (Number(deployerETH) / 1e18).toFixed(5), "ETH");
  if (deployerETH === 0n) {
    throw new Error("Deployer has 0 ETH — cannot pay for gas.");
  }

  step("Deploying AuthHub");
  const authHub = await viem.deployContract("AuthHub");
  ok(`AuthHub: ${authHub.address}`);

  const record = {
    contract: "AuthHub",
    network: "arbitrum",
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.account.address,
    authHub: authHub.address,
  };
  await fs.mkdir(new URL("./deployments/", import.meta.url), { recursive: true });
  await fs.writeFile(DEPLOYMENT_FILE, JSON.stringify(record, null, 2) + "\n", "utf8");
  ok(`Saved → ${DEPLOYMENT_FILE.pathname}`);

  banner("DONE");
  console.log("Next: set MAINNET_AUTH_HUB_ADDRESS =", authHub.address, "in .env, then run");
  console.log("  CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/deploy-slotstable.ts --network arbitrum");
  console.log("\nAlso verify on Arbiscan:");
  console.log("  npx hardhat verify --network arbitrum", authHub.address);
}

main().catch((e) => {
  console.error("\n✖ Deploy failed:", e);
  process.exit(1);
});
