/**
 * Serialising the discovered region for scene metadata.
 *
 * Scene metadata is capped at roughly 16KB (DESIGN.md §5), so the region cannot go across as
 * raw cells. Run-length encoding suits it exactly: the region is a small number of large
 * contiguous blobs, so runs are long and few.
 *
 * The grid is written into the header rather than assumed. A stored region is only meaningful
 * against the grid it was recorded on — change the map size or the scene's dpi and the cells
 * address different ground — so the decoder can detect a mismatch instead of silently
 * misplacing explored area.
 *
 * Format: `v1|columns|rows|cellSize|originX|originY|<base64 varint runs>`, runs alternating
 * unset/set and starting with unset.
 */

import { createMask, type RegionMask } from "./regionMask";
import { cellCount, type CellGrid } from "./cellGrid";

const VERSION = "v1";
const FIELD_SEPARATOR = "|";

export function encodeRegion(mask: RegionMask): string {
  const runs = toRunLengths(mask.cells);
  const bytes = encodeVarints(runs);
  const { grid } = mask;

  return [
    VERSION,
    grid.columns,
    grid.rows,
    grid.cellSize,
    grid.origin.x,
    grid.origin.y,
    bytesToBase64(bytes),
  ].join(FIELD_SEPARATOR);
}

/**
 * @returns the decoded region, or `null` if the text is malformed or from a future version.
 * Callers should compare the returned grid against the current one (`sameGrid`) and discard on
 * mismatch — a well-formed region recorded against a different grid is still unusable.
 */
export function decodeRegion(text: unknown): RegionMask | null {
  if (typeof text !== "string") return null;

  const parts = text.split(FIELD_SEPARATOR);
  if (parts.length !== 7) return null;

  const [version, columnsText, rowsText, cellSizeText, originXText, originYText, payload] =
    parts as [string, string, string, string, string, string, string];
  if (version !== VERSION) return null;

  const columns = Number(columnsText);
  const rows = Number(rowsText);
  const cellSize = Number(cellSizeText);
  const originX = Number(originXText);
  const originY = Number(originYText);

  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns <= 0 ||
    rows <= 0 ||
    !Number.isFinite(cellSize) ||
    cellSize <= 0 ||
    !Number.isFinite(originX) ||
    !Number.isFinite(originY)
  ) {
    return null;
  }

  const grid: CellGrid = {
    origin: { x: originX, y: originY },
    cellSize,
    columns,
    rows,
  };

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload);
  } catch {
    return null;
  }

  const runs = decodeVarints(bytes);
  if (runs === null) return null;

  const total = runs.reduce((sum, run) => sum + run, 0);
  if (total !== cellCount(grid)) return null;

  const mask = createMask(grid);
  let index = 0;
  let filled = false;
  for (const run of runs) {
    if (filled) mask.cells.fill(1, index, index + run);
    index += run;
    filled = !filled;
  }

  return mask;
}

/** Alternating run lengths, starting with a run of unset cells (possibly zero-length). */
function toRunLengths(cells: Uint8Array): number[] {
  const runs: number[] = [];
  let current = 0;
  let run = 0;

  for (const cell of cells) {
    const value = cell === 1 ? 1 : 0;
    if (value === current) {
      run++;
    } else {
      runs.push(run);
      current = value;
      run = 1;
    }
  }
  runs.push(run);

  return runs;
}

function encodeVarints(values: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  for (const value of values) {
    let remaining = value;
    while (remaining >= 0x80) {
      bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(remaining);
  }
  return Uint8Array.from(bytes);
}

/** @returns decoded values, or `null` if the final varint is truncated. */
function decodeVarints(bytes: Uint8Array): number[] | null {
  const values: number[] = [];
  let value = 0;
  let multiplier = 1;
  let pending = false;

  for (const byte of bytes) {
    pending = true;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0;
      multiplier = 1;
      pending = false;
    } else {
      multiplier *= 128;
    }
  }

  return pending ? null : values;
}

/** Chunked so a large payload does not build one enormous argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
