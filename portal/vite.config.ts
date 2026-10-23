import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { clientLicenses } from "./clientLicenses";

export default defineConfig({
  root: resolve(__dirname, "client"),
  publicDir: false,
  plugins: [react(), clientLicenses()],
  build: { outDir: resolve(__dirname, "dist"), emptyOutDir: true },
});
