/**
 * Headless extension entry point. Owlbear loads this via manifest `background_url`.
 *
 * Build order step 1 scope: prove the extension loads in a real room, prove the dev log
 * round-trips, and assert pixel access. Everything else lands in later steps.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog } from "./devlog";
import { assertPixelAccess } from "./probe";
import { installVisibilityOverlay } from "./debug/visibilityOverlay";

installDevLog();

OBR.onReady(async () => {
  devLog("info", "Cartographer's Fog: background ready");

  await runProbe();

  // Development only — draws the CPU visibility polygons over the scene so they can be
  // compared against the GPU fog. No-ops in production builds.
  installVisibilityOverlay();

  // Scenes can be swapped without reloading the extension, and a scene change can bring
  // in a map from a different asset origin, so re-assert rather than trusting startup.
  OBR.scene.onReadyChange((ready) => {
    if (ready) void runProbe();
  });
});

async function runProbe(): Promise<void> {
  try {
    await assertPixelAccess();
  } catch (error) {
    devLog("error", "CORS probe threw", error);
  }
}
