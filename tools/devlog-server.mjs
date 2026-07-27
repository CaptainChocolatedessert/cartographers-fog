/**
 * Dev log receiver. Pairs with src/devlog.ts — see DESIGN.md, "Dev log shim".
 *
 *   npm run devlog
 *
 * Appends to dev.log (gitignored) and echoes to stdout, so a failure inside a real
 * Owlbear room is readable without digging through browser devtools.
 */

import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = 9999;
const LOG_FILE = fileURLToPath(new URL("../dev.log", import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

const server = createServer((req, res) => {
  // The extension iframe is on a different origin from this receiver, so the POST is a
  // cross-origin request and needs both the preflight answer and the header below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) req.destroy();
  });

  req.on("end", async () => {
    res.writeHead(204).end();
    try {
      await record(JSON.parse(body));
    } catch {
      await record({ level: "warn", at: null, args: [`unparseable payload: ${body.slice(0, 200)}`] });
    }
  });
});

async function record({ level = "info", at = null, args = [], client = "?" }) {
  const stamp = at ?? new Date().toISOString();
  const time = stamp.slice(11, 23);
  // Every client in the room logs here, so say which one. Without it, a GM and a player
  // interleaved read as a single client contradicting itself.
  const who = `[${String(client).padEnd(8)}]`;
  const line = `${time} [${String(level).toUpperCase()}] ${who} ${args.join(" ")}`;
  process.stdout.write(`${line}\n`);
  await appendFile(
    LOG_FILE,
    `${stamp} [${level}] ${who} ${args.join(" ")}\n`,
    "utf8",
  );
}

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`dev log receiver listening on http://localhost:${PORT}/log\n`);
  process.stdout.write(`appending to ${LOG_FILE}\n`);
});
