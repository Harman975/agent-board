import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/server.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
  },
]);
