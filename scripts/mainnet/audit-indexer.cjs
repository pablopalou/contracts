/**
 * Indexer integrity audit — compare on-chain bets against what the indexer serves.
 *
 * Ground truth: PaymentHandler.GameBetProcessed(game, bettor, referrer, baseCost, …).
 * EVERY bet from EVERY game flows through it, so it's the canonical "a bet
 * happened" event. We count + sum it per game address straight from the chain
 * (Etherscan V2 logs API), then compare against the indexer's per-game view
 * (/views/games/:game → stats.total_bets / total_wagered).
 *
 * Lag-proof: we read the indexer's last-synced block from /status and bound the
 * on-chain query to that block, so bets not yet indexed can't show as "missing".
 *
 *   cd contracts
 *   node scripts/mainnet/audit-indexer.cjs
 *
 * Env: MAINNET_ARBISCAN_API_KEY (or ARBISCAN_API_KEY), INDEXER_URL
 *      (default https://indexer.betandhold.com), INDEXER_ADMIN_JWT (only if the
 *      admin gate is on — paste an admin access token).
 */
require("dotenv").config();
const { getAddress, formatEther } = require("viem");
const V6 = require("./deployments/arb-mainnet-v6.json");

const HANDLER = getAddress(V6.contracts.paymentHandler);
const TOPIC_BET = "0xb8dac089bb2cbc4ff6671f0d0faef139e8711b453fb45caa683ba59c71c40f2c"; // V6 GameBetProcessed
const INDEXER = (process.env.INDEXER_URL || "https://indexer.betandhold.com").replace(/\/$/, "");
const JWT = process.env.INDEXER_ADMIN_JWT;

// game address → indexer /views/games/:game key
const GAME_BY_ADDR = new Map(
  [
    ["roulette", V6.contracts.roulette],
    ["slots", V6.contracts.slots],
    ["plinko", V6.contracts.plinko],
    ["crash", V6.contracts.crashGame],
    ["mines", V6.contracts.mines],
    ["jackpot", V6.contracts.progressiveJackpot],
  ]
    .filter(([, a]) => a)
    .map(([key, a]) => [getAddress(a).toLowerCase(), key]),
);

const topicToAddr = (t) => getAddress("0x" + t.slice(26));
const dataWordBigInt = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));

async function idxGet(path) {
  const res = await fetch(`${INDEXER}${path}`, {
    headers: JWT ? { authorization: `Bearer ${JWT}` } : {},
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`indexer ${path} → ${res.status} (admin gate on; set INDEXER_ADMIN_JWT)`);
  }
  if (!res.ok) throw new Error(`indexer ${path} → ${res.status}`);
  return res.json();
}

async function fetchAllBets(apiKey, toBlock) {
  const perGame = new Map(); // addr → { count, wagered, bettors:Set }
  const seen = new Set();
  let fromBlock = 0;
  let total = 0;
  for (;;) {
    let page = 1;
    let lastBlock = fromBlock;
    let hitCap = false;
    for (;;) {
      const url =
        `https://api.etherscan.io/v2/api?chainid=42161&module=logs&action=getLogs` +
        `&address=${HANDLER}&topic0=${TOPIC_BET}&fromBlock=${fromBlock}&toBlock=${toBlock}` +
        `&page=${page}&offset=1000&apikey=${apiKey}`;
      const j = await (await fetch(url)).json();
      const logs = Array.isArray(j.result) ? j.result : [];
      if (logs.length === 0) break;
      for (const l of logs) {
        lastBlock = parseInt(l.blockNumber, 16);
        const id = `${l.blockNumber}-${l.logIndex}`;
        if (seen.has(id)) continue;
        seen.add(id);
        total++;
        const gameAddr = topicToAddr(l.topics[1]).toLowerCase();
        const bettor = topicToAddr(l.topics[2]).toLowerCase();
        const baseCost = dataWordBigInt(l.data, 0); // first data word
        const g = perGame.get(gameAddr) ?? { count: 0, wagered: 0n, bettors: new Set() };
        g.count++;
        g.wagered += baseCost;
        g.bettors.add(bettor);
        perGame.set(gameAddr, g);
      }
      process.stdout.write(`\r  scanned ${total} bet events (block ${lastBlock})   `);
      if (page * 1000 >= 10000) { hitCap = true; break; }
      if (logs.length < 1000) break;
      page++;
      await new Promise((r) => setTimeout(r, 220));
    }
    if (!hitCap) break;
    fromBlock = lastBlock;
    await new Promise((r) => setTimeout(r, 220));
  }
  process.stdout.write("\n");
  return { perGame, total };
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const eva = (wei) => Number(formatEther(wei)).toFixed(2);

async function main() {
  const apiKey = process.env.MAINNET_ARBISCAN_API_KEY || process.env.ARBISCAN_API_KEY;
  if (!apiKey) throw new Error("Missing ARBISCAN key in env");

  console.log(`\n── Indexer integrity audit ──`);
  console.log("handler:", HANDLER, "\nindexer:", INDEXER);

  // 1. Bound to the indexer's synced block so lag can't read as a miss.
  const status = await idxGet("/status");
  const syncedBlock = status?.arbitrum?.block?.number;
  if (!syncedBlock) throw new Error("could not read synced block from /status");
  console.log("indexer synced block:", syncedBlock, "\n");

  // 2. Ground truth from chain, up to the synced block.
  console.log("Fetching on-chain GameBetProcessed…");
  const { perGame, total } = await fetchAllBets(apiKey, syncedBlock);

  // 3. Indexer per-game views.
  console.log("Fetching indexer per-game views…\n");
  const rows = [];
  for (const [addr, key] of GAME_BY_ADDR) {
    const chain = perGame.get(addr) ?? { count: 0, wagered: 0n, bettors: new Set() };
    let idxBets = 0, idxWagered = "0";
    try {
      const view = await idxGet(`/views/games/${key}`);
      idxBets = Number(view?.stats?.total_bets ?? 0);
      idxWagered = String(view?.stats?.total_wagered ?? "0");
    } catch (e) {
      idxBets = NaN;
      console.warn(`  ⚠ ${key}: ${e.message}`);
    }
    rows.push({
      key,
      chainBets: chain.count,
      idxBets,
      betDelta: Number.isNaN(idxBets) ? NaN : idxBets - chain.count,
      chainWagered: chain.wagered,
      idxWagered: BigInt(idxWagered || "0"),
    });
  }

  // 4. Report.
  console.log(
    pad("game", 10), padL("chain bets", 12), padL("idx bets", 10), padL("Δ", 6),
    padL("chain EVA", 14), padL("idx EVA", 14), padL("Δ EVA", 10), " status",
  );
  console.log("─".repeat(96));
  let allOk = true;
  for (const r of rows) {
    const wagDelta = r.idxWagered - r.chainWagered;
    const ok = r.betDelta === 0 && wagDelta === 0n;
    if (!ok) allOk = false;
    const flag = Number.isNaN(r.betDelta) ? "❓ gated" : ok ? "✅" : "⚠️  MISMATCH";
    console.log(
      pad(r.key, 10), padL(r.chainBets, 12), padL(r.idxBets, 10),
      padL(Number.isNaN(r.betDelta) ? "?" : r.betDelta, 6),
      padL(eva(r.chainWagered), 14), padL(eva(r.idxWagered), 14),
      padL(eva(wagDelta), 10), " " + flag,
    );
  }
  console.log("─".repeat(96));
  const chainTotal = rows.reduce((a, r) => a + r.chainBets, 0);
  const idxTotal = rows.reduce((a, r) => a + (Number.isNaN(r.idxBets) ? 0 : r.idxBets), 0);
  console.log(pad("TOTAL", 10), padL(chainTotal, 12), padL(idxTotal, 10), padL(idxTotal - chainTotal, 6));
  console.log(`\non-chain bet events (all games, incl. any unmapped): ${total}`);
  const unmapped = [...perGame.keys()].filter((a) => !GAME_BY_ADDR.has(a));
  if (unmapped.length) console.log("⚠ unmapped game addresses with bets:", unmapped.join(", "));
  console.log(allOk ? "\n✅ Indexer matches chain for all mapped games.\n" : "\n⚠️  Discrepancies above — investigate.\n");
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n" + (e.stack || e.message)); process.exit(1); });
