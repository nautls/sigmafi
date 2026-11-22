import { fileURLToPath, URL } from "url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import svgLoader from "vite-svg-loader";

const lithosTarget = process.env.VITE_LITHOS_API_TARGET || "http://127.0.0.1:9000";

function lithosProxy() {
  return {
    target: lithosTarget,
    changeOrigin: true,
    configure: (proxy: { on: (event: string, cb: (req: { removeHeader: (k: string) => void }) => void) => void }) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("origin");
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  css: { devSourcemap: true },
  plugins: [vue(), svgLoader()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  server: {
    proxy: {
      "/sigmafi": lithosProxy(),
      "/dex": lithosProxy(),
      "/wallet": lithosProxy()
    }
  }
});
