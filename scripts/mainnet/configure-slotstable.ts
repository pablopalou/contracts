/**
 * Configures the three Tigrinho slots (1-line / 3-line / 5-line) on the
 * mainnet SlotsTable using the SAME solver-certified fixtures already
 * verified on testnet (RTP tables are math, not network-specific — see
 * scripts/testnet/fixtures/), and verifies getRtpBps() matches the
 * fixture's own rtpBps after each setConfig call.
 *
 * Run once, after deploy-slotstable.ts:
 *   CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/configure-slotstable.ts --network arbitrum
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Shared with testnet — these are solver-certified paytables (probabilities +
// payout multipliers), not addresses, so they don't need a mainnet-local copy.
const FIXTURES_DIR = path.join(__dirname, "..", "testnet", "fixtures");

type Addr = `0x${string}`;

type FixtureTier = { probability: string; payoutMultiplierHundredths: number };
type Fixture = { rtpBps: number; tiers: FixtureTier[] };

// configIndex 0 = 1-line, 1 = 3-line, 2 = 5-line — matches the testnet convention.
const SLOTS: { configIndex: number; file: string }[] = [
  { configIndex: 0, file: "tigrinho-1line.runtime.json" },
  { configIndex: 1, file: "tigrinho-3line.runtime.json" },
  { configIndex: 2, file: "tigrinho-5line.runtime.json" },
];

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
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "Refusing to run against mainnet without CONFIRM_MAINNET=yes. Re-run as:\n" +
        "  CONFIRM_MAINNET=yes npx hardhat run scripts/mainnet/configure-slotstable.ts --network arbitrum",
    );
  }

  const deploymentFile = new URL("./deployments/slotstable-mainnet.json", import.meta.url);
  const raw = await fs.readFile(deploymentFile, "utf8").catch(() => {
    throw new Error(
      `${deploymentFile.pathname} not found — run deploy-slotstable.ts first.`,
    );
  });
  const deployment = JSON.parse(raw) as { slotsTable: Addr };

  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  if (networkName !== "arbitrum") {
    throw new Error(`This script targets --network arbitrum; got "${networkName}".`);
  }

  const slotsTable = await viem.getContractAt("SlotsTable", deployment.slotsTable);

  banner("Configuring mainnet SlotsTable from solver fixtures");
  console.log("SlotsTable:", deployment.slotsTable);

  for (const { configIndex, file } of SLOTS) {
    const rawFixture = await fs.readFile(path.join(FIXTURES_DIR, file), "utf8");
    const fixture = JSON.parse(rawFixture) as Fixture;

    step(`configIndex ${configIndex} (${file}) — ${fixture.tiers.length} tiers, target RTP ${fixture.rtpBps} bps`);

    const tiers = fixture.tiers.map((t) => ({
      probability: BigInt(t.probability),
      payoutMultiplierHundredths: t.payoutMultiplierHundredths,
    }));

    const tx = await slotsTable.write.setConfig([
      configIndex,
      {
        enabled: true,
        minWager: 0n,
        maxWager: 0n,
        maxMultiplierHundredths: 0, // derived on-chain, overwritten
        cachedRtpBps: 0,            // derived on-chain, overwritten
      },
      tiers,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    ok(`setConfig mined: ${tx}`);

    const onChainRtp = await slotsTable.read.getRtpBps([configIndex]);
    if (onChainRtp !== fixture.rtpBps) {
      throw new Error(
        `RTP mismatch on configIndex ${configIndex}: fixture says ${fixture.rtpBps} bps, ` +
          `on-chain getRtpBps() returned ${onChainRtp} bps`,
      );
    }
    ok(`Certified: on-chain RTP == fixture RTP (${onChainRtp} bps)`);
  }

  banner("DONE — all three slots configured and RTP-certified on mainnet");
}

main().catch((e) => {
  console.error("\n✖ Configuration failed:", e);
  process.exit(1);
});
