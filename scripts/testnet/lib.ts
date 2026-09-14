/**
 * Shared helpers for testnet scripts:
 *   - env-var loading + validation
 *   - testnet wallet derivation from TESTNET_SEED (BIP-44 path indices 0..N)
 *   - deployment file I/O (single source of truth for play scripts)
 *
 * Every script under scripts/testnet should import from here so addresses and
 * configuration stay consistent across deploy → setup → play stages.
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

// ESM equivalent of __dirname (the project's tsconfig targets NodeNext ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Addr = `0x${string}`;

// ── env ────────────────────────────────────────────────────────────────────

export interface TestnetEnv {
  rpcUrl: string;
  deployerKey: Addr;
  vrfCoordinator: Addr;
  vrfKeyHash: Addr;
  vrfSubscriptionId: bigint;
  testnetSeed: string;
  arbiscanApiKey?: string;
}

function readEnv(name: string, optional = false): string {
  const v = (process.env[name] ?? "").trim();
  if (!v && !optional) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function asAddress(v: string, label: string): Addr {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`${label} is not a valid address: ${v}`);
  }
  return v as Addr;
}

function asBytes32(v: string, label: string): Addr {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${label} is not a valid bytes32: ${v}`);
  }
  return v as Addr;
}

function asPrivateKey(v: string, label: string): Addr {
  const stripped = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`${label} is not a valid 32-byte private key`);
  }
  return stripped as Addr;
}

export function loadTestnetEnv(): TestnetEnv {
  return {
    rpcUrl: readEnv("ARBITRUM_SEPOLIA_RPC_URL"),
    deployerKey: asPrivateKey(readEnv("DEPLOYER_PRIVATE_KEY"), "DEPLOYER_PRIVATE_KEY"),
    vrfCoordinator: asAddress(readEnv("VRF_COORDINATOR"), "VRF_COORDINATOR"),
    vrfKeyHash: asBytes32(readEnv("VRF_KEY_HASH"), "VRF_KEY_HASH"),
    vrfSubscriptionId: BigInt(readEnv("VRF_SUBSCRIPTION_ID")),
    testnetSeed: readEnv("TESTNET_SEED"),
    arbiscanApiKey: readEnv("ARBISCAN_API_KEY", true) || undefined,
  };
}

// ── wallet derivation ─────────────────────────────────────────────────────

/**
 * Explicit role → BIP-44 path index map.
 *
 * `operator` is parked at idx 10 (instead of the natural idx 2) so it lives
 * OUTSIDE the operatorsServer wallet pool's derivation range (idx 1..N, with
 * default OPERATOR_COUNT=4). Sharing a single EOA between the gameOperator
 * role and a batch operator caused cross-process nonce races — each side has
 * its own in-process nonceManager, neither sees the other's pending txs, and
 * the operator EOA ends up with "nonce too high" rejections. Keeping a gap
 * of ~5 indices gives room to grow OPERATOR_COUNT without re-colliding.
 *
 * Adding new roles? Append with a fresh index — DO NOT reuse a previously
 * occupied slot or you'll silently change a deployed address.
 */
export const TESTNET_ROLE_PATH_INDEX = {
  player1: 0,
  player2: 1,
  sessionKey: 3,
  oracleSigner: 4,
  feeRecipient: 5,
  defaultReceiver: 6,
  operator: 10,
} as const;

export type TestnetRole = keyof typeof TESTNET_ROLE_PATH_INDEX;

export const TESTNET_ROLES = Object.keys(TESTNET_ROLE_PATH_INDEX) as readonly TestnetRole[];

export type TestnetWallets = Record<TestnetRole, HDAccount>;

export function deriveTestnetWallets(seed: string): TestnetWallets {
  const out = {} as TestnetWallets;
  for (const role of TESTNET_ROLES) {
    const idx = TESTNET_ROLE_PATH_INDEX[role];
    out[role] = mnemonicToAccount(seed, { path: `m/44'/60'/0'/0/${idx}` });
  }
  return out;
}

export function summarizeWallets(wallets: TestnetWallets): Record<TestnetRole, Addr> {
  const out = {} as Record<TestnetRole, Addr>;
  for (const role of TESTNET_ROLES) {
    out[role] = wallets[role].address;
  }
  return out;
}

// ── deployment file I/O ───────────────────────────────────────────────────

/**
 * The core platform contracts a new game needs to talk to. A new game team
 * runs `deploy-core.ts` to bootstrap these, then deploys their game contract
 * against the addresses captured here.
 */
export interface CoreContracts {
  evaToken: Addr;
  authHub: Addr;
  mlr: Addr;
  paymentHandler: Addr;
  randomProvider: Addr;
  progressiveJackpot: Addr;
}

/** Every production game we've deployed so far. */
export interface GameContracts {
  roulette: Addr;
  slots: Addr;
  plinko: Addr;
  mines: Addr;
  paymentOnlyGameAdapter: Addr;
  ticketLottery: Addr;
  crashGame: Addr;
  /** Optional — absent until deploy-slotstable.ts has run once. */
  slotsTable?: Addr;
}

interface BaseDeployment {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: Addr;
  vrf: {
    coordinator: Addr;
    keyHash: Addr;
    subscriptionId: string; // bigint serialized as string
  };
  wallets: Record<TestnetRole, Addr>;
}

/** Core-only deployment record (no games). Produced by `deploy-core.ts`. */
export interface CoreDeployment extends BaseDeployment {
  contracts: CoreContracts;
}

/** Full deployment record (core + every platform game). Produced by `deploy.ts`. */
export interface Deployment extends BaseDeployment {
  contracts: CoreContracts & GameContracts;
}

const DEPLOYMENT_DIR = path.join(__dirname, "..", "..", "deployments");

export function deploymentPath(networkName: string): string {
  return path.join(DEPLOYMENT_DIR, `${networkName}.json`);
}

export function coreDeploymentPath(networkName: string): string {
  return path.join(DEPLOYMENT_DIR, `${networkName}-core.json`);
}

export async function saveDeployment(d: Deployment): Promise<string> {
  await fs.mkdir(DEPLOYMENT_DIR, { recursive: true });
  const p = deploymentPath(d.network);
  await fs.writeFile(p, JSON.stringify(d, null, 2) + "\n", "utf8");
  return p;
}

export async function saveCoreDeployment(d: CoreDeployment): Promise<string> {
  await fs.mkdir(DEPLOYMENT_DIR, { recursive: true });
  const p = coreDeploymentPath(d.network);
  await fs.writeFile(p, JSON.stringify(d, null, 2) + "\n", "utf8");
  return p;
}

export async function loadDeployment(networkName: string): Promise<Deployment> {
  const p = deploymentPath(networkName);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as Deployment;
}

export async function loadCoreDeployment(networkName: string): Promise<CoreDeployment> {
  const p = coreDeploymentPath(networkName);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as CoreDeployment;
}
