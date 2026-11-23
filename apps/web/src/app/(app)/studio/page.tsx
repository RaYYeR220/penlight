import type { Metadata } from "next";
import { StudioView } from "./view";

export const metadata: Metadata = { title: "Studio" };

export default function Page() {
  return <StudioView />;
}
