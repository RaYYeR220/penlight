"use client";
import Link from "next/link";
import { priceAt } from "@penlight/sdk";
import { useLots, usePresence, useRollupSlot } from "@/hooks/chain";
import { usd } from "@/lib/chain";

export default function Floor() {
  usePresence();
  const lots = useLots();
  const slot = useRollupSlot(100);
  return (
    <main style={{ padding: 32 }}>
      <h1>Floor</h1>
      <p>rollup slot {slot.toString()}</p>
      <ul>
        {(lots ?? []).map((l) => {
          const c = { startPrice: BigInt(l.startPrice), floorPrice: BigInt(l.floorPrice), openSlot: BigInt(l.openSlot), durationSlots: BigInt(l.durationSlots) };
          return (
            <li key={l.id}>
              <Link href={`/lot/${l.id}`}>Lot #{l.id}</Link> · {l.status} · {l.status === "live" ? usd(priceAt(c, slot)) : l.paid !== "0" ? `paid ${usd(l.paid)}` : ""}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
