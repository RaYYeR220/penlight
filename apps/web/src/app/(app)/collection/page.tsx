import type { Metadata } from "next";
import { CollectionView } from "./view";

export const metadata: Metadata = { title: "Collection" };

export default function Page() {
  return <CollectionView />;
}
