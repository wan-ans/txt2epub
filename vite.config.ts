import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// base: "./" 是 Electron file:// 加载构建产物的前提
export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 首个渲染块只保留启动需要的代码；EPUB 编辑器（Quill）等按需加载
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          jszip: ["jszip"],
          vue: ["vue"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
