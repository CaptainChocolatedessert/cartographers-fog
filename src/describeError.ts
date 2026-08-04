/**
 * Turn any thrown value into one readable line.
 *
 * ## Owlbear's failures are not `Error`s
 *
 * The SDK posts every call to the parent frame and waits for a reply. When the parent refuses, the
 * SDK rejects with the payload it received — unaltered, unwrapped, and never converted. A scene call
 * made before a scene is open rejects with the plain object:
 *
 * ```
 * { error: { name: "MissingDataError", message: "No scene found" } }
 * ```
 *
 * Nothing in that is an `Error`, so the obvious `error instanceof Error` test is false for every
 * failure the SDK can hand back, and a reporter written around it discards the only useful thing it
 * was given. That is not a quirk of one call: it is how every rejection from the SDK arrives.
 *
 * ## Why this is its own module
 *
 * Pure, and therefore testable. The panel imports the SDK, so nothing in it can be reached from a
 * node test — the SDK reads `window.location.search` at module load and dies. Splitting the pure
 * half out is the standing rule here, and it matters more than usual for this function: it exists to
 * survive shapes nobody controls, which is exactly the kind of thing that quietly stops working.
 *
 * ## What it must never do
 *
 * Return a bare, undescribed value silently. A description that reads the same whether it found a
 * cause or found nothing is a diagnostic that cannot distinguish its outcomes — the failure this
 * project has paid for repeatedly — and it is what hid the panel's startup bug for two days. When
 * there is nothing to say, this says so.
 */
export function describeError(value: unknown, depth = 0): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;

    // The SDK's envelope, unwrapped. Bounded rather than followed to the end: past this point the
    // payload is Owlbear's own, and a general search for something error-shaped would be guessing
    // at a structure nobody has documented. The bound also settles a payload referring to itself.
    if (depth < 2 && "error" in record) {
      return describeError(record.error, depth + 1);
    }

    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (name && message) return `${name}: ${message}`;
    if (name || message) return name || message;

    try {
      const json = JSON.stringify(value);
      // `{}` is the shape a `DOMException` and a few other host objects take, since their fields sit
      // on the prototype. Passing it on would say nothing; the fallback at least names the type.
      if (json && json !== "{}") return json;
    } catch {
      // Cyclic, or holding a value JSON cannot carry. The fallback covers it.
    }
  }

  // `String()` on an object is not safe — one made with a null prototype has no `toString` and
  // throws, which would turn a report about a failure into a second failure inside the reporter.
  const shown =
    value !== null && typeof value === "object"
      ? Object.prototype.toString.call(value)
      : String(value);
  return `no detail on ${shown}`;
}
