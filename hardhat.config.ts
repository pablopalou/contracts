import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import "dotenv/config";

// Falls back to the public endpoint so `hardhat compile` / `hardhat test` work without
// secrets (CI, fresh clones). Mainnet deploy/play scripts should still set a dedicated RPC.
const PUBLIC_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
const rpcMainnet = (process.env.MAINNET_ARBITRUM_RPC_URL ?? process.env.ARBITRUM_RPC_URL ?? "").trim() || PUBLIC_ARBITRUM_RPC;
const privMainnet = (process.env.MAINNET_DEPLOYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
const PUBLIC_ARBITRUM_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const rpcSepolia = (process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "").trim() || PUBLIC_ARBITRUM_SEPOLIA_RPC;
const privSepolia = (process.env.DEPLOYER_PRIVATE_KEY ?? privMainnet).trim();
const arbiscanKey = (process.env.MAINNET_ARBISCAN_API_KEY ?? process.env.ARBISCAN_API_KEY ?? "").trim();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.20",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.20",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 800,
          },
        },
      },
    },
  },
  networks: {
    hardhatArbitrum: {
      type: "edr-simulated",
      chainType: "generic",
    },
    arbitrum: {
      type: "http",
      chainType: "generic",
      url: rpcMainnet,
      accounts: privMainnet ? [privMainnet] : [],
    },
    arbitrumSepolia: {
      type: "http",
      chainType: "generic",
      url: rpcSepolia,
      accounts: privSepolia ? [privSepolia] : [],
    },
  },
  paths: {
    sources: "./contracts",
  },
  verify: {
    etherscan: {
      apiKey: arbiscanKey,
    },
  },
};

export default config;
