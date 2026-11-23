import type { NextConfig } from "next";

const HOUSE = process.env.HOUSE_URL ?? "http://35.187.34.216:8787";

const nextConfig: NextConfig = {
  transpilePackages: ["@penlight/sdk"],
  async rewrites() {
    return [{ source: "/api/house/:path*", destination: `${HOUSE}/api/:path*` }];
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
