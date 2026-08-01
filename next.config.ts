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
