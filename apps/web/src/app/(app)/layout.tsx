import { PlayerProvider } from "@/components/player";
import { Footer, Nav } from "@/components/nav";
import "./app.css";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlayerProvider>
      <div className="app">
        <Nav />
        <main className="page">{children}</main>
        <Footer />
      </div>
    </PlayerProvider>
  );
}
