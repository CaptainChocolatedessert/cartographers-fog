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

  // Subscribe BEFORE the first check, not after. A scene that becomes ready in the window
  // between checking `isReady()` and subscribing produces no transition to observe, and the
  // probe then never runs at all — silently, with no error. Observed happening
  // intermittently on real loads. Subscribing first cannot miss the transition; the probe
  // is idempotent per map, so the overlap is harmless.
  //
  // Re-running on scene change is wanted anyway: a new scene can bring in a map from a
  // different asset origin.
  OBR.scene.onReadyChange((ready) => {
    if (ready) void runProbe();
  });

  await runProbe();

  // Development only — draws the CPU visibility polygons over the scene so they can be
  // compared against the GPU fog. No-ops in production builds.
  installVisibilityOverlay();
});

async function runProbe(): Promise<void> {
  try {
    await assertPixelAccess();
  } catch (error) {
    devLog("error", "CORS probe threw", error);
  }
}
