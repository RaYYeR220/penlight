import { serve } from "@hono/node-server";
import { app } from "./api.js";
import { botsTick, fundBots, initBots } from "./bots.js";
import { config, deployment, house, log, store } from "./context.js";
import { backfill, schedule, tick } from "./keeper.js";

function loop(name: string, everyMs: number, fn: () => Promise<unknown>) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log(`${name}:`, (e as Error).message?.slice(0, 200));
    } finally {
      running = false;
    }
  }, everyMs);
}

store.load();
initBots();
void backfill().catch((e) => log("backfill:", e.message));
log(`house ${house.publicKey.toBase58()} program ${deployment.programId}`);

loop("keeper", 250, tick);
loop("schedule", 2000, schedule);
loop("bots", 120, botsTick);
loop("fund", 120_000, fundBots);
void fundBots().catch((e) => log("fund:", e.message));

serve({ fetch: app.fetch, port: config.port }, (i) => log(`api on :${i.port}`));
