/**
 * Configures the three Tigrinho slots (1-line / 3-line / 5-line) on the
 * deployed SlotsTable using the solver-certified fixtures, and verifies
 * getRtpBps() matches the fixture's own rtpBps after each setConfig call.
 *
 *   npx hardhat run scripts/testnet/configure-slotstable.ts --network arbitrumSepolia
 */

import { network } from "hardhat";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDeployment } from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Addr = `0x${string}`;

type FixtureTier = { probability: string; payoutMultiplierHundredths: number };
type Fixture = { rtpBps: number; tiers: FixtureTier[] };

// configIndex 0 = 1-line, 1 = 3-line, 2 = 5-line — matches Doc "slots" convention.
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
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  const deployment = await loadDeployment(networkName);
  if (!deployment.contracts.slotsTable) {
    throw new Error("SlotsTable not deployed yet — run deploy-slotstable.ts first.");
  }
  const slotsTable = await viem.getContractAt(
    "SlotsTable",
    deployment.contracts.slotsTable as Addr,
  );

  banner("Configuring SlotsTable slots from solver fixtures");

  for (const { configIndex, file } of SLOTS) {
    const raw = await fs.readFile(
      path.join(__dirname, "fixtures", file),
      "utf8",
    );
    const fixture = JSON.parse(raw) as Fixture;

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

  banner("DONE — all three slots configured and RTP-certified");
}

main().catch((e) => {
  console.error("\n✖ Configuration failed:", e);
  process.exit(1);
});
