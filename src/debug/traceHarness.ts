/**
 * The manual half of build order step 4 — drives `src/trace/*` over a real map image and
 * draws the result so a human can judge it.
 *
 * Loaded only by `trace.html`, which is not a build input, so none of this reaches a
 * published bundle. It imports nothing from the SDK: everything here works on an image and
 * a canvas, and placing the output in a scene is step 5.
 *
 * Three things it exists to answer that a test cannot:
 *
 * 1. Do the traced lines land on the map's walls and features, or on its paper texture?
 * 2. Does centerline tracing return the stroke somebody drew, rather than a loop round it?
 * 3. Is the segment count within reach of the item budget at a useful segment length?
 *
 * Lengths are expressed in **grid squares**, converted to pixels here — the convention from
 * the author's `VTT_Maps`, and the reason its tuning survives a change of map resolution.
 * The pipeline itself stays in pixel space and knows nothing about grids.
 *
 * ## Tracing and painting are separate
 *
 * A trace costs a couple of hundred milliseconds, so panning could not re-run it. Everything
 * derived from the image is computed once in `recompute` and cached; `paint` only draws that
 * cache under the current view transform. Which controls belong to which is `VIEW_CONTROLS`.
 *
 * The URL field also exercises the real cross-origin path against Owlbear's CDN — paste an
 * asset URL from a room and a `SecurityError` here would mean the CORS result recorded in
 * DESIGN.md has changed.
 */

import type { BinaryMask } from "../trace/binarize";
import type { TracedSegment } from "../trace/chop";
import type { PixelImage } from "../trace/field";
import {
  buildField,
  buildMask,
  buildSkeleton,
  traceImage,
  type TraceOptions,
} from "../trace/pipeline";
import { chunkSegments } from "../trace/strokeChunks";

const canvas = element<HTMLCanvasElement>("canvas");
const context = canvas.getContext("2d")!;
const viewport = element<HTMLElement>("viewport");
const statusLine = element<HTMLParagraphElement>("status");
const warningLine = element<HTMLParagraphElement>("warning");
const statsBlock = element<HTMLDivElement>("stats");
const zoomReadout = element<HTMLSpanElement>("zoomValue");

/** Controls that only change what is drawn, never what is traced. */
const VIEW_CONTROLS = new Set([
  "background",
  "showLines",
  "showSegments",
  "showMidpoints",
]);

const MIN_SCALE = 0.05;
const MAX_SCALE = 64;

/** The map, at whatever resolution it was loaded. Traced from a downscaled copy. */
let source: HTMLImageElement | HTMLCanvasElement | null = null;

interface Traced {
  readonly traceCanvas: HTMLCanvasElement;
  readonly pixels: PixelImage;
  readonly options: TraceOptions;
  readonly result: ReturnType<typeof traceImage>;
  /** Lazily built previews of the intermediate stages, keyed by background choice. */
  readonly layers: Map<string, HTMLCanvasElement>;
}

let traced: Traced | null = null;

/**
 * Screen position of the traced image: `screen = (trace - offset) * scale`, in CSS pixels.
 * Held in trace-image coordinates so the geometry can be drawn untransformed.
 */
const view = { scale: 1, offsetX: 0, offsetY: 0 };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function number(id: string): number {
  return Number(element<HTMLInputElement>(id).value);
}

function choice(id: string): string {
  return element<HTMLSelectElement>(id).value;
}

function checked(id: string): boolean {
  return element<HTMLInputElement>(id).checked;
}

/** Pixels per grid square *in the traced image*, after downscaling. */
function pixelsPerGrid(traceWidth: number): number {
  if (!source) return number("pixelsPerGrid");
  const scale = Math.min(traceWidth, source.width) / source.width;
  return Math.max(1, number("pixelsPerGrid") * scale);
}

function readOptions(perGrid: number): TraceOptions {
  return {
    mode: choice("mode") as TraceOptions["mode"],
    blurSigma: number("blur"),
    simplifyTolerance: number("simplify"),
    minContourLength: number("minLength") * perGrid,
    segmentLength: number("segment") * perGrid,
    contour: {
      field: choice("field") as TraceOptions["contour"]["field"],
      level: number("level"),
    },
    centerline: {
      threshold: choice(
        "threshold",
      ) as TraceOptions["centerline"]["threshold"],
      level: number("globalLevel"),
      sauvolaRadius: number("sauvolaRadius"),
      sauvolaK: number("sauvolaK"),
      stubLength: number("stub") * perGrid,
      weldRadius: number("weld"),
      joinThroughJunctions: checked("joinThrough"),
      maxTurnDegrees: 40,
    },
  };
}

function inkColour(): string {
  return getComputedStyle(document.body).color;
}

/** Downscale to the trace width — DESIGN.md's "trace a 1024px copy" note, done locally. */
function toTraceCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
  traceWidth: number,
): HTMLCanvasElement {
  const width = Math.min(traceWidth, image.width);
  const height = Math.max(1, Math.round((image.height * width) / image.width));

  const scaled = document.createElement("canvas");
  scaled.width = width;
  scaled.height = height;
  const scaledContext = scaled.getContext("2d")!;
  scaledContext.drawImage(image, 0, 0, width, height);
  return scaled;
}

function recompute(): void {
  if (!source) return;

  element<HTMLFieldSetElement>("contourGroup").hidden =
    choice("mode") !== "contour";
  element<HTMLFieldSetElement>("centerlineGroup").hidden =
    choice("mode") !== "centerline";

  const previousWidth = traced?.traceCanvas.width ?? 0;
  const traceCanvas = toTraceCanvas(source, number("traceWidth"));
  const traceContext = traceCanvas.getContext("2d")!;

  let pixels: PixelImage;
  try {
    pixels = traceContext.getImageData(
      0,
      0,
      traceCanvas.width,
      traceCanvas.height,
    );
  } catch (error) {
    // The one failure mode that is about the platform rather than the tuning.
    warningLine.textContent = `Canvas is tainted — pixels unreadable (${
      (error as Error).name
    }). The asset did not send Access-Control-Allow-Origin.`;
    return;
  }

  const perGrid = pixelsPerGrid(traceCanvas.width);
  const options = readOptions(perGrid);
  const result = traceImage(pixels, options);

  traced = { traceCanvas, pixels, options, result, layers: new Map() };

  // Changing the trace width changes the coordinate system the view is expressed in. Rescale
  // rather than re-fit, so tuning the resolution does not throw away where you were looking.
  if (previousWidth > 0 && previousWidth !== traceCanvas.width) {
    const ratio = traceCanvas.width / previousWidth;
    view.scale /= ratio;
    view.offsetX *= ratio;
    view.offsetY *= ratio;
  }

  reportStats(perGrid);
  paint();
}

function reportStats(perGrid: number): void {
  if (!traced) return;
  const { result, options } = traced;
  const { stats } = result;

  const items = chunkSegments(result.segments).length;
  const commands = result.segments.reduce(
    (sum, segment) => sum + segment.points.length,
    0,
  );

  const lines = [
    `traced      ${stats.imageWidth}×${stats.imageHeight}`,
    `grid        ${perGrid.toFixed(1)} px/square`,
    // A level above the field's max finds nothing, which looks identical to a broken trace.
    `field       max ${stats.fieldMax.toFixed(2)}, mean ${stats.fieldMean.toFixed(2)}`,
  ];
  if (options.mode === "centerline") {
    lines.push(`ink         ${(stats.inkFraction * 100).toFixed(1)}%`);
  }
  lines.push(
    `contours    ${stats.rawContours} raw -> ${stats.keptContours} kept`,
    `points      ${stats.rawPoints} -> ${stats.keptPoints}`,
    `segments    ${stats.segments}`,
    `commands    ${commands} in ${items} item${items === 1 ? "" : "s"}`,
    ``,
    `field ms    ${stats.fieldMs.toFixed(1)}`,
    `mask ms     ${stats.maskMs.toFixed(1)}`,
    `trace ms    ${stats.contourMs.toFixed(1)}`,
    `simplify ms ${stats.simplifyMs.toFixed(1)}`,
    `chop ms     ${stats.chopMs.toFixed(1)}`,
    `total ms    ${stats.totalMs.toFixed(1)}`,
  );

  statsBlock.textContent = lines.join("\n");
  warningLine.textContent = diagnose(options, stats, perGrid);
}

/**
 * The two failures that look like nothing rather than like an error.
 *
 * Both were hit while building this: a Sobel field whose maximum sits below the level
 * returns no contours at all, and a threshold that reads the paper as ink returns a thicket
 * of short chains. Neither announces itself in the picture.
 */
function diagnose(
  options: TraceOptions,
  stats: ReturnType<typeof traceImage>["stats"],
  perGrid: number,
): string {
  if (options.mode === "contour" && stats.fieldMax < options.contour.level) {
    return `Level ${options.contour.level.toFixed(2)} is above the field's maximum of ${stats.fieldMax.toFixed(2)} — nothing can cross it.`;
  }
  if (options.mode === "centerline") {
    if (stats.inkFraction > 0.3) {
      return `${(stats.inkFraction * 100).toFixed(0)}% of the map reads as ink — the threshold is letting the background through.`;
    }
    if (stats.inkFraction > 0 && stats.keptContours === 0) {
      return "Ink was found but no strokes survived — try a smaller minimum stroke length.";
    }
    if (perGrid < 24) {
      return `Only ${perGrid.toFixed(0)}px per grid square: linework this fine thins badly, and two-pixel diagonals erode away. Raise the trace width.`;
    }
  }
  return "";
}

// -------------------------------------------------------------------------------------
// Painting
// -------------------------------------------------------------------------------------

function paint(): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(viewport.clientWidth));
  const height = Math.max(1, Math.round(viewport.clientHeight));

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  zoomReadout.textContent = `${(view.scale * 100).toFixed(0)}%`;

  if (!traced || !source) return;

  const k = view.scale * ratio;
  context.setTransform(k, 0, 0, k, -view.offsetX * k, -view.offsetY * k);

  drawBackground();
  // Widths are divided by the scale so a stroke keeps its weight on screen rather than
  // fattening as you zoom — what is being judged is where the line is, not how thick.
  if (checked("showLines")) drawSegments(traced.result.segments, view.scale);
  if (checked("showMidpoints")) drawMidpoints(traced.result.segments, view.scale);
}

function drawBackground(): void {
  if (!traced || !source) return;

  const kind = choice("background");
  if (kind === "none") return;

  const { traceCanvas } = traced;

  if (kind === "map") {
    // The full-resolution source rather than the traced copy, so zooming in compares the
    // strokes against the real map instead of against the downscale they came from.
    context.imageSmoothingEnabled = true;
    context.drawImage(source, 0, 0, traceCanvas.width, traceCanvas.height);
    return;
  }

  // Stage previews are one pixel per traced pixel; keep them crisp so a skeleton reads as
  // the pixels it is.
  context.imageSmoothingEnabled = view.scale < 1;
  context.drawImage(layerFor(kind), 0, 0);
}

/** Build a preview of an intermediate stage once, then reuse it across paints. */
function layerFor(kind: string): HTMLCanvasElement {
  const cached = traced!.layers.get(kind);
  if (cached) return cached;

  const { pixels, options } = traced!;
  const field = buildField(pixels, options);

  let image: ImageData;
  if (kind === "field") {
    image = new ImageData(field.width, field.height);
    for (let i = 0; i < field.data.length; i++) {
      const level = Math.round(255 * clamp01(field.data[i]!));
      const p = i * 4;
      image.data[p] = level;
      image.data[p + 1] = level;
      image.data[p + 2] = level;
      image.data[p + 3] = 255;
    }
  } else {
    const mask = buildMask(field, options.centerline);
    image = maskImage(
      kind === "skeleton" ? buildSkeleton(mask, options.centerline) : mask,
    );
  }

  const layer = document.createElement("canvas");
  layer.width = image.width;
  layer.height = image.height;
  layer.getContext("2d")!.putImageData(image, 0, 0);
  traced!.layers.set(kind, layer);
  return layer;
}

function maskImage(mask: BinaryMask): ImageData {
  const image = new ImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const ink = mask.data[i] === 1;
    const p = i * 4;
    image.data[p] = ink ? 20 : 250;
    image.data[p + 1] = ink ? 20 : 250;
    image.data[p + 2] = ink ? 20 : 250;
    image.data[p + 3] = 255;
  }
  return image;
}

function drawSegments(
  segments: readonly TracedSegment[],
  scale: number,
): void {
  const colourEach = checked("showSegments");
  context.lineWidth = 1.25 / scale;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = inkColour();

  segments.forEach((segment, index) => {
    if (colourEach) {
      // Alternating hues make the pre-cut boundaries visible — the thing that decides how
      // crisply the runtime mask can follow the visibility edge.
      context.strokeStyle = `hsl(${(index * 47) % 360} 70% 50%)`;
    }

    context.beginPath();
    const [first, ...rest] = segment.points;
    context.moveTo(first!.x, first!.y);
    for (const point of rest) context.lineTo(point.x, point.y);
    context.stroke();
  });
}

function drawMidpoints(
  segments: readonly TracedSegment[],
  scale: number,
): void {
  const size = 2 / scale;
  context.fillStyle = "#c04a2a";
  for (const segment of segments) {
    context.fillRect(
      segment.midpoint.x - size / 2,
      segment.midpoint.y - size / 2,
      size,
      size,
    );
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// -------------------------------------------------------------------------------------
// View
// -------------------------------------------------------------------------------------

function fitView(): void {
  if (!traced) return;
  const { traceCanvas } = traced;
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);

  view.scale = Math.min(
    width / traceCanvas.width,
    height / traceCanvas.height,
  );
  view.offsetX = (traceCanvas.width - width / view.scale) / 2;
  view.offsetY = (traceCanvas.height - height / view.scale) / 2;
  paint();
}

function zoomAt(screenX: number, screenY: number, factor: number): void {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  if (next === view.scale) return;

  // Keep whatever is under the pointer under the pointer.
  const traceX = view.offsetX + screenX / view.scale;
  const traceY = view.offsetY + screenY / view.scale;
  view.scale = next;
  view.offsetX = traceX - screenX / next;
  view.offsetY = traceY - screenY / next;
  paint();
}

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      Math.exp(-event.deltaY * 0.0015),
    );
  },
  { passive: false },
);

let dragging: { x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (event) => {
  dragging = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  view.offsetX -= (event.clientX - dragging.x) / view.scale;
  view.offsetY -= (event.clientY - dragging.y) / view.scale;
  dragging = { x: event.clientX, y: event.clientY };
  paint();
});

for (const type of ["pointerup", "pointercancel"] as const) {
  canvas.addEventListener(type, (event) => {
    dragging = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = "grab";
  });
}

canvas.addEventListener("dblclick", fitView);
element<HTMLButtonElement>("fit").addEventListener("click", fitView);

new ResizeObserver(() => paint()).observe(viewport);

// -------------------------------------------------------------------------------------
// Sources
// -------------------------------------------------------------------------------------

/**
 * A synthetic map, so the page does something before anyone finds a file.
 *
 * Line art over a mottled parchment ground, because that is the case the centerline path is
 * built for — a clean map would make the threshold controls look unnecessary. Not a
 * substitute for tracing a real map.
 */
function sampleMap(): HTMLCanvasElement {
  const map = document.createElement("canvas");
  map.width = 1200;
  map.height = 900;
  const paint = map.getContext("2d")!;

  paint.fillStyle = "#e8dcc0";
  paint.fillRect(0, 0, map.width, map.height);

  const random = seededRandom(7);

  // Parchment: broad blotches plus a fine speckle, both inside the ink's luminance range.
  for (let i = 0; i < 120; i++) {
    const radius = 40 + random() * 160;
    paint.fillStyle = `rgba(150, 125, 85, ${0.03 + random() * 0.05})`;
    paint.beginPath();
    paint.arc(random() * map.width, random() * map.height, radius, 0, Math.PI * 2);
    paint.fill();
  }
  paint.fillStyle = "rgba(120, 100, 70, 0.18)";
  for (let i = 0; i < 9000; i++) {
    paint.fillRect(random() * map.width, random() * map.height, 2, 2);
  }

  const rooms = [
    { x: 100, y: 100, w: 320, h: 240 },
    { x: 560, y: 80, w: 280, h: 200 },
    { x: 880, y: 320, w: 240, h: 300 },
    { x: 180, y: 480, w: 380, h: 300 },
    { x: 640, y: 560, w: 200, h: 220 },
  ];

  // Hatched shading inside the rooms, the kind of texture that defeats a global threshold.
  paint.strokeStyle = "rgba(90, 75, 55, 0.28)";
  paint.lineWidth = 2;
  for (const room of rooms) {
    for (let x = room.x - room.h; x < room.x + room.w; x += 14) {
      paint.beginPath();
      paint.moveTo(x, room.y + room.h);
      paint.lineTo(x + room.h, room.y);
      paint.stroke();
    }
  }

  // The linework itself: walls drawn as strokes, not as filled bands.
  paint.strokeStyle = "#2b241c";
  paint.lineWidth = 7;
  paint.lineJoin = "round";
  for (const room of rooms) paint.strokeRect(room.x, room.y, room.w, room.h);

  paint.lineWidth = 6;
  const corridors: Array<[number, number, number, number]> = [
    [420, 210, 560, 210],
    [700, 280, 700, 620],
    [560, 630, 640, 630],
    [360, 340, 360, 480],
    [840, 470, 880, 470],
  ];
  for (const [x0, y0, x1, y1] of corridors) {
    paint.beginPath();
    paint.moveTo(x0, y0);
    paint.lineTo(x1, y1);
    paint.stroke();
  }

  return map;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function useSource(
  image: HTMLImageElement | HTMLCanvasElement,
  description: string,
): void {
  source = image;
  traced = null;
  statusLine.textContent = `${description} — ${image.width}×${image.height}`;
  warningLine.textContent = "";
  recompute();
  // A new map is the one time the view should reset; tuning keeps where you were looking.
  fitView();
}

function loadUrl(url: string): void {
  if (!url) return;
  const image = new Image();
  // Without this the canvas is tainted and getImageData throws, whatever the server sends.
  image.crossOrigin = "anonymous";
  image.onload = () => useSource(image, "loaded from URL");
  image.onerror = () => {
    warningLine.textContent =
      "Image failed to load. A cross-origin image needs CORS headers even to load with crossOrigin set.";
  };
  image.src = url;
}

let pending = 0;
function scheduleRecompute(): void {
  // Sliders fire continuously and a full trace is tens to hundreds of milliseconds.
  window.clearTimeout(pending);
  pending = window.setTimeout(recompute, 80);
}

for (const input of document.querySelectorAll("input, select")) {
  const readout = document.getElementById(`${input.id}Value`);
  input.addEventListener("input", () => {
    if (readout) readout.textContent = (input as HTMLInputElement).value;
    if (input.id === "url") return;
    if (VIEW_CONTROLS.has(input.id)) paint();
    else scheduleRecompute();
  });
}

element<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  image.onload = () => {
    useSource(image, file.name);
    URL.revokeObjectURL(objectUrl);
  };
  image.src = objectUrl;
});

element<HTMLButtonElement>("load").addEventListener("click", () => {
  loadUrl(element<HTMLInputElement>("url").value.trim());
});

element<HTMLInputElement>("url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadUrl(element<HTMLInputElement>("url").value.trim());
});

element<HTMLButtonElement>("sample").addEventListener("click", () => {
  useSource(sampleMap(), "synthetic sample map");
});

canvas.style.cursor = "grab";
useSource(sampleMap(), "synthetic sample map");
