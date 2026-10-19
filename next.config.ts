import type { NextConfig } from "next";
import path from "node:path";
import { version } from "./package.json";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  env: {
    /** release version shown in the footer; bumped by CI on every push */
    NEXT_PUBLIC_APP_VERSION: version,
  },
  /*
   * Pacchetti che turbopack non deve impacchettare, ma lasciare a node a
   * runtime: la module evaluation di eval/core si rompe, resvg e' un binding
   * nativo (.node), e il convertitore GLB carica un wasm con un loader che
   * turbopack non sa risolvere ("Can't resolve 'a'" in occt-import-js).
   * Tutti girano in route server, quindi lasciarli fuori dal bundle basta.
   */
  /*
   * Headers for every response. No full CSP: the tscircuit viewers load
   * workers and wasm in ways a strict policy would break, so it only says
   * what is safe everywhere (no framing, no plugins, no foreign <base>).
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  serverExternalPackages: [
    // the Altium parser: 6,6MB of ESM that turbopack has no reason to bundle
    "altium-toolkit",
    "@tscircuit/eval",
    "@tscircuit/core",
    "@resvg/resvg-js",
    "circuit-json-to-gltf",
    "occt-import-js",
  ],
};

export default nextConfig;
