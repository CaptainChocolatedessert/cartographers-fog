/**
 * Dev log shim — forwards errors and console output out of the extension iframe to a
 * local Node receiver, so a failure inside a real Owlbear room is readable outside the
 * browser. See DESIGN.md, "Dev log shim".
 *
 * No-ops entirely in production builds.
 */

const ENDPOINT = "http://localhost:9999/log";

export type LogLevel = "info" | "warn" | "error" | "reject" | "console";

/**
 * Stringify log arguments without throwing. Anything can end up in a log call —
 * circular SDK items, Errors, DOM events — and the shim losing a message is much worse
 * than the message being ugly, since the message is usually why we are looking.
 */
export function serializeArgs(args: readonly unknown[]): string[] {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    }
    if (typeof arg === "string") return arg;
    if (typeof arg === "bigint") return `${arg}n`;
    if (typeof arg === "symbol") return arg.toString();
    if (typeof arg === "function") return `[Function ${arg.name || "anonymous"}]`;
    if (arg === null || typeof arg !== "object") return String(arg);
    try {
      return JSON.stringify(arg, circularReplacer()) ?? String(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  });
}

function circularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

export function devLog(level: LogLevel, ...args: unknown[]): void {
  if (!import.meta.env.DEV) return;
  // Fire and forget. A missing receiver must never break the extension, so every
  // failure path here is swallowed deliberately.
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      level,
      args: serializeArgs(args),
      at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

let installed = false;

export function installDevLog(): void {
  if (!import.meta.env.DEV || installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    devLog("error", event.message, `${event.filename}:${event.lineno}:${event.colno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    devLog("reject", event.reason);
  });

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    devLog("console", ...args);
    originalError(...args);
  };

  devLog("info", "dev log shim installed");
}
