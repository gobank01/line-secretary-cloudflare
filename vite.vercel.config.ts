// Build เฉพาะฝั่งหน้าเว็บ (ไม่มี Cloudflare plugin) สำหรับ deploy บน Vercel
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-vercel" },
});
