/**
 * Measures what this extension can actually store, and where.
 *
 * DESIGN.md records the scene-metadata cap as "reportedly 16KB", and several decisions rest on
 * that number — the discovered-region encoding, whether a bitmask is viable at useful
 * resolution, and whether the region should live in items instead. It has never been checked.
 *
 * Three questions, answered by measurement rather than folklore:
 *
 *   1. What is the real scene-metadata cap?
 *   2. Is it per key, or shared across all keys? If per key, splitting the region across
 *      several keys is the simplest fix available and no items are needed at all.
 *   3. How much geometry fits in a single scene item? That is the ceiling on storing the
 *      region as `Path` commands, which would be resolution-independent and dodge the cap.
 *
 * Development only, GM only, and runs once per page load. Everything it writes is removed in a
 * `finally`, including on failure — it must not leave debris in a real scene.
 */

import OBR, {
  Command,
  buildPath,
  isPath,
  type Path,
  type PathCommand,
} from "@owlbear-rodeo/sdk";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const PROBE_KEY = `${NAMESPACE}/storage-probe`;
const PROBE_ITEM_KEY = `${NAMESPACE}/storage-probe-item`;

/**
 * Deliberately *not* prefixed with PROBE_KEY, so cleanup leaves it alone. It has to outlive
 * the page to test what it tests.
 */
const PERSIST_KEY = `${NAMESPACE}/persist-check`;
const PERSIST_SIZE_KB = 256;
const PERSIST_TAIL = "<<END>>";

/**
 * While the cross-client test is running, the GM keeps the payload in place instead of
 * clearing it after verifying — a player client cannot read it if the writer deletes it first.
 * Set to false once the question is settled, and the next GM load will clear it.
 */
const RETAIN_PERSIST_PAYLOAD = false;

/** Payload sizes to try, in KB. Stops at the first that fails to round-trip. */
const METADATA_SIZES_KB = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Command counts to try for the item test. Bisected further once the boundary is bracketed. */
const ITEM_COMMAND_COUNTS = [1_000, 5_000, 20_000, 80_000];

let hasRun = false;

export async function probeStorageLimits(): Promise<void> {
  if (!import.meta.env.DEV || hasRun) return;
  hasRun = true;

  let isGm = false;

  try {
    // Wait rather than give up. Checking readiness once loses the race whenever the scene is
    // still loading — the same check-then-give-up bug that silently skipped the CORS probe.
    if (!(await waitForScene(15_000))) {
      devLog("info", "storage probe skipped — scene never became ready");
      return;
    }

    isGm = (await OBR.player.getRole()) === "GM";

    if (!isGm) {
      // Players read, never write. This is the cross-client test: a payload written by the GM
      // in a different browser can only arrive here via the server, so an intact read proves
      // both a real round trip and — more importantly — that scene metadata reaches players
      // at all, which DESIGN.md §5's whole architecture assumes.
      await readPersistenceAsPlayer();
      return;
    }

    devLog("info", "storage probe: starting (GM)");
    // First, because it reports on what the *previous* page load wrote.
    await checkPersistence();
    const singleKey = await probeSingleKey();
    await probeMultipleKeys(singleKey);
    await probeItemGeometry();
    devLog("info", "storage probe: done");
  } catch (error) {
    devLog("error", "storage probe threw", error);
  } finally {
    // Only the GM writes, so only the GM has anything to clean up.
    if (isGm) await cleanUp();
  }
}

/**
 * Resolve once the scene is ready, or on timeout.
 *
 * Subscribes *before* checking, so a scene that becomes ready in the gap between the two
 * cannot slip through unobserved.
 */
function waitForScene(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(ready);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = OBR.scene.onReadyChange((ready) => {
      if (ready) finish(true);
    });

    void OBR.scene.isReady().then((ready) => {
      if (ready) finish(true);
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read-only half of the cross-client test. Never writes. */
async function readPersistenceAsPlayer(): Promise<void> {
  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  const stored = metadata[PERSIST_KEY];

  if (typeof stored !== "string") {
    devLog(
      "info",
      "storage probe (player): no payload found. Either the GM has not written one yet, or " +
        "scene metadata does not reach player clients at all — the latter would break the " +
        "shared-state architecture, so check the GM log for a 'wrote 256KB' line before " +
        "concluding anything.",
    );
    return;
  }

  const intact = stored === makePersistPayload();
  const hasTail = stored.endsWith(PERSIST_TAIL);

  devLog(
    "info",
    `storage probe (player): read ${Math.round(stored.length / 1024)}KB of ${PERSIST_SIZE_KB}KB, ` +
      `tail ${hasTail ? "present" : "MISSING"} -> ` +
      (intact
        ? "CROSS-CLIENT ROUND TRIP CONFIRMED — metadata reaches players byte-identical"
        : "ALTERED IN TRANSIT — metadata is not delivered verbatim to players"),
  );
}

/**
 * The only test here that proves anything about *persistence*.
 *
 * Writing and reading back within one page load may only exercise a local cache — Owlbear can
 * update local state optimistically and sync afterwards, in which case a server-side rejection
 * or truncation would look exactly like success. So this writes a payload on one load and
 * verifies it on the next, after it has made a genuine round trip.
 *
 * A trailing marker makes truncation unmistakable: a short read is one thing, but a full-length
 * payload missing its tail would mean something quietly rewrote the middle.
 */
async function checkPersistence(): Promise<void> {
  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  const stored = metadata[PERSIST_KEY];
  const expected = makePersistPayload();

  if (typeof stored !== "string") {
    await OBR.scene.setMetadata({ [PERSIST_KEY]: expected });
    devLog(
      "info",
      `storage probe: persistence — wrote ${PERSIST_SIZE_KB}KB. ` +
        `RELOAD THE ROOM to find out whether it survived the server.`,
    );
    return;
  }

  const intact = stored === expected;
  const hasTail = stored.endsWith(PERSIST_TAIL);
  devLog(
    "info",
    `storage probe: persistence — read back ${Math.round(stored.length / 1024)}KB ` +
      `of ${PERSIST_SIZE_KB}KB, tail ${hasTail ? "present" : "MISSING"} -> ` +
      `${intact ? "SURVIVED the round trip" : "ALTERED — metadata is not stored verbatim"}`,
  );

  if (RETAIN_PERSIST_PAYLOAD) {
    devLog(
      "info",
      "storage probe: leaving the payload in place so a player client can read it. " +
        "Clear RETAIN_PERSIST_PAYLOAD when the cross-client test is done.",
    );
    return;
  }

  await OBR.scene.setMetadata({ [PERSIST_KEY]: undefined });
}

function makePersistPayload(): string {
  const size = PERSIST_SIZE_KB * 1024;
  return "z".repeat(size - PERSIST_TAIL.length) + PERSIST_TAIL;
}

interface SingleKeyResult {
  largestKb: number;
  /** True only if a size actually failed. False means the probe ran out of sizes to try. */
  foundLimit: boolean;
}

async function probeSingleKey(): Promise<SingleKeyResult> {
  let largest = 0;
  let foundLimit = false;

  for (const sizeKb of METADATA_SIZES_KB) {
    const payload = "x".repeat(sizeKb * 1024);
    const outcome = await tryWriteMetadata({ [PROBE_KEY]: payload }, (metadata) =>
      metadata[PROBE_KEY] === payload,
    );

    devLog("info", `storage probe: single key ${sizeKb}KB -> ${outcome}`);
    if (outcome !== "ok") {
      foundLimit = true;
      break;
    }
    largest = sizeKb;
  }

  devLog(
    "info",
    foundLimit
      ? `storage probe: single-key limit is between ${largest}KB and the next size up`
      : `storage probe: single key OK to ${largest}KB — no limit found, probe range exhausted`,
  );
  return { largestKb: largest, foundLimit };
}

/**
 * Write several keys each holding a payload known to be fine on its own. If the cap is per key
 * they all survive; if it is shared, the later writes fail or truncate.
 */
async function probeMultipleKeys(single: SingleKeyResult): Promise<void> {
  if (single.largestKb === 0) {
    devLog("info", "storage probe: skipping multi-key test, nothing fit");
    return;
  }

  const KEYS = 4;
  const payload = "y".repeat(single.largestKb * 1024);
  const update: Record<string, string> = {};
  for (let i = 0; i < KEYS; i++) update[`${PROBE_KEY}/${i}`] = payload;

  const outcome = await tryWriteMetadata(update, (metadata) =>
    Object.keys(update).every((key) => metadata[key] === payload),
  );

  const total = KEYS * single.largestKb;

  /**
   * "Per key" only follows if the single-key probe actually hit a ceiling. If it merely ran
   * out of sizes to try, N keys succeeding shows nothing more than that the total fits — a
   * shared cap larger than the total is equally consistent with it.
   */
  const verdict = !single.foundLimit
    ? `INCONCLUSIVE on per-key vs shared — no single-key limit was found, so this only shows total >= ${total}KB`
    : outcome === "ok"
      ? "cap is PER KEY — the total exceeds the known single-key limit"
      : "cap is SHARED across keys";

  devLog(
    "info",
    `storage probe: ${KEYS} keys x ${single.largestKb}KB (${total}KB total) -> ${outcome} — ${verdict}`,
  );

  const clear: Record<string, undefined> = {};
  for (const key of Object.keys(update)) clear[key] = undefined;
  await OBR.scene.setMetadata(clear).catch(() => {});
}

/**
 * How much geometry fits in one scene item — the ceiling on storing the discovered region as
 * `Path` commands. Scans by powers, then bisects to pin the boundary, since "somewhere between
 * 5k and 20k" is too vague to design against.
 */
async function probeItemGeometry(): Promise<void> {
  let largestOk = 0;
  let smallestFail = 0;

  for (const count of ITEM_COMMAND_COUNTS) {
    if (await tryItemWithRetry(count)) {
      largestOk = count;
    } else {
      smallestFail = count;
      break;
    }
  }

  if (smallestFail > 0) {
    // Converge exactly. The error says "array length limit", so the boundary is likely a round
    // number — worth knowing precisely, because it caps the renderer as well as storage.
    for (let i = 0; i < 16 && smallestFail - largestOk > 1; i++) {
      const midpoint = Math.floor((largestOk + smallestFail) / 2);
      if (await tryItemWithRetry(midpoint)) largestOk = midpoint;
      else smallestFail = midpoint;
    }
  }

  devLog(
    "info",
    `storage probe: largest item = ${largestOk} commands ` +
      `(~${Math.round(estimateBytes(largestOk) / 1024)}KB)` +
      (smallestFail > 0 ? `, rejected at ${smallestFail}` : ", never rejected"),
  );
}

type ItemOutcome = "ok" | "too-big" | "rate-limited";

/**
 * Try an item, retrying through rate limits with backoff.
 *
 * Owlbear throttles rapid writes with `RateLimitHit`, which is emphatically *not* a size
 * rejection. Conflating the two drives a bisection to a false floor — an earlier version of
 * this probe did exactly that, and the resulting "the ceiling moves between runs" conclusion
 * was an artefact of it rather than a property of the API.
 */
async function tryItemWithRetry(count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const outcome = await tryItem(count);
    if (outcome === "ok") return true;
    if (outcome === "too-big") return false;

    const backoff = 250 * 2 ** attempt;
    devLog("info", `storage probe: rate limited at ${count}, backing off ${backoff}ms`);
    await sleep(backoff);
  }

  devLog(
    "info",
    `storage probe: ${count} commands still rate limited after 5 attempts — treating as ` +
      `INCONCLUSIVE, not as a size limit`,
  );
  return false;
}

/** @returns whether an item with this many commands both stored and read back intact. */
async function tryItem(count: number): Promise<ItemOutcome> {
  let created: string | undefined;

  try {
    const item = buildPath()
      .commands(makeCommands(count))
      .position({ x: 0, y: 0 })
      .fillOpacity(0)
      .strokeOpacity(0)
      .layer("DRAWING")
      .visible(false)
      .locked(true)
      .disableHit(true)
      .name("Cartographer's Fog storage probe")
      .metadata({ [PROBE_ITEM_KEY]: true })
      .build();
    created = item.id;

    await OBR.scene.items.addItems([item]);

    const [stored] = await OBR.scene.items.getItems<Path>(
      (candidate) => isPath(candidate) && candidate.id === created,
    );
    const survived = stored?.commands.length ?? 0;
    const ok = survived === count;

    devLog(
      "info",
      `storage probe: item ${count} commands (~${Math.round(estimateBytes(count) / 1024)}KB) -> ` +
        (ok ? "ok" : `MISMATCH, read back ${survived}`),
    );
    return ok ? "ok" : "too-big";
  } catch (error) {
    // Pass the error itself, not String(error) — the latter renders as [object Object] and
    // throws away the message that says *why* it was refused, which is the whole point here.
    devLog("info", `storage probe: item ${count} commands -> rejected`, error);
    return isRateLimit(error) ? "rate-limited" : "too-big";
  } finally {
    if (created) await OBR.scene.items.deleteItems([created]).catch(() => {});
    // Space out writes so the bisection does not trip the limiter in the first place.
    await sleep(150);
  }
}

/** Distinguishes throttling from a genuine size rejection. */
function isRateLimit(error: unknown): boolean {
  const name = (error as { error?: { name?: string }; name?: string })?.error?.name
    ?? (error as { name?: string })?.name;
  return name === "RateLimitHit";
}

function makeCommands(count: number): PathCommand[] {
  const commands: PathCommand[] = [[Command.MOVE, 0, 0]];
  for (let i = 1; i < count; i++) {
    // Coordinates with a few digits, so the size estimate is not wildly optimistic.
    commands.push([Command.LINE, (i % 977) + 0.25, (i % 691) + 0.75]);
  }
  return commands;
}

/** Rough serialised size — three numbers of ~8 characters plus JSON punctuation. */
function estimateBytes(commandCount: number): number {
  return commandCount * 30;
}

type Outcome = "ok" | "truncated" | "rejected";

/**
 * Write, read back, and verify. Read-back matters because a silent truncation would otherwise
 * look identical to success.
 */
async function tryWriteMetadata(
  update: Record<string, unknown>,
  verify: (metadata: Record<string, unknown>) => boolean,
): Promise<Outcome> {
  try {
    await OBR.scene.setMetadata(update);
  } catch {
    return "rejected";
  }

  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  return verify(metadata) ? "ok" : "truncated";
}

async function cleanUp(): Promise<void> {
  try {
    const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
    const clear: Record<string, undefined> = {};
    for (const key of Object.keys(metadata)) {
      if (key.startsWith(PROBE_KEY)) clear[key] = undefined;
    }
    if (Object.keys(clear).length > 0) await OBR.scene.setMetadata(clear);

    const strays = await OBR.scene.items.getItems(
      (item) => PROBE_ITEM_KEY in item.metadata,
    );
    if (strays.length > 0) {
      await OBR.scene.items.deleteItems(strays.map((item) => item.id));
    }

    devLog("info", "storage probe: cleaned up");
  } catch (error) {
    devLog("error", "storage probe: CLEANUP FAILED — scene may hold probe debris", error);
  }
}
