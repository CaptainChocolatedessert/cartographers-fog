import { defineConfig } from "vite";

/**
 * `base` must match the GitHub Pages project subpath. Project Pages serve from
 * /<repo>/, and assets resolve against the origin root otherwise.
 *
 * The same prefix is hardcoded in public/manifest.json, which Vite does not rewrite.
 * If this changes, change that too.
 */
export default defineConfig({
  base: "/cartographers-fog/",
  server: {
    /**
     * Owlbear fetches the manifest from its own HTTPS origin, so loading the extension
     * from this dev server is a cross-origin request. Vite's default is to refuse those
     * — a deliberate hardening, since otherwise any page you visit while developing
     * could read your dev server's responses.
     *
     * Allow Owlbear specifically rather than setting `cors: true`, which would restore
     * exactly the hole the default is there to close. Dev server only; has no effect on
     * the built output.
     */
    cors: {
      origin: [/^https:\/\/([a-z0-9-]+\.)*owlbear\.rodeo$/],
    },
  },
  build: {
    rollupOptions: {
      // Relative to project root.
      input: {
        // Landing page — what a human sees at the Pages URL.
        main: "index.html",
        // Headless extension entry point, loaded by Owlbear via manifest background_url.
        background: "background.html",
      },
    },
  },
});
