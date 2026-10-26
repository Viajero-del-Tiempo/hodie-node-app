import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createServerShutdown, SERVER_SHUTDOWN_TIMEOUT_MS } from "../src/services/server-shutdown.service.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

const require = createRequire(import.meta.url);
function fixture(components) {
  const clock = createVirtualClock(), processEvents = new EventEmitter(), logs = [], exits = [];
  const shutdown = createServerShutdown({ components, clock, processEvents, logger: row => logs.push(row), exit: code => exits.push(code) });
  return { clock, processEvents, logs, exits, shutdown };
}

test("ecosystem conserva el nombre existente, plazo y fechas sin secretos ni reinicio por memoria", () => {
  const { apps } = require("../ecosystem.config.cjs");
  assert.equal(apps.length, 1);
  assert.deepEqual(apps[0], { name: "hodie-backend", script: "./server.js",
    cwd: new URL("../", import.meta.url).pathname.replace(/\/$/u, ""), kill_timeout: 15000, time: true });
  assert.ok(SERVER_SHUTDOWN_TIMEOUT_MS < apps[0].kill_timeout);
  assert.equal(Object.hasOwn(apps[0], "env"), false);
  assert.equal(Object.hasOwn(apps[0], "max_memory_restart"), false);
});

for (const signal of ["SIGINT", "SIGTERM"]) test(`${signal} inicia todos los cierres y termina antes del plazo de PM2`, async () => {
  const calls = [];
  const f = fixture(Object.fromEntries(["guardianAndWorkers", "whatsapp", "receiptCleanup", "http", "memory"]
    .map(name => [name, async () => { calls.push(name); }])));
  assert.equal(f.shutdown.isStopping(), false);
  f.processEvents.emit(signal);
  assert.equal(f.shutdown.isStopping(), true);
  const result = await f.shutdown.stop();
  assert.deepEqual(calls, ["guardianAndWorkers", "whatsapp", "receiptCleanup", "http", "memory"]);
  assert.deepEqual(f.exits, [0]); assert.deepEqual(result.pending, []);
  assert.equal(result.code, "SERVER_SHUTDOWN_COMPLETE"); assert.ok(result.elapsedMs < 15000);
  assert.equal(f.logs[0].reason, signal); assert.equal(f.clock.pendingTimers(), 0);
  assert.equal(f.processEvents.listenerCount("SIGINT"), 0); assert.equal(f.processEvents.listenerCount("SIGTERM"), 0);
});

test("un trabajador trabado no impide client.destroy; señales repetidas no duplican cierres y el límite es 14 s", async () => {
  let release, destroyed = 0, workerCalls = 0;
  const f = fixture({ guardianAndWorkers: () => { workerCalls++; return new Promise(resolve => { release = resolve; }); },
    whatsapp: async () => { destroyed++; } });
  f.processEvents.emit("SIGINT"); f.processEvents.emit("SIGINT"); f.processEvents.emit("SIGTERM");
  const completion = f.shutdown.stop();
  assert.equal(completion, f.shutdown.stop());
  await flushMicrotasks(); assert.equal(destroyed, 1); assert.equal(workerCalls, 1);
  await f.clock.advanceAsync(13999); assert.deepEqual(f.exits, []);
  await f.clock.advanceAsync(1);
  const result = await completion;
  assert.equal(result.code, "SERVER_SHUTDOWN_TIMEOUT"); assert.equal(result.elapsedMs, 14000);
  assert.deepEqual(result.pending, ["guardianAndWorkers"]); assert.deepEqual(f.exits, [1]);
  release(); await flushMicrotasks(); assert.deepEqual(f.exits, [1]);
  assert.equal(f.clock.pendingTimers(), 0);
});

test("un cierre que falla no omite los demás ni expone el error crudo", async () => {
  let destroyed = false;
  const f = fixture({ guardianAndWorkers: () => { throw new Error("Detalle privado"); },
    whatsapp: async () => { destroyed = true; } });
  const result = await f.shutdown.stop();
  assert.equal(destroyed, true); assert.equal(result.code, "SERVER_SHUTDOWN_FAILED");
  assert.deepEqual(f.exits, [1]); assert.deepEqual(result.pending, []);
  assert.equal(f.logs.find(row => row.code === "SERVER_COMPONENT_CLOSE_FAILED").component, "guardianAndWorkers");
  assert.equal(JSON.stringify(f.logs).includes("Detalle privado"), false);
});

test("server registra señales antes de initialize y destruye WhatsApp aun sin ready; no abre HTTP después del cierre", async () => {
  // Ejecuta el punto de entrada real con dependencias falsas: no abre Firebase, HTTP ni Chromium.
  const source = (await readFile(new URL("../server.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gmu, "");
  const clock = createVirtualClock(), processEvents = new EventEmitter(), calls = [], exits = [];
  let initializeDone, shutdown;
  vm.runInNewContext(source, {
    dotenv: { config() {} }, process: { env: {} }, console: { log() {}, error() {} }, receipts: { cleanup: {} },
    app: { listen: () => assert.fail("HTTP no debe iniciar tras SIGTERM") },
    cleanupStaleOrderPDFs() {},
    createProcessMemoryMonitor: () => ({ start() {}, stop: () => calls.push("memory") }),
    startReceiptCleanup: () => () => { calls.push("receiptCleanup"); },
    initializeWhatsapp: () => {
      assert.equal(processEvents.listenerCount("SIGTERM"), 1);
      return new Promise(resolve => { initializeDone = resolve; });
    },
    shutdownAgentPilot: async () => { calls.push("guardianAndWorkers"); },
    whatsappClient: { destroy: async () => { calls.push("whatsapp"); }, logout: () => assert.fail("No borrar sesión") },
    createServerShutdown: options => {
      shutdown = createServerShutdown({ ...options, clock, processEvents, logger() {}, exit: code => exits.push(code) });
      return shutdown;
    },
  });
  processEvents.emit("SIGTERM"); await flushMicrotasks();
  assert.deepEqual(calls, ["guardianAndWorkers", "receiptCleanup", "memory", "whatsapp"]);
  assert.deepEqual(exits, []);
  initializeDone(); await shutdown.stop(); await flushMicrotasks();
  assert.deepEqual(calls, ["guardianAndWorkers", "receiptCleanup", "memory", "whatsapp", "whatsapp"]);
  assert.deepEqual(exits, [0]);
});

test("server cierra HTTP sin cortar las solicitudes en curso y espera su cierre junto con WhatsApp", async () => {
  const source = (await readFile(new URL("../server.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gmu, "");
  const clock = createVirtualClock(), processEvents = new EventEmitter(), calls = [], exits = [];
  let httpClosed, shutdown;
  const http = new EventEmitter();
  http.close = callback => { calls.push("http.close"); httpClosed = callback; };
  http.closeIdleConnections = () => calls.push("http.closeIdleConnections");
  http.closeAllConnections = () => assert.fail("Dar margen a las solicitudes en curso");
  vm.runInNewContext(source, {
    dotenv: { config() {} }, process: { env: {} }, console: { log() {}, error() {} }, receipts: { cleanup: {} },
    app: { listen: () => http }, cleanupStaleOrderPDFs() {}, initializeWhatsapp: async () => {},
    createProcessMemoryMonitor: () => ({ start() {}, stop() {} }), startReceiptCleanup: () => async () => {},
    shutdownAgentPilot: async () => { calls.push("guardianAndWorkers"); },
    whatsappClient: { destroy: async () => { calls.push("whatsapp"); } },
    createServerShutdown: options => {
      shutdown = createServerShutdown({ ...options, clock, processEvents, logger() {}, exit: code => exits.push(code) });
      return shutdown;
    },
  });
  await flushMicrotasks(); processEvents.emit("SIGINT"); await flushMicrotasks();
  assert.deepEqual(calls, ["guardianAndWorkers", "whatsapp", "http.close", "http.closeIdleConnections"]);
  await clock.advanceAsync(1000); assert.deepEqual(exits, []);
  httpClosed(); const result = await shutdown.stop();
  assert.equal(result.elapsedMs, 1000); assert.deepEqual(exits, [0]);
});
