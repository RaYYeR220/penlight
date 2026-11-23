#!/usr/bin/env -S npx tsx
/**
 * penlight — the Penlight floor from a terminal.
 */
import {
  Floor,
  HINTS,
  STATUS,
  ROLLUP_SLOT_MS,
  UserError,
  detail,
  faucet,
  loadKeypair,
  parseUsd,
  signedUsdText,
  summarize,
  usdText,
  type AppraisalReport,
  type LotSummary,
} from "./floor.js";

const HELP = `penlight — sealed lots on a falling clock, on Solana + MagicBlock's private rollup

Usage
  penlight lots [--limit N]                    newest lots: status, clock price, facts, results
  penlight lot <id>                            one lot in full
  penlight verify <id|address>                 re-derive an opened lot from its public record
  penlight appraise [id]                       appraise a live lot (every live lot if no id)
  penlight take <id> --max <usd> --key <path>  take a live lot at the clock price, up to --max
  penlight faucet --key <path>                 250 test USDC into your rollup balance, from the House
  penlight holdings --key <path>               your rollup balances

Environment
  PENLIGHT_HOUSE_URL   House API for the faucet (default https://penlight-app.vercel.app/api/house)
  PENLIGHT_BASE_RPC    Solana devnet RPC
  PENLIGHT_TEE_RPC     private rollup RPC
`;

// ───────────────────────────── arguments ─────────────────────────────

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") flags.set("help", true);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function flag(args: Args, name: string, required: true): string;
function flag(args: Args, name: string, required?: false): string | undefined;
function flag(args: Args, name: string, required = false): string | undefined {
  const v = args.flags.get(name);
  if (v === true) throw new UserError(`--${name} needs a value`);
  if (v === undefined && required) throw new UserError(`--${name} is required`);
  return v;
}

function only(args: Args, allowed: string[], maxPositional: number) {
  for (const k of args.flags.keys()) if (k !== "help" && !allowed.includes(k)) throw new UserError(`unknown option --${k}`);
  if (args.positional.length > maxPositional) throw new UserError(`unexpected argument "${args.positional[maxPositional]}"`);
}

// ───────────────────────────── output ─────────────────────────────

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const dim = paint(2);
const bold = paint(1);

const n = (x: number | bigint) => x.toLocaleString("en-US");
const seconds = (slots: number) => `~${((slots * ROLLUP_SLOT_MS) / 1000).toFixed(slots * ROLLUP_SLOT_MS < 10_000 ? 1 : 0)} s`;
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const originText = (s: LotSummary) => (s.origin === "house" ? "house lot" : "consigned");

function wrap(text: string, indent: string): string {
  const width = Math.min(process.stdout.columns || 100, 100) - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function headline(s: LotSummary): string {
  if (s.clock) {
    const c = s.clock;
    if (c.phase === "opening") return `opens in ${n(c.slotsUntilOpen)} slots at ${usdText(s.startPriceUsd)}`;
    const where = c.phase === "falling" ? `▼ ${usdText(s.floorPriceUsd)} floor in ${n(c.slotsUntilFloor)} slots` : c.phase;
    return `clock ${bold(usdText(c.priceNowUsd))}  ${dim(where)}  · ${s.factsDisclosed}/${HINTS} facts`;
  }
  if (s.opened && s.sale) {
    const edge = s.opened.edgeUsd ?? 0;
    return `paid ${usdText(s.sale.paidUsd)} · worth ${usdText(s.opened.valueUsd)} · edge ${(edge >= 0 ? green : red)(signedUsdText(edge))}`;
  }
  if (s.opened) return `nobody took it · worth ${usdText(s.opened.valueUsd)}`;
  if (s.sale) return `taken for ${usdText(s.sale.paidUsd)} · being opened`;
  if (s.status === "live") return `${s.factsDisclosed}/${HINTS} facts`;
  return "being prepared: the clock starts when it goes live";
}

function printLots(lots: LotSummary[], slot: bigint) {
  console.log(`${bold("Penlight")} · devnet · rollup slot ${n(slot)}\n`);
  if (!lots.length) {
    console.log("No lots yet.");
    return;
  }
  const w = Math.max(...lots.map((s) => String(s.id).length)) + 1;
  for (const s of lots) {
    console.log(`${bold(`#${s.id}`.padEnd(w))}  ${s.status.padEnd(9)}  ${originText(s).padEnd(9)}  ${headline(s)}`);
    for (const f of s.facts) console.log(`${" ".repeat(w + 4)}${dim(`${f.n}.`)} ${f.text}`);
  }
  const live = lots.filter((s) => s.status === "live").length;
  console.log(dim(`\n${lots.length} lots shown, ${live} live. Check any opened lot: penlight verify <id>`));
}

function printLot(s: ReturnType<typeof detail>) {
  const where = s.location === "solana" ? "settled on Solana" : "in the private rollup";
  console.log(`${bold(`Lot #${s.id}`)} · ${originText(s)} · ${s.status} · ${where}\n`);
  const row = (k: string, v: string) => console.log(`  ${dim(k.padEnd(10))}${v}`);
  row("address", s.address);
  row("seller", s.seller);
  row("seal", s.commitment);
  row("clock", `${usdText(s.startPriceUsd)} → ${usdText(s.floorPriceUsd)} over ${n(s.durationSlots)} rollup slots (${seconds(s.durationSlots)})`);
  if (s.clock) {
    const c = s.clock;
    row("now", c.phase === "opening" ? `opens in ${n(c.slotsUntilOpen)} slots` : `${bold(usdText(c.priceNowUsd))} at slot ${n(c.rollupSlot)} (${c.phase})`);
    if (c.nextFact) row("next fact", `#${c.nextFact.n} at slot ${n(c.nextFact.atSlot)}, in ${n(c.nextFact.inSlots)} slots (${seconds(c.nextFact.inSlots)})`);
  }
  console.log(`\n  ${bold("Facts")} ${dim(`${s.factsDisclosed}/${HINTS}`)}`);
  if (!s.facts.length) console.log(`  ${dim("none disclosed yet")}`);
  for (const f of s.facts) console.log(`  ${f.n}. ${f.text.padEnd(50)} ${dim(`slot ${n(f.slot)}`)}`);
  if (s.sale) {
    console.log(`\n  ${bold("Sale")}`);
    console.log(`  taken by ${s.sale.winner} for ${bold(usdText(s.sale.paidUsd))} at rollup slot ${n(s.sale.soldSlot)}`);
  }
  if (s.opened) {
    console.log(`\n  ${bold("Contents")}`);
    for (const c of s.opened.contents) console.log(`  ${c.amount.padStart(22)} ${c.symbol.padEnd(7)} ${usdText(c.valueUsd).padStart(10)}`);
    const edge = s.opened.edgeUsd;
    console.log(`  ${"".padStart(30)} ${bold(usdText(s.opened.valueUsd).padStart(10))} total${edge === null ? "" : ` · edge ${(edge >= 0 ? green : red)(signedUsdText(edge))}`}`);
    console.log(`  ${dim(`salt ${s.salt}`)}`);
    console.log(`  ${dim(`seed ${s.seed}`)}`);
  }
  if (s.explorer) console.log(`\n  ${dim(s.explorer)}`);
}

function printAppraisal(a: AppraisalReport) {
  if (!a.live) {
    console.log(a.note);
    return;
  }
  console.log(`${bold(`Lot #${a.id}`)} · ${a.origin === "house" ? "house lot" : "consigned"} · ${a.factsUsed}/${HINTS} facts · clock ${bold(usdText(a.clock.priceNowUsd))} (${a.clock.phase})\n`);
  const t = (x: number | null) => (x === null ? "—" : usdText(x));
  const d = a.distributionUsd;
  if (d) {
    console.log(`  value     p10 ${t(d.p10)}   p50 ${bold(t(d.p50))}   p90 ${t(d.p90)}`);
    console.log(dim(`            ${n(a.draws!.consistent)} of ${n(a.draws!.sampled)} sampled draws fit every fact; valued at ${a.pricedWith}`));
  }
  if (a.boundsUsd.atLeast !== null || a.boundsUsd.atMost !== null) {
    console.log(`  facts say at least ${t(a.boundsUsd.atLeast)}, at most ${t(a.boundsUsd.atMost)}`);
  }
  if (a.suggestion.takeAtOrBelowUsd !== null) console.log(`  take at   ≤ ${bold(usdText(a.suggestion.takeAtOrBelowUsd))}`);
  console.log(`\n${wrap(a.suggestion.text, "  ")}`);
}

// ───────────────────────────── commands ─────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help" || args.flags.has("help")) {
    console.log(HELP);
    return 0;
  }
  const floor = new Floor();

  switch (cmd) {
    case "lots": {
      only(args, ["limit"], 0);
      const limit = Number(flag(args, "limit") ?? 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UserError("--limit must be a whole number from 1 to 200");
      const [lots, slot] = await Promise.all([floor.lots(limit), floor.rollupSlot()]);
      printLots(lots.map((x) => summarize(x, slot)), slot);
      return 0;
    }

    case "lot": {
      only(args, [], 1);
      const id = args.positional[0];
      if (!id) throw new UserError("usage: penlight lot <id>");
      const [x, slot] = await Promise.all([floor.lot(id), floor.rollupSlot()]);
      printLot(detail(x, slot));
      return 0;
    }

    case "verify": {
      only(args, [], 1);
      const ref = args.positional[0];
      if (!ref) throw new UserError("usage: penlight verify <id|address>");
      const { located, checks } = await floor.verify(ref);
      const s = summarize(located, null);
      const where = located.where === "solana" ? "Solana devnet (settled record)" : "the private rollup (not settled yet)";
      console.log(`${bold(`Lot #${s.id}`)} ${dim(s.address)}`);
      console.log(`read from ${where} · ${s.status}${s.opened ? ` · worth ${usdText(s.opened.valueUsd)}` : ""}${s.sale ? ` · paid ${usdText(s.sale.paidUsd)}` : ""}\n`);
      const w = Math.max(...checks.map((c) => c.name.length));
      for (const c of checks) console.log(`  ${c.ok ? green("✓") : red("✗")} ${c.name.padEnd(w)}  ${dim(c.detail)}`);
      const failed = checks.filter((c) => !c.ok).length;
      console.log();
      if (failed === 0) console.log(green(`All ${checks.length} checks pass.`) + dim(" Seal, facts, price and value all re-derive from the public record."));
      else if (checks.length === 1 && !checks[0].ok) console.log(red(`Not verifiable yet: lot #${s.id} hasn't been opened.`));
      else console.log(red(`${failed} of ${checks.length} checks failed.`));
      if (s.explorer) console.log(dim(s.explorer));
      return failed === 0 ? 0 : 1;
    }

    case "appraise": {
      only(args, [], 1);
      const id = args.positional[0];
      if (id !== undefined) {
        printAppraisal(await floor.appraise(await floor.lot(id)));
        return 0;
      }
      const lots = await floor.lots(40);
      const live = lots.filter((x) => x.lot.status === STATUS.LIVE && x.where === "rollup");
      if (!live.length) {
        const newest = lots[0] ? summarize(lots[0], null) : null;
        console.log(`No lots are live right now.${newest ? ` The newest is #${newest.id} (${newest.status}).` : ""}`);
        return 0;
      }
      for (const [i, x] of live.entries()) {
        if (i) console.log();
        printAppraisal(await floor.appraise(x));
      }
      return 0;
    }

    case "take": {
      only(args, ["max", "key"], 1);
      const id = args.positional[0];
      if (!id) throw new UserError("usage: penlight take <id> --max <usd> --key <path>");
      const max = parseUsd(flag(args, "max", true));
      const wallet = floor.wallet(loadKeypair(flag(args, "key", true)));
      const r = await wallet.take(id, max);
      console.log(green(`Took lot #${r.lot} for ${usdText(r.paidUsd)}`) + ` (max ${usdText(r.maxUsd)}) at rollup slot ${n(r.soldSlot)}, confirmed in ${r.confirmMs} ms.`);
      console.log(dim(`signature ${r.signature}`));
      console.log(`The lot is opened and delivered to you next; watch it with: penlight lot ${r.lot}`);
      return 0;
    }

    case "faucet": {
      only(args, ["key"], 0);
      const key = loadKeypair(flag(args, "key", true));
      const r = await faucet(key.publicKey, floor.settings.houseUrl);
      console.log(green(`${usdText(r.amountUsd)} test USDC sent privately to ${short(key.publicKey.toBase58())}'s rollup balance.`));
      console.log(dim(`signature ${r.signature}`));
      return 0;
    }

    case "holdings": {
      only(args, ["key"], 0);
      const wallet = floor.wallet(loadKeypair(flag(args, "key", true)));
      const rows = await wallet.holdings();
      console.log(`${bold("Rollup balances")} · ${wallet.publicKey.toBase58()}\n`);
      const held = rows.filter((r) => r.amount !== "0");
      if (!held.length) console.log("  nothing yet: penlight faucet --key <path>");
      for (const r of held) console.log(`  ${r.amount.padStart(22)} ${r.symbol.padEnd(12)} ${r.valueUsd === null ? "" : usdText(r.valueUsd).padStart(10)}`);
      const total = held.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
      if (held.length) console.log(`  ${"".padStart(35)} ${bold(usdText(total).padStart(10))} total`);
      return 0;
    }

    default:
      throw new UserError(`unknown command "${cmd}"; run penlight help`);
  }
}

// Exit by letting the event loop drain rather than process.exit(): on Windows,
// exiting while RPC sockets are still closing can abort the process.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof UserError) console.error(`penlight: ${e.message}`);
    else console.error(`penlight: ${(e as Error)?.message ?? e}`);
    process.exitCode = e instanceof UserError ? 1 : 2;
  },
);
