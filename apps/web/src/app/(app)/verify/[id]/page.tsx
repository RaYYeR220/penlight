import type { Metadata } from "next";
import { VerifyLot } from "./view";

export async function generateMetadata({ params }: PageProps<"/verify/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Verify lot #${id}` };
}

export default async function Page({ params }: PageProps<"/verify/[id]">) {
  const { id } = await params;
  return <VerifyLot id={/^\d+$/.test(id) ? Number(id) : NaN} />;
}
