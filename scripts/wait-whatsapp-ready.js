import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export async function inspectPM2(signal) {
  // jlist puede contener env/secretos: nunca imprimirlo, ni sus errores crudos.
  const { stdout } = await exec("pm2", ["jlist"], { signal, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const matches = JSON.parse(stdout).filter(app => app.name === "hodie-backend");
  if (matches.length !== 1) return null;
  const app = matches[0];
  return { pid: app.pid, startedAt: app.pm2_env?.pm_uptime, status: app.pm2_env?.status, logPath: app.pm2_env?.pm_out_log_path };
}
export async function readStartupLogs(logPath, signal) {
  if (typeof logPath !== "string" || !logPath) return [];
  const directory = dirname(logPath), current = basename(logPath), stem = current.replace(/\.log$/u, "");
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  // Incluye rotaciones sin comprimir para no perder ready durante logrotate.
  const candidates = [current, ...names.filter(name => name.startsWith(stem + "__") && name.endsWith(".log")).sort().reverse().slice(0, 7)];
  const chunks = [];
  for (const name of candidates) {
    signal.throwIfAborted();
    let file;
    try {
      file = await open(join(directory, name), "r");
      const size = (await file.stat()).size, start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      chunks.push(start ? text.slice(text.indexOf("\n") + 1) : text);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { await file?.close(); }
  }
  signal.throwIfAborted(); return chunks;
}
export function findReadyEvent(chunks, processInfo, since) {
  if (processInfo?.status !== "online" || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0
      || !Number.isSafeInteger(processInfo.startedAt)) return null;
  for (const line of chunks.flatMap(text => text.split(/\r?\n/u))) {
    const begin = line.indexOf("{"); if (begin < 0) continue;
    let event;
    try { event = JSON.parse(line.slice(begin)); } catch { continue; }
    const agent = event.agent;
    if (event.event !== "whatsapp_connection" || event.code !== "WHATSAPP_READY" || event.pid !== processInfo.pid
        || !Number.isSafeInteger(event.startedAt) || event.startedAt < Math.max(since, processInfo.startedAt)
        || typeof event.bootId !== "string" || !/^[a-f0-9-]{36}$/u.test(event.bootId)
        || typeof agent?.enabled !== "boolean" || !["message", "silent"].includes(agent.maintenanceMode)
        || typeof agent.allowlistDefined !== "boolean"
        || (agent.allowlistDefined ? !Number.isSafeInteger(agent.allowlistCount) || agent.allowlistCount < 0 : agent.allowlistCount !== null)) continue;
    // Solo devolver campos controlados, nunca la línea cruda ni el entorno PM2.
    return { event: event.event, code: event.code, pid: event.pid, startedAt: event.startedAt, bootId: event.bootId,
      agent: { enabled: agent.enabled, maintenanceMode: agent.maintenanceMode,
        allowlistDefined: agent.allowlistDefined, allowlistCount: agent.allowlistCount } };
  }
  return null;
}
function abortable(action, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true }); });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }), aborted])
    .finally(() => signal.removeEventListener("abort", listener));
}
export async function waitForWhatsAppReady({ since, timeoutMs = 60000, inspect = inspectPM2, readLogs = readStartupLogs,
  clock = { now: Date.now, setTimeout, clearTimeout }, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Plazo o fecha de deploy inválidos");
  const timeout = Object.assign(new Error("WhatsApp no informó ready y el modo del agente para el proceso actual dentro de 60 s"), { code: "WHATSAPP_READY_TIMEOUT" });
  const controller = new AbortController(), signal = controller.signal, deadline = clock.now() + timeoutMs;
  const timer = clock.setTimeout(() => controller.abort(timeout), timeoutMs);
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        const processInfo = await abortable(() => inspect(signal), signal);
        const chunks = processInfo?.logPath ? await abortable(() => readLogs(processInfo.logPath, signal), signal) : [];
        const ready = findReadyEvent(chunks, processInfo, since);
        if (ready) {
          // No aceptar una línea del proceso que murió mientras se leía el log.
          const current = await abortable(() => inspect(signal), signal);
          if (current?.status === "online" && current.pid === processInfo.pid && current.startedAt === processInfo.startedAt) return ready;
        }
      } catch (error) { if (signal.aborted) throw signal.reason; /* Reintentar lecturas/PM2 transitorios sin volcar env. */ }
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw timeout;
      await abortable(() => sleep(Math.min(1000, remaining), signal), signal);
    }
  } finally { clock.clearTimeout(timer); controller.abort(); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--since" || !/^[0-9]+$/u.test(argv[1])) throw new Error("Uso: node scripts/wait-whatsapp-ready.js --since MILISEGUNDOS_UNIX");
  const event = await waitForWhatsAppReady({ since: Number(argv[1]) });
  console.log(JSON.stringify({ ...event, code: "DEPLOY_WHATSAPP_READY" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.code === "WHATSAPP_READY_TIMEOUT" ? error.message : "No se pudo verificar el arranque de WhatsApp en PM2"); process.exitCode = 1; });
}
