import type { NextConfig } from "next";
import path from "node:path";

const MONOREPO_ROOT = path.join(__dirname, "../..");

const HOUSE = process.env.HOUSE_URL ?? "http://35.187.34.216:8787";

const nextConfig: NextConfig = {
  transpilePackages: ["@penlight/sdk"],
  outputFileTracingRoot: MONOREPO_ROOT,
  async rewrites() {
    return {
      // The landing page is a hand-built static page with its own canvas object.
      beforeFiles: [{ source: "/", destination: "/landing.html" }],
      afterFiles: [{ source: "/api/house/:path*", destination: `${HOUSE}/api/:path*` }],
      fallback: [],
    };
  },
  turbopack: {
    root: MONOREPO_ROOT,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
