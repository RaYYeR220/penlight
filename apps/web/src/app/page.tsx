import { redirect } from "next/navigation";

// `/` is served from public/landing.html by a rewrite; this only runs if that is bypassed.
export default function Home() {
  redirect("/landing.html");
}
