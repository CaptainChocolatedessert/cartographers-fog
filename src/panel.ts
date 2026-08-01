/**
 * The settings panel — the extension's first real UI, and the home for controls that a context
 * menu cannot host.
 *
 * ## This page writes metadata and nothing else
 *
 * The panel is a **separate iframe** from the background page. It shares no module state with the
 * tracker or the sketch: importing `tracker.ts` here would instantiate a second, empty copy rather
 * than reach the running one. So every control writes shared metadata, and the effect arrives back
 * through subscriptions the background page already has — `onSketchSettingsChange` for the map and
 * the clear, `onRegionChange` for the reset, `onAppearanceChange` for the look.
 *
 * That is not a workaround; it is DESIGN.md §5 working as intended. Shared state is the interface,
 * so a second surface costs no new plumbing, and it works identically for the GM's own client and
 * for every player at the table.
 *
 * ## What this closes
 *
 * - **The map picker works on a locked map.** A context menu needs an item *selected*, and a scene
 *   map is normally locked and so cannot be clicked — which made the nomination unreachable in
 *   exactly the scene that needed it.
 * - **The reset is confirmed.** DESIGN.md reached for `OBR.modal` or a context-menu `embed` because
 *   a context menu has nowhere to ask the question. Inside a panel it is a two-step button, so the
 *   modal is not needed after all.
 *
 * The three context-menu entries stay for now. They work, and retiring them is a separate call once
 * this has been used at a table.
 */

import OBR from "@owlbear-rodeo/sdk";

import {
  MAX_WIDTH_SQUARES,
  MAX_WOBBLE_SQUARES,
  MIN_WIDTH_SQUARES,
  type Appearance,
} from "./sketch/appearance";
import {
  onAppearanceChange,
  readAppearance,
  writeAppearance,
} from "./sketch/appearanceStore";
import { effectiveOpacity } from "./sketch/pencil";
import { listMapImages, type MapImageSummary } from "./sketch/mapImage";
import {
  clearSketch,
  onSketchSettingsChange,
  readSketchSettings,
  writeMapChoice,
} from "./sketch/sketchSettings";
import { clearRegion, writeRegion } from "./region/store";
import { buildSceneGrid } from "./region/sceneGrid";
import { fillMask } from "./region/regionMask";
import { devLog } from "./devlog";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

const gmOnly = element("gmOnly");
const playerOnly = element("playerOnly");
const mapsBox = element("maps");
const mapsEmpty = element("mapsEmpty");
const colorInput = element<HTMLInputElement>("color");
const widthInput = element<HTMLInputElement>("width");
const widthValue = element("widthValue");
const wobbleInput = element<HTMLInputElement>("wobble");
const wobbleValue = element("wobbleValue");
const periodInput = element<HTMLInputElement>("period");
const periodValue = element("periodValue");
const wobbleNote = element("wobbleNote");
const passesInput = element<HTMLInputElement>("passes");
const passesValue = element("passesValue");
const passOpacityInput = element<HTMLInputElement>("passOpacity");
const passOpacityValue = element("passOpacityValue");
const scatterInput = element<HTMLInputElement>("scatter");
const scatterValue = element("scatterValue");
const pencilNote = element("pencilNote");
const revealAllButton = element<HTMLButtonElement>("revealAll");
const clearButton = element<HTMLButtonElement>("clear");
const resetButton = element<HTMLButtonElement>("reset");
const status = element("status");

let chosenMapId: string | undefined;

/**
 * Two-step confirmation state for the reset.
 *
 * A second click within the window commits. Cheaper than a modal and, for a GM-only action whose
 * worst case is re-walking a map, proportionate — the thing being prevented is a misclick, not a
 * considered mistake.
 */
let resetArmed = false;
let disarmTimer: ReturnType<typeof setTimeout> | undefined;
const DISARM_MS = 4000;

function say(message: string): void {
  status.textContent = message;
}

/**
 * Width is *displayed* as `1/N` of a grid square, because that is how it is reasoned about — the
 * shipped default is "a twelfth of a square", not "0.0833 squares".
 *
 * But a bigger denominator is a *finer* line, so using it as the slider's value directly makes
 * dragging right thin the stroke, which is backwards from what a slider implies. The slider
 * therefore carries a thickness rank and these two functions flip between the two scales. The
 * endpoints are the denominators of `MIN_WIDTH_SQUARES` and `MAX_WIDTH_SQUARES`, so the slider
 * cannot express a value the store would clamp.
 */
const THIN_DENOMINATOR = Math.round(1 / MIN_WIDTH_SQUARES);
const THICK_DENOMINATOR = Math.round(1 / MAX_WIDTH_SQUARES);
const RANK_SUM = THIN_DENOMINATOR + THICK_DENOMINATOR;

/** Slider position (higher = thicker) for a width in grid squares. */
function rankFor(squares: number): number {
  return RANK_SUM - Math.round(1 / squares);
}

/** Width in grid squares for a slider position. */
function squaresForRank(rank: number): number {
  return squaresFor(RANK_SUM - rank);
}

function denominatorForRank(rank: number): number {
  return RANK_SUM - rank;
}

function squaresFor(denominator: number): number {
  return Math.min(MAX_WIDTH_SQUARES, Math.max(MIN_WIDTH_SQUARES, 1 / denominator));
}

/**
 * Wobble runs 0 to `MAX_WOBBLE_SQUARES` over the slider's whole travel, in half-hundredths of a
 * grid square, so the low end keeps fine steps — the shipped 0.02 sits at 8% of the range and the
 * settings worth having are probably near it rather than near the top.
 *
 * Shown as a percentage of a grid square rather than as `1/N` like the stroke width. Zero has no
 * denominator, and "off" is a state this control has to be able to express.
 */
const WOBBLE_STEPS = 50;
const wobbleSquaresForStep = (step: number): number =>
  (step / WOBBLE_STEPS) * MAX_WOBBLE_SQUARES;
const wobbleStepFor = (squares: number): number =>
  Math.round((squares / MAX_WOBBLE_SQUARES) * WOBBLE_STEPS);

function showWobble(step: number): void {
  wobbleValue.textContent =
    step === 0 ? "off" : `${(wobbleSquaresForStep(step) * 100).toFixed(1)}%`;
}

/**
 * Period is carried in hundredths of a grid square — a direct scale, unlike the width's
 * denominator or the amplitude's percentage, because a length in squares is what it is.
 */
const periodSquaresFor = (hundredths: number): number => hundredths / 100;
const periodHundredthsFor = (squares: number): number => Math.round(squares * 100);

/** Scatter is carried in thousandths of a square — the useful range is under a stroke width. */
const scatterSquaresFor = (thousandths: number): number => thousandths / 1000;
const scatterThousandthsFor = (squares: number): number =>
  Math.round(squares * 1000);

/**
 * Say what the pencil settings actually produce, because two of them compound in a way that
 * otherwise looks like the controls fighting each other: three passes at 50% do not read as
 * half-strength, they read as 87%. Showing the stacked result turns "why did raising passes make
 * it darker" into something visible rather than something to be discovered.
 *
 * Also names the case where the texture is silently inert — passes without scatter just redraw the
 * same line on top of itself, which darkens and textures nothing.
 */
function showPencilNote(
  passes: number,
  passOpacity: number,
  scatterSquares: number,
): void {
  if (passes <= 1) {
    pencilNote.textContent = "One pass — no texture.";
    return;
  }
  if (!(scatterSquares > 0)) {
    pencilNote.textContent =
      "Passes with no scatter fall on the same line — raise scatter to see the texture.";
    return;
  }
  pencilNote.textContent = `${passes} passes stack to ${(
    effectiveOpacity(passes, passOpacity) * 100
  ).toFixed(0)}% ink.`;
}

/**
 * Coalesce the continuous controls into one write per pause.
 *
 * A colour picker and a slider both fire `input` on every pixel of travel, and Owlbear rate-limits
 * metadata writes — DESIGN.md measured `RateLimitHit` on rapid writes and notes that the region's
 * debounce is what avoids an enforced limiter rather than mere politeness. Same reasoning here,
 * and the same trade: the panel updates its own readout immediately, and the table sees the change
 * a beat later.
 */
const WRITE_DEBOUNCE_MS = 200;
let pendingChanges: Partial<Appearance> = {};
let writeTimer: ReturnType<typeof setTimeout> | undefined;

function queueAppearance(changes: Partial<Appearance>): void {
  pendingChanges = { ...pendingChanges, ...changes };
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const changesToWrite = pendingChanges;
    pendingChanges = {};
    writeTimer = undefined;
    void writeAppearance(changesToWrite).catch((error) => {
      devLog("error", "panel: could not save appearance", error);
      say("Could not save that setting.");
    });
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Reflect stored settings in the controls.
 *
 * Skipped while a write is in flight: this also runs from `onAppearanceChange`, and adopting an
 * echo of our own debounced write would yank a slider back under the user's thumb mid-drag.
 */
function showAppearance(appearance: Appearance): void {
  if (writeTimer !== undefined) return;
  colorInput.value = appearance.strokeColor;
  const rank = rankFor(appearance.strokeWidthSquares);
  widthInput.value = String(rank);
  widthValue.textContent = `1/${denominatorForRank(rank)}`;
  const step = wobbleStepFor(appearance.wobbleSquares);
  wobbleInput.value = String(step);
  showWobble(step);
  const hundredths = periodHundredthsFor(appearance.wobbleWavelengthSquares);
  periodInput.value = String(hundredths);
  periodValue.textContent = periodSquaresFor(hundredths).toFixed(2);

  passesInput.value = String(appearance.pencilPasses);
  passesValue.textContent = String(appearance.pencilPasses);
  passOpacityInput.value = String(Math.round(appearance.pencilOpacity * 100));
  passOpacityValue.textContent = `${Math.round(appearance.pencilOpacity * 100)}%`;
  const scatter = scatterThousandthsFor(appearance.pencilScatterSquares);
  scatterInput.value = String(scatter);
  scatterValue.textContent =
    scatter === 0 ? "off" : scatterSquaresFor(scatter).toFixed(3);
  showPencilNote(
    appearance.pencilPasses,
    appearance.pencilOpacity,
    appearance.pencilScatterSquares,
  );
}

/** Current pencil settings as the controls show them, for the note and for writes. */
function pencilFromControls(): {
  passes: number;
  opacity: number;
  scatterSquares: number;
} {
  return {
    passes: Number(passesInput.value),
    opacity: Number(passOpacityInput.value) / 100,
    scatterSquares: scatterSquaresFor(Number(scatterInput.value)),
  };
}

function renderMaps(maps: readonly MapImageSummary[]): void {
  mapsBox.replaceChildren();
  mapsEmpty.hidden = maps.length > 0;

  for (const map of maps) {
    const button = document.createElement("button");
    button.className = map.id === chosenMapId ? "chosen" : "";

    const name = document.createElement("span");
    name.className = "map-name";
    name.textContent = map.name;

    // Size, lock and visibility are the facts that tell a real map from a token left on the MAP
    // layer, and a players' map from a GM overlay. The panel shows them rather than deciding.
    const detail = document.createElement("span");
    detail.className = "map-detail";
    detail.textContent =
      `${map.width}×${map.height}` +
      (map.visible ? "" : " · hidden") +
      (map.locked ? " · locked" : "") +
      (map.plausible ? "" : " · too small to be a map?") +
      (map.id === chosenMapId ? " · sketching this" : "");

    button.append(name, detail);
    button.addEventListener("click", () => {
      void choose(map);
    });
    mapsBox.append(button);
  }
}

async function choose(map: MapImageSummary): Promise<void> {
  try {
    // Re-enables the sketch as a side effect, which is the only way back from "Clear sketch".
    await writeMapChoice(map.id);
    chosenMapId = map.id;
    say(`Sketching from "${map.name}". Tracing takes a moment.`);
    await refreshMaps();
  } catch (error) {
    devLog("error", "panel: could not nominate a map", error);
    say("Could not save that choice.");
  }
}

async function refreshMaps(): Promise<void> {
  const [maps, settings] = await Promise.all([
    listMapImages(),
    readSketchSettings(),
  ]);
  // A nomination naming an item this scene does not have is stale — a map deleted, or a choice
  // made in another scene. Showing it as chosen would be a lie; `mapImage.ts` ignores it too.
  chosenMapId = maps.some((map) => map.id === settings.mapId)
    ? settings.mapId
    : undefined;
  renderMaps(maps);
}

/**
 * Owlbear's own light/dark, not the project's parchment palette.
 *
 * A panel is chrome and belongs to the app's UI; the sketch is content and keeps its sepia. Only
 * the handful of variables the stylesheet actually consumes are set, so a theme missing a field
 * falls back to the stylesheet's own value rather than to `undefined`.
 */
function applyTheme(theme: {
  mode?: string;
  background?: { paper?: string; default?: string };
  text?: { primary?: string; secondary?: string };
  primary?: { main?: string };
}): void {
  const root = document.documentElement.style;
  const paper = theme.background?.paper ?? theme.background?.default;
  if (paper) root.setProperty("--bg", paper);
  if (theme.text?.primary) root.setProperty("--text", theme.text.primary);
  if (theme.text?.secondary) root.setProperty("--dim", theme.text.secondary);
  if (theme.primary?.main) root.setProperty("--accent", theme.primary.main);
  root.setProperty(
    "--line",
    theme.mode === "LIGHT" ? "#00000024" : "#ffffff1f",
  );
}

function disarmReset(): void {
  resetArmed = false;
  resetButton.textContent = "Reset explored area";
  if (disarmTimer !== undefined) clearTimeout(disarmTimer);
  disarmTimer = undefined;
}

async function start(): Promise<void> {
  const role = await OBR.player.getRole();
  if (role !== "GM") {
    // Hiding controls is a convention, not a permission boundary — DESIGN.md notes the
    // `Permission` enum does not govern metadata, so this is politeness rather than enforcement.
    // The writes it guards are read-modify-write for exactly that reason.
    playerOnly.hidden = false;
    return;
  }
  gmOnly.hidden = false;

  await OBR.theme.getTheme().then(applyTheme).catch(() => {});
  OBR.theme.onChange(applyTheme);

  showAppearance(await readAppearance());
  await refreshMaps();

  // The scene's map list changes without this page knowing — a map added, deleted, or nominated
  // from the context menu that still ships.
  OBR.scene.items.onChange(() => {
    void refreshMaps();
  });
  onSketchSettingsChange(() => {
    void refreshMaps();
  });
  // Another client — or the GM's other window — may change the look.
  onAppearanceChange(showAppearance);

  colorInput.addEventListener("input", () => {
    queueAppearance({ strokeColor: colorInput.value });
  });

  widthInput.addEventListener("input", () => {
    const rank = Number(widthInput.value);
    // Readout updates now, the write lands on the pause — see `queueAppearance`.
    widthValue.textContent = `1/${denominatorForRank(rank)}`;
    queueAppearance({ strokeWidthSquares: squaresForRank(rank) });
  });

  wobbleInput.addEventListener("input", () => {
    const step = Number(wobbleInput.value);
    showWobble(step);
    // The note is shown because wobble is baked in at trace time — this costs a re-trace rather
    // than a redraw (see `appearance.ts`), and a few hundred milliseconds of nothing happening
    // otherwise reads as a control that did not work. The debounce matters more here than for the
    // other two: every settled value re-traces the map, so a dragged slider without it would
    // queue a few hundred milliseconds of work per pixel of travel.
    wobbleNote.hidden = false;
    queueAppearance({ wobbleSquares: wobbleSquaresForStep(step) });
    setTimeout(() => {
      wobbleNote.hidden = true;
    }, 1600);
  });

  passesInput.addEventListener("input", () => {
    const pencil = pencilFromControls();
    passesValue.textContent = String(pencil.passes);
    showPencilNote(pencil.passes, pencil.opacity, pencil.scatterSquares);
    // Geometry: a pass is a displaced copy, so the map is traced again.
    wobbleNote.hidden = false;
    queueAppearance({ pencilPasses: pencil.passes });
    setTimeout(() => {
      wobbleNote.hidden = true;
    }, 1600);
  });

  passOpacityInput.addEventListener("input", () => {
    const pencil = pencilFromControls();
    passOpacityValue.textContent = `${Math.round(pencil.opacity * 100)}%`;
    showPencilNote(pencil.passes, pencil.opacity, pencil.scatterSquares);
    // The one pencil control that is PathStyle rather than geometry, so it is a redraw only —
    // deliberately not in `invalidatesTrace`.
    queueAppearance({ pencilOpacity: pencil.opacity });
  });

  scatterInput.addEventListener("input", () => {
    const pencil = pencilFromControls();
    scatterValue.textContent =
      pencil.scatterSquares === 0 ? "off" : pencil.scatterSquares.toFixed(3);
    showPencilNote(pencil.passes, pencil.opacity, pencil.scatterSquares);
    wobbleNote.hidden = false;
    queueAppearance({ pencilScatterSquares: pencil.scatterSquares });
    setTimeout(() => {
      wobbleNote.hidden = true;
    }, 1600);
  });

  periodInput.addEventListener("input", () => {
    const hundredths = Number(periodInput.value);
    periodValue.textContent = periodSquaresFor(hundredths).toFixed(2);
    // Also a re-trace, and this one changes the point count too — the subdivision step follows
    // the period, so a short one produces a denser sketch.
    wobbleNote.hidden = false;
    queueAppearance({ wobbleWavelengthSquares: periodSquaresFor(hundredths) });
    setTimeout(() => {
      wobbleNote.hidden = true;
    }, 1600);
  });

  revealAllButton.addEventListener("click", () => {
    void (async () => {
      revealAllButton.disabled = true;
      try {
        // Built here rather than asked of the tracker, for the reason in this file's header: the
        // panel is its own iframe. `buildSceneGrid` is the same call the tracker makes, so the
        // grid matches and `store.ts`'s grid check accepts the write — a mask built against a
        // different grid would be rejected on read and the scene would silently stay unexplored.
        const grid = await buildSceneGrid();
        if (!grid) {
          say("No map in this scene to mark explored.");
          return;
        }

        // Every client's tracker unions this in through `onRegionChange`, exactly as it would a
        // region the GM had walked.
        const ok = await writeRegion(fillMask(grid));
        say(
          ok
            ? "Whole map marked explored. Anywhere currently in view still stays unsketched."
            : "Could not save the explored area.",
        );
      } catch (error) {
        devLog("error", "panel: could not mark the map explored", error);
        say("Could not mark the map explored.");
      } finally {
        revealAllButton.disabled = false;
      }
    })();
  });

  clearButton.addEventListener("click", () => {
    void (async () => {
      try {
        await clearSketch();
        await refreshMaps();
        say("Sketch cleared. Pick a map above to bring it back.");
      } catch (error) {
        devLog("error", "panel: could not clear the sketch", error);
        say("Could not clear the sketch.");
      }
    })();
  });

  resetButton.addEventListener("click", () => {
    if (!resetArmed) {
      resetArmed = true;
      resetButton.textContent = "Reset explored area — click again";
      disarmTimer = setTimeout(disarmReset, DISARM_MS);
      say("This cannot be undone.");
      return;
    }

    disarmReset();
    void (async () => {
      try {
        // A plain metadata write. Every client's tracker — including this GM's own background
        // page — reacts through `onRegionChange`, which clears its local mask and redraws. The
        // tracker also cancels any pending region write when it sees this, so a token settling
        // mid-reset cannot write the old region straight back.
        await clearRegion();
        say("Explored area reset.");
      } catch (error) {
        devLog("error", "panel: could not reset the explored area", error);
        say("Could not reset the explored area.");
      }
    })();
  });
}

OBR.onReady(() => {
  void start().catch((error) => {
    devLog("error", "panel: failed to start", error);
    say("The panel could not start.");
  });
});
