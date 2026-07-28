/**
 * Headless extension entry point. Owlbear loads this via manifest `background_url`.
 *
 * Build order step 1 scope: prove the extension loads in a real room, prove the dev log
 * round-trips, and assert pixel access. Everything else lands in later steps.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel } from "./devlog";
import { assertPixelAccess } from "./probe";
import { installVisibilityOverlay } from "./debug/visibilityOverlay";
import { installRegionTracker } from "./region/tracker";
import { installClearRegionMenu } from "./debug/clearRegionMenu";
import { installChooseMapMenu } from "./sketch/chooseMapMenu";

installDevLog();

OBR.onReady(async () => {
  // Label this client before anything else logs — every client in the room shares one
  // receiver, and unlabelled interleaved output is actively misleading.
  const role = await OBR.player.getRole();
  setDevLogLabel(`${role === "GM" ? "GM" : "player"}:${OBR.player.id.slice(0, 4)}`);

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

  // Build order step 3: track the discovered region and draw it. Shares one visibility
  // computation with the overlay above. Step 5's traced sketch rides the same lifecycle — the
  // tracker owns `discovered` and the visible polygons, which are exactly what masking needs.
  void installRegionTracker();

  // Ships, unlike the dev menu below: a scene with more than one MAP image traces nothing until
  // the GM nominates one, because the other may be a GM overlay that must not be sketched onto
  // player screens.
  void installChooseMapMenu();

  // The drag probe (`./debug/dragProbe`) is deliberately NOT installed. It answered its question
  // — `getItemBounds` is live mid-drag, `getItems` is not — and leaving it running costs two
  // extra bounds round trips per light every 100ms, competing with the region tracker's poll for
  // exactly the resource that now limits sampling density. Re-install it to re-measure.

  // Development only. Right-click any item -> "Clear explored region" to reset a scene back to
  // unexplored, which is what makes discovery testable more than once.
  void installClearRegionMenu();

  // The storage probe (`./debug/storageProbe`) is deliberately NOT called any more. Its three
  // questions are answered and the numbers are recorded in DESIGN.md, "Storage limits". Leaving
  // it running costs on every load: it writes megabytes, floods the shared dev log with hundreds
  // of lines that bury whatever is actually being diagnosed, and consumes the same write rate
  // limit the region persistence needs. Re-enable it here to re-measure, not by default.
});

async function runProbe(): Promise<void> {
  try {
    await assertPixelAccess();
  } catch (error) {
    devLog("error", "CORS probe threw", error);
  }
}
