// Token Radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// rankable pre-token protocol below the watchlist floor: 40 + 186 = 226 rows, exhaustive under the
// rankable rule, with no arbitrary cut. A protocol is pre-token when its index entry records no token
// (no market cap, no CoinGecko id, no symbol); live-token protocols are kept apart and shown as the
// market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures, through one function applied to every
// row, with no protocol name ever special-cased:
//
//   base       = the category's calibrated multiple (see calibrateMultiples below)
//   growth     = log-damped seven-day growth, so a +4,448% print cannot swamp the board
//   maturity   = concave in age with no token, saturating after about three years
//   chains     = log of the chain count, capped, so distribution helps but never swamps TVL
//   implied    = max(1, round(tvl_usd x base x growth x maturity x chains))
//
// The category multiple is calibrated from the snapshot itself, not asserted: for each category,
// take the live (token-trading, non-CEX) protocols in that category, take the median of their
// market-cap / TVL ratios, and shrink it toward the global median by n / (n + 5), where n is the
// number of live protocols in the category. Categories with fewer than 3 live protocols use the
// global median outright, because one or two live prices are not a market. The multiple is clamped
// to [0.10, 0.35]. The global median itself is computed from the same live rows, never hardcoded.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the page recomputes them. */
export interface ModelConstants {
  growth_weight: number;
  growth_damp: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_scale_days: number;
  unknown_age_days: number;
  chain_weight: number;
  chain_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  min_live_for_category: number;
  shrink_k: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.25,
  growth_damp: 10,
  growth_cap: 1.2,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_scale_days: 365,
  unknown_age_days: 365,
  chain_weight: 0.05,
  chain_cap: 1.2,
  multiple_floor: 0.1,
  multiple_cap: 0.35,
  min_live_for_category: 3,
  shrink_k: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries: all of them. */
export const EARLY_ROWS = 1000;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's calibration: how many live protocols priced it, their median ratio, the multiple. */
export interface CategoryMultiple {
  category: string;
  live_n: number;
  median_mcap_tvl: number | null;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    category_live_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  category_live_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  category_multiples: CategoryMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list, else null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A live-token protocol usable to price a category: it trades, is not a CEX, and has a market cap. */
function isLivePriced(p: SnapshotProtocol): boolean {
  return !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/**
 * The category multiples, calibrated from the snapshot's own live rows. The global multiple is the
 * median market-cap / TVL across all live-priced protocols. A category with at least
 * min_live_for_category live rows gets its own median, shrunk toward the global median by
 * n / (n + shrink_k); a thinner category takes the global median. Every multiple is clamped.
 */
export function calibrateMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, CategoryMultiple> } {
  const live = snapshot.protocols.filter(isLivePriced);
  const global = median(live.map((p) => (p.mcap_usd as number) / p.tvl_usd)) ?? 0.25;
  const byCategory = new Map<string, CategoryMultiple>();
  const cats = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    const c = p.category ?? 'Other';
    const list = cats.get(c) ?? [];
    list.push(p);
    cats.set(c, list);
  }
  for (const [category, rows] of cats) {
    const med = median(rows.map((p) => (p.mcap_usd as number) / p.tvl_usd));
    let multiple = global;
    if (med !== null && rows.length >= model.min_live_for_category) {
      const w = rows.length / (rows.length + model.shrink_k);
      multiple = global + w * (med - global);
    }
    multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, multiple));
    byCategory.set(category, { category, live_n: rows.length, median_mcap_tvl: med, multiple });
  }
  return { global, byCategory };
}

/** The category multiple for one protocol, from the calibration. */
export function baseMultipleFor(p: SnapshotProtocol, calibration: { global: number; byCategory: Map<string, CategoryMultiple> }, model: ModelConstants = MODEL): { multiple: number; live_n: number } {
  const entry = calibration.byCategory.get(p.category ?? 'Other');
  if (entry === undefined) return { multiple: Math.min(model.multiple_cap, Math.max(model.multiple_floor, calibration.global)), live_n: 0 };
  return { multiple: entry.multiple, live_n: entry.live_n };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: { global: number; byCategory: Map<string, CategoryMultiple> },
  model: ModelConstants = MODEL,
): { implied: number; base: number; live_n: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple: base, live_n } = baseMultipleFor(protocol, calibration, model);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = rawGrowth;
  const signed = Math.sign(rawGrowth) * Math.log(1 + Math.abs(rawGrowth) / model.growth_damp);
  const damped = Math.min(model.growth_cap, Math.max(-model.growth_cap, signed));
  const growthMult = 1 + model.growth_weight * damped;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + model.maturity_range * (1 - Math.exp(-ageForModel / model.maturity_scale_days));
  const chainCount = Math.max(1, protocol.chains.length);
  const chainMult = Math.min(model.chain_cap, 1 + model.chain_weight * Math.log(chainCount));
  const implied = Math.max(1, Math.round(protocol.tvl_usd * base * growthMult * maturityMult * chainMult));
  return { implied, base, live_n, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrateMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, never rounded: the dashboard recomputes the row from this number, and a
      // rounded multiple would make the page's number differ from board.json on most rows.
      base_multiple: s.base,
      category_live_n: s.live_n,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('farm')) return `Deposit $${capital} of USDC into ${name}'s farm on ${chain} and keep the position open.`;
  if (c.includes('payment')) return `Send $${capital} through ${name} on ${chain} and keep the receipt for the activity.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action, a second, different action from the main deposit. */
function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against your supply on ${name}, then repay it the same week.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('liquidity manager')) return `Swap a small amount in ${name}'s main pool on ${chain} and add the proceeds back to the position.`;
  if (c.includes('bridge')) return `Bridge a small amount back the other way through ${name} so both directions are used.`;
  if (c.includes('staking') || c.includes('restak')) return `Restake the rewards ${name} pays on ${chain} instead of withdrawing them.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close and reopen a small hedge on ${name} so the account stays active.`;
  if (c.includes('prediction')) return `Settle one market and open another small position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Rebalance between ${name}'s vaults on ${chain} once, keeping most of the position in place.`;
  if (c.includes('rwa')) return `Claim the yield ${name} pays and redeposit it into the same asset on ${chain}.`;
  if (c.includes('farm')) return `Harvest the farm rewards on ${name} and compound them into the position.`;
  return `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote on ${name}.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const weekly = weeklyActionFor(p, chain);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: weekly, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Open ${p.name}'s own points or rewards page and check what activity it counts before you add more funds.`, cost: 'no fee to check', time: '10 minutes' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, check the protocol's audits and its TVL trend, and add no more than $${capital} while either looks worse than when you entered.`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it, and claim only from the link the protocol itself publishes.`, cost: 'nothing but the log, and never pay to claim', time: '5 minutes' },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    category_live_n: row.model.category_live_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const calibration = calibrateMultiples(snapshot, model);
  const category_multiples = [...calibration.byCategory.values()].sort((a, b) => b.live_n - a.live_n || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(calibration.global),
    category_multiples,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
