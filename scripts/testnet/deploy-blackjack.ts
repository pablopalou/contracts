/**
 * Incremental testnet deploy — BlackjackGame on Arbitrum Sepolia.
 *
 *   npm run deploy:blackjack:testnet
 *   (= npx hardhat run scripts/testnet/deploy-blackjack.ts --network arbitrumSepolia)
 *
 * Reads the existing platform deployment (deployments/arbitrumSepolia.json),
 * deploys ONLY BlackjackGame against the already-deployed core (token,
 * PaymentHandler, RandomProvider, AuthHub) and runs the registration
 * checklist from GAME_AUTHOR_GUIDE §7:
 *
 *   1. deploy BlackjackGame(token, handler, provider, authHub, operator)
 *   2. paymentHandler.registerGame(game, game, feeRecipient, 45, 45, 0) — 0.9 % total,
 *      paid by the game out of its rules edge (payouts are on gross wagers)
 *   3. randomProvider.setConsumerStatus(game, true, 1)
 *   4. authHub.setSpendTracker(game, true)
 *   5. authHub.setOperator(operator, true) — the backend relays *For actions itself
 *      (game.setGameOperator is done by the constructor)
 *   6. setTableConfig(min 0.1 / max 2 EVA, Perfect Pairs max 0.5 EVA, 10 min / 1 h)
 *   7. bankroll EVA + top up operator ETH if needed
 *
 * RandomProvider is already a consumer of the VRF subscription (per-provider,
 * not per-game), so Chainlink is not touched.
 *
 * Optional env:
 *   BLACKJACK_OPERATOR      — backend wallet (gameOperator + AuthHub operator); default: deployer
 *   BLACKJACK_BANKROLL_EVA  — bankroll in EVA (default 200)
 *   BLACKJACK_MIN_BET_EVA / BLACKJACK_MAX_BET_EVA / BLACKJACK_MAX_SIDE_BET_EVA (defaults 0.1 / 2 / 0.5)
 *
 * Updates deployments/arbitrumSepolia.json (contracts.blackjack) and refreshes
 * the vendored copies in backends/operatorsServer and blackjackBackend if present.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { formatEther, nonceManager, parseEther } from "viem";

import { loadDeployment, saveDeployment, type Deployment } from "./lib.js";

type Addr = `0x${string}`;

// Fees on the PaymentHandler — 0.9 % total, split 50/50 house/referral, no jackpot.
const HOUSE_BPS = 45;
const REFERRAL_BPS = 45;
const JACKPOT_BPS = 0;

const SETTLE_TIMEOUT = 10 * 60; // operator may resolve an abandoned round
const REFUND_TIMEOUT = 60 * 60; // anyone may refund an unsettled round

const DEFAULT_BANKROLL_EVA = "200";
const OPERATOR_MIN_ETH = parseEther("0.05");
const OPERATOR_TOPUP_ETH = parseEther("0.1");

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
function envOr(name: string, fallback: string): string {
  return (process.env[name] ?? "").trim() || fallback;
}

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(`This script targets arbitrumSepolia; got "${networkName}".`);
  }

  const deployment = await loadDeployment(networkName);
  const core = deployment.contracts;

  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account.address as Addr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (deployerWallet.account as any).nonceManager = nonceManager;

  const waitTx = async (hash: `0x${string}`) => {
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const operator = envOr("BLACKJACK_OPERATOR", deployer) as Addr;
  const bankrollEva = parseEther(envOr("BLACKJACK_BANKROLL_EVA", DEFAULT_BANKROLL_EVA));
  const minBet = parseEther(envOr("BLACKJACK_MIN_BET_EVA", "0.1"));
  const maxBet = parseEther(envOr("BLACKJACK_MAX_BET_EVA", "2"));
  const maxSideBet = parseEther(envOr("BLACKJACK_MAX_SIDE_BET_EVA", "0.5"));

  banner("BLACKJACK — Incremental deploy (Arbitrum Sepolia)");
  console.log("Network:        ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:       ", deployer);
  console.log("Operator:       ", operator);
  console.log("EVA token:      ", core.evaToken);
  console.log("PaymentHandler: ", core.paymentHandler);
  console.log("RandomProvider: ", core.randomProvider);
  console.log("AuthHub:        ", core.authHub);
  console.log("Fee recipient:  ", deployment.wallets.feeRecipient);
  console.log("Fees:           ", `${HOUSE_BPS / 100}% house + ${REFERRAL_BPS / 100}% referral + ${JACKPOT_BPS / 100}% jackpot`);
  console.log("Table:          ", `${formatEther(minBet)}–${formatEther(maxBet)} EVA, Perfect Pairs ≤ ${formatEther(maxSideBet)} EVA`);

  banner("1. Deploy BlackjackGame");
  const game = await viem.deployContract("BlackjackGame", [
    core.evaToken,
    core.paymentHandler,
    core.randomProvider,
    core.authHub,
    operator,
  ]);
  ok(`BlackjackGame: ${game.address}`);

  banner("2. Platform registration");
  const handler = await viem.getContractAt("PaymentHandler", core.paymentHandler);
  step(`registerGame(game, game, feeRecipient, ${HOUSE_BPS}, ${REFERRAL_BPS}, ${JACKPOT_BPS})`);
  await waitTx(
    await handler.write.registerGame([game.address, game.address, deployment.wallets.feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
  );
  ok("Registered on PaymentHandler (0.9% total fees)");

  const provider = await viem.getContractAt("RandomProvider", core.randomProvider);
  step("randomProvider.setConsumerStatus(game, true, 1)");
  await waitTx(await provider.write.setConsumerStatus([game.address, true, 1n]));
  ok("Registered as RandomProvider consumer (1 range)");

  const authHub = await viem.getContractAt("AuthHub", core.authHub);
  step("authHub.setSpendTracker(game, true)");
  await waitTx(await authHub.write.setSpendTracker([game.address, true]));
  ok("Registered as AuthHub spend tracker");

  step(`authHub.setOperator(${operator}, true)`);
  if ((await authHub.read.isOperator([operator])) as boolean) {
    ok("Operator already on the AuthHub allowlist");
  } else {
    await waitTx(await authHub.write.setOperator([operator, true]));
    ok("Operator added to the AuthHub allowlist");
  }

  banner("3. Table config");
  step("setTableConfig");
  await waitTx(
    await game.write.setTableConfig([
      { enabled: true, minBet, maxBet, maxSideBet, settleTimeout: SETTLE_TIMEOUT, refundTimeout: REFUND_TIMEOUT },
    ]),
  );
  ok(`Table enabled: ${formatEther(minBet)}–${formatEther(maxBet)} EVA, side ≤ ${formatEther(maxSideBet)} EVA, ${SETTLE_TIMEOUT}s / ${REFUND_TIMEOUT}s`);

  banner("4. Funding");
  const token = await viem.getContractAt("EverValueCoin", core.evaToken);
  const deployerEva = (await token.read.balanceOf([deployer])) as bigint;
  const bankroll = deployerEva >= bankrollEva ? bankrollEva : deployerEva;
  if (bankroll === 0n) {
    console.warn("  ⚠ Deployer has no EVA — the game has NO bankroll (startRound will revert)");
  } else {
    step(`Bankroll: transferring ${formatEther(bankroll)} EVA to the game`);
    await waitTx(await token.write.transfer([game.address, bankroll]));
    ok(`Bankroll: ${formatEther(bankroll)} EVA (max exposure per round at 2 EVA + 0.5 side ≈ 24 EVA)`);
  }

  if (operator.toLowerCase() !== deployer.toLowerCase()) {
    const opBal = await publicClient.getBalance({ address: operator });
    if (opBal < OPERATOR_MIN_ETH) {
      step(`Operator ETH low (${formatEther(opBal)}): sending ${formatEther(OPERATOR_TOPUP_ETH)} ETH`);
      await waitTx(await deployerWallet.sendTransaction({ to: operator, value: OPERATOR_TOPUP_ETH }));
      ok("Operator funded");
    } else {
      ok(`Operator ETH ok (${formatEther(opBal)})`);
    }
  } else {
    ok("Operator == deployer; no extra funding");
  }

  banner("5. Save deployment");
  const extended = {
    ...deployment,
    contracts: { ...deployment.contracts, blackjack: game.address as Addr },
  } as Deployment & { contracts: Deployment["contracts"] & { blackjack: Addr } };
  const savedPath = await saveDeployment(extended);
  ok(`deployments JSON updated: ${savedPath}`);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const vendoredTargets = [
    path.join(scriptDir, "../../../backends/operatorsServer/deployments/arbitrumSepolia.json"),
    path.join(scriptDir, "../../../../blackjackBackend/deployments/arbitrumSepolia.json"),
  ];
  for (const target of vendoredTargets) {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(extended, null, 2) + "\n", "utf8");
      ok(`vendored copy refreshed: ${target}`);
    } catch (e) {
      console.warn(`  ⚠ could not write ${target}: ${(e as Error).message}`);
    }
  }

  banner("DONE");
  console.log("BlackjackGame:", game.address);
  console.log("\nBackend env: BLACKJACK_GAME_ADDRESS=" + game.address);
  console.log("Client env:  VITE_BLACKJACK_GAME=" + game.address);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
