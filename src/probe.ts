/**
 * CORS startup assertion. See DESIGN.md, "Map pixel access".
 *
 * The CDN was verified to send `Access-Control-Allow-Origin: *` unconditionally, so this
 * is expected to pass — it exists because that check used asset URLs observed in the page
 * rather than the exact string `image.url` returns through the SDK, and because a
 * SecurityError surfacing later inside a trace pipeline is far harder to diagnose than
 * one reported at startup.
 */

import OBR, { isImage, type Image as ImageItem } from "@owlbear-rodeo/sdk";
import { devLog } from "./devlog";

export type ProbeOutcome = "clean" | "tainted" | "blocked";

/**
 * Load `url` cross-origin and attempt a 1px readback.
 *
 * - `clean`   — pixels are readable; the vector route works.
 * - `blocked` — the image never loaded (CORS refused at the network layer).
 * - `tainted` — loaded but unreadable. Should not happen with crossOrigin set.
 */
export function probeImageUrl(url: string): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve("blocked");
        ctx.drawImage(img, 0, 0, 1, 1);
        ctx.getImageData(0, 0, 1, 1);
        resolve("clean");
      } catch {
        resolve("tainted");
      }
    };
    img.onerror = () => resolve("blocked");

    img.src = withCacheBust(url);
  });
}

/**
 * Force a fresh fetch so the probe reports on the CORS policy rather than on whatever
 * happens to be sitting in the HTTP cache.
 */
function withCacheBust(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("cfProbe", Date.now().toString(36));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The last map URL successfully probed.
 *
 * Callers may invoke this more than once for the same scene — deliberately, since the
 * alternative is a check-then-subscribe race that can skip the probe entirely (see
 * background.ts). Keying on the URL makes repeats free while still re-probing when a new
 * scene brings in a map from a different origin.
 */
let lastProbedUrl: string | null = null;

/** Probe the current scene's map image, reporting through the dev log. */
export async function assertPixelAccess(): Promise<void> {
  if (!(await OBR.scene.isReady())) {
    devLog("info", "CORS probe skipped — no scene loaded");
    return;
  }

  const maps = await OBR.scene.items.getItems<ImageItem>(
    (item) => isImage(item) && item.layer === "MAP",
  );
  const map = maps[0];
  if (!map) {
    devLog("info", "CORS probe skipped — scene has no MAP image");
    return;
  }

  const url = map.image.url;
  if (url === lastProbedUrl) return;
  lastProbedUrl = url;
  const outcome = await probeImageUrl(url);

  if (outcome === "clean") {
    devLog("info", `CORS probe: CLEAN (${safeHost(url)}) — pixel access confirmed`);
  } else {
    // Deliberately console.error rather than devLog: this is the one message that must
    // survive into production builds, where devLog compiles away to nothing. The dev shim
    // wraps console.error, so it still reaches dev.log during development.
    console.error(
      `Cartographer's Fog — CORS probe: ${outcome.toUpperCase()} for ${url}. ` +
        `Map pixels are unreadable, so tracing cannot run. ` +
        `See DESIGN.md, "Fallback if pixel access ever breaks".`,
    );
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable url";
  }
}
