/**
 * Testnet deploy script — Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/deploy.ts --network arbitrumSepolia
 *
 * Deploys the entire platform against real Chainlink VRF v2.5 on Arbitrum Sepolia:
 *   - EverValueCoin, AuthHub, MultiLevelReferral, PaymentHandler
 *   - RandomProvider (pointing at the real VRF coordinator)
 *   - ProgressiveJackpot
 *   - All seven games (Roulette, Slots, Plinko, Mines, PaymentOnlyGameAdapter, TicketLottery, CrashGame)
 *
 * Then wires everything together, configures each game with sensible defaults,
 * bankrolls each game, and adds RandomProvider + TicketLottery as VRF consumers
 * on the pre-funded Chainlink subscription.
 *
 * Funding of testnet wallets, approvals, and session-key authorization are
 * handled by scripts/testnet/setup.ts so the deploy stage stays focused.
 *
 * Output: deployments/arbitrumSepolia.json — read by setup.ts and play scripts.
 */

import { network } from "hardhat";
import {
  createWalletClient,
  formatEther,
  http,
  nonceManager,
  parseEther,
  type Account,
  type Address,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

import {
  loadTestnetEnv,
  deriveTestnetWallets,
  summarizeWallets,
  saveDeployment,
  type Deployment,
} from "./lib.js";

type Addr = `0x${string}`;

// ─────────────────────────────────────────────────────────────────────────
// CONFIG (per-game defaults — match contracts/games/* setters)
// ─────────────────────────────────────────────────────────────────────────

// PaymentHandler fee split per game (must total < 10000)
const HOUSE_BPS = 200;       // 2% house edge → fee recipient
const REFERRAL_BPS = 200;    // 2% referrals
const JACKPOT_BPS = 100;     // 1% routed to ProgressiveJackpot at bet entry

// MLR referral ladder: 40% / 30% / 20% to upline levels 1, 2, 3
const MLR_LEVELS: readonly number[] = [4000, 3000, 2000];

// ProgressiveJackpot tier ladder (9 tiers, last is terminal)
const PJ_TIER_COUNT = 9;
const PJ_TIER_COST = parseEther("1"); // 1 EVA per direct bet at any tier
const PJ_PROB_BASE = 1000;            // 0.1% base
const PJ_PROB_MAX = 50_000;           // 5% max
const PJ_PROB_INCREMENT = 30;         // 0.003% per entry

// Pot seeding (per tier + consolation)
const PJ_POT_SEED = parseEther("10");

// Game bankroll (EVA each)
const GAME_BANKROLL = parseEther("2000");

// Roulette table
const ROULETTE_MIN_MULTIPLIER = 200;   // 2.00x
const ROULETTE_MAX_MULTIPLIER = 5000;  // 50.00x

// Plinko
const PLINKO_ROWS = 8;
function plinkoMultipliers(rows: number, base: number): bigint[] {
  // Symmetric, monotonic from edges to center. mults[k] == mults[rows-k].
  const out: bigint[] = [];
  const center = rows / 2;
  for (let i = 0; i <= rows; i++) {
    const dist = Math.abs(i - center);
    out.push(BigInt(Math.max(base, Math.round(base + Math.pow(dist, 2) * 30))));
  }
  return out;
}

// Mines
const MINES_MIN = 3;
const MINES_MAX = 5;
const MINES_CLAIM_TIMEOUT_SECONDS = 300; // 5 minutes
function minesMultiplierTable(minesCount: number): number[] {
  const len = 21 - minesCount + 1;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(100 + i * 12); // 1.00x → 1.12x → ... monotonically increasing
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

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

const VRF_COORD_ABI = [
  {
    type: "function",
    name: "addConsumer",
    inputs: [
      { name: "subId", type: "uint256" },
      { name: "consumer", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getSubscription",
    inputs: [{ name: "subId", type: "uint256" }],
    outputs: [
      { name: "balance", type: "uint96" },
      { name: "nativeBalance", type: "uint96" },
      { name: "reqCount", type: "uint64" },
      { name: "owner", type: "address" },
      { name: "consumers", type: "address[]" },
    ],
    stateMutability: "view",
  },
] as const;

async function addVrfConsumer(
  deployer: any,
  publicClient: any,
  coordinator: Addr,
  subId: bigint,
  consumer: Addr,
  label: string,
) {
  try {
    const hash = await deployer.writeContract({
      address: coordinator,
      abi: VRF_COORD_ABI,
      functionName: "addConsumer",
      args: [subId, consumer],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    ok(`Added ${label} as VRF consumer (${consumer})`);
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    if (msg.includes("AlreadyAdded") || msg.includes("already")) {
      ok(`${label} is already a VRF consumer`);
    } else {
      console.warn(`  ⚠ Failed to add ${label} as VRF consumer: ${msg}`);
      console.warn(`     You may need to add it manually at vrf.chain.link`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadTestnetEnv();

  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(
      `This script targets arbitrumSepolia; got "${networkName}". ` +
        `Run with: npx hardhat run scripts/testnet/deploy.ts --network arbitrumSepolia`,
    );
  }

  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account.address;

  // ── Nonce-stable submission ──────────────────────────────────────────────
  // Hardhat-toolbox-viem's wallet client doesn't attach a nonce manager,
  // so every tx fetches the nonce via eth_getTransactionCount(latest). On
  // Infura's multi-node setup that read can lag the chain head by one
  // immediately after a fresh tx, causing "nonce too low" rejects partway
  // through a multi-tx deploy. Attaching viem's singleton `nonceManager`
  // to the account makes viem track nonces locally and allocate them
  // sequentially across every subsequent submission from this wallet.
  // The wallet client is shared by every viem.deployContract / contract.write
  // call below, so this one line propagates everywhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (deployerWallet.account as any).nonceManager = nonceManager;

  // ── Receipt-wait wrapper ─────────────────────────────────────────────────
  // Hardhat-toolbox-viem v3 creates each contract with its own internal
  // walletClient — monkey-patching `deployerWallet.writeContract` does NOT
  // propagate to `contract.write.X(...)` calls. We have to wrap each contract
  // at the moment it's returned from `viem.deployContract(...)`. The proxy
  // on `.write` intercepts every method and awaits the receipt before
  // returning, guaranteeing the chain has applied tx N before tx N+1 reads
  // its nonce from getTransactionCount.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _origDeploy = (viem as any).deployContract.bind(viem);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (viem as any).deployContract = async (...args: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = await _origDeploy(...args);
    if (contract?.write && typeof contract.write === "object") {
      contract.write = new Proxy(contract.write, {
        get(target, key) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (target as any)[key];
          if (typeof fn !== "function") return fn;
          return async (...callArgs: unknown[]) => {
            const hash = (await fn(...callArgs)) as `0x${string}`;
            await publicClient.waitForTransactionReceipt({ hash });
            return hash;
          };
        },
      });
    }
    return contract;
  };

  const deployerBal = await publicClient.getBalance({ address: deployer });

  const wallets = deriveTestnetWallets(env.testnetSeed);
  const walletAddrs = summarizeWallets(wallets);

  banner("BURNING GAMES — Testnet deploy (Arbitrum Sepolia)");
  console.log("Network:                ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:               ", deployer);
  console.log("Deployer balance:       ", parseFloat((Number(deployerBal) / 1e18).toFixed(6)), "ETH");
  console.log("VRF coordinator:        ", env.vrfCoordinator);
  console.log("VRF key hash:           ", env.vrfKeyHash);
  console.log("VRF subscription:       ", env.vrfSubscriptionId.toString());
  console.log("\nTestnet wallets (derived from TESTNET_SEED):");
  for (const role of Object.keys(walletAddrs) as (keyof typeof walletAddrs)[]) {
    console.log(`  ${role.padEnd(18)} ${walletAddrs[role]}`);
  }

  // ── 1. Token + auth ────────────────────────────────────────────────────
  banner("1. Core: token + AuthHub");

  step("Deploying EverValueCoin");
  const token = await viem.deployContract("EverValueCoin");
  ok(`EverValueCoin: ${token.address}`);

  step("Deploying AuthHub");
  const authHub = await viem.deployContract("AuthHub");
  ok(`AuthHub: ${authHub.address}`);

  // ── 2. Referral + payment ──────────────────────────────────────────────
  banner("2. MultiLevelReferral + PaymentHandler");

  step("Deploying MultiLevelReferral (defaultReceiver = " + walletAddrs.defaultReceiver + ")");
  const mlr = await viem.deployContract("MultiLevelReferral", [
    token.address as Addr,
    walletAddrs.defaultReceiver,
  ]);
  ok(`MultiLevelReferral: ${mlr.address}`);

  step("Setting MLR levels: " + MLR_LEVELS.join(" / ") + " bps");
  await mlr.write.setLevels([MLR_LEVELS.length, [...MLR_LEVELS]]);
  ok("MLR levels set");

  step("Deploying PaymentHandler");
  const paymentHandler = await viem.deployContract("PaymentHandler", [token.address as Addr]);
  ok(`PaymentHandler: ${paymentHandler.address}`);

  step("Wiring MLR ↔ PaymentHandler");
  await mlr.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setReferralContract([mlr.address]);
  ok("Wiring done");

  // ── 3. RandomProvider (real VRF) ───────────────────────────────────────
  banner("3. RandomProvider (production VRF wrapper)");

  step("Deploying RandomProvider");
  const randomProvider = await viem.deployContract("RandomProvider", [env.vrfCoordinator]);
  ok(`RandomProvider: ${randomProvider.address}`);

  step("Setting VRF key hash + subscription ID");
  await randomProvider.write.setKeyHash([env.vrfKeyHash]);
  await randomProvider.write.setSubscriptionId([env.vrfSubscriptionId]);
  ok("Key hash + subId set");

  // ── 4. ProgressiveJackpot ──────────────────────────────────────────────
  banner("4. ProgressiveJackpot");

  step("Deploying ProgressiveJackpot");
  const pj = await viem.deployContract("ProgressiveJackpot", [
    token.address as Addr,
    randomProvider.address,
    authHub.address,
  ]);
  ok(`ProgressiveJackpot: ${pj.address}`);

  step("Wiring PJ ↔ PaymentHandler (both directions)");
  await pj.write.setPaymentHandler([paymentHandler.address]);
  await paymentHandler.write.setJackpot([pj.address]);
  ok("Both directions wired");

  step("Registering PJ as a RandomProvider consumer (maxRanges = 1)");
  await randomProvider.write.setConsumerStatus([pj.address, true, 1n]);
  ok("Consumer registered");

  step("Configuring PJ tier ladder (" + PJ_TIER_COUNT + " tiers, fixed " + PJ_TIER_COST + " EVA cost)");
  const tiers = Array.from({ length: PJ_TIER_COUNT }, (_, i) => ({
    prizeMetric: 0n,
    isTerminal: i === PJ_TIER_COUNT - 1,
    isPercent: false,
    fixedBetCost: PJ_TIER_COST,
    useDynamicCost: false,
    costBps: 0,
  }));
  await pj.write.setTierLadder([tiers]);
  await pj.write.setAllTierProbConfigs([PJ_PROB_BASE, PJ_PROB_MAX, PJ_PROB_INCREMENT]);
  ok("Tier ladder + probability config set");

  step("Configuring PJ direct-bet outcomes (lose + 2 consolation + 9 tier awards)");
  const directOutcomes: Array<{
    enabled: boolean;
    tierAdvance: number;
    tierResetTo: number;
    consolationMultiplier: number;
    awardsTier: boolean;
  }> = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
  ];
  for (let i = 0; i < PJ_TIER_COUNT; i++) {
    directOutcomes.push({
      enabled: true,
      tierAdvance: 1,
      tierResetTo: 0,
      consolationMultiplier: 0,
      awardsTier: true,
    });
  }
  const cdHash = await pj.write.configureDirectBet([true, directOutcomes]);
  await publicClient.waitForTransactionReceipt({ hash: cdHash });
  const sdHash = await pj.write.setDirectFallback([0]);
  await publicClient.waitForTransactionReceipt({ hash: sdHash });
  ok("Direct-bet outcomes configured");

  step("Registering PJ as a PaymentHandler game (for direct bets)");
  await paymentHandler.write.registerGame([
    pj.address,
    pj.address,
    walletAddrs.feeRecipient,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([pj.address, true]);
  ok("PJ registered as a game + AuthHub spend tracker");

  step("Seeding PJ pots (consolation + " + PJ_TIER_COUNT + " tiers × " + PJ_POT_SEED + " EVA)");
  // Single approve covers all the seedings
  const totalSeed = PJ_POT_SEED * BigInt(PJ_TIER_COUNT + 1);
  await token.write.approve([pj.address, totalSeed]);
  await pj.write.seedConsolationPot([PJ_POT_SEED]);
  for (let i = 0; i < PJ_TIER_COUNT; i++) {
    await pj.write.seedTierPot([i, PJ_POT_SEED]);
  }
  ok("Pots seeded");

  // ── 5. AuthHub operator allowlist ──────────────────────────────────────
  banner("5. AuthHub operator allowlist");
  step("Adding operator wallet to AuthHub allowlist");
  await authHub.write.setOperator([walletAddrs.operator, true]);
  ok(`Operator ${walletAddrs.operator} allowlisted`);

  // ── 6. Games ──────────────────────────────────────────────────────────
  banner("6. Games");

  // ── 6a. SingleRandomRoulette ──
  step("Deploying SingleRandomRoulette");
  const roulette = await viem.deployContract("SingleRandomRoulette", [
    paymentHandler.address,
    randomProvider.address,
    token.address as Addr,
    authHub.address,
  ]);
  ok(`SingleRandomRoulette: ${roulette.address}`);
  await randomProvider.write.setConsumerStatus([roulette.address, true, 8n]);
  await paymentHandler.write.registerGame([
    roulette.address, roulette.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([roulette.address, true]);
  await roulette.write.setTableConfig([
    {
      enabled: true,
      replayBps: 0,
      jackpotBps: JACKPOT_BPS,
      minMultiplier: ROULETTE_MIN_MULTIPLIER,
      maxMultiplier: ROULETTE_MAX_MULTIPLIER,
      minWager: 0n,
      maxWager: 0n,
    },
  ]);
  ok("Roulette configured (table enabled, registered, consumer + spend tracker)");

  // Register Roulette as a PJ game so jackpot entries route correctly
  const rouletteOutcomes: typeof directOutcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
  ];
  for (let i = 0; i < PJ_TIER_COUNT; i++) {
    rouletteOutcomes.push({
      enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });
  }
  const rgHash = await pj.write.registerGame([roulette.address, rouletteOutcomes]);
  await publicClient.waitForTransactionReceipt({ hash: rgHash });
  const sgfHash = await pj.write.setGameFallback([roulette.address, 0]);
  await publicClient.waitForTransactionReceipt({ hash: sgfHash });
  ok("Roulette registered on PJ for jackpot entries");

  // ── 6b. MultiLineSlots ──
  step("Deploying MultiLineSlots");
  const slots = await viem.deployContract("MultiLineSlots", [
    paymentHandler.address,
    randomProvider.address,
    token.address as Addr,
    authHub.address,
  ]);
  ok(`MultiLineSlots: ${slots.address}`);
  await randomProvider.write.setConsumerStatus([slots.address, true, 9n]);
  await paymentHandler.write.registerGame([
    slots.address, slots.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([slots.address, true]);

  // 4 active symbols (3 normal + 1 wild)
  const sym = (w: number, three: number, two: number, isWild: boolean, enabled: boolean) =>
    ({ weightBps: w, threeMatchPayout: three, twoMatchPayout: two, isWild, enabled });
  await slots.write.setAllSymbols([[
    sym(2500, 200, 50, false, true),  // S0: 2.0x triple
    sym(2500, 500, 100, false, true), // S1: 5.0x triple
    sym(2500, 1000, 200, false, true), // S2: 10x triple
    sym(2500, 0, 0, true, true),       // S3: wild
    sym(0, 0, 0, false, false), sym(0, 0, 0, false, false),
    sym(0, 0, 0, false, false), sym(0, 0, 0, false, false),
  ]]);
  await slots.write.setSlotsConfig([{
    enabled: true, activeSymbolCount: 4, minWagerPerLine: 0n, maxWagerPerLine: 0n,
  }]);
  ok("Slots configured (4 active symbols, table enabled)");

  // ── 6c. Plinko ──
  step("Deploying Plinko (initial operator = " + walletAddrs.operator + ")");
  const plinko = await viem.deployContract("Plinko", [
    paymentHandler.address,
    randomProvider.address,
    token.address as Addr,
    authHub.address,
    walletAddrs.operator,
    0n, // minBet
    0n, // maxBet
  ]);
  ok(`Plinko: ${plinko.address}`);
  await randomProvider.write.setConsumerStatus([plinko.address, true, 1n]);
  await paymentHandler.write.registerGame([
    plinko.address, plinko.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([plinko.address, true]);
  await plinko.write.setAllowedRows([[PLINKO_ROWS]]);
  await plinko.write.setMultipliers([PLINKO_ROWS, 0, plinkoMultipliers(PLINKO_ROWS, 50)]); // RiskLow
  await plinko.write.setMultipliers([PLINKO_ROWS, 1, plinkoMultipliers(PLINKO_ROWS, 30)]); // RiskMedium
  await plinko.write.setMultipliers([PLINKO_ROWS, 2, plinkoMultipliers(PLINKO_ROWS, 20)]); // RiskHigh
  ok("Plinko configured (rows " + PLINKO_ROWS + ", three risk levels)");

  // ── 6d. MinesGameHybrid ──
  // Mines uses the unified gameOperators allowlist for both lifecycle calls and
  // off-chain attestation signing. We seed `operator` at construction and add
  // `oracleSigner` as a second allowlisted operator so play scripts can keep
  // signing attestations from a separate hot key.
  step("Deploying MinesGameHybridV2 (operator)");
  const mines = await viem.deployContract("MinesGameHybridV2", [
    token.address as Addr,
    paymentHandler.address,
    randomProvider.address,
    authHub.address,
    walletAddrs.operator,
  ]);
  ok(`MinesGameHybridV2: ${mines.address}`);
  await mines.write.setGameOperator([walletAddrs.oracleSigner, true]);
  await randomProvider.write.setConsumerStatus([mines.address, true, 1n]);
  await paymentHandler.write.registerGame([
    mines.address, mines.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([mines.address, true]);
  await mines.write.setTableConfig([{
    enabled: true,
    minMines: MINES_MIN,
    maxMines: MINES_MAX,
    minWager: 0n,
    maxWager: 0n,
    claimTimeout: MINES_CLAIM_TIMEOUT_SECONDS,
  }]);
  for (let m = MINES_MIN; m <= MINES_MAX; m++) {
    await mines.write.setMultiplierTable([m, minesMultiplierTable(m)]);
  }
  ok("Mines configured (mines range " + MINES_MIN + "-" + MINES_MAX + ", attestation signers: " + walletAddrs.operator + ", " + walletAddrs.oracleSigner + ")");

  // ── 6e. PaymentOnlyGameAdapter ──
  step("Deploying PaymentOnlyGameAdapter (operator = " + walletAddrs.operator + ")");
  const payAdapter = await viem.deployContract("PaymentOnlyGameAdapter", [
    token.address as Addr,
    paymentHandler.address,
    authHub.address,
    walletAddrs.operator,
  ]);
  ok(`PaymentOnlyGameAdapter: ${payAdapter.address}`);
  await paymentHandler.write.registerGame([
    payAdapter.address, payAdapter.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([payAdapter.address, true]);
  ok("PaymentOnlyGameAdapter registered");

  // ── 6f. TicketLottery (talks to coordinator DIRECTLY, not via RandomProvider) ──
  step("Deploying TicketLottery (operator = " + walletAddrs.operator + ")");
  const lottery = await viem.deployContract("TicketLottery", [
    env.vrfCoordinator,
    env.vrfKeyHash,
    env.vrfSubscriptionId,
    walletAddrs.operator,
  ]);
  ok(`TicketLottery: ${lottery.address}`);

  // ── 6g. CrashGame ──
  // PushVRFGame shape. Constructor: (token, paymentHandler, randomProvider, admin, authHub, operator).
  // Game-lifecycle ops (createRound / startRound / revealSeed / settleRoundExposure / submitMerkleRoot
  // / depositBond / withdrawBond) are gated to `gameOperators` — the constructor seeds `walletAddrs.operator`
  // as the initial one.
  step("Deploying CrashGame (admin = deployer, operator = " + walletAddrs.operator + ")");
  const crash = await viem.deployContract("CrashGame", [
    token.address as Addr,
    paymentHandler.address,
    randomProvider.address,
    deployer,             // admin (Ownable2Step) — multisig in production
    authHub.address,
    walletAddrs.operator, // initial gameOperator
  ]);
  ok(`CrashGame: ${crash.address}`);
  await randomProvider.write.setConsumerStatus([crash.address, true, 1n]);
  await paymentHandler.write.registerGame([
    crash.address, crash.address, walletAddrs.feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);
  await authHub.write.setSpendTracker([crash.address, true]);

  // Testnet-friendly tuning (defaults are production-shape: 1000 EVA bond, 5 EVA max bet).
  // We mirror what `crash-mainnet.json` uses: 10 EVA bond, 0.1–1 EVA bets, 100 EVA cap per round.
  // NOTE on multiplier convention: CrashGame uses 4-decimal basis points, NOT 2.
  //   10_000   = 1.0000x (this is MIN_MULTIPLIER's threshold zone — below 10_100 reverts)
  //   1_000_000 = 100.0000x
  //   5_000_000 = 500.0000x (DEFAULT_MAX_MULTIPLIER)
  // The mainnet json description "100.00x" maps to the raw uint32 1_000_000.
  step("Configuring CrashGame (testnet limits)");
  await crash.write.setBetLimits([parseEther("0.1"), parseEther("1")]);
  await crash.write.setMaxPayoutPerRound([parseEther("100")]);
  await crash.write.setMaxMultiplier([1_000_000]); // 100.00x — 4-decimal bps
  await crash.write.setOperatorBondAmount([parseEther("10")]);
  ok("CrashGame configured");

  // Deposit the operator bond. CrashGame tracks `bond[msg.sender]` per operator
  // and gates `createRound` on the caller's bond ≥ operatorBondAmount. The bond
  // MUST come from the operator wallet itself — depositing as deployer would
  // credit the deployer's slot and leave the operator unable to open rounds.
  //
  // Flow: deployer funds the operator wallet with just enough ETH for two txs
  // (approve + depositBond), then transfers the bond amount in EVA. The
  // operator wallet then approves and deposits from its own client.
  const CRASH_OPERATOR_BOND = parseEther("10");
  const OPERATOR_GAS_ETH = parseEther("0.002"); // ~2 txs on Arbitrum Sepolia + slack

  step(`Funding operator wallet with gas + bond capital`);
  const operatorEthBal = await publicClient.getBalance({ address: walletAddrs.operator });
  if (operatorEthBal < OPERATOR_GAS_ETH) {
    const delta = OPERATOR_GAS_ETH - operatorEthBal;
    const ethHash = await deployerWallet.sendTransaction({
      to: walletAddrs.operator,
      value: delta,
    });
    await publicClient.waitForTransactionReceipt({ hash: ethHash });
    ok(`Operator ETH: +${formatEther(delta)} (was ${formatEther(operatorEthBal)}, target ${formatEther(OPERATOR_GAS_ETH)})`);
  } else {
    ok(`Operator ETH: already ${formatEther(operatorEthBal)} (≥${formatEther(OPERATOR_GAS_ETH)})`);
  }
  const evaHash = await token.write.transfer([walletAddrs.operator, CRASH_OPERATOR_BOND]);
  await publicClient.waitForTransactionReceipt({ hash: evaHash });
  ok(`Operator EVA: +${formatEther(CRASH_OPERATOR_BOND)} → ${walletAddrs.operator}`);

  // Build a viem walletClient bound to the operator account so it can sign
  // approve + depositBond txs directly. nonceManager keeps the two sequential
  // sends from racing on the chain-read nonce.
  const operatorClient = createWalletClient({
    account: { ...wallets.operator, nonceManager } as Account,
    chain: arbitrumSepolia,
    transport: http(env.rpcUrl),
  });

  const erc20ApproveAbi = [
    {
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ name: "", type: "bool" }],
    },
  ] as const;
  const depositBondAbi = [
    {
      type: "function",
      name: "depositBond",
      stateMutability: "nonpayable",
      inputs: [{ name: "amount", type: "uint256" }],
      outputs: [],
    },
  ] as const;

  step(`Operator approves CrashGame for ${formatEther(CRASH_OPERATOR_BOND)} EVA`);
  const approveHash = await operatorClient.writeContract({
    address: token.address as Addr,
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [crash.address, CRASH_OPERATOR_BOND],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  ok(`approve mined: ${approveHash}`);

  step(`Operator deposits ${formatEther(CRASH_OPERATOR_BOND)} EVA bond on CrashGame`);
  const depositHash = await operatorClient.writeContract({
    address: crash.address,
    abi: depositBondAbi,
    functionName: "depositBond",
    args: [CRASH_OPERATOR_BOND],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  ok(`Bond deposited by operator (${walletAddrs.operator}): ${depositHash}`);

  // ── 7. Bankroll each game ─────────────────────────────────────────────
  banner("7. Bankrolling games");
  for (const [label, game] of [
    ["Roulette", roulette],
    ["Slots", slots],
    ["Plinko", plinko],
    ["Mines", mines],
    ["PaymentOnlyGameAdapter", payAdapter],
    ["ProgressiveJackpot", pj],
    ["CrashGame", crash],
  ] as const) {
    await token.write.transfer([game.address, GAME_BANKROLL]);
    ok(`Transferred ${parseFloat((Number(GAME_BANKROLL) / 1e18).toFixed(2))} EVA → ${label}`);
  }

  // ── 8. Register VRF consumers on the Chainlink subscription ───────────
  banner("8. Chainlink VRF subscription wiring");
  console.log(
    "Adding RandomProvider + TicketLottery as consumers on subscription " +
      env.vrfSubscriptionId.toString(),
  );

  await addVrfConsumer(
    deployerWallet, publicClient, env.vrfCoordinator,
    env.vrfSubscriptionId, randomProvider.address, "RandomProvider",
  );
  await addVrfConsumer(
    deployerWallet, publicClient, env.vrfCoordinator,
    env.vrfSubscriptionId, lottery.address, "TicketLottery",
  );

  // Verify the subscription sees both
  try {
    const sub = await publicClient.readContract({
      address: env.vrfCoordinator,
      abi: VRF_COORD_ABI,
      functionName: "getSubscription",
      args: [env.vrfSubscriptionId],
    });
    const consumers = sub[4] as readonly Address[];
    console.log(`  Subscription LINK balance:    ${sub[0]} juels`);
    console.log(`  Subscription native balance:  ${sub[1]} wei`);
    console.log(`  Subscription owner:           ${sub[3]}`);
    console.log(`  Subscription consumers (${consumers.length}):`);
    for (const c of consumers) {
      const tag =
        c.toLowerCase() === randomProvider.address.toLowerCase() ? "  ← RandomProvider"
        : c.toLowerCase() === lottery.address.toLowerCase()        ? "  ← TicketLottery"
        : "";
      console.log(`    ${c}${tag}`);
    }
  } catch (e) {
    console.warn("  ⚠ Could not read subscription state:", (e as Error).message);
  }

  // ── 9. Save deployment ────────────────────────────────────────────────
  banner("9. Saving deployment");
  const deployment: Deployment = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer,
    vrf: {
      coordinator: env.vrfCoordinator,
      keyHash: env.vrfKeyHash,
      subscriptionId: env.vrfSubscriptionId.toString(),
    },
    wallets: walletAddrs,
    contracts: {
      evaToken: token.address,
      authHub: authHub.address,
      mlr: mlr.address,
      paymentHandler: paymentHandler.address,
      randomProvider: randomProvider.address,
      progressiveJackpot: pj.address,
      roulette: roulette.address,
      slots: slots.address,
      plinko: plinko.address,
      mines: mines.address,
      paymentOnlyGameAdapter: payAdapter.address,
      ticketLottery: lottery.address,
      crashGame: crash.address,
    },
  };
  const savedPath = await saveDeployment(deployment);
  ok(`Deployment saved → ${savedPath}`);

  banner("DEPLOYMENT COMPLETE");
  console.log("Next steps:");
  console.log("  1. npx hardhat run scripts/testnet/setup.ts --network arbitrumSepolia");
  console.log("     → funds testnet wallets with ETH + EVA, submits approvals, authorizes session key");
  console.log("  2. Play scripts (TBD) will read the deployment JSON and run interactions.\n");
}

main().catch((e) => {
  console.error("\n✖ Deploy failed:", e);
  process.exit(1);
});
