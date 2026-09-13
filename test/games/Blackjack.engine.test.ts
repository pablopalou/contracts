import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { hexToBytes, keccak256, toHex, type Hex } from "viem";

import { KeccakShoe } from "../helpers/blackjack/shoe.js";
import { actionsFromBytes, Action } from "../helpers/blackjack/actions.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * BlackjackEngineLib ↔ TypeScript engine parity, pinned by the golden vectors
 * generated in blackjackBackend (scripts/genGoldenVectors.ts).
 */

interface GoldenFile {
  rulesVersion: number;
  vectors: Array<{
    name: string;
    seed: Hex;
    stake: string;
    sideBet: string;
    actions: Hex;
    abandoned: boolean;
    flags: { doubled: boolean; split: boolean; insured: boolean };
    expected: {
      payout: string;
      wagerRefund: string;
      cardsDrawn: number;
      playerNatural: boolean;
      dealerNatural: boolean;
      insuranceTaken: boolean;
      insurancePayout: string;
      sideBetOutcome: string;
      sideBetPayout: string;
      dealerCards: number[];
      hands: Array<{ cards: number[]; bet: string; outcome: string; payout: string }>;
    };
  }>;
}

const OUTCOME_CODE: Record<string, number> = { blackjack: 0, win: 1, push: 2, lose: 3, bust: 4 };
const PP_CODE: Record<string, number> = { none: 0, mixed: 1, colored: 2, perfect: 3 };

const golden = JSON.parse(
  readFileSync(new URL("../fixtures/blackjack-golden-rounds.json", import.meta.url), "utf8"),
) as GoldenFile;

let env: Awaited<ReturnType<typeof network.connect>>;
let harness: any;

before(async () => {
  env = await network.connect();
  harness = await env.viem.deployContract("BlackjackEngineHarness");
});

function bytesToCards(hex: Hex): number[] {
  return Array.from(hexToBytes(hex));
}

describe("BlackjackEngineLib — golden vectors", () => {
  it("fixture targets the current rules version", async () => {
    expect(golden.rulesVersion).to.equal(1);
    expect(golden.vectors.length).to.be.greaterThan(50);
  });

  it("the shoe order matches the TypeScript KeccakShoe for a full 312-card deal", async () => {
    const seed = keccak256(toHex("shoe-parity"));
    const shoe = new KeccakShoe(seed);
    const expected = Array.from({ length: 312 }, () => shoe.draw());
    const onchain = (await harness.read.draw([seed, 312])) as number[];
    expect(onchain.map(Number)).to.deep.equal(expected);
  });

  for (const v of golden.vectors) {
    it(`replays: ${v.name}`, async () => {
      const res = (await harness.read.play([
        v.seed,
        { stake: BigInt(v.stake), sideBet: BigInt(v.sideBet), doubled: v.flags.doubled, split: v.flags.split, insured: v.flags.insured, abandoned: v.abandoned },
        v.actions,
      ])) as any;
      expect(res.payout.toString()).to.equal(v.expected.payout);
      expect(res.wagerRefund.toString()).to.equal(v.expected.wagerRefund);
      expect(Number(res.cardsDrawn)).to.equal(v.expected.cardsDrawn);
      expect(res.playerNatural).to.equal(v.expected.playerNatural);
      expect(res.dealerNatural).to.equal(v.expected.dealerNatural);
      expect(res.insurancePayout.toString()).to.equal(v.expected.insurancePayout);
      expect(res.sideBetPayout.toString()).to.equal(v.expected.sideBetPayout);
      expect(Number(res.sideBetOutcome)).to.equal(PP_CODE[v.expected.sideBetOutcome]);
      expect(bytesToCards(res.dealerCards)).to.deep.equal(v.expected.dealerCards);
      expect(Number(res.handCount)).to.equal(v.expected.hands.length);
      expect(bytesToCards(res.hand0Cards)).to.deep.equal(v.expected.hands[0].cards);
      expect(Number(res.handOutcomes[0])).to.equal(OUTCOME_CODE[v.expected.hands[0].outcome]);
      expect(res.handPayouts[0].toString()).to.equal(v.expected.hands[0].payout);
      if (v.expected.hands.length > 1) {
        expect(bytesToCards(res.hand1Cards)).to.deep.equal(v.expected.hands[1].cards);
        expect(Number(res.handOutcomes[1])).to.equal(OUTCOME_CODE[v.expected.hands[1].outcome]);
        expect(res.handPayouts[1].toString()).to.equal(v.expected.hands[1].payout);
      } else {
        expect(res.hand1Cards).to.equal("0x");
      }
    });
  }
});

describe("BlackjackEngineLib — guards", () => {
  // A vector whose round reaches the player phase with a plain stand.
  const plain = golden.vectors.find((v) => v.actions === "0x01")!;
  const base = { stake: BigInt(plain.stake), sideBet: BigInt(plain.sideBet), doubled: false, split: false, insured: false, abandoned: false };

  it("rejects an illegal action, a short log and trailing actions", async () => {
    await expectRevert(harness.read.play([plain.seed, base, toHex(new Uint8Array([Action.SPLIT]))]), "IllegalAction");
    await expectRevert(harness.read.play([plain.seed, base, toHex(new Uint8Array([9]))]), "IllegalAction");
    await expectRevert(harness.read.play([plain.seed, base, "0x"]), "IncompleteActions");
    await expectRevert(harness.read.play([plain.seed, base, toHex(new Uint8Array([Action.STAND, Action.STAND]))]), "TrailingActions");
  });

  it("refunds unused on-chain wagers and rejects unfunded actions", async () => {
    const plainRes = (await harness.read.play([plain.seed, base, "0x01"])) as any;
    const withFlags = (await harness.read.play([plain.seed, { ...base, doubled: true, split: true, insured: true }, "0x01"])) as any;
    const stake = BigInt(plain.stake);
    expect(withFlags.wagerRefund).to.equal(stake + stake + stake / 2n);
    expect(withFlags.payout).to.equal(plainRes.payout + stake + stake + stake / 2n);
    const dbl = golden.vectors.find((v) => v.name === "hard 11 double")!;
    const dblInput = { stake: BigInt(dbl.stake), sideBet: BigInt(dbl.sideBet), doubled: false, split: false, insured: false, abandoned: false };
    await expectRevert(harness.read.play([dbl.seed, dblInput, dbl.actions]), "UnfundedAction");
    const spl = golden.vectors.find((v) => v.name === "pair of eights split")!;
    const splInput = { stake: BigInt(spl.stake), sideBet: BigInt(spl.sideBet), doubled: false, split: false, insured: false, abandoned: false };
    await expectRevert(harness.read.play([spl.seed, splInput, spl.actions]), "UnfundedAction");
    const ins = golden.vectors.find((v) => v.name === "dealer natural with ace up, insurance taken")!;
    const insInput = { stake: BigInt(ins.stake), sideBet: BigInt(ins.sideBet), doubled: false, split: false, insured: false, abandoned: false };
    await expectRevert(harness.read.play([ins.seed, insInput, ins.actions]), "UnfundedAction");
  });

  it("abandoned mode auto-stands an empty log", async () => {
    const res = (await harness.read.play([plain.seed, { ...base, abandoned: true }, "0x"])) as any;
    expect(res.payout.toString()).to.equal(plain.expected.payout);
  });

  it("an insurance decision is required with an ace up unless abandoned", async () => {
    const ins = golden.vectors.find((v) => v.name.startsWith("ace up, no naturals"))!;
    const input = { stake: BigInt(ins.stake), sideBet: BigInt(ins.sideBet), doubled: false, split: false, insured: false, abandoned: false };
    await expectRevert(harness.read.play([ins.seed, input, "0x"]), "IncompleteActions");
    await expectRevert(harness.read.play([ins.seed, input, "0x00"]), "IllegalAction");
  });
});
