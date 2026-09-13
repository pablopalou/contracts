// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/shoe.ts.
// Kept byte-identical by the shared golden vectors (test/fixtures/blackjack-golden-rounds.json).
import { encodePacked, hexToBigInt, keccak256, type Address, type Hex } from "viem";
import { CARDS_PER_DECK, assertCard, type Card } from "./cards.js";
import { RULES } from "./rules.js";

/** Source of cards for a round. Production uses `KeccakShoe`; tests and the simulator inject others. */
export interface Shoe {
  draw(): Card;
  readonly drawn: number;
}

/**
 * Round seed — the single input from which the whole shoe order derives.
 * Solidity: keccak256(abi.encodePacked(serverSeed, vrfWord, requestId, address(this)))
 * (same shape as MinesGameHybrid._resolveClaim).
 */
export function deriveRoundSeed(serverSeed: Hex, vrfWord: bigint, requestId: bigint, game: Address): Hex {
  return keccak256(
    encodePacked(["bytes32", "uint256", "uint256", "address"], [serverSeed, vrfWord, requestId, game]),
  );
}

/**
 * Commit published before the bet. Solidity: keccak256(abi.encodePacked(serverSeed, player)).
 * Binding the player prevents a commit minted for one wallet being reused by another.
 */
export function commitFor(serverSeed: Hex, player: Address): Hex {
  return keccak256(encodePacked(["bytes32", "address"], [serverSeed, player]));
}

/**
 * Six-deck shoe shuffled lazily with a partial Fisher-Yates driven by a keccak
 * chain, so only the cards actually dealt are ever computed. Mirrors
 * `BlackjackEngineLib` exactly:
 *
 *   slot[i] = i % 52 initially (six copies of every card)
 *   for draw i: s = keccak256(abi.encodePacked(s, uint16(i)));
 *               j = i + uint256(s) % (312 - i); swap(slot[i], slot[j]); deal slot[i]
 */
export class KeccakShoe implements Shoe {
  private readonly slots: Uint8Array;
  private state: Hex;
  private index = 0;

  constructor(seed: Hex) {
    this.state = seed;
    this.slots = new Uint8Array(RULES.shoeSize);
    for (let i = 0; i < RULES.shoeSize; i++) this.slots[i] = i % CARDS_PER_DECK;
  }

  get drawn(): number {
    return this.index;
  }

  draw(): Card {
    const i = this.index;
    if (i >= RULES.shoeSize) throw new Error("shoe exhausted");
    this.state = keccak256(encodePacked(["bytes32", "uint16"], [this.state, i]));
    const remaining = BigInt(RULES.shoeSize - i);
    const j = i + Number(hexToBigInt(this.state) % remaining);
    const tmp = this.slots[i]!;
    this.slots[i] = this.slots[j]!;
    this.slots[j] = tmp;
    this.index = i + 1;
    return this.slots[i]!;
  }
}

/** Deals a fixed sequence — for tests, demos and golden scenarios. */
export class ScriptedShoe implements Shoe {
  private index = 0;

  constructor(private readonly cards: readonly Card[]) {
    for (const c of cards) assertCard(c);
  }

  get drawn(): number {
    return this.index;
  }

  draw(): Card {
    if (this.index >= this.cards.length) throw new Error("scripted shoe exhausted");
    return this.cards[this.index++]!;
  }
}
