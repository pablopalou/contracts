// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/actions.ts.
// Kept byte-identical by the shared golden vectors (test/fixtures/blackjack-golden-rounds.json).
import { keccak256, type Hex } from "viem";

/** Player actions, encoded as one byte each (the contract takes `bytes actions`). */
export const Action = {
  HIT: 0,
  STAND: 1,
  DOUBLE: 2,
  SPLIT: 3,
  INSURE_YES: 4,
  INSURE_NO: 5,
} as const;

export type ActionCode = (typeof Action)[keyof typeof Action];

export const ACTION_NAMES = ["hit", "stand", "double", "split", "insure_yes", "insure_no"] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function isActionCode(value: unknown): value is ActionCode {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < ACTION_NAMES.length;
}

export function actionName(code: ActionCode): ActionName {
  return ACTION_NAMES[code];
}

export function actionFromName(name: string): ActionCode {
  const idx = ACTION_NAMES.indexOf(name as ActionName);
  if (idx < 0) throw new RangeError(`unknown action ${name}`);
  return idx as ActionCode;
}

/** Raw byte encoding — what goes on-chain and into the EIP-712 `actionsHash`. */
export function actionsToBytes(actions: readonly ActionCode[]): Hex {
  let hex = "0x";
  for (const a of actions) {
    if (!isActionCode(a)) throw new RangeError(`invalid action ${a}`);
    hex += a.toString(16).padStart(2, "0");
  }
  return hex as Hex;
}

export function actionsFromBytes(hex: Hex): ActionCode[] {
  const body = hex.slice(2);
  if (body.length % 2 !== 0) throw new RangeError("odd-length actions hex");
  const out: ActionCode[] = [];
  for (let i = 0; i < body.length; i += 2) {
    const v = parseInt(body.slice(i, i + 2), 16);
    if (!isActionCode(v)) throw new RangeError(`invalid action byte ${v}`);
    out.push(v);
  }
  return out;
}

/** Solidity: keccak256(actions) over the raw bytes. Signed by the player in `ConfirmRound`. */
export function actionsHash(actions: readonly ActionCode[]): Hex {
  return keccak256(actionsToBytes(actions));
}
