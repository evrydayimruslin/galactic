const launchApiProxyTarget = process.env.LAUNCH_API_PROXY_TARGET ||
  "http://127.0.0.1:8787";

export default {
  clearScreen: false,
  server: {
    port: 5178,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api/launch": {
        target: launchApiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
      // Stripe Connect status/onboarding + earnings→balance transfers live
      // under /api/user on the same worker.
      "/api/user": {
        target: launchApiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
      // Keep copied local-development MCP URLs usable. Production serves the
      // same path on the public origin; Vite must explicitly forward it.
      "/mcp": {
        target: launchApiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
      // The passwordless confirmation screen is a launch-web SPA route. All
      // other /auth endpoints continue to proxy to the API worker.
      "^/auth/(?!confirm(?:[/?]|$))": {
        target: launchApiProxyTarget,
        changeOrigin: true,
        secure: true,
      },
    },
    fs: {
      allow: ["../.."],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
  envPrefix: ["VITE_"],
};
