import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  /*
   * Pacchetti che turbopack non deve impacchettare, ma lasciare a node a
   * runtime: la module evaluation di eval/core si rompe, resvg e' un binding
   * nativo (.node), e il convertitore GLB carica un wasm con un loader che
   * turbopack non sa risolvere ("Can't resolve 'a'" in occt-import-js).
   * Tutti girano in route server, quindi lasciarli fuori dal bundle basta.
   */
  serverExternalPackages: [
    "@tscircuit/eval",
    "@tscircuit/core",
    "@resvg/resvg-js",
    "circuit-json-to-gltf",
    "occt-import-js",
  ],
};

export default nextConfig;
