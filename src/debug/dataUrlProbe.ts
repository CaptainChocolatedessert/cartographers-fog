/**
 * Will Owlbear render an `Image` whose `url` is a `data:` URI, and how large a one?
 *
 * DESIGN.md has carried this as an open question since the rendering modes were first written, and
 * it gates every raster route this project might take — the masked map copy of mode 2, and now the
 * idea of making the *sketch* itself a raster so it can carry a real pencil texture and variable
 * stroke width.
 *
 * The alternative is `buildImageUpload`, which pushes into the room's asset storage. That is far
 * too heavy for anything per-move, and it leaves the GM's asset library full of our debris, so a
 * failure here does not merely make the raster route slower — it makes it a different and much
 * worse design.
 *
 * ## A size ladder, because the first version asked the wrong question and then hid the answer
 *
 * A `data:` URL is a string in an item record, and strings crossing an iframe message bus have
 * limits. The first version tried 32x32 and 512x512 and concluded nothing, for two reasons worth
 * recording because both are recurring mistakes:
 *
 * - **The large swatch was 1.37MB, not the ~200KB estimated.** PNG cannot compress noise, so it is
 *   512*512*4 raw plus base64 overhead. That did not probe the interesting range, it jumped clear
 *   past it.
 * - **`addItems` did not reject it — it never returned at all.** No success, no error, nothing in
 *   the log. And because the reference outlines were batched into the *same* call, the hang took
 *   out the markers whose whole job was to distinguish "refused" from "never drawn". A diagnostic
 *   that shares fate with the thing it measures cannot report on it.
 *
 * So: the outlines go in their own call, first, and always. Then each size is added on its own, in
 * ascending order, **raced against a timeout** so a hang is a reported outcome rather than silence.
 * Three outcomes are distinguished at every rung — drawn, refused, hung — and the ladder stops at
 * the first that is not "drawn", since a wedged message bus makes everything after it meaningless.
 *
 * Noise rather than flat colour deliberately: a flat image compresses to almost nothing and would
 * smuggle a small payload past a limit while looking like a large one. This is the honest worst
 * case, and a real sketch raster — mostly transparent, with thin strokes — would compress far
 * better than these figures suggest.
 *
 * Reading it: the last rung that drew, and the first that did not, bracket the usable payload. If
 * even the smallest fails, `data:` URLs are not usable and the raster route needs asset uploads,
 * which is too heavy for anything that updates as tokens move.
 *
 * Development only. Items are local, so nothing is networked, and everything is removed on the next
 * run or by `clearDataUrlProbe`.
 */

import OBR, {
  Command,
  buildImage,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const PROBE_KEY = `${NAMESPACE}/dataurl-probe`;

/** Above `FOG`, so the swatches are visible wherever the view is and whatever the fog covers. */
const PROBE_LAYER = "CONTROL" as const;

/**
 * Pixel sizes to try, ascending. 32 is "does this work at all"; 512 is the one that hung the
 * message bus at 1.37MB, kept so the ladder still brackets it from below.
 */
const LADDER = [32, 64, 128, 256, 512];

/** A local item add should take milliseconds. Anything near this is wedged, not slow. */
const ADD_TIMEOUT_MS = 6000;

export async function runDataUrlProbe(): Promise<void> {
  if (!(await OBR.scene.isReady())) {
    devLog("warn", "data URL probe: no scene open");
    return;
  }

  await clearDataUrlProbe();

  const dpi = (await OBR.scene.grid.getDpi()) || 150;
  const origin = await viewCentre(dpi);

  const size = dpi * 1.4;
  const gap = dpi * 0.3;
  // Below the blend probe's bars, which centre on the same point. They collided in the first
  // version and the swatches sat on top of the bars, which made "I cannot see them" ambiguous.
  const rowOffset = dpi * 2.5;
  const left = origin.x - (LADDER.length * (size + gap) - gap) / 2;
  const top = origin.y + rowOffset;

  const placement = LADDER.map((pixels, index) => ({
    pixels,
    x: left + index * (size + gap),
    y: top,
  }));

  // **The outlines go first, in their own call, and always.** Batched with the images they shared
  // the images' fate: the 1.37MB payload hung `addItems` and took the reference markers with it,
  // so a blank screen could not be told from a probe that never ran.
  try {
    await OBR.scene.local.addItems(
      placement.map((p) => slot(p.x, p.y, size, `${p.pixels}px`)),
    );
    devLog(
      "info",
      `data URL probe: ${LADDER.length} outlined boxes drawn BELOW the blend probe's bars, ` +
        `smallest on the left (${LADDER.join(", ")}px). Each should fill with coloured static.`,
    );
  } catch (error) {
    devLog("error", "data URL probe: could not draw the reference outlines", error);
    return;
  }

  for (const { pixels, x, y } of placement) {
    const url = pixels <= 32 ? checkerDataUrl(pixels) : noiseDataUrl(pixels);
    const kb = (url.length / 1024).toFixed(1);

    let item: Item;
    try {
      item = buildImage(
        {
          width: pixels,
          height: pixels,
          mime: "image/png",
          url,
        },
        // dpi chosen so every swatch occupies `size` world units whatever its pixel count, so the
        // row is comparable by eye.
        { offset: { x: 0, y: 0 }, dpi: (pixels / size) * dpi },
      )
        .position({ x, y })
        .layer(PROBE_LAYER)
        .locked(true)
        .disableHit(true)
        .name(`data URL probe ${pixels}px`)
        .metadata({ [PROBE_KEY]: true })
        .build();
    } catch (error) {
      devLog(
        "error",
        `data URL probe: ${pixels}px (${kb}KB) REFUSED when building the item — ` +
          `this rung is the ceiling`,
        error,
      );
      return;
    }

    // Three outcomes, and they must be told apart. The first version could only distinguish two,
    // and the one it missed — a silent hang — is what actually happened.
    const outcome = await addWithTimeout(item);
    if (outcome === "drawn") {
      devLog("info", `data URL probe: ${pixels}px (${kb}KB) added OK`);
      continue;
    }

    devLog(
      "error",
      outcome === "hung"
        ? `data URL probe: ${pixels}px (${kb}KB) HUNG — addItems never returned after ` +
            `${ADD_TIMEOUT_MS}ms. The payload is past what the message bus will carry. Stopping: ` +
            `everything after a wedged bus is meaningless. Usable ceiling is below ${kb}KB.`
        : `data URL probe: ${pixels}px (${kb}KB) REJECTED by the scene — a clean refusal, so the ` +
            `ceiling is below ${kb}KB.`,
    );
    return;
  }

  devLog(
    "info",
    "data URL probe: every rung added. Now LOOK — a box that is outlined but empty means the " +
      "item was accepted and not rendered, which is a different answer from a refusal and the " +
      "one that would quietly sink the raster route.",
  );
}

/**
 * Add one item, distinguishing success, rejection and hang.
 *
 * The timeout is the whole point. `addItems` on an oversized `data:` URL neither resolves nor
 * rejects — it simply never comes back, and an `await` on it stops the probe dead with nothing in
 * the log. Racing it turns that silence into an observation.
 *
 * Note the losing promise is not cancellable, so a hung call stays pending for the life of the
 * page. That is a reason to stop the ladder rather than press on: the bus may well be wedged.
 */
async function addWithTimeout(item: Item): Promise<"drawn" | "rejected" | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ADD_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      OBR.scene.local.addItems([item]).then(() => "drawn" as const),
      timeout,
    ]);
    return result;
  } catch {
    return "rejected";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function clearDataUrlProbe(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => PROBE_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

/** An empty outline marking where a swatch should appear — see the call site for why. */
function slot(
  x: number,
  y: number,
  size: number,
  label: string,
): Item {
  const commands: PathCommand[] = [
    [Command.MOVE, x, y],
    [Command.LINE, x + size, y],
    [Command.LINE, x + size, y + size],
    [Command.LINE, x, y + size],
    [Command.CLOSE],
  ];

  return buildPath()
    .commands(commands)
    .position({ x: 0, y: 0 })
    .strokeColor("#00e5ff")
    .strokeOpacity(1)
    .strokeWidth(Math.max(2, size / 60))
    .fillOpacity(0)
    .layer(PROBE_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`data URL probe slot ${label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/** A magenta/transparent checker — unmistakable, and shows that alpha survives the round trip. */
function checkerDataUrl(pixels: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext("2d")!;

  const cell = Math.max(1, Math.floor(pixels / 8));
  for (let y = 0; y < pixels; y += cell) {
    for (let x = 0; x < pixels; x += cell) {
      if (((x / cell) + (y / cell)) % 2 === 0) continue;
      context.fillStyle = "#ff00ff";
      context.fillRect(x, y, cell, cell);
    }
  }

  return canvas.toDataURL("image/png");
}

/**
 * Random pixels, so PNG cannot compress the payload away.
 *
 * A flat or gently-shaded 512x512 encodes to a few KB and would sail past a length limit that a
 * real composited map tile would hit — the probe would then report success for a payload nothing
 * like the one the design needs. Noise is the honest worst case.
 */
function noiseDataUrl(pixels: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext("2d")!;

  const image = context.createImageData(pixels, pixels);
  let state = 0x9e3779b9;
  for (let i = 0; i < image.data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    image.data[i] = state & 0xff;
    image.data[i + 1] = (state >>> 8) & 0xff;
    image.data[i + 2] = (state >>> 16) & 0xff;
    // Partly transparent, because the sketch would need alpha and an opaque test would not
    // exercise it.
    image.data[i + 3] = 128 + ((state >>> 24) & 0x7f);
  }
  context.putImageData(image, 0, 0);

  return canvas.toDataURL("image/png");
}

/** Centre of the current view, so the swatches cannot land off-screen. */
async function viewCentre(dpi: number): Promise<{ x: number; y: number }> {
  try {
    const [width, height] = await Promise.all([
      OBR.viewport.getWidth(),
      OBR.viewport.getHeight(),
    ]);
    return await OBR.viewport.inverseTransformPoint({
      x: width / 2,
      y: height / 2,
    });
  } catch {
    devLog("warn", "data URL probe: viewport unavailable, drawing near the origin");
    return { x: dpi, y: dpi };
  }
}
