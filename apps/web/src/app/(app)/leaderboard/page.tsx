import type { Metadata } from "next";
import { LeaderboardView } from "./view";

export const metadata: Metadata = { title: "Leaderboard" };

export default function Page() {
  return <LeaderboardView />;
}
