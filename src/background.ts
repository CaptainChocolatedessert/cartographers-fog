/**
 * Headless extension entry point. Owlbear loads this via manifest `background_url`.
 *
 * Build order step 1 scope: prove the extension loads in a real room, prove the dev log
 * round-trips, and assert pixel access. Everything else lands in later steps.
 */

import OBR from "@owlbear-rodeo/sdk";
import { installDevLog, devLog, setDevLogLabel } from "./devlog";
import { assertPixelAccess } from "./probe";
import { installRegionTracker } from "./region/tracker";
import { installRaiseMenu } from "./annotations/raiseMenu";
import { installResetMenu } from "./region/resetMenu";
import { installSketchMenus } from "./sketch/sketchMenu";

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

  // The visibility overlay (`./debug/visibilityOverlay`) is deliberately NOT installed, same as
  // the two probes below. Its cyan outlines answered step 2's question — the CPU polygons track
  // the GPU fog, and `attenuationRadius` is the outer edge of the falloff — and they now draw on
  // top of the sketch they were used to build. Re-install it to re-check that tuning after
  // changing the sweep, which DESIGN.md §1 expects to be necessary. It was dev-only and
  // tree-shaken from production regardless, so this changes only what a developer sees.

  // Build order step 3: track the discovered region and draw it. Shares one visibility
  // computation with the overlay above. Step 5's traced sketch rides the same lifecycle — the
  // tracker owns `discovered` and the visible polygons, which are exactly what masking needs.
  void installRegionTracker();

  // The GM's controls, both shipping. Nominating a map is required on a scene with more than one
  // MAP image, since the other may be a GM overlay that must not be sketched onto player screens;
  // the toggle is how a scene whose map traces badly gets the sketch switched off.
  void installSketchMenus();

  // Also ships. The discovered region only ever grows, so without a reset a GM who has explored
  // a scene has no way back to an unexplored one.
  void installResetMenu();

  // Nothing to do with the sketch: a label or an arrow drawn on the map is hidden by the fog like
  // anything else, and some annotations are meant to be read at all times. The panel carries the
  // bulk way back, which is what makes the raise safe to offer at all — see `raiseMenu.ts`.
  void installRaiseMenu();

  // The drag probe (`./debug/dragProbe`) is deliberately NOT installed. It answered its question
  // — `getItemBounds` is live mid-drag, `getItems` is not — and leaving it running costs two
  // extra bounds round trips per light every 100ms, competing with the region tracker's poll for
  // exactly the resource that now limits sampling density. Re-install it to re-measure.

  // The uniform probe (`./debug/uniformProbe`) is deliberately NOT installed, retired 2026-08-01
  // having answered phase 0 of the shader renderer: 256 slots and 517 uniforms per effect are
  // accepted with no ceiling found, padded sentinel slots draw nothing, one 64-slot effect over ten
  // grid squares costs no visible frame rate, and a stroke split across two effects shows no seam.
  // Numbers and the reasoning about batch size are in DESIGN.md, "Phase 0 — MEASURED". Re-install it
  // to re-measure after changing `sdfSource`; note its ladder must draw SEPARATE marks per slot, as
  // a saturated cell cannot tell a working slot count from a broken one.

  // The render probes (`./debug/blendProbe`, `./debug/dataUrlProbe`) are deliberately NOT
  // installed, and retired for the same reason as the two below: they answered their questions and
  // then drew bars, cyan patches and swatch boxes over the map on every scene open. All three
  // findings are in DESIGN.md — `data:` URLs do not render, an attached effect clips to its
  // parent's fill and needs no visible fill, and a `STANDALONE` effect can draw a stroke outright
  // from geometry passed as uniforms, stably in world space. Re-install to re-measure; the cells
  // are cheap to extend, which is how the last one got to ten.

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

