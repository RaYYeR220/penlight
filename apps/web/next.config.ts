import type { NextConfig } from "next";

const HOUSE = process.env.HOUSE_URL ?? "http://35.187.34.216:8787";

const nextConfig: NextConfig = {
  transpilePackages: ["@penlight/sdk"],
  async rewrites() {
    return {
      // The landing page is a hand-built static page with its own canvas object.
      beforeFiles: [{ source: "/", destination: "/landing.html" }],
      afterFiles: [{ source: "/api/house/:path*", destination: `${HOUSE}/api/:path*` }],
      fallback: [],
    };
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
