/**
 * Testnet setup script — Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/setup.ts --network arbitrumSepolia
 *
 * Run AFTER deploy.ts. Reads deployments/arbitrumSepolia.json and:
 *   1. Funds player1, player2, operator with ETH from the deployer.
 *   2. Transfers EVA to player1, player2 so they can place bets.
 *   3. Each player submits `approve(game, MAX)` for every game contract.
 *   4. player1 authorizes a session key on AuthHub (so delegated tests can run).
 *
 * Session-only roles (sessionKey, oracleSigner, feeRecipient, defaultReceiver)
 * are intentionally not funded — they sign or receive but never submit txs.
 */

import { network } from "hardhat";
import {
  createWalletClient,
  http,
  parseEther,
  maxUint256,
  formatEther,
  type Account,
  type Address,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

import {
  loadTestnetEnv,
  deriveTestnetWallets,
  loadDeployment,
  type TestnetWallets,
} from "./lib.js";

type Addr = `0x${string}`;

// ── Funding amounts (Generous tier) ────────────────────────────────────────

const ETH_PER_WALLET = parseEther("0.02");
const EVA_PER_PLAYER = parseEther("500");

/** Spend cap the session key is authorized for on AuthHub. */
const SESSION_KEY_SPEND_CAP = parseEther("500");

// ── Helpers ────────────────────────────────────────────────────────────────

function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
function step(s: string) { console.log(`\n→ ${s}`); }
function ok(s: string)   { console.log(`  ✓ ${s}`); }
function info(s: string) { console.log(`  ${s}`); }

function makeWalletClient(account: Account, rpcUrl: string) {
  return createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpcUrl) });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const env = loadTestnetEnv();
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(`This script targets arbitrumSepolia; got "${networkName}".`);
  }

  const deployment = await loadDeployment(networkName);
  const wallets: TestnetWallets = deriveTestnetWallets(env.testnetSeed);

  // Sanity: deployment file's wallet addresses must match what we just derived.
  for (const role of Object.keys(deployment.wallets) as (keyof typeof deployment.wallets)[]) {
    if (deployment.wallets[role].toLowerCase() !== wallets[role].address.toLowerCase()) {
      throw new Error(
        `Wallet mismatch for ${role}: deployment has ${deployment.wallets[role]}, ` +
          `seed-derived address is ${wallets[role].address}. ` +
          `Did TESTNET_SEED change since the deploy?`,
      );
    }
  }

  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account.address;
  const deployerBalBefore = await publicClient.getBalance({ address: deployer });

  banner("BURNING GAMES — Testnet setup (Arbitrum Sepolia)");
  console.log("Deployer:           ", deployer);
  console.log("Deployer ETH:       ", formatEther(deployerBalBefore));
  console.log("Deployment file:    ", `deployments/${networkName}.json`);
  console.log("Token:              ", deployment.contracts.evaToken);

  // ── 1. ETH funding ──────────────────────────────────────────────────────
  banner("1. Funding wallets with ETH");

  const ethRecipients: Array<keyof typeof wallets> = ["player1", "player2", "operator"];
  for (const role of ethRecipients) {
    const addr = wallets[role].address;
    const bal = await publicClient.getBalance({ address: addr });
    if (bal >= ETH_PER_WALLET) {
      ok(`${role} (${addr}) already has ${formatEther(bal)} ETH — skipping`);
      continue;
    }
    step(`Sending ${formatEther(ETH_PER_WALLET)} ETH → ${role} (${addr})`);
    const hash = await deployerWallet.sendTransaction({
      to: addr,
      value: ETH_PER_WALLET - bal, // top up to target rather than always sending full amount
    });
    await publicClient.waitForTransactionReceipt({ hash });
    ok("Funded");
  }

  // ── 2. EVA funding ──────────────────────────────────────────────────────
  banner("2. Funding players with EVA");

  const token = await viem.getContractAt("EverValueCoin", deployment.contracts.evaToken);
  const evaRecipients: Array<keyof typeof wallets> = ["player1", "player2"];
  for (const role of evaRecipients) {
    const addr = wallets[role].address;
    const bal = await token.read.balanceOf([addr]);
    if (bal >= EVA_PER_PLAYER) {
      ok(`${role} (${addr}) already has ${formatEther(bal)} EVA — skipping`);
      continue;
    }
    const topUp = EVA_PER_PLAYER - bal;
    step(`Transferring ${formatEther(topUp)} EVA → ${role} (${addr})`);
    const hash = await token.write.transfer([addr, topUp]);
    await publicClient.waitForTransactionReceipt({ hash });
    ok("Transferred");
  }

  // ── 3. Player approvals ────────────────────────────────────────────────
  banner("3. Player approvals");

  // Every player approves every game for max EVA.
  // Note: PaymentOnlyGameAdapter, Roulette, Slots, Plinko, Mines, ProgressiveJackpot,
  // and CrashGame all pull tokens from the player via their game address (V5 flow).
  // TicketLottery never touches EVA.
  const gamesToApprove: Array<[string, Addr]> = [
    ["Roulette", deployment.contracts.roulette],
    ["Slots", deployment.contracts.slots],
    ["Plinko", deployment.contracts.plinko],
    ["Mines", deployment.contracts.mines],
    ["PaymentOnlyGameAdapter", deployment.contracts.paymentOnlyGameAdapter],
    ["ProgressiveJackpot", deployment.contracts.progressiveJackpot],
    ["CrashGame", deployment.contracts.crashGame],
  ];

  for (const role of evaRecipients) {
    info(`As ${role} (${wallets[role].address}):`);
    const playerClient = makeWalletClient(wallets[role], env.rpcUrl);
    const playerToken = await viem.getContractAt("EverValueCoin", deployment.contracts.evaToken, {
      client: { wallet: playerClient },
    });
    for (const [label, gameAddr] of gamesToApprove) {
      const current = await token.read.allowance([wallets[role].address, gameAddr]);
      // Re-approve only if current allowance isn't already "infinite-ish"
      if (current >= EVA_PER_PLAYER * 1000n) {
        ok(`  ${label} already approved (allowance ≥ huge) — skipping`);
        continue;
      }
      const hash = await playerToken.write.approve([gameAddr, maxUint256]);
      await publicClient.waitForTransactionReceipt({ hash });
      ok(`  approve(${label}, MAX) ok`);
    }
  }

  // ── 4. Session-key authorization (player1 → sessionKey) ────────────────
  banner("4. Session-key authorization on AuthHub");

  const player1Client = makeWalletClient(wallets.player1, env.rpcUrl);
  const authHubAsPlayer = await viem.getContractAt("AuthHub", deployment.contracts.authHub, {
    client: { wallet: player1Client },
  });
  const authHubRead = await viem.getContractAt("AuthHub", deployment.contracts.authHub);

  const currentKey = await authHubRead.read.sessionKeyOf([wallets.player1.address]);
  if (currentKey.toLowerCase() === wallets.sessionKey.address.toLowerCase()) {
    const remaining = await authHubRead.read.remainingSpend([wallets.player1.address]);
    ok(`player1 already authorized sessionKey (remaining spend cap: ${formatEther(remaining)} EVA)`);
  } else {
    step(`player1 authorizes sessionKey (${wallets.sessionKey.address}) with cap ${formatEther(SESSION_KEY_SPEND_CAP)} EVA, no expiry`);
    // authorize(sessionKey, expiresAt=0 → no expiry, spendCap)
    const hash = await authHubAsPlayer.write.authorize([
      wallets.sessionKey.address,
      0n,
      SESSION_KEY_SPEND_CAP,
    ]);
    await publicClient.waitForTransactionReceipt({ hash });
    ok("Authorized");
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────
  banner("SETUP COMPLETE");
  const deployerBalAfter = await publicClient.getBalance({ address: deployer });
  const ethSpent = deployerBalBefore - deployerBalAfter;
  console.log("Deployer ETH spent in this script:", formatEther(ethSpent));
  console.log("\nFinal wallet balances:");
  for (const role of Object.keys(wallets) as (keyof typeof wallets)[]) {
    const addr = wallets[role].address;
    const ethBal = await publicClient.getBalance({ address: addr });
    const evaBal = await token.read.balanceOf([addr]);
    console.log(
      `  ${role.padEnd(18)} ${addr}  ` +
        `ETH ${formatEther(ethBal).padStart(8)}  ` +
        `EVA ${formatEther(evaBal).padStart(8)}`,
    );
  }
  console.log("\nReady to play. Next: write scripts/testnet/play-*.ts that read deployments/arbitrumSepolia.json.\n");
}

main().catch((e) => {
  console.error("\n✖ Setup failed:", e);
  process.exit(1);
});
