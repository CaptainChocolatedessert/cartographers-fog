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
  DEFAULT_APPEARANCE,
  MAX_WIDTH_SQUARES,
  MAX_WOBBLE_SQUARES,
  MIN_WIDTH_SQUARES,
  type Appearance,
  type BrushId,
  type BrushSettings,
  type ParchmentSettings,
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
  writeWallMargin,
} from "./sketch/sketchSettings";
import { clearRegion, writeRegion } from "./region/store";
import { describeError } from "./describeError";
import { buildSceneGrid } from "./region/sceneGrid";
import { fillMask } from "./region/regionMask";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

const gmOnly = element("gmOnly");
const playerOnly = element("playerOnly");
const mapsBox = element("maps");
const mapsEmpty = element("mapsEmpty");
const noScene = element("noScene");
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
const brushInput = element<HTMLSelectElement>("brush");
const featherInput = element<HTMLInputElement>("feather");
const featherValue = element("featherValue");
const featherNote = element("featherNote");
const grainScaleInput = element<HTMLInputElement>("grainScale");
const grainScaleValue = element("grainScaleValue");
const grainDepthInput = element<HTMLInputElement>("grainDepth");
const grainDepthValue = element("grainDepthValue");
const edgeRoughnessInput = element<HTMLInputElement>("edgeRoughness");
const edgeRoughnessValue = element("edgeRoughnessValue");
const taperInput = element<HTMLInputElement>("taper");
const taperValue = element("taperValue");
const entryBulgeInput = element<HTMLInputElement>("entryBulge");
const entryBulgeValue = element("entryBulgeValue");
const tailWidthInput = element<HTMLInputElement>("tailWidth");
const tailWidthValue = element("tailWidthValue");
const pressureInput = element<HTMLInputElement>("pressure");
const pressureValue = element("pressureValue");
const nibAngleInput = element<HTMLInputElement>("nibAngle");
const nibAngleValue = element("nibAngleValue");
const nibContrastInput = element<HTMLInputElement>("nibContrast");
const nibContrastValue = element("nibContrastValue");
const parchmentOn = element<HTMLInputElement>("parchmentOn");
const parchmentControls = element("parchmentControls");
const parchmentColor = element<HTMLInputElement>("parchmentColor");
const parchmentOpacity = element<HTMLInputElement>("parchmentOpacity");
const parchmentOpacityValue = element("parchmentOpacityValue");
const parchmentScale = element<HTMLInputElement>("parchmentScale");
const parchmentScaleValue = element("parchmentScaleValue");
const parchmentContrast = element<HTMLInputElement>("parchmentContrast");
const parchmentContrastValue = element("parchmentContrastValue");
const shaderOnly = element("shaderOnly");
const strokesOnly = element("strokesOnly");
const grainOnly = element("grainOnly");
const inkOnly = element("inkOnly");
const nibOnly = element("nibOnly");
const scatterInput = element<HTMLInputElement>("scatter");
const scatterValue = element("scatterValue");
const pencilNote = element("pencilNote");
const wallMarginInput = element<HTMLInputElement>("wallMargin");
const wallMarginValue = element("wallMarginValue");
const wallMarginNote = element("wallMarginNote");
const playersMayStyleInput = element<HTMLInputElement>("playersMayStyle");
const gmOnlyAppearance = element("gmOnlyAppearance");
const tabStrip = document.querySelector<HTMLElement>(".tabs")!;
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

/**
 * The startup step in progress, for the console line when one of them fails.
 *
 * `start()` is a long run of awaits and each one used to report the same sentence, so a failure said
 * nothing about *where* it happened — six different causes, one indistinguishable message. Recording
 * the step costs an assignment and turns "the panel could not start" into a line naming the call
 * that refused.
 */
let stage = "loading";

/**
 * Report a failure: the whole of it to the console, a plain sentence to the panel.
 *
 * **Not `devLog`.** That shim compiles away in production, so every error path here threw its cause
 * on the floor the moment it was deployed — the string "panel: failed to start" appears in none of
 * the built chunks. DESIGN.md already records this rule for the CORS probe: anything reported to a
 * user in production goes through `console.error`, which the dev shim forwards to `dev.log` anyway,
 * so nothing is lost locally either.
 *
 * The described form leads the console line because a raw payload logs collapsed — `Object { error:
 * {…} }` — and has to be expanded by hand before it says anything at all. The raw value follows it
 * for the cases the one-liner does not cover.
 *
 * **The panel itself gets none of that** (user, 2026-08-04: it "doesn't have to be a debugging
 * tool"). A GM wants to know their setting did not save; the name of the SDK error that refused it
 * is noise to them and the console is a better home for it.
 *
 * @param hint appended on screen, for the one failure where the panel is wholly unusable and so
 * worth saying where the reason can be found.
 */
function report(message: string, error: unknown, hint?: string): void {
  console.error(
    `panel: ${message} (${stage}) — ${describeError(error)}`,
    error,
  );
  say(hint ? `${message}. ${hint}` : `${message}.`);
}

function say(message: string): void {
  status.textContent = message;
}

/**
 * Width is carried as **tenths of a percent of a grid square**, so the slider is linear in the
 * thing being looked at.
 *
 * This replaced a slider whose value was a *denominator* — `1/12` of a square and so on — which
 * read well but behaved badly (user, 2026-08-02: "the result feels nonlinear with too little
 * resolution at the high end"). The trouble is that 1/N compresses exactly where the control is
 * wanted: one step near the thick end moved the width by a quarter of itself (1/4 to 1/5 is a 20%
 * jump), while one step near the thin end moved it by under two percent. Resolution was inverted,
 * and there was no way to ask for a stroke between 1/4 and 1/5 at all.
 *
 * Percent of a square gives every step the same weight. The cost is the readout: "8.3%" is less
 * evocative than "1/12", and the shipped default is genuinely thought of as a twelfth. That is the
 * trade, and it is worth it — the display was never the part that was hard to use.
 *
 * Tenths rather than whole percent because the useful range is only 1.7% to 25%, and whole percent
 * would offer 24 positions across it.
 */
const widthTenthsFor = (squares: number): number => Math.round(squares * 1000);

const widthSquaresFor = (tenths: number): number =>
  Math.min(MAX_WIDTH_SQUARES, Math.max(MIN_WIDTH_SQUARES, tenths / 1000));

const showWidth = (tenths: number): void => {
  widthValue.textContent = `${(tenths / 10).toFixed(1)}%`;
};

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
      ? "Marks drawn per pixel. Each brush keeps its own settings."
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
function showRelevantControls(renderer: Renderer, brush: BrushId): void {
  shaderOnly.hidden = renderer !== "shader";
  strokesOnly.hidden = renderer !== "strokes";
  // Each brush shows only its own controls. Under another brush these sliders would move and change
  // nothing, which reads as a broken brush rather than as controls that do not apply.
  const brushes = renderer === "shader";
  grainOnly.hidden = !brushes || brush !== "charcoal";
  inkOnly.hidden = !brushes || brush !== "ink";
  nibOnly.hidden = !brushes || brush !== "nib";
}

/**
 * Decide what this client may see, for a role and a current permission setting.
 *
 * Called at startup *and* from `onAppearanceChange`, which is the part that matters: a GM revoking
 * access mid-session must take the tab away from a player who already has the panel open. The
 * appearance subscription fires on every client anyway, so this costs nothing and its absence would
 * read as "I turned it off and they kept fiddling".
 *
 * Note this deliberately does **not** sit inside `showAppearance`, which skips its work while a
 * write is pending so a slider is not yanked mid-drag. Suppressing a *revocation* for that reason
 * would be exactly wrong — a player fiddling with a slider is precisely the player whose access has
 * just been withdrawn.
 *
 * Players get the Appearance tab and nothing else. Setup and Debug hold the map nomination, the
 * explored-area reset and the two erase buttons: all either destructive or scene-owning, and none
 * of them things this switch was offered to hand over.
 */
function applyAccess(isGm: boolean, playersMayStyle: boolean): void {
  const allowed = isGm || playersMayStyle;
  gmOnly.hidden = !allowed;
  playerOnly.hidden = allowed;
  gmOnlyAppearance.hidden = !isGm;

  // One tab needs no tab strip; a lone "Appearance" button is chrome advertising a choice that
  // isn't there. The panels themselves are switched below rather than by `installTabs`, which never
  // runs its click handlers for a player.
  tabStrip.hidden = !isGm;
  if (isGm) return;

  for (const tab of document.querySelectorAll<HTMLElement>('[role="tabpanel"]')) {
    tab.hidden = tab.id !== "panelAppearance";
  }
}

/**
 * The whole appearance as last seen, so a brush write can be composed against it.
 *
 * `writeAppearance` merges shallowly, so writing one brush's slider means sending the *entire*
 * `brushes` record — send only the edited brush and every other brush's tuning is erased. This is
 * also updated optimistically in `queueBrush`, because two slider moves inside one debounce window
 * would otherwise both build on the same stale record and the first would be lost.
 */
let current: Appearance = DEFAULT_APPEARANCE;

/** Queue a change to the *currently selected* brush, preserving every other brush's settings. */
function queueBrush(changes: Partial<BrushSettings>): void {
  const id = current.brush;
  const brushes = {
    ...current.brushes,
    [id]: { ...current.brushes[id], ...changes },
  };
  current = { ...current, brushes };
  queueAppearance({ brushes });
}

function showBrushSettings(settings: BrushSettings): void {
  const feather = featherHundredthsFor(settings.featherFraction);
  featherInput.value = String(feather);
  featherValue.textContent = `${feather}%`;
  showFeatherNote(settings.featherFraction);

  const scale = grainThousandthsFor(settings.grainScaleSquares);
  grainScaleInput.value = String(scale);
  grainScaleValue.textContent = grainSquaresFor(scale).toFixed(3);

  const depth = Math.round(settings.grainDepth * 100);
  grainDepthInput.value = String(depth);
  grainDepthValue.textContent = `${depth}%`;

  const rough = Math.round(settings.edgeRoughness * 100);
  edgeRoughnessInput.value = String(rough);
  edgeRoughnessValue.textContent = `${rough}%`;
}

/**
 * Reflect the parchment settings, and hide its controls when it is off.
 *
 * Hidden rather than disabled, matching the brush groups: four inert sliders under an unticked box
 * is a lot of panel spent saying nothing.
 */
function showParchment(settings: ParchmentSettings): void {
  parchmentOn.checked = settings.enabled;
  parchmentControls.hidden = !settings.enabled;
  parchmentColor.value = settings.color;

  const opacity = Math.round(settings.opacity * 1000);
  parchmentOpacity.value = String(opacity);
  parchmentOpacityValue.textContent = `${(opacity / 10).toFixed(1)}%`;

  const scale = Math.round(settings.scaleSquares * 100);
  parchmentScale.value = String(scale);
  parchmentScaleValue.textContent = (scale / 100).toFixed(2);

  const contrast = Math.round(settings.contrast * 100);
  parchmentContrast.value = String(contrast);
  parchmentContrastValue.textContent = `${contrast}%`;
}

/**
 * Queue a change to the parchment block, composed against the whole of it.
 *
 * Same reasoning as `queueBrush`: `writeAppearance` merges shallowly, so sending a partial
 * `parchment` object would erase the fields it left out.
 */
function queueParchment(changes: Partial<ParchmentSettings>): void {
  const parchment = { ...current.parchment, ...changes };
  current = { ...current, parchment };
  queueAppearance({ parchment });
}

/** Grain cell size is carried in thousandths of a grid square. */
const grainSquaresFor = (thousandths: number): number => thousandths / 1000;
const grainThousandthsFor = (squares: number): number =>
  Math.round(squares * 1000);

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

/**
 * The margin's own debounce, separate from the appearance one because it writes *scene* metadata.
 *
 * Sharing a timer would mean a margin change and a colour change coalescing into one pause and
 * then landing as two writes anyway, against two different stores — no saving, and a suppression
 * flag that no longer says which store is mid-write.
 */
let marginWriteTimer: ReturnType<typeof setTimeout> | undefined;

function queueWallMargin(strokeWidths: number): void {
  if (marginWriteTimer !== undefined) clearTimeout(marginWriteTimer);
  marginWriteTimer = setTimeout(() => {
    marginWriteTimer = undefined;
    void writeWallMargin(strokeWidths).catch((error) => {
      report("Could not save the wall margin", error);
    });
  }, WRITE_DEBOUNCE_MS);
}

function queueAppearance(changes: Partial<Appearance>): void {
  pendingChanges = { ...pendingChanges, ...changes };
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const changesToWrite = pendingChanges;
    pendingChanges = {};
    writeTimer = undefined;
    void writeAppearance(changesToWrite).catch((error) => {
      report("Could not save that setting", error);
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
  // Kept so brush writes can be composed against the whole record — see `queueBrush`.
  current = appearance;
  rendererInput.value = appearance.renderer;
  brushInput.value = appearance.brush;
  showRendererNote(appearance.renderer);
  showRelevantControls(appearance.renderer, appearance.brush);
  showBrushSettings(appearance.brushes[appearance.brush]);
  showParchment(appearance.parchment);
  playersMayStyleInput.checked = appearance.playersMayStyle;
  colorInput.value = appearance.strokeColor;
  const widthTenths = widthTenthsFor(appearance.strokeWidthSquares);
  widthInput.value = String(widthTenths);
  showWidth(widthTenths);
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

/**
 * Whether a scene is open, as last observed. `undefined` until the first observation, which is what
 * makes `applyScene` idempotent without swallowing the very first call.
 */
let sceneReady: boolean | undefined;

/**
 * Keep the scene-dependent half of the panel in step with whether a scene is actually open.
 *
 * **This is why the panel would not start at all.** Startup read the scene — the map list, and the
 * scene settings behind the wall-margin slider — the moment it reached that line, with nothing
 * asking whether there was a scene to read. Owlbear refuses those calls outright when there is not
 * (`MissingDataError: No scene found`), and the refusal came straight back out of `start()`, so the
 * whole panel was abandoned over it — including the entire Appearance tab, which is room-scoped and
 * would have worked perfectly well. A popover is a freshly built frame: its connection to Owlbear
 * goes ready as soon as the message channel is up, which is *not* the moment the scene has been
 * handed to it, so the read landed too early every time.
 *
 * **Subscribe first, then check.** This project's own rule, and the panel was the one surface not
 * following it — the background page, the region tracker, the visibility watcher and the startup
 * probe all do. Checking first would leave a window in which a scene arriving produces no transition
 * to observe, and the panel would sit empty for the rest of the session. The resulting overlap is
 * free because `applyScene` ignores an observation matching what it already believes.
 */
function watchScene(): void {
  OBR.scene.onReadyChange(applyScene);
  void OBR.scene.isReady()
    .then(applyScene)
    .catch((error) => {
      // Caught rather than left to become an unhandled rejection: this runs outside `start()`, so
      // there is no longer a catch above it, and the whole point of moving it out here was that the
      // scene must not be able to take the panel down with it.
      report("Could not tell whether a scene is open", error);
    });
}

function applyScene(ready: boolean): void {
  if (ready === sceneReady) return;
  sceneReady = ready;

  // A scene change must not leave a destructive button one click from firing, because the click
  // that follows would land on a *different* scene than the one the GM was looking at when they
  // armed it.
  for (const confirmable of confirmables) confirmable.disarm();

  showSceneControls(ready);
  if (ready) refreshMapsIfReady();
  else renderMaps([]);
}

/**
 * Show the scene-scoped controls as what they are.
 *
 * Everything in Setup, plus erasing this scene's data, reads or writes the open scene — with none
 * open they would not merely be unhelpful, they would fail. Disabled says that plainly. Appearance
 * is deliberately untouched: it lives in room metadata and works with no scene at all, which is the
 * whole point of the panel surviving this state rather than abandoning startup over it.
 */
function showSceneControls(ready: boolean): void {
  noScene.hidden = ready;
  wallMarginInput.disabled = !ready;
  revealAllButton.disabled = !ready;
  clearButton.disabled = !ready;
  resetButton.disabled = !ready;
  eraseSceneButton.disabled = !ready;
}

/**
 * Refresh the map list, but only when there is a scene to read it from.
 *
 * The two subscriptions that call this fire for reasons of their own — and one of them, scene
 * metadata, carries every region write during play — so they can easily land while no scene is
 * open. Reading the scene without one is the failure this whole gate exists to stop, so the guard
 * is load-bearing rather than defensive dressing.
 */
function refreshMapsIfReady(): void {
  if (sceneReady !== true) return;
  void refreshMaps().catch((error) => {
    // A scene can close between the check and the read. Rare, and the next readiness change puts
    // the panel right; reported rather than swallowed so it cannot become another silent failure.
    report("Could not read this scene", error);
  });
}

function renderMaps(maps: readonly MapImageSummary[]): void {
  mapsBox.replaceChildren();
  // "No MAP-layer image in this scene" is a lie when there is no scene, and `noScene` is saying the
  // true thing in its place.
  mapsEmpty.hidden = maps.length > 0 || sceneReady !== true;

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
    report("Could not save that choice", error);
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
  showWallMargin(settings.marginStrokeWidths);
}

/** Hundredths of a stroke width, so the judged 1.5 is reachable on a whole-number slider. */
const marginHundredthsFor = (strokeWidths: number): number =>
  Math.round(strokeWidths * 100);
const marginStrokeWidthsFor = (hundredths: number): number => hundredths / 100;

/**
 * Reflect the stored margin, unless a write of our own is still pending.
 *
 * Same reasoning as the appearance controls: this also runs from `onSketchSettingsChange`, which
 * fires for *every* scene metadata write including the region's — several a minute during play —
 * so adopting one mid-drag would yank the slider under the GM's thumb.
 */
function showWallMargin(strokeWidths: number): void {
  if (marginWriteTimer !== undefined) return;
  const hundredths = marginHundredthsFor(strokeWidths);
  wallMarginInput.value = String(hundredths);
  showMarginReadout(hundredths);
}

function showMarginReadout(hundredths: number): void {
  const strokeWidths = marginStrokeWidthsFor(hundredths);
  wallMarginValue.textContent =
    hundredths === 0 ? "off" : `${strokeWidths.toFixed(2)}×`;

  // Both ends are worth naming, because both look like faults. Zero is the one to explain: the
  // linework going patchy along a wall is the artefact the margin exists to remove, so a GM who
  // has slid it to nothing is looking at the expected result rather than a broken trace.
  wallMarginNote.textContent =
    hundredths === 0
      ? "Off. Wall linework will appear in patches — nothing is drawn past what was seen."
      : strokeWidths > 2
        ? "Wide. Reaches further past explored ground, which can show a room across a thin wall."
        : "Multiples of this map's measured ink width, so it adapts to how heavily the map is drawn.";
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
      // `report` is the whole of it. A `say` after this one overwrote the message it had just
      // written, so the reporting added here was wiped in the same breath as it appeared.
      report(`${idleLabel} failed`, error);
    });
  });
}

async function start(): Promise<void> {
  stage = "getting your role";
  const isGm = (await OBR.player.getRole()) === "GM";

  stage = "reading the appearance settings";
  const appearance = await readAppearance();

  stage = "building the tabs";
  installTabs();

  stage = "reading the theme";
  await OBR.theme.getTheme().then(applyTheme).catch(() => {});
  OBR.theme.onChange(applyTheme);

  stage = "showing the settings";
  showAppearance(appearance);
  // Hiding controls is a convention, not a permission boundary — DESIGN.md notes the `Permission`
  // enum does not govern metadata, so a determined player could always write these. The writes are
  // read-modify-write for exactly that reason, which is also what makes several editors safe.
  applyAccess(isGm, appearance.playersMayStyle);

  // The appearance controls below are wired for *everyone*, including a player currently locked
  // out, and only their visibility varies. Installing them lazily on the first grant would mean a
  // player who is handed the tab mid-session sees live-looking sliders that do nothing until they
  // reopen the panel. Listeners on hidden controls cost nothing; that bug would not be free.
  if (isGm) {
    stage = "wiring the GM controls";
    installGmControls();

    // The scene's map list changes without this page knowing — a map added, deleted, or nominated
    // from the context menu that still ships. Both are plain subscribe messages rather than calls
    // awaiting an answer, so neither can fail for want of a scene; their *callbacks* can land
    // without one, which is what `refreshMapsIfReady` is guarding.
    OBR.scene.items.onChange(refreshMapsIfReady);
    onSketchSettingsChange(refreshMapsIfReady);

    // Last, and deliberately not awaited. Reading the scene is the one part of startup that can be
    // refused for a reason that is nobody's fault and mends itself, so it must not be able to take
    // the rest of the panel down with it — every control above this line is room-scoped and works
    // with no scene at all.
    stage = "waiting for a scene";
    watchScene();
  }

  // Another client — the GM's other window, or any player who has been handed the tab — may change
  // the look. Several editors at once is accepted rather than arbitrated (user, 2026-08-02): writes
  // merge field by field, so two people on *different* controls compose, and two on the same one
  // means last write wins.
  onAppearanceChange((next) => {
    showAppearance(next);
    applyAccess(isGm, next.playersMayStyle);
  });

  playersMayStyleInput.addEventListener("change", () => {
    // Written immediately rather than through `queueAppearance`: a checkbox produces one event, so
    // there is nothing to coalesce, and the debounce would only delay a grant by 200ms.
    void writeAppearance({ playersMayStyle: playersMayStyleInput.checked }).catch(
      (error) => {
        report("Could not save that setting", error);
      },
    );
  });

  colorInput.addEventListener("input", () => {
    queueAppearance({ strokeColor: colorInput.value });
  });

  widthInput.addEventListener("input", () => {
    const tenths = Number(widthInput.value);
    // Readout updates now, the write lands on the pause — see `queueAppearance`.
    showWidth(tenths);
    queueAppearance({ strokeWidthSquares: widthSquaresFor(tenths) });
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
    queueBrush({ featherFraction: fraction });
  });

  grainScaleInput.addEventListener("input", () => {
    const squares = grainSquaresFor(Number(grainScaleInput.value));
    grainScaleValue.textContent = squares.toFixed(3);
    queueBrush({ grainScaleSquares: squares });
  });

  grainDepthInput.addEventListener("input", () => {
    const depth = Number(grainDepthInput.value) / 100;
    grainDepthValue.textContent = `${Math.round(depth * 100)}%`;
    queueBrush({ grainDepth: depth });
  });

  edgeRoughnessInput.addEventListener("input", () => {
    const roughness = Number(edgeRoughnessInput.value) / 100;
    edgeRoughnessValue.textContent = `${Math.round(roughness * 100)}%`;
    queueBrush({ edgeRoughness: roughness });
  });

  taperInput.addEventListener("input", () => {
    const fraction = Number(taperInput.value) / 100;
    taperValue.textContent = `${Math.round(fraction * 100)}%`;
    queueBrush({ taperFraction: fraction });
  });

  entryBulgeInput.addEventListener("input", () => {
    const bulge = Number(entryBulgeInput.value) / 100;
    entryBulgeValue.textContent = `${Math.round(bulge * 100)}%`;
    queueBrush({ entryBulge: bulge });
  });

  tailWidthInput.addEventListener("input", () => {
    const tail = Number(tailWidthInput.value) / 100;
    tailWidthValue.textContent = `${Math.round(tail * 100)}%`;
    queueBrush({ tailWidth: tail });
  });

  pressureInput.addEventListener("input", () => {
    const pressure = Number(pressureInput.value) / 100;
    pressureValue.textContent = `${Math.round(pressure * 100)}%`;
    queueBrush({ pressure });
  });

  nibAngleInput.addEventListener("input", () => {
    const degrees = Number(nibAngleInput.value);
    nibAngleValue.textContent = `${degrees}°`;
    queueBrush({ nibAngleDegrees: degrees });
  });

  nibContrastInput.addEventListener("input", () => {
    const contrast = Number(nibContrastInput.value) / 100;
    nibContrastValue.textContent = `${Math.round(contrast * 100)}%`;
    queueBrush({ nibContrast: contrast });
  });

  parchmentOn.addEventListener("change", () => {
    parchmentControls.hidden = !parchmentOn.checked;
    queueParchment({ enabled: parchmentOn.checked });
  });

  parchmentColor.addEventListener("input", () => {
    queueParchment({ color: parchmentColor.value });
  });

  parchmentOpacity.addEventListener("input", () => {
    const opacity = Number(parchmentOpacity.value) / 1000;
    parchmentOpacityValue.textContent = `${(opacity * 100).toFixed(1)}%`;
    queueParchment({ opacity });
  });

  parchmentScale.addEventListener("input", () => {
    const squares = Number(parchmentScale.value) / 100;
    parchmentScaleValue.textContent = squares.toFixed(2);
    queueParchment({ scaleSquares: squares });
  });

  parchmentContrast.addEventListener("input", () => {
    const contrast = Number(parchmentContrast.value) / 100;
    parchmentContrastValue.textContent = `${Math.round(contrast * 100)}%`;
    queueParchment({ contrast });
  });

  brushInput.addEventListener("change", () => {
    const brush = brushInput.value as BrushId;
    // Adopt the chosen brush's own stored values rather than leaving the previous brush's on the
    // sliders — that is the whole point of storing them per brush.
    current = { ...current, brush };
    showRelevantControls(current.renderer, brush);
    showBrushSettings(current.brushes[brush]);
    queueAppearance({ brush });
  });

  rendererInput.addEventListener("change", () => {
    const renderer = rendererInput.value as Renderer;
    current = { ...current, renderer };
    showRendererNote(renderer);
    showRelevantControls(renderer, current.brush);
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

}

/**
 * Wire the controls only a GM ever gets: the map picker's siblings, and everything destructive.
 *
 * Split from `start()` so a player's client never installs them at all. The buttons sit inside tab
 * panels a player cannot reach, so leaving them wired would be *currently* harmless — but "hidden
 * yet live" is the shape of thing that becomes a real hole the moment someone changes what is
 * hidden, and the split costs one function boundary.
 */
function installGmControls(): void {
  wallMarginInput.addEventListener("input", () => {
    const hundredths = Number(wallMarginInput.value);
    // Readout now, write on the pause. Every client applies it as a redraw, so the sketch follows
    // a beat later without the map being traced again.
    showMarginReadout(hundredths);
    queueWallMargin(marginStrokeWidthsFor(hundredths));
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
        report("Could not mark the map explored", error);
      } finally {
        // Not a flat re-enable: the scene may have closed while this ran, and `showSceneControls`
        // has already had its say about that.
        revealAllButton.disabled = sceneReady !== true;
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
        report("Could not clear the sketch", error);
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
  void start()
    // Or every later failure — a slider write, a button — would be logged against whichever startup
    // step happened to be recorded last, which is worse than no step at all: it would read as a
    // precise answer and point at the wrong place.
    .then(() => {
      stage = "running";
    })
    .catch((error) => {
      // The one failure worth pointing somewhere, because it leaves nothing else to look at.
      report(
        "The panel could not start",
        error,
        "The browser console has the reason.",
      );
    });
});
