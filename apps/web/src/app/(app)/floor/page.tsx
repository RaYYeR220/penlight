import type { Metadata } from "next";
import { FloorView } from "./view";

export const metadata: Metadata = { title: "Floor" };

export default function Page() {
  return <FloorView />;
}
