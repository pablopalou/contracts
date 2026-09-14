/**
 * Deploys SlotsTable (Tigerous/Tigrinho) to Arbitrum mainnet against the
 * live V5 platform infrastructure, and wires it up: RandomProviderV2
 * consumer, PaymentHandler registration, AuthHub spend tracker.
 *
 * Does NOT call setConfig (paytables) — run configure-slotstable.ts
 * afterwards. Splitting deploy from configure means a mistake in the
 * paytable step never requires re-deploying the contract.
 *
 *   CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/deploy-slotstable.ts --network arbitrum
 *
 * ── Prerequisites ────────────────────────────────────────────────────────
 *  1. AuthHub deployed on mainnet (scripts/mainnet/deploy-authhub.ts) — it
 *     doesn't exist yet as of writing (absent from every scripts/mainnet/
 *     deployments/*.json and from index.json's platform.core). SlotsTable's
 *     constructor takes it directly and cannot deploy without one.
 *  2. MAINNET_AUTH_HUB_ADDRESS set in .env to that address.
 *
 * ── registerGame arity — READ THIS ──────────────────────────────────────
 * contracts/core/PaymentHandler.sol today has exactly ONE registerGame,
 * taking 6 args (game, payoutTarget, feeRecipient, houseEdgeBps, referralBps,
 * jackpotBps) and auto-enabling the game. But scripts/mainnet/deploy-arbitrum-v5.ts
 * — the script that deployed the PaymentHandler actually LIVE on mainnet
 * today — calls a 5-arg version (no jackpotBps) followed by a separate
 * setGameStatus call, and so does scripts/mainnet/setup-mines-v5.ts (a mainnet
 * deploy that hasn't run yet). That strongly suggests those scripts predate
 * the current 6-arg source and the LIVE contract may still be the older
 * version. This script can only compile against the current (6-arg) source,
 * so it dry-runs that exact call via `simulateContract` before ever sending
 * a real transaction — if the live contract doesn't have that selector, this
 * fails loudly here with a clear message instead of burning gas on a mystery
 * revert. If it fails, the fee split isn't reconcilable until the PaymentHandler
 * itself is upgraded — this is a genuine platform-level gap, not something to
 * work around by guessing at a different call shape.
 *
 * ── Fee split ────────────────────────────────────────────────────────────
 * Defaults to the same 2% house / 2% referral / 1% jackpot split already
 * certified against the Tigrinho fixtures on testnet (see deploy-slotstable.ts
 * there) — NOT the older 1.5%/1.5%/0% split Plinko/Roulette/Mines use on V5.
 * Override via env if the business wants a different split for mainnet, but
 * note the fixture RTPs (9124–9164 bps) were only validated against a 9500 bps
 * net stake (10000 - 200 - 200 - 100); a materially different split changes
 * the effective RTP away from what was solver-certified.
 */

import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

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

function requireAddress(name: string): Addr {
  const v = (process.env[name] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`Missing or invalid env var ${name} (expected a 0x address)`);
  }
  return v as Addr;
}

function addressWithDefault(name: string, fallback: Addr): Addr {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`Invalid env var ${name} (expected a 0x address): ${v}`);
  }
  return v as Addr;
}

// ─── V5 platform infrastructure (index.json's platform.core, current as of
// its lastUpdated date) — overridable via env in case this runs after a
// future core migration without needing a script edit.
const TOKEN_ADDRESS = addressWithDefault(
  "MAINNET_EVA_TOKEN_ADDRESS",
  "0x45D9831d8751B2325f3DBf48db748723726e1C8c",
);
const HANDLER = addressWithDefault(
  "MAINNET_PAYMENT_HANDLER_ADDRESS",
  "0xabe66fc056dd0e116b90201e487ea102fd7df1ba",
);
const RANDOM = addressWithDefault(
  "MAINNET_RANDOM_PROVIDER_ADDRESS",
  "0x6513baa6c53a570ec899bb1504a95f160b8d7850",
);
const FEE_RECIPIENT = addressWithDefault(
  "MAINNET_FEE_RECIPIENT_ADDRESS",
  "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd", // "house" wallet in arb-mainnet-v5.json
);

// No default — this genuinely doesn't exist on mainnet yet. See the
// Prerequisites note above.
const AUTH_HUB = requireAddress("MAINNET_AUTH_HUB_ADDRESS");

const HOUSE_BPS = Number(process.env.MAINNET_SLOTSTABLE_HOUSE_BPS ?? 200); // 2%
const REFERRAL_BPS = Number(process.env.MAINNET_SLOTSTABLE_REFERRAL_BPS ?? 200); // 2%
const JACKPOT_BPS = Number(process.env.MAINNET_SLOTSTABLE_JACKPOT_BPS ?? 100); // 1%

const CONSUMER_RANGE_LIMIT = 1n; // 1 range/bet — same as testnet

// Unset or "0" → skip funding; fund manually once the deploy is verified.
const BANKROLL = process.env.MAINNET_SLOTSTABLE_BANKROLL ?? "0";

const DEPLOYMENT_FILE = new URL("./deployments/slotstable-mainnet.json", import.meta.url);

async function main() {
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "Refusing to run against mainnet without CONFIRM_MAINNET=yes. " +
        "This deploys a real contract, registers it with real infrastructure, " +
        "and optionally moves real EVA. Re-run as:\n" +
        "  CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/deploy-slotstable.ts --network arbitrum",
    );
  }

  const existing = await fs.readFile(DEPLOYMENT_FILE, "utf8").catch(() => null);
  if (existing) {
    const parsed = JSON.parse(existing);
    throw new Error(
      `SlotsTable already deployed at ${parsed.slotsTable} (${DEPLOYMENT_FILE.pathname}). ` +
        `This script is one-shot; delete that file first if you really need to redeploy.`,
    );
  }

  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  if (networkName !== "arbitrum") {
    throw new Error(`This script targets --network arbitrum; got "${networkName}".`);
  }
  const chainId = await publicClient.getChainId();
  if (chainId !== 42161) {
    throw new Error(`Expected Arbitrum One (chainId 42161); connected chainId is ${chainId}.`);
  }
  if (HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS >= 10000) {
    throw new Error("HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS must be < 10000 (PaymentHandler.MAX_BPS).");
  }

  const [deployer] = await viem.getWalletClients();
  const deployerETH = await publicClient.getBalance({ address: deployer.account.address });

  banner("SlotsTable (Tigerous) — Arbitrum Mainnet");
  console.log("Network:        ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:       ", deployer.account.address);
  console.log("Deployer ETH:   ", formatEther(deployerETH), "ETH");
  console.log("EverValueCoin:  ", TOKEN_ADDRESS);
  console.log("PaymentHandler: ", HANDLER);
  console.log("RandomProviderV2:", RANDOM);
  console.log("AuthHub:        ", AUTH_HUB);
  console.log("Fee split:      ", `${HOUSE_BPS / 100}% house / ${REFERRAL_BPS / 100}% referral / ${JACKPOT_BPS / 100}% jackpot`);
  console.log("Bankroll:       ", BANKROLL === "0" ? "SKIPPED (fund manually after deploy)" : `${BANKROLL} EVA`);

  if (deployerETH === 0n) {
    throw new Error("Deployer has 0 ETH — cannot pay for gas.");
  }

  // ── Pre-flight: confirm the live PaymentHandler/RandomProviderV2/AuthHub
  // actually respond before spending any gas on a real deploy. Doesn't
  // guarantee registerGame's arity matches (see file header) — that's
  // checked separately, right before it's actually called.
  step("Pre-flight: probing infrastructure contracts");
  const paymentHandler = await viem.getContractAt("PaymentHandler", HANDLER);
  const randomProvider = await viem.getContractAt("RandomProviderV2", RANDOM);
  const authHub = await viem.getContractAt("AuthHub", AUTH_HUB);
  const token = await viem.getContractAt("EverValueCoin", TOKEN_ADDRESS);

  await paymentHandler.read.owner().catch((e: unknown) => {
    throw new Error(`PaymentHandler at ${HANDLER} did not respond to owner(): ${e}`);
  });
  await randomProvider.read.owner().catch((e: unknown) => {
    throw new Error(`RandomProviderV2 at ${RANDOM} did not respond to owner(): ${e}`);
  });
  await authHub.read.owner().catch((e: unknown) => {
    throw new Error(
      `AuthHub at ${AUTH_HUB} did not respond to owner() — is MAINNET_AUTH_HUB_ADDRESS correct ` +
        `and did deploy-authhub.ts actually finish? ${e}`,
    );
  });
  ok("PaymentHandler, RandomProviderV2, and AuthHub all responded");

  if (BANKROLL !== "0") {
    const bankrollWei = parseEther(BANKROLL);
    const deployerEva = await token.read.balanceOf([deployer.account.address]);
    if (deployerEva < bankrollWei) {
      throw new Error(
        `Deployer EVA balance (${formatEther(deployerEva)}) is less than the requested bankroll (${BANKROLL}).`,
      );
    }
  }

  step("Deploying SlotsTable");
  const slotsTable = await viem.deployContract("SlotsTable", [HANDLER, RANDOM, TOKEN_ADDRESS, AUTH_HUB]);
  ok(`SlotsTable: ${slotsTable.address}`);

  step("Registering as RandomProviderV2 consumer (1 range per bet)");
  let tx = await randomProvider.write.setConsumerStatus([slotsTable.address, true, CONSUMER_RANGE_LIMIT]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Consumer registered");

  step(`Registering in PaymentHandler (${HOUSE_BPS / 100}% house / ${REFERRAL_BPS / 100}% referral / ${JACKPOT_BPS / 100}% jackpot)`);
  const registerArgs = [
    slotsTable.address,
    slotsTable.address,
    FEE_RECIPIENT,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ] as const;
  // Dry-run first — see the file header on why this arity is uncertain
  // against whatever's actually live.
  await paymentHandler.simulate.registerGame(registerArgs as unknown as Parameters<typeof paymentHandler.write.registerGame>[0]).catch((e: unknown) => {
    throw new Error(
      `registerGame(${registerArgs.join(", ")}) reverted in simulation against the LIVE PaymentHandler at ${HANDLER}. ` +
        `This mainnet PaymentHandler likely only has the older 5-arg registerGame (see this file's header) — ` +
        `SlotsTable's fee split cannot be registered until the platform's PaymentHandler is upgraded to the ` +
        `6-arg (jackpotBps) version this contract was built against. SlotsTable itself IS deployed at ` +
        `${slotsTable.address} — do not lose that address. Original error: ${e}`,
    );
  });
  tx = await paymentHandler.write.registerGame(registerArgs as unknown as Parameters<typeof paymentHandler.write.registerGame>[0]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Registered in PaymentHandler");

  step("Registering as AuthHub spend tracker");
  tx = await authHub.write.setSpendTracker([slotsTable.address, true]);
  await publicClient.waitForTransactionReceipt({ hash: tx });
  ok("Spend tracker registered");

  if (BANKROLL !== "0") {
    step(`Bankrolling with ${BANKROLL} EVA`);
    tx = await token.write.transfer([slotsTable.address, parseEther(BANKROLL)]);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    ok("Bankrolled");
  }

  const record = {
    contract: "SlotsTable",
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.account.address,
    slotsTable: slotsTable.address,
    infrastructure: {
      token: TOKEN_ADDRESS,
      handler: HANDLER,
      randomProvider: RANDOM,
      authHub: AUTH_HUB,
      feeRecipient: FEE_RECIPIENT,
    },
    config: {
      houseBps: HOUSE_BPS,
      referralBps: REFERRAL_BPS,
      jackpotBps: JACKPOT_BPS,
      consumerRangeLimit: CONSUMER_RANGE_LIMIT.toString(),
      bankroll: BANKROLL,
    },
  };
  await fs.mkdir(new URL("./deployments/", import.meta.url), { recursive: true });
  await fs.writeFile(DEPLOYMENT_FILE, JSON.stringify(record, null, 2) + "\n", "utf8");
  ok(`Saved → ${DEPLOYMENT_FILE.pathname}`);

  banner("DONE");
  console.log("SlotsTable deployed:", slotsTable.address);
  console.log("\nNext steps:");
  console.log("  1. Verify on Arbiscan:");
  console.log(
    "       npx hardhat verify --network arbitrum",
    slotsTable.address,
    HANDLER,
    RANDOM,
    TOKEN_ADDRESS,
    AUTH_HUB,
  );
  console.log("  2. Configure the paytables:");
  console.log("       CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/configure-slotstable.ts --network arbitrum");
  if (BANKROLL === "0") {
    console.log("  3. Fund the bankroll manually:");
    console.log(`       evaToken.transfer(${slotsTable.address}, amount)`);
  }
  console.log("\nAlso add this game to scripts/mainnet/deployments/index.json manually:");
  console.log(
    JSON.stringify(
      {
        current: "V1",
        artifact: "slotstable-mainnet.json",
        address: slotsTable.address,
        contract: "SlotsTable",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("\n✖ Deploy failed:", e);
  process.exit(1);
});
