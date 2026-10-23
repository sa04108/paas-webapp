import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { clientLicenses } from "./clientLicenses.mts";

export default defineConfig({
  root: resolve(import.meta.dirname, "client"),
  publicDir: false,
  plugins: [react(), clientLicenses()],
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true },
});
