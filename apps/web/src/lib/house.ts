"use client";

/** Lot as the House API serves it (bigints as strings). */
export interface ApiLot {
  id: number;
  address: string;
  origin: "house" | "consigned";
  seller: string;
  status: string;
  statusCode: number;
  startPrice: string;
  floorPrice: string;
  openSlot: string;
  durationSlots: string;
  commitment: string;
  hints: { kind: number; sym: number; a: string; b: string; slot: string }[];
  hintPrices: string[][];
  winner: string | null;
  winnerName: string | null;
  paid: string;
  soldSlot: string;
  opened: boolean;
  amounts: string[] | null;
  value: string | null;
  edge: string | null;
  seed: string | null;
  salt: string | null;
}

export interface FeedEvent {
  at: number;
  kind: string;
  lot?: number;
  text: string;
  sig?: string;
}

export interface LeaderRow {
  address: string;
  name: string | null;
  lots: number;
  paid: string;
  value: string;
  edge: string;
}

const base = "/api/house";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `${path}: ${r.status}`), { status: r.status, body: j });
  return j as T;
}

export const house = {
  lots: (limit = 40) => get<ApiLot[]>(`/lots?limit=${limit}`),
  lot: (id: number) => get<ApiLot>(`/lots/${id}`),
  events: (since = 0) => get<FeedEvent[]>(`/events?since=${since}`),
  leaderboard: () => get<LeaderRow[]>(`/leaderboard`),
  stats: () => get<{ lotsCreated: number; sold: number; volume: string; factsDisclosed: number; takeMedianMs: number | null }>(`/stats`),
  deployment: () => get<{ bots: { name: string; style: string; address: string }[] }>(`/deployment`),
  presence: (id: string) => post<{ active: boolean }>(`/presence`, { id }),
  faucet: (owner: string) => post<{ signature: string; amount: string }>(`/faucet`, { owner }),
  relay: (tx: string) => post<{ signature: string }>(`/relay`, { tx }),
};
