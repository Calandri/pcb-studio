import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // il bundling server di turbopack rompe la module evaluation di eval/core, e
  // resvg e' un binding nativo (.node) che non e' impacchettabile in ESM:
  // vanno caricati nativamente da node_modules a runtime
  serverExternalPackages: ["@tscircuit/eval", "@tscircuit/core", "@resvg/resvg-js"],
};

export default nextConfig;
