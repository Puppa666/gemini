import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "./" => funziona su GitHub Pages con qualsiasi nome di repository
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
