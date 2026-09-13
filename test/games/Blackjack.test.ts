import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodeFunctionData, keccak256, toHex, parseEther, toFunctionSelector, type Hex } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert as expectRevertRaw } from "../helpers/utils.js";
import { KeccakShoe, commitFor, deriveRoundSeed } from "../helpers/blackjack/shoe.js";
import { RoundRun } from "../helpers/blackjack/blackjack.js";
import { Action, actionsHash, actionsToBytes, type ActionCode } from "../helpers/blackjack/actions.js";
import { isAce } from "../helpers/blackjack/cards.js";

/**
 * BlackjackGame lifecycle tests: start (direct + relayed), extra wagers, settle
 * with on-chain replay, abandoned resolution, expiry refunds, admin, batching.
 *
 * Scenarios are constructed by searching the VRF word that deals the wanted
 * cards, using the vendored TypeScript engine (pinned to the Solidity replay by
 * the golden vectors in Blackjack.engine.test.ts).
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

const W = { deployer: 0, playerA: 1, sessionA: 2, operator: 3, feeRecipient: 4, defaultRcv: 5, playerB: 6, sessionB: 7, other: 12 } as const;
const HOUSE_BPS = 45;
const REFERRAL_BPS = 45;
const STAKE = ONE_EVA;
const SIDE = parseEther("0.2");
const TABLE = { enabled: true, minBet: parseEther("0.1"), maxBet: parseEther("2"), maxSideBet: parseEther("0.5"), settleTimeout: 600, refundTimeout: 3600 };
const ST = { None: 0, Active: 1, Settled: 2, Refunded: 3 } as const;
const KIND = { Double: 0, Split: 1, Insurance: 2 } as const;

/** The Hardhat node does not decode the custom errors raised inside the base
 *  modifiers (onlyOperator / onlyGameOperator) — it reports the raw selector —
 *  so accept either the error name or its 4-byte selector in the message. */
let gameAbi: any[] = [];
function errorText(err: unknown, depth = 0): string {
  if (depth > 10 || err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const e = err as Record<string, unknown> & { cause?: unknown };
  const parts: string[] = [];
  for (const key of ["message", "shortMessage", "details", "metaMessages", "reason", "name", "data"]) {
    const v = e[key];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.map(String).join(" "));
  }
  if (e.cause) parts.push(errorText(e.cause, depth + 1));
  return parts.join(" | ");
}
async function expectRevert(promise: Promise<unknown>, name: string): Promise<void> {
  const item = gameAbi.find((i) => i.type === "error" && i.name === name);
  const selector = item ? toFunctionSelector(`${name}(${item.inputs.map((x: any) => x.type).join(",")})`) : null;
  try {
    await promise;
  } catch (err) {
    const text = errorText(err);
    if (text.includes(name) || (selector && text.includes(selector))) return;
    return expectRevertRaw(Promise.reject(err), name);
  }
  throw new Error(`expected revert with "${name}" but call succeeded`);
}

let seedCounter = 0;
function freshServerSeed(): Hex {
  seedCounter++;
  return keccak256(toHex(`server-seed-${seedCounter}`));
}

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();
});

function addr(idx: number): `0x${string}` {
  return walletClients[idx].account.address;
}

interface Ctx {
  token: any;
  handler: any;
  provider: any;
  coordinator: any;
  authHub: any;
  game: any;
}

async function setup(opts: { bankroll?: bigint; table?: Partial<typeof TABLE> } = {}): Promise<Ctx> {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, addr(W.defaultRcv)]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  const provider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  await provider.write.setSubscriptionId([1n]);
  const authHub = await env.viem.deployContract("AuthHub");

  const game = await env.viem.deployContract("BlackjackGame", [
    token.address,
    handler.address,
    provider.address,
    authHub.address,
    addr(W.operator),
  ]);

  gameAbi = game.abi as any[];
  await provider.write.setConsumerStatus([game.address, true, 1n]);
  await handler.write.registerGame([game.address, game.address, addr(W.feeRecipient), HOUSE_BPS, REFERRAL_BPS, 0]);
  await authHub.write.setOperator([addr(W.operator), true]);
  await authHub.write.setSpendTracker([game.address, true]);
  await game.write.setTableConfig([{ ...TABLE, ...(opts.table ?? {}) }]);

  for (const idx of [W.playerA, W.playerB]) {
    await token.write.transfer([addr(idx), HUNDRED_EVA]);
    const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, { client: { wallet: walletClients[idx] } });
    await playerToken.write.approve([game.address, ONE_THOUSAND_EVA]);
  }
  const bankroll = opts.bankroll ?? HUNDRED_EVA;
  if (bankroll > 0n) await token.write.transfer([game.address, bankroll]);

  return { token, handler, provider, coordinator, authHub, game };
}

function gameAs(ctx: Ctx, idx: number) {
  return env.viem.getContractAt("BlackjackGame", ctx.game.address, { client: { wallet: walletClients[idx] } });
}

async function gameEvents(ctx: Ctx, eventName: string): Promise<any[]> {
  return publicClient.getContractEvents({ address: ctx.game.address, abi: ctx.game.abi, eventName, fromBlock: 0n } as any);
}

async function nowOnChain(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

async function authorizeSession(ctx: Ctx, playerIdx: number, sessionIdx: number, spendCap = 0n) {
  const hub = await env.viem.getContractAt("AuthHub", ctx.authHub.address, { client: { wallet: walletClients[playerIdx] } });
  await hub.write.authorize([addr(sessionIdx), 0n, spendCap]);
}

const domain = (ctx: Ctx) => ({ name: "BlackjackGame", version: "1", chainId, verifyingContract: ctx.game.address });

async function signStart(ctx: Ctx, playerIdx: number, signerIdx: number, msg: { stake?: bigint; sideBet?: bigint; referrer?: `0x${string}`; commit: Hex; nonce?: bigint; deadline?: bigint; game?: `0x${string}` }) {
  const player = addr(playerIdx);
  const nonce = msg.nonce ?? ((await ctx.game.read.actionNonces([player])) as bigint);
  const deadline = msg.deadline ?? (await nowOnChain()) + 3600n;
  const signature = await walletClients[signerIdx].signTypedData({
    domain: domain(ctx),
    types: {
      StartRound: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "stake", type: "uint128" },
        { name: "sideBet", type: "uint128" },
        { name: "potentialReferrer", type: "address" },
        { name: "commit", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartRound",
    message: { game: msg.game ?? ctx.game.address, player, stake: msg.stake ?? STAKE, sideBet: msg.sideBet ?? 0n, potentialReferrer: msg.referrer ?? ZERO_ADDRESS, commit: msg.commit, nonce, deadline },
  });
  return { player, nonce, deadline, signature };
}

async function signAddWager(ctx: Ctx, playerIdx: number, signerIdx: number, requestId: bigint, kind: number, over: { nonce?: bigint; deadline?: bigint } = {}) {
  const player = addr(playerIdx);
  const nonce = over.nonce ?? ((await ctx.game.read.actionNonces([player])) as bigint);
  const deadline = over.deadline ?? (await nowOnChain()) + 3600n;
  const signature = await walletClients[signerIdx].signTypedData({
    domain: domain(ctx),
    types: {
      AddWager: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "requestId", type: "uint256" },
        { name: "kind", type: "uint8" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AddWager",
    message: { game: ctx.game.address, player, requestId, kind, nonce, deadline },
  });
  return { nonce, deadline, signature };
}

async function signConfirm(ctx: Ctx, playerIdx: number, signerIdx: number, requestId: bigint, actions: readonly ActionCode[]) {
  return walletClients[signerIdx].signTypedData({
    domain: domain(ctx),
    types: {
      ConfirmRound: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "requestId", type: "uint256" },
        { name: "actionsHash", type: "bytes32" },
      ],
    },
    primaryType: "ConfirmRound",
    message: { game: ctx.game.address, player: addr(playerIdx), requestId, actionsHash: actionsHash(actions) },
  });
}

/** Direct startRound from the player's wallet. Returns the round id (the VRF requestId). */
async function startDirect(ctx: Ctx, playerIdx: number, opts: { stake?: bigint; sideBet?: bigint; serverSeed?: Hex } = {}) {
  const serverSeed = opts.serverSeed ?? freshServerSeed();
  const commit = commitFor(serverSeed, addr(playerIdx));
  const g = await gameAs(ctx, playerIdx);
  await g.write.startRound([opts.stake ?? STAKE, opts.sideBet ?? 0n, ZERO_ADDRESS, commit]);
  const requestId = (await ctx.game.read.activeRoundOf([addr(playerIdx)])) as bigint;
  return { requestId, serverSeed, commit, stake: opts.stake ?? STAKE, sideBet: opts.sideBet ?? 0n };
}

/** Find a VRF word whose deal satisfies `pred`, fulfill it on-chain, return the TS mirror of the round. */
async function dealMatching(
  ctx: Ctx,
  round: { requestId: bigint; serverSeed: Hex; stake: bigint; sideBet: bigint },
  pred: (run: RoundRun) => boolean,
): Promise<{ run: RoundRun; word: bigint }> {
  for (let w = 1n; w < 50_000n; w++) {
    const seed = deriveRoundSeed(round.serverSeed, w, round.requestId, ctx.game.address);
    const run = new RoundRun(new KeccakShoe(seed), { stake: round.stake, sideBet: round.sideBet });
    if (pred(run)) {
      await ctx.coordinator.write.fulfill([ctx.provider.address, round.requestId, [w]]);
      return { run, word: w };
    }
  }
  throw new Error("no word found");
}

const plainStand = (r: RoundRun) =>
  r.phase === "player" && !r.insuranceOffered && !r.legalActions().includes(Action.SPLIT) && !r.legalActions().includes(Action.DOUBLE);

async function settleAs(ctx: Ctx, operatorIdx: number, requestId: bigint, serverSeed: Hex, actions: readonly ActionCode[], signature: Hex) {
  const g = await gameAs(ctx, operatorIdx);
  const hash = await g.write.settle([requestId, serverSeed, actionsToBytes(actions), signature]);
  return publicClient.waitForTransactionReceipt({ hash });
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction & admin
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — construction & admin", () => {
  it("wires the platform, seeds the operator and exposes the rules version", async () => {
    const ctx = await setup();
    expect((await ctx.game.read.evaToken()).toLowerCase()).to.equal(ctx.token.address.toLowerCase());
    expect((await ctx.game.read.paymentHandler()).toLowerCase()).to.equal(ctx.handler.address.toLowerCase());
    expect((await ctx.game.read.randomProvider()).toLowerCase()).to.equal(ctx.provider.address.toLowerCase());
    expect((await ctx.game.read.authHub()).toLowerCase()).to.equal(ctx.authHub.address.toLowerCase());
    expect(await ctx.game.read.gameOperators([addr(W.operator)])).to.equal(true);
    expect(Number(await ctx.game.read.RULES_VERSION())).to.equal(1);
    const cfg = (await ctx.game.read.tableConfig()) as any[];
    expect(cfg[0]).to.equal(true);
    expect(cfg[1]).to.equal(TABLE.minBet);
  });

  it("setTableConfig validates bounds and is owner-only", async () => {
    const ctx = await setup();
    await expectRevert(ctx.game.write.setTableConfig([{ ...TABLE, minBet: 0n }]), "InvalidConfig");
    await expectRevert(ctx.game.write.setTableConfig([{ ...TABLE, maxBet: TABLE.minBet - 1n }]), "InvalidConfig");
    await expectRevert(ctx.game.write.setTableConfig([{ ...TABLE, settleTimeout: 0 }]), "InvalidConfig");
    await expectRevert(ctx.game.write.setTableConfig([{ ...TABLE, refundTimeout: 10 }]), "InvalidConfig");
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.setTableConfig([TABLE]), "Ownable");
    await ctx.game.write.setTableConfig([{ ...TABLE, enabled: false }]);
    const events = await gameEvents(ctx, "TableConfigUpdated");
    expect(events.length).to.be.greaterThan(0);
  });

  it("withdrawHouseFunds respects locked exposure", async () => {
    const ctx = await setup({ bankroll: parseEther("10") });
    await startDirect(ctx, W.playerA); // locks 2.5 EVA
    const free = (await ctx.game.read.availableLiquidity()) as bigint;
    expect(free).to.equal(parseEther("10") + (STAKE * 9910n) / 10000n - (STAKE * 5n) / 2n);
    await expectRevert(ctx.game.write.withdrawHouseFunds([addr(W.deployer), free + 1n]), "InsufficientFreeLiquidity");
    await expectRevert(ctx.game.write.withdrawHouseFunds([ZERO_ADDRESS, 1n]), "to");
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.withdrawHouseFunds([addr(W.other), 1n]), "Ownable");
    const before = (await ctx.token.read.balanceOf([addr(W.deployer)])) as bigint;
    await ctx.game.write.withdrawHouseFunds([addr(W.deployer), free]);
    expect((await ctx.token.read.balanceOf([addr(W.deployer)])) as bigint).to.equal(before + free);
    expect((await gameEvents(ctx, "HouseFundsWithdrawn")).length).to.equal(1);
  });

  it("pause blocks new rounds; emergencyWithdraw only when paused", async () => {
    const ctx = await setup();
    await ctx.game.write.pause();
    const g = await gameAs(ctx, W.playerA);
    await expectRevert(g.write.startRound([STAKE, 0n, ZERO_ADDRESS, keccak256("0x01")]), "Pausable: paused");
    await ctx.game.write.emergencyWithdraw([addr(W.deployer), 0n]);
    expect((await ctx.token.read.balanceOf([ctx.game.address])) as bigint).to.equal(0n);
    await ctx.game.write.unpause();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startRound
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — startRound", () => {
  it("collects the gross wager, pays fees, locks exposure and requests VRF", async () => {
    const ctx = await setup();
    const playerBefore = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    const { requestId, commit } = await startDirect(ctx, W.playerA, { sideBet: SIDE });
    expect(requestId).to.equal(1n);
    const gross = STAKE + SIDE;
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(playerBefore - gross);
    expect((await ctx.token.read.balanceOf([addr(W.feeRecipient)])) as bigint).to.equal((gross * BigInt(HOUSE_BPS)) / 10000n);
    const r = (await ctx.game.read.getRound([requestId])) as any;
    expect(r.player.toLowerCase()).to.equal(addr(W.playerA).toLowerCase());
    expect(r.status).to.equal(ST.Active);
    expect(r.stake).to.equal(STAKE);
    expect(r.sideBet).to.equal(SIDE);
    expect(r.commit).to.equal(commit);
    expect(r.locked).to.equal((STAKE * 5n) / 2n + SIDE * 26n);
    expect((await ctx.game.read.lockedExposure()) as bigint).to.equal(r.locked);
    expect(Number(await ctx.provider.read.getRequestStatus([requestId]))).to.equal(1);
    const started = await gameEvents(ctx, "RoundStarted");
    expect(started.length).to.equal(1);
    const placed = await gameEvents(ctx, "BetPlaced");
    expect(placed[0].args.amount).to.equal(gross);
    expect((await ctx.game.read.totalWagered([requestId])) as bigint).to.equal(gross);
  });

  it("validates config, commit, limits and single active round", async () => {
    const ctx = await setup();
    const g = await gameAs(ctx, W.playerA);
    const commit = keccak256("0x1234");
    await expectRevert(g.write.startRound([STAKE, 0n, ZERO_ADDRESS, `0x${"0".repeat(64)}`]), "InvalidCommit");
    await expectRevert(g.write.startRound([TABLE.minBet - 1n, 0n, ZERO_ADDRESS, commit]), "BetTooLow");
    await expectRevert(g.write.startRound([TABLE.maxBet + 1n, 0n, ZERO_ADDRESS, commit]), "BetTooHigh");
    await expectRevert(g.write.startRound([STAKE, TABLE.maxSideBet + 1n, ZERO_ADDRESS, commit]), "SideBetTooHigh");
    await startDirect(ctx, W.playerA);
    await expectRevert(g.write.startRound([STAKE, 0n, ZERO_ADDRESS, commit]), "ActiveRoundExists");
    await ctx.game.write.setTableConfig([{ ...TABLE, enabled: false }]);
    const gB = await gameAs(ctx, W.playerB);
    await expectRevert(gB.write.startRound([STAKE, 0n, ZERO_ADDRESS, commit]), "GameDisabled");
  });

  it("reverts on a misconfigured payout target and on a liquidity shortfall", async () => {
    const ctx = await setup({ bankroll: 0n });
    const g = await gameAs(ctx, W.playerA);
    await expectRevert(g.write.startRound([STAKE, 0n, ZERO_ADDRESS, keccak256("0x01")]), "LiquidityShortfall");
    await ctx.handler.write.updateGameConfig([ctx.game.address, addr(W.other), addr(W.feeRecipient), HOUSE_BPS, REFERRAL_BPS, 0]);
    await expectRevert(g.write.startRound([STAKE, 0n, ZERO_ADDRESS, keccak256("0x01")]), "PaymentHandlerMisconfigured");
  });

  it("startRoundFor: session-key signature, spend cap, nonce, deadline, game binding, operator gate", async () => {
    const ctx = await setup();
    const op = await gameAs(ctx, W.operator);
    const commit = commitFor(freshServerSeed(), addr(W.playerA));

    // no session key yet
    let s = await signStart(ctx, W.playerA, W.sessionA, { commit });
    await expectRevert(op.write.startRoundFor([s.player, STAKE, 0n, ZERO_ADDRESS, commit, s.nonce, s.deadline, s.signature]), "NoSessionKey");

    await authorizeSession(ctx, W.playerA, W.sessionA, STAKE + SIDE); // cap exactly one round with side bet
    const stranger = await gameAs(ctx, W.other);
    await expectRevert(stranger.write.startRoundFor([s.player, STAKE, 0n, ZERO_ADDRESS, commit, s.nonce, s.deadline, s.signature]), "NotOperator");

    const wrongGame = await signStart(ctx, W.playerA, W.sessionA, { commit, game: addr(W.other) });
    await expectRevert(op.write.startRoundFor([wrongGame.player, STAKE, 0n, ZERO_ADDRESS, commit, wrongGame.nonce, wrongGame.deadline, wrongGame.signature]), "InvalidSignature");
    const expired = await signStart(ctx, W.playerA, W.sessionA, { commit, deadline: 1n });
    await expectRevert(op.write.startRoundFor([expired.player, STAKE, 0n, ZERO_ADDRESS, commit, expired.nonce, expired.deadline, expired.signature]), "ExpiredDeadline");
    const badNonce = await signStart(ctx, W.playerA, W.sessionA, { commit, nonce: 7n });
    await expectRevert(op.write.startRoundFor([badNonce.player, STAKE, 0n, ZERO_ADDRESS, commit, badNonce.nonce, badNonce.deadline, badNonce.signature]), "InvalidNonce");
    const badSigner = await signStart(ctx, W.playerA, W.other, { commit });
    await expectRevert(op.write.startRoundFor([badSigner.player, STAKE, 0n, ZERO_ADDRESS, commit, badSigner.nonce, badSigner.deadline, badSigner.signature]), "InvalidSignature");

    // happy path with the side bet: charges the cap with the gross amount
    s = await signStart(ctx, W.playerA, W.sessionA, { commit, sideBet: SIDE });
    await op.write.startRoundFor([s.player, STAKE, SIDE, ZERO_ADDRESS, commit, s.nonce, s.deadline, s.signature]);
    expect((await ctx.game.read.actionNonces([addr(W.playerA)])) as bigint).to.equal(1n);
    expect((await ctx.authHub.read.remainingSpend([addr(W.playerA)])) as bigint).to.equal(0n);
    const requestId = (await ctx.game.read.activeRoundOf([addr(W.playerA)])) as bigint;
    expect(requestId).to.equal(1n);

    // replaying the same signature fails on the nonce
    await expectRevert(op.write.startRoundFor([s.player, STAKE, SIDE, ZERO_ADDRESS, commit, s.nonce, s.deadline, s.signature]), "InvalidNonce");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra wagers
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — addWager", () => {
  it("double / split are exclusive, insurance is half the stake, each locks 1.5× and is single-use", async () => {
    const ctx = await setup();
    const { requestId } = await startDirect(ctx, W.playerA);
    const g = await gameAs(ctx, W.playerA);
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;

    await g.write.addWager([requestId, KIND.Insurance]);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before - STAKE / 2n);
    await expectRevert(g.write.addWager([requestId, KIND.Insurance]), "WagerAlreadyAdded");

    await g.write.addWager([requestId, KIND.Double]);
    await expectRevert(g.write.addWager([requestId, KIND.Double]), "WagerAlreadyAdded");
    await expectRevert(g.write.addWager([requestId, KIND.Split]), "WagerConflict");

    const r = (await ctx.game.read.getRound([requestId])) as any;
    expect(r.doubled).to.equal(true);
    expect(r.split).to.equal(false);
    expect(r.insured).to.equal(true);
    expect(r.locked).to.equal((STAKE * 5n) / 2n + (STAKE * 3n) / 2n * 2n);
    expect((await ctx.game.read.totalWagered([requestId])) as bigint).to.equal(STAKE + STAKE + STAKE / 2n);
    const events = await gameEvents(ctx, "WagerAdded");
    expect(events.length).to.equal(2);

    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.addWager([requestId, KIND.Split]), "Unauthorized");
    await expectRevert(g.write.addWager([99n, KIND.Split]), "InvalidRequest");

    // the opposite exclusion
    const rb = await startDirect(ctx, W.playerB);
    const gB = await gameAs(ctx, W.playerB);
    await gB.write.addWager([rb.requestId, KIND.Split]);
    await expectRevert(gB.write.addWager([rb.requestId, KIND.Double]), "WagerConflict");
    await expectRevert(gB.write.addWager([rb.requestId, KIND.Split]), "WagerAlreadyAdded");
  });

  it("addWagerFor charges the spend cap with the wager amount", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, W.playerA, W.sessionA, STAKE + STAKE / 2n);
    const op = await gameAs(ctx, W.operator);
    const commit = commitFor(freshServerSeed(), addr(W.playerA));
    const s = await signStart(ctx, W.playerA, W.sessionA, { commit });
    await op.write.startRoundFor([s.player, STAKE, 0n, ZERO_ADDRESS, commit, s.nonce, s.deadline, s.signature]);
    const requestId = (await ctx.game.read.activeRoundOf([addr(W.playerA)])) as bigint;

    let w = await signAddWager(ctx, W.playerA, W.sessionA, requestId, KIND.Double);
    await expectRevert(op.write.addWagerFor([addr(W.playerA), requestId, KIND.Double, w.nonce, w.deadline, w.signature]), "SpendCapExceeded");
    w = await signAddWager(ctx, W.playerA, W.sessionA, requestId, KIND.Insurance);
    await op.write.addWagerFor([addr(W.playerA), requestId, KIND.Insurance, w.nonce, w.deadline, w.signature]);
    expect((await ctx.authHub.read.remainingSpend([addr(W.playerA)])) as bigint).to.equal(0n);
    expect(((await ctx.game.read.getRound([requestId])) as any).insured).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settle
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — settle", () => {
  it("replays a plain round on-chain, pays what the engine says and clears state (player wallet signature)", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const { run, word } = await dealMatching(ctx, round, plainStand);
    run.apply(Action.STAND);
    const expected = run.finish();
    const actions = run.actions;
    const sig = await signConfirm(ctx, W.playerA, W.playerA, round.requestId, actions);

    const preview = (await ctx.game.read.previewRound([round.requestId, round.serverSeed, actionsToBytes(actions), false])) as any;
    expect(preview.payout).to.equal(expected.payout);

    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    const receipt = await settleAs(ctx, W.operator, round.requestId, round.serverSeed, actions, sig);
    console.log(`      settle gas (plain stand): ${receipt.gasUsed}`);
    expect(Number(receipt.gasUsed)).to.be.lessThan(1_000_000);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + expected.payout);
    const r = (await ctx.game.read.getRound([round.requestId])) as any;
    expect(r.status).to.equal(ST.Settled);
    expect((await ctx.game.read.lockedExposure()) as bigint).to.equal(0n);
    expect((await ctx.game.read.activeRoundOf([addr(W.playerA)])) as bigint).to.equal(0n);
    const settled = await gameEvents(ctx, "RoundSettled");
    expect(settled.length).to.equal(1);
    expect(settled[0].args.vrfWord).to.equal(word);
    expect(settled[0].args.serverSeed).to.equal(round.serverSeed);
    expect(settled[0].args.abandoned).to.equal(false);
    expect(settled[0].args.payout).to.equal(expected.payout);
    const envelope = await gameEvents(ctx, "BetSettled");
    expect(envelope[0].args.payout).to.equal(expected.payout);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, actions, sig), "InvalidRequest");
  });

  it("accepts the AuthHub session key as signer and rejects anyone else", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, W.playerA, W.sessionA);
    const round = await startDirect(ctx, W.playerA);
    const { run } = await dealMatching(ctx, round, plainStand);
    run.apply(Action.STAND);
    const actions = run.actions;
    const bad = await signConfirm(ctx, W.playerA, W.other, round.requestId, actions);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, actions, bad), "InvalidPlayerSignature");
    const tampered = await signConfirm(ctx, W.playerA, W.sessionA, round.requestId, [Action.HIT]);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, actions, tampered), "InvalidPlayerSignature");
    const good = await signConfirm(ctx, W.playerA, W.sessionA, round.requestId, actions);
    await expectRevert(settleAs(ctx, W.other, round.requestId, round.serverSeed, actions, good), "NotGameOperator");
    await settleAs(ctx, W.operator, round.requestId, round.serverSeed, actions, good);
  });

  it("requires the VRF word and the committed server seed", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const sig = await signConfirm(ctx, W.playerA, W.playerA, round.requestId, [Action.STAND]);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, [Action.STAND], sig), "RandomNotReady");
    await expectRevert(ctx.game.read.previewRound([round.requestId, round.serverSeed, "0x01", false]), "RandomNotReady");
    await expectRevert(ctx.game.read.previewRound([77n, round.serverSeed, "0x01", false]), "InvalidRequest");
    await dealMatching(ctx, round, plainStand);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, freshServerSeed(), [Action.STAND], sig), "InvalidCommit");
    await expectRevert(settleAs(ctx, W.operator, round.requestId, `0x${"0".repeat(64)}`, [Action.STAND], sig), "InvalidCommit");
  });

  it("rejects illegal or incomplete logs, refunds an unused on-chain wager and rejects unfunded actions", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    await dealMatching(ctx, round, plainStand);
    const g = await gameAs(ctx, W.playerA);
    const bad = [Action.SPLIT] as ActionCode[];
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, bad, await signConfirm(ctx, W.playerA, W.playerA, round.requestId, bad)), "IllegalAction");
    const empty = [] as ActionCode[];
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, empty, await signConfirm(ctx, W.playerA, W.playerA, round.requestId, empty)), "IncompleteActions");
    const trailing = [Action.STAND, Action.STAND] as ActionCode[];
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, trailing, await signConfirm(ctx, W.playerA, W.playerA, round.requestId, trailing)), "TrailingActions");
    // a double played without paying for it is rejected
    const unfunded = [Action.DOUBLE] as ActionCode[];
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, unfunded, await signConfirm(ctx, W.playerA, W.playerA, round.requestId, unfunded)), "IllegalAction");
    // insurance bought on-chain but never usable in the play → refunded at settlement
    await g.write.addWager([round.requestId, KIND.Insurance]);
    const stand = [Action.STAND] as ActionCode[];
    const preview = (await ctx.game.read.previewRound([round.requestId, round.serverSeed, actionsToBytes(stand), false])) as any;
    expect(preview.wagerRefund).to.equal(STAKE / 2n);
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await settleAs(ctx, W.operator, round.requestId, round.serverSeed, stand, await signConfirm(ctx, W.playerA, W.playerA, round.requestId, stand));
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + preview.payout);
  });

  it("an action that costs money is rejected when its wager was not paid on-chain", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const { run } = await dealMatching(ctx, round, (r) => r.phase === "player" && r.legalActions().includes(Action.DOUBLE) && !r.legalActions().includes(Action.SPLIT));
    run.apply(Action.DOUBLE);
    const sig = await signConfirm(ctx, W.playerA, W.playerA, round.requestId, run.actions);
    await expectRevert(settleAs(ctx, W.operator, round.requestId, round.serverSeed, run.actions, sig), "UnfundedAction");
  });

  it("double: pulls the extra stake and pays 4× on a win", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const { run } = await dealMatching(
      ctx,
      round,
      (r) => r.phase === "player" && r.legalActions().includes(Action.DOUBLE) && !r.legalActions().includes(Action.SPLIT),
    );
    const g = await gameAs(ctx, W.playerA);
    await g.write.addWager([round.requestId, KIND.Double]);
    run.apply(Action.DOUBLE);
    const expected = run.finish();
    const sig = await signConfirm(ctx, W.playerA, W.playerA, round.requestId, run.actions);
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await settleAs(ctx, W.operator, round.requestId, round.serverSeed, run.actions, sig);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + expected.payout);
    expect(expected.hands[0].bet).to.equal(STAKE * 2n);
  });

  it("split: two hands, second hand dealt in turn, both settled", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const { run } = await dealMatching(ctx, round, (r) => r.phase === "player" && r.legalActions().includes(Action.SPLIT) && !isAce(r.hands[0].cards[0]));
    const g = await gameAs(ctx, W.playerA);
    await g.write.addWager([round.requestId, KIND.Split]);
    run.apply(Action.SPLIT);
    while (run.phase === "player") run.apply(Action.STAND);
    const expected = run.finish();
    expect(expected.hands.length).to.equal(2);
    const sig = await signConfirm(ctx, W.playerA, W.playerA, round.requestId, run.actions);
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    const receipt = await settleAs(ctx, W.operator, round.requestId, round.serverSeed, run.actions, sig);
    console.log(`      settle gas (split): ${receipt.gasUsed}`);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + expected.payout);
  });

  it("insurance pays 2:1 against a dealer natural; a player natural pays 3:2; Perfect Pairs pays on the side bet", async () => {
    const ctx = await setup();
    // insurance vs dealer natural
    const r1 = await startDirect(ctx, W.playerA);
    const d1 = await dealMatching(ctx, r1, (r) => r.insuranceOffered && r.dealerNatural && !r.playerNatural);
    const gA = await gameAs(ctx, W.playerA);
    await gA.write.addWager([r1.requestId, KIND.Insurance]);
    d1.run.apply(Action.INSURE_YES);
    const e1 = d1.run.finish();
    expect(e1.insurancePayout).to.equal((STAKE / 2n) * 3n);
    let before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await settleAs(ctx, W.operator, r1.requestId, r1.serverSeed, d1.run.actions, await signConfirm(ctx, W.playerA, W.playerA, r1.requestId, d1.run.actions));
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + e1.payout);

    // player natural 3:2 with a Perfect Pairs side bet that loses
    const r2 = await startDirect(ctx, W.playerA, { sideBet: SIDE });
    const d2 = await dealMatching(ctx, r2, (r) => r.playerNatural && !r.dealerNatural && !r.insuranceOffered);
    const e2 = d2.run.finish();
    expect(e2.payout).to.equal(STAKE + (STAKE * 3n) / 2n + e2.sideBetPayout);
    before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await settleAs(ctx, W.operator, r2.requestId, r2.serverSeed, [], await signConfirm(ctx, W.playerA, W.playerA, r2.requestId, []));
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + e2.payout);

    // Perfect Pairs win (any pair) with a side bet
    const r3 = await startDirect(ctx, W.playerB, { sideBet: SIDE });
    const d3 = await dealMatching(ctx, r3, (r) => r.sideBetOutcome !== "none" && r.phase === "player" && !r.insuranceOffered);
    while (d3.run.phase === "player") d3.run.apply(Action.STAND);
    const e3 = d3.run.finish();
    expect(e3.sideBetPayout > 0n).to.equal(true);
    before = (await ctx.token.read.balanceOf([addr(W.playerB)])) as bigint;
    await settleAs(ctx, W.operator, r3.requestId, r3.serverSeed, d3.run.actions, await signConfirm(ctx, W.playerB, W.playerB, r3.requestId, d3.run.actions));
    expect((await ctx.token.read.balanceOf([addr(W.playerB)])) as bigint).to.equal(before + e3.payout);
  });

  it("resolveAbandoned: only after settleTimeout, auto-stands, flags the settlement", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const { run } = await dealMatching(ctx, round, (r) => r.insuranceOffered && !r.dealerNatural && !r.playerNatural);
    const op = await gameAs(ctx, W.operator);
    await expectRevert(op.write.resolveAbandoned([round.requestId, round.serverSeed, "0x"]), "TimeoutNotReached");
    await env.networkHelpers.time.increase(TABLE.settleTimeout + 1);
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.resolveAbandoned([round.requestId, round.serverSeed, "0x"]), "NotGameOperator");
    run.autoComplete();
    const expected = run.finish();
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await op.write.resolveAbandoned([round.requestId, round.serverSeed, "0x"]);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + expected.payout);
    const settled = await gameEvents(ctx, "RoundSettled");
    expect(settled[0].args.abandoned).to.equal(true);
    expect(((await ctx.game.read.getRound([round.requestId])) as any).status).to.equal(ST.Settled);
    await expectRevert(op.write.resolveAbandoned([round.requestId, round.serverSeed, "0x"]), "InvalidRequest");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refunds
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — cancelExpired", () => {
  it("anyone after refundTimeout: refunds every gross wager and unlocks", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA, { sideBet: SIDE });
    const g = await gameAs(ctx, W.playerA);
    await g.write.addWager([round.requestId, KIND.Split]);
    await g.write.addWager([round.requestId, KIND.Insurance]);
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.cancelExpired([round.requestId]), "TimeoutNotReached");
    await env.networkHelpers.time.increase(TABLE.refundTimeout + 1);
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await other.write.cancelExpired([round.requestId]);
    const expectedRefund = STAKE + SIDE + STAKE + STAKE / 2n;
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + expectedRefund);
    expect(((await ctx.game.read.getRound([round.requestId])) as any).status).to.equal(ST.Refunded);
    expect((await ctx.game.read.lockedExposure()) as bigint).to.equal(0n);
    expect((await ctx.game.read.activeRoundOf([addr(W.playerA)])) as bigint).to.equal(0n);
    const failed = await gameEvents(ctx, "BetFailed");
    expect(failed.length).to.equal(1);
    await expectRevert(other.write.cancelExpired([round.requestId]), "InvalidRequest");
    // the player can start again
    await startDirect(ctx, W.playerA);
  });

  it("operator after settleTimeout: only when the VRF word never arrived", async () => {
    const ctx = await setup();
    const round = await startDirect(ctx, W.playerA);
    const op = await gameAs(ctx, W.operator);
    await expectRevert(op.write.cancelExpired([round.requestId]), "TimeoutNotReached");
    await env.networkHelpers.time.increase(TABLE.settleTimeout + 1);
    const other = await gameAs(ctx, W.other);
    await expectRevert(other.write.cancelExpired([round.requestId]), "TimeoutNotReached");
    const before = (await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint;
    await op.write.cancelExpired([round.requestId]);
    expect((await ctx.token.read.balanceOf([addr(W.playerA)])) as bigint).to.equal(before + STAKE);

    const r2 = await startDirect(ctx, W.playerA);
    await dealMatching(ctx, r2, plainStand);
    await env.networkHelpers.time.increase(TABLE.settleTimeout + 1);
    await expectRevert(op.write.cancelExpired([r2.requestId]), "RandomAlreadyFulfilled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batched delegated execution
// ─────────────────────────────────────────────────────────────────────────────

describe("BlackjackGame — multicallTry", () => {
  it("relays two players' startRoundFor in one batch; a bad sub-call is isolated; non-operators are rejected", async () => {
    const ctx = await setup();
    await authorizeSession(ctx, W.playerA, W.sessionA);
    await authorizeSession(ctx, W.playerB, W.sessionB);
    const commitA = commitFor(freshServerSeed(), addr(W.playerA));
    const commitB = commitFor(freshServerSeed(), addr(W.playerB));
    const sA = await signStart(ctx, W.playerA, W.sessionA, { commit: commitA });
    const sB = await signStart(ctx, W.playerB, W.sessionB, { commit: commitB, nonce: 5n }); // stale nonce → isolated failure
    const abi = ctx.game.abi;
    const callA = encodeFunctionData({ abi, functionName: "startRoundFor", args: [sA.player, STAKE, 0n, ZERO_ADDRESS, commitA, sA.nonce, sA.deadline, sA.signature] });
    const callB = encodeFunctionData({ abi, functionName: "startRoundFor", args: [sB.player, STAKE, 0n, ZERO_ADDRESS, commitB, sB.nonce, sB.deadline, sB.signature] });
    const op = await gameAs(ctx, W.operator);
    await op.write.multicallTry([[callA, callB]], { gas: 3_000_000n });
    expect((await ctx.game.read.activeRoundOf([addr(W.playerA)])) as bigint).to.equal(1n);
    expect((await ctx.game.read.activeRoundOf([addr(W.playerB)])) as bigint).to.equal(0n);
    const failed = await gameEvents(ctx, "MulticallSubCallFailed");
    expect(failed.length).to.equal(1);
    expect(Number(failed[0].args.index)).to.equal(1);
    const stranger = await gameAs(ctx, W.other);
    await expectRevert(stranger.write.multicallTry([[callA]], { gas: 1_000_000n }), "NotAuthorizedMulticaller");
  });
});
