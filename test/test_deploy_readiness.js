import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWhatsAppRuntimeLogger } from "../src/utils/whatsapp-startup.util.js";
import { createAgentWhatsAppConfig } from "../src/config/agent-whatsapp.config.js";
import { findReadyEvent, readStartupLogs, waitForWhatsAppReady } from "../scripts/wait-whatsapp-ready.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

const bootId = "12345678-1234-1234-1234-123456789abc";
const processInfo = { pid: 321, startedAt: 1000, status: "online", logPath: "/unused/hodie-backend-out.log" };
const ready = { event: "whatsapp_connection", code: "WHATSAPP_READY", pid: 321, startedAt: 1001, bootId,
  agent: { enabled: true, maintenanceMode: "silent", allowlistDefined: true, allowlistCount: 1 } };
const line = event => `2026-10-18T10:20:30: ${JSON.stringify(event)}\n`;

test("ready informa interruptor, modo y cantidad efectivos sin teléfonos ni entorno", () => {
  for (const [env, expected] of [
    [{}, { enabled: false, maintenanceMode: "message", allowlistDefined: false, allowlistCount: null }],
    [{ AGENT_ENABLED: "true" }, { enabled: true, maintenanceMode: "message", allowlistDefined: false, allowlistCount: null }],
    [{ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "" }, { enabled: true, maintenanceMode: "message", allowlistDefined: true, allowlistCount: 0 }],
    [{ AGENT_ENABLED: "true", AGENT_MAINTENANCE_MODE: "silent", AGENT_ALLOWLIST: "595900000001,595900000002" },
      { enabled: true, maintenanceMode: "silent", allowlistDefined: true, allowlistCount: 2 }],
  ]) {
    const logs = [], config = createAgentWhatsAppConfig({ ...env, JWT_SECRET: "No imprimir" });
    const logger = createWhatsAppRuntimeLogger(config, { pid: 321, startedAt: 1001, bootId, logger: row => logs.push(row) });
    logger({ event: "whatsapp_connection", code: "WHATSAPP_AUTHENTICATED" });
    assert.deepEqual(logs[0], { event: "whatsapp_connection", code: "WHATSAPP_AUTHENTICATED" });
    logger({ event: "whatsapp_connection", code: "WHATSAPP_READY" });
    assert.deepEqual(logs[1].agent, expected); assert.equal(logs[1].pid, 321); assert.equal(logs[1].bootId, bootId);
    assert.equal(JSON.stringify(logs).includes("5959000000"), false); assert.equal(JSON.stringify(logs).includes("No imprimir"), false);
  }
});

test("acepta JSON con fecha de PM2 y solo devuelve metadatos permitidos del arranque actual", () => {
  assert.deepEqual(findReadyEvent([line({ ...ready, secret: "No imprimir" })], processInfo, 999), ready);
  for (const event of [
    { ...ready, pid: 320 }, { ...ready, startedAt: 998 }, { ...ready, startedAt: 999 },
    { ...ready, bootId: undefined }, { ...ready, agent: undefined },
    { ...ready, agent: { ...ready.agent, maintenanceMode: undefined } },
    { ...ready, agent: { ...ready.agent, allowlistCount: undefined } },
  ]) assert.equal(findReadyEvent([line(event)], processInfo, 999), null);
  assert.equal(findReadyEvent([line(ready)], processInfo, 1002), null);
  assert.equal(findReadyEvent([line(ready)], { ...processInfo, status: "stopped" }, 999), null);
  assert.equal(findReadyEvent(["✅ WhatsApp listo\nno es JSON\n"], processInfo, 999), null);
});

test("lee el log actual y las rotaciones sin aceptar un ready viejo en lugar del actual", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hodie-ready-"));
  try {
    const path = join(directory, "hodie-backend-out.log");
    await writeFile(path, line({ ...ready, pid: 320 }));
    await writeFile(join(directory, "hodie-backend-out__2026-10-18_10-20-30.log"), line(ready));
    await writeFile(join(directory, "otra-app-out.log"), line({ ...ready, pid: 999 }));
    const chunks = await readStartupLogs(path, new AbortController().signal);
    assert.equal(chunks.length, 2); assert.deepEqual(findReadyEvent(chunks, processInfo, 999), ready);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("espera el ready nuevo y vuelve a verificar que el PID siga activo antes de aprobar el deploy", async () => {
  const clock = createVirtualClock(1100);
  let reads = 0, inspections = 0;
  const result = await waitForWhatsAppReady({ since: 999, clock,
    inspect: async () => { inspections++; return processInfo; },
    readLogs: async () => [line(++reads === 1 ? { ...ready, pid: 320 } : ready)],
    sleep: async ms => clock.advanceAsync(ms),
  });
  assert.deepEqual(result, ready); assert.equal(reads, 2); assert.equal(inspections, 3);
  assert.equal(clock.now(), 2100); assert.equal(clock.pendingTimers(), 0);
});

test("un proceso reemplazado durante la lectura no pasa la verificación", async () => {
  const clock = createVirtualClock(1100), replacement = { ...processInfo, pid: 322, startedAt: 1100 };
  let inspections = 0;
  await assert.rejects(waitForWhatsAppReady({ since: 999, clock, timeoutMs: 1000,
    inspect: async () => ++inspections === 1 ? processInfo : replacement,
    readLogs: async () => [line(ready)], sleep: async ms => clock.advanceAsync(ms),
  }), { code: "WHATSAPP_READY_TIMEOUT" });
  assert.equal(inspections, 2); assert.equal(clock.pendingTimers(), 0);
});

test("sin ready, con errores de lectura o con PM2 trabado termina a los 60 s sin volcar datos privados", async () => {
  for (const inspect of [async () => processInfo, async () => { throw new Error("Entorno privado de PM2"); }, () => new Promise(() => {})]) {
    const clock = createVirtualClock(1100), signals = [];
    const pending = waitForWhatsAppReady({ since: 999, clock, inspect: signal => { signals.push(signal); return inspect(); },
      readLogs: async () => [line({ ...ready, startedAt: 998 })],
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        const timer = clock.setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clock.clearTimeout(timer); reject(signal.reason); }, { once: true });
      }),
    });
    const rejected = assert.rejects(pending, error => error.code === "WHATSAPP_READY_TIMEOUT" && !error.message.includes("privado"));
    await flushMicrotasks(); await clock.advanceAsync(59999);
    assert.equal(signals[0].aborted, false);
    await clock.advanceAsync(1); await rejected;
    assert.equal(signals[0].aborted, true); assert.equal(clock.pendingTimers(), 0);
  }
});

test("deploy conserva instalación y parche; aplica ecosystem, guarda y comprueba ready después de logs", async () => {
  const source = await readFile(new URL("../deploy.sh", import.meta.url), "utf8");
  const ordered = ["set -e", "npm ci", "npx puppeteer browsers install chrome", 'grep -q "cleanMediaOptions"',
    "deploy_started_at=$(node -p 'Date.now()')", "pm2 startOrRestart ecosystem.config.cjs --update-env", "pm2 save",
    "pm2 logs hodie-backend --lines 15 --nostream", 'node scripts/wait-whatsapp-ready.js --since "$deploy_started_at"'];
  let previous = -1;
  for (const fragment of ordered) { const index = source.indexOf(fragment); assert.ok(index > previous, fragment); previous = index; }
  assert.equal(source.includes("pm2 restart hodie-backend"), false);
  assert.equal(source.includes("pm2 delete"), false);
});
