import type { Metadata } from "next";
import { LotRoom } from "./view";

export async function generateMetadata({ params }: PageProps<"/lot/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Lot #${id}` };
}

export default async function Page({ params }: PageProps<"/lot/[id]">) {
  const { id } = await params;
  return <LotRoom id={/^\d+$/.test(id) ? Number(id) : NaN} />;
}
