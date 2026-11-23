import type { Metadata } from "next";
import { VerifyView } from "./view";

export const metadata: Metadata = { title: "Verify" };

export default function Page() {
  return <VerifyView />;
}
