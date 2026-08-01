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
  type Renderer,
} from "./sketch/appearance";
import {
  eraseAppearance,
  onAppearanceChange,
  readAppearance,
  writeAppearance,
} from "./sketch/appearanceStore";
import { effectiveOpacity } from "./sketch/pencil";
import { listMapImages, type MapImageSummary } from "./sketch/mapImage";
import {
  clearSketch,
  eraseSketchSettings,
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
const rendererInput = element<HTMLSelectElement>("renderer");
const rendererNote = element("rendererNote");
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
const featherInput = element<HTMLInputElement>("feather");
const featherValue = element("featherValue");
const featherNote = element("featherNote");
const shaderOnly = element("shaderOnly");
const strokesOnly = element("strokesOnly");
const scatterInput = element<HTMLInputElement>("scatter");
const scatterValue = element("scatterValue");
const pencilNote = element("pencilNote");
const revealAllButton = element<HTMLButtonElement>("revealAll");
const clearButton = element<HTMLButtonElement>("clear");
const resetButton = element<HTMLButtonElement>("reset");
const eraseSceneButton = element<HTMLButtonElement>("eraseScene");
const eraseRoomButton = element<HTMLButtonElement>("eraseRoom");
const status = element("status");

let chosenMapId: string | undefined;

/**
 * Two-step confirmation state for the reset.
 *
 * A second click within the window commits. Cheaper than a modal and, for a GM-only action whose
 * worst case is re-walking a map, proportionate — the thing being prevented is a misclick, not a
 * considered mistake.
 */
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
 * Say what the renderer choice actually changes, since the two look similar in a still.
 *
 * Worth a line rather than leaving it to be discovered: the shader route trades roughly a hundred
 * scene items for three, and the Pencil controls below stop applying under it — passes exist
 * because a `Path`'s style is per-item, which is precisely the constraint the shader removes. A
 * control that silently stops doing anything is the sort of thing that reads as a bug.
 */
function showRendererNote(renderer: Renderer): void {
  rendererNote.textContent =
    renderer === "shader"
      ? "Soft edges, drawn per pixel."
      : "Hard-edged vector lines. Much cheaper to draw.";
}

/**
 * Show only the controls the current renderer actually obeys.
 *
 * Edge is shader-only because a `Path`'s silhouette is hard whatever it is set to; the Pencil group
 * is `Path`-only because passes exist to work around `PathStyle` being per-item, which is precisely
 * the constraint the shader removes. Leaving both on screen would mean, on either setting, a slider
 * that moves and changes nothing — and an inert control is read as a bug in the renderer rather than
 * as a control that does not apply.
 *
 * Hidden, not disabled. A disabled row still occupies a short panel and still invites the question.
 * The stored values survive either way, so switching back restores what was set.
 */
function showRelevantControls(renderer: Renderer): void {
  shaderOnly.hidden = renderer !== "shader";
  strokesOnly.hidden = renderer !== "strokes";
}

/** Feather is carried in hundredths of the stroke's half-width. */
const featherFractionFor = (hundredths: number): number => hundredths / 100;
const featherHundredthsFor = (fraction: number): number =>
  Math.round(fraction * 100);

/**
 * Name the two ends, because neither is obvious from a percentage.
 *
 * Zero is worth calling out especially: it makes the shader renderer draw a hard edge, which is
 * what "Lines" already does — so a GM who has slid it to zero and cannot see the difference is
 * looking at the right answer, not a broken one.
 */
function showFeatherNote(fraction: number): void {
  if (fraction === 0) {
    featherNote.textContent = "Hard edge — the same silhouette as Lines.";
  } else if (fraction >= 0.8) {
    featherNote.textContent = "All fade, no solid core.";
  } else {
    featherNote.textContent = "";
  }
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
  rendererInput.value = appearance.renderer;
  showRendererNote(appearance.renderer);
  showRelevantControls(appearance.renderer);
  const feather = featherHundredthsFor(appearance.featherFraction);
  featherInput.value = String(feather);
  featherValue.textContent = `${feather}%`;
  showFeatherNote(appearance.featherFraction);
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

/**
 * Wire the tab strip.
 *
 * Driven off `data-panel` and `[role="tab"]` rather than a hardcoded list, so adding a tab is a
 * button and a panel in the HTML and nothing here.
 *
 * **The tab is not persisted, and that is a deliberate omission rather than an oversight.** The
 * popover is torn down and rebuilt each time it opens, so remembering the choice needs somewhere
 * durable — and both candidates are wrong for it. Room metadata would broadcast a GM's tab to every
 * client and cost a networked write per click; `sessionStorage` is partitioned per top-level site by
 * Firefox's Total Cookie Protection in this third-party iframe (see the environment notes) and can
 * simply vanish. Opening on Setup every time is a small cost against either.
 */
function installTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

  const select = (chosen: HTMLButtonElement): void => {
    for (const tab of tabs) {
      const selected = tab === chosen;
      tab.setAttribute("aria-selected", String(selected));
      // Roving tabindex: a tablist is one stop in the tab order, and the arrow keys move within it.
      // Without this every tab is its own stop, which is the wrong shape for a group of three.
      tab.tabIndex = selected ? 0 : -1;
      element(tab.dataset.panel!).hidden = !selected;
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      // Wraps, which is what a tablist is expected to do.
      const next = tabs[(index + step + tabs.length) % tabs.length]!;
      select(next);
      next.focus();
    });
  });
}

/**
 * Give a button a two-click confirmation: the first arms it, a second within `DISARM_MS` commits.
 *
 * Cheaper than a modal and proportionate for GM-only actions whose worst case is re-walking a map
 * — the thing being prevented is a misclick, not a considered mistake. `OBR.modal` remains the
 * honest answer if one of these ever grows teeth.
 *
 * **One armed button at a time, and that is the point of centralising this.** With three
 * destructive buttons each holding private arm state, arming one and then clicking another would
 * leave the first silently armed behind a label that had reverted — so a later stray click on it
 * would fire immediately with no confirmation at all. Arming here disarms every other.
 */
interface Confirmable {
  disarm(): void;
}
const confirmables: Confirmable[] = [];

function installConfirm(
  button: HTMLButtonElement,
  idleLabel: string,
  armedLabel: string,
  warning: string,
  commit: () => Promise<void>,
): void {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    armed = false;
    button.textContent = idleLabel;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  confirmables.push({ disarm });

  button.addEventListener("click", () => {
    if (!armed) {
      for (const other of confirmables) other.disarm();
      armed = true;
      button.textContent = armedLabel;
      timer = setTimeout(disarm, DISARM_MS);
      say(warning);
      return;
    }

    disarm();
    void commit().catch((error) => {
      devLog("error", `panel: ${idleLabel} failed`, error);
      say("That did not work — see the log.");
    });
  });
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
  installTabs();

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

  featherInput.addEventListener("input", () => {
    const fraction = featherFractionFor(Number(featherInput.value));
    featherValue.textContent = `${featherHundredthsFor(fraction)}%`;
    showFeatherNote(fraction);
    // A uniform on effects that get rebuilt anyway, so a redraw — not in `invalidatesTrace`.
    queueAppearance({ featherFraction: fraction });
  });

  rendererInput.addEventListener("change", () => {
    const renderer = rendererInput.value as Renderer;
    showRendererNote(renderer);
    showRelevantControls(renderer);
    // `change`, not `input`, and no debounce needed — a select fires once when the choice settles
    // rather than continuously, so this cannot meet the rate limiter the sliders have to dodge.
    // A redraw only: both renderers consume the same wobbled geometry, which is what makes them
    // comparable. See `invalidatesTrace`, which deliberately excludes this.
    queueAppearance({ renderer });
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

  installConfirm(
    resetButton,
    "Reset explored area",
    "Reset explored area — click again",
    "This cannot be undone.",
    async () => {
      // A plain metadata write. Every client's tracker — including this GM's own background
      // page — reacts through `onRegionChange`, which clears its local mask and redraws. The
      // tracker also cancels any pending region write when it sees this, so a token settling
      // mid-reset cannot write the old region straight back.
      await clearRegion();
      say("Explored area reset.");
    },
  );

  installConfirm(
    eraseSceneButton,
    "Erase this scene's data",
    "Erase scene data — click again",
    "Erases the region, the map choice and the off switch.",
    async () => {
      // Both writes go through the ordinary paths so the tracker's existing subscriptions do the
      // work — `clearRegion` in particular cancels any pending debounced region write, which is
      // the race that would otherwise put the region straight back a moment later.
      //
      // Region first. Erasing the settings re-enables tracing on a one-map scene, and doing that
      // while the old region is still stored would briefly redraw the whole remembered sketch
      // before wiping it.
      await clearRegion();
      await eraseSketchSettings();
      await refreshMaps();
      // Says the map re-traces, because otherwise the next thing that happens looks like the erase
      // failed: the region is empty, so the sketch redraws from scratch as ground is re-explored,
      // and a GM watching lines return has no way to tell a fresh trace from the old one surviving.
      say("Scene data erased. The map re-traces, and sketches again as you explore.");
    },
  );

  installConfirm(
    eraseRoomButton,
    "Erase appearance settings",
    "Erase appearance — click again",
    "Room-wide: affects every scene in this room.",
    async () => {
      await eraseAppearance();
      // The store's own change subscription repaints the controls on every client, this one
      // included, so there is nothing to update by hand here.
      say("Appearance reset to defaults for the whole room.");
    },
  );
}

OBR.onReady(() => {
  void start().catch((error) => {
    devLog("error", "panel: failed to start", error);
    say("The panel could not start.");
  });
});
