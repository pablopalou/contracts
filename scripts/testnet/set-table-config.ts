/**
 * Update roulette TableConfig on testnet — sets minWager and maxWager.
 *
 *   npx hardhat run scripts/testnet/set-table-config.ts --network arbitrumSepolia
 */

import { network } from "hardhat";
import { parseEther, formatEther } from "viem";

import { loadDeployment } from "./lib.js";
import { banner, step, ok } from "./play-lib.js";

const ROULETTE_ABI = [
  {
    inputs: [],
    name: "getTableConfig",
    outputs: [{
      components: [
        { name: "enabled",       type: "bool"    },
        { name: "replayBps",     type: "uint16"  },
        { name: "jackpotBps",    type: "uint16"  },
        { name: "minMultiplier", type: "uint16"  },
        { name: "maxMultiplier", type: "uint16"  },
        { name: "minWager",      type: "uint256" },
        { name: "maxWager",      type: "uint256" },
      ],
      internalType: "struct SingleRandomRoulette.TableConfig",
      name: "", type: "tuple",
    }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{
      components: [
        { name: "enabled",       type: "bool"    },
        { name: "replayBps",     type: "uint16"  },
        { name: "jackpotBps",    type: "uint16"  },
        { name: "minMultiplier", type: "uint16"  },
        { name: "maxMultiplier", type: "uint16"  },
        { name: "minWager",      type: "uint256" },
        { name: "maxWager",      type: "uint256" },
      ],
      internalType: "struct SingleRandomRoulette.TableConfig",
      name: "config", type: "tuple",
    }],
    name: "setTableConfig",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function main() {
  const conn = await network.connect();
  const networkName = conn.networkName;
  const viem = conn.viem;
  const deployment = await loadDeployment(networkName);
  const rouletteAddress = deployment.contracts.roulette as `0x${string}`;

  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  banner("Update Roulette TableConfig — minWager & maxWager");
  console.log("Roulette: ", rouletteAddress);
  console.log("Deployer: ", deployer.account.address);

  const MIN_WAGER = parseEther("0.1");   // 0.1 EVA
  const MAX_WAGER = parseEther("1000");  // 1000 EVA

  step("Reading current TableConfig...");
  const current = await publicClient.readContract({
    address: rouletteAddress,
    abi: ROULETTE_ABI,
    functionName: "getTableConfig",
  });

  console.log(`  enabled:       ${current.enabled}`);
  console.log(`  replayBps:     ${current.replayBps}`);
  console.log(`  jackpotBps:    ${current.jackpotBps}`);
  console.log(`  minMultiplier: ${current.minMultiplier} (x${current.minMultiplier / 100})`);
  console.log(`  maxMultiplier: ${current.maxMultiplier} (x${current.maxMultiplier / 100})`);
  console.log(`  minWager:      ${formatEther(current.minWager)} EVA`);
  console.log(`  maxWager:      ${formatEther(current.maxWager)} EVA`);

  step(`Calling setTableConfig(minWager=${formatEther(MIN_WAGER)}, maxWager=${formatEther(MAX_WAGER)})...`);

  const hash = await deployer.writeContract({
    address: rouletteAddress,
    abi: ROULETTE_ABI,
    functionName: "setTableConfig",
    args: [{
      enabled:       current.enabled,
      replayBps:     current.replayBps,
      jackpotBps:    current.jackpotBps,
      minMultiplier: current.minMultiplier,
      maxMultiplier: current.maxMultiplier,
      minWager:      MIN_WAGER,
      maxWager:      MAX_WAGER,
    }],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  ok(`tx: ${hash}`);

  const updated = await publicClient.readContract({
    address: rouletteAddress,
    abi: ROULETTE_ABI,
    functionName: "getTableConfig",
  });
  ok(`minWager: ${formatEther(updated.minWager)} EVA`);
  ok(`maxWager: ${formatEther(updated.maxWager)} EVA`);
  banner("Done");
}

main().catch((e) => { console.error(e); process.exit(1); });
