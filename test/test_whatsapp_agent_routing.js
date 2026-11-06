import test from "node:test";
import assert from "node:assert/strict";
import { createAgentWhatsAppConfig, allowsAgentPhone, DEFAULT_MAINTENANCE_MESSAGE, MAINTENANCE_INTERVAL_MS } from "../src/config/agent-whatsapp.config.js";
import { createWhatsAppPilot } from "../src/services/whatsapp-agent.service.js";
import { MESSAGE_ID_TTL_MS } from "../src/config/agent-whatsapp.config.js";
import { WHATSAPP_INBOX_COLLECTION, WHATSAPP_OUTBOX_COLLECTION } from "../src/services/whatsapp-delivery.repository.js";
import { deliveryFixture, incoming } from "./helpers/whatsapp-fixtures.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("launcher del piloto valida proyecto/host antes de importar SDKs o revisar puertos", () => {
  for (const invalid of [{ GCLOUD_PROJECT: "not-the-demo-project" }, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:9999" }]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/dev-agent-whatsapp.js", import.meta.url))], {
      env: { ...process.env, AGENT_ENABLED: "true", AGENT_ALLOWLIST: "595900000001", ...invalid }, encoding: "utf8", timeout: 5000,
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Configuración inválida: se requiere demo-hodie-catalogo/);
    assert.equal(result.stderr.includes("EADDRINUSE"), false); assert.equal(result.stdout.includes("Firebase Admin"), false);
  }
});

test("configuración: apagado conserva legacy; lista ausente, vacía, normalizada e inválida", () => {
  assert.deepEqual(createAgentWhatsAppConfig({ AGENT_ENABLED: "false", AGENT_ALLOWLIST: 12, AGENT_MAINTENANCE_MESSAGE: null }), { enabled: false, allowlist: null });
  assert.equal(createAgentWhatsAppConfig({}).enabled, false);
  const all = createAgentWhatsAppConfig({ AGENT_ENABLED: "true" });
  assert.equal(all.maintenanceMode, "message");
  assert.equal(all.allowlist, null); assert.equal(allowsAgentPhone(all, null), true);
  const none = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: " " });
  assert.deepEqual(none.allowlist, []); assert.equal(allowsAgentPhone(none, "595900000001"), false);
  const selected = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "+595 900 000 001,0900000001" });
  assert.deepEqual(selected.allowlist, ["595900000001"]);
  assert.equal(allowsAgentPhone(selected, "595900000001"), true); assert.equal(allowsAgentPhone(selected, "123@lid"), false);
  for (const value of ["", "on", "yes"]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: value }));
  for (const value of ["123@lid", "595900000001,", "texto", 1]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: value }));
  for (const value of ["", " ", 12]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_MAINTENANCE_MESSAGE: value }));
});

test("matriz modo × interruptor × lista: silent exige interruptor activo y lista definida no vacía", () => {
  for (const mode of [undefined, "message", "silent"]) {
    for (const enabled of [false, true]) {
      for (const allowlist of [undefined, "", " ", "+595 900 000 001,0900000001"]) {
        const env = { AGENT_ENABLED: String(enabled),
          ...(mode === undefined ? {} : { AGENT_MAINTENANCE_MODE: mode }),
          ...(allowlist === undefined ? {} : { AGENT_ALLOWLIST: allowlist }) };
        if (mode === "silent" && (!enabled || !allowlist?.trim())) {
          assert.throws(() => createAgentWhatsAppConfig(env), /silent exige AGENT_ENABLED=true y AGENT_ALLOWLIST definida y no vacía/);
        } else {
          const config = createAgentWhatsAppConfig(env);
          assert.equal(config.enabled, enabled);
          if (enabled) {
            assert.equal(config.maintenanceMode, mode ?? "message");
            assert.deepEqual(config.allowlist, allowlist === undefined ? null : allowlist.trim() ? ["595900000001"] : []);
          }
        }
      }
    }
  }
  assert.throws(() => createAgentWhatsAppConfig({ AGENT_MAINTENANCE_MODE: "silent", AGENT_ALLOWLIST: "595900000001" }), /silent exige/);
  for (const enabled of ["false", "true"]) {
    for (const mode of ["", "Silent", "MESSAGE", "other", " silent ", null, 0, true]) {
      assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: enabled, AGENT_ALLOWLIST: "595900000001", AGENT_MAINTENANCE_MODE: mode }),
        /AGENT_MAINTENANCE_MODE debe ser message o silent/);
    }
  }
});

test("launcher informa modo y cantidad normalizada sin imprimir teléfonos antes de iniciar servicios", () => {
  for (const mode of ["message", "silent"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/dev-agent-whatsapp.js", import.meta.url))], {
      env: { ...process.env, GCLOUD_PROJECT: "demo-hodie-catalogo", CATALOG_TEST_PROJECT_ID: "demo-hodie-catalogo", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        GEMINI_API_KEY: "", AGENT_ENABLED: "true", AGENT_MAINTENANCE_MODE: mode, AGENT_MAINTENANCE_MESSAGE: DEFAULT_MAINTENANCE_MESSAGE,
        AGENT_ALLOWLIST: "+595 900 000 001,0900000001,595900000002" },
      encoding: "utf8", timeout: 5000,
    });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Falta GEMINI_API_KEY/);
    assert.equal(result.stdout.trim(), `Piloto WhatsApp: mantenimiento=${mode}; números habilitados=2`);
    assert.equal(result.stdout.includes("595900000001"), false);
    assert.equal(result.stdout.includes("595900000002"), false);
  }
});

test("interruptor apagado entrega el control al legacy sin tocar DB, identidad, transporte ni runtime", async () => {
  const forbidden = () => assert.fail("El piloto apagado no tiene efectos");
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({}), repository: { claimMessage: forbidden },
    resolvePhone: forbidden, transport: { sendText: forbidden }, createRuntime: forbidden });
  assert.equal(await pilot.handle(incoming("disabled")), false);
  await pilot.shutdown();
});

test("matriz activa: lista ausente habilita todos; lista vacía mantiene; lista restringida resuelve LID sin confiar en body", async () => {
  for (const [allowlist, resolved, enabled] of [[undefined, null, true], ["", "595900000001", false],
    ["595900000001", "595900000001", true], ["595900000001", null, false], ["595900000002", "595900000001", false]]) {
    const f = deliveryFixture(); let received = 0;
    const config = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", ...(allowlist === undefined ? {} : { AGENT_ALLOWLIST: allowlist }) });
    const pilot = createWhatsAppPilot({ config, repository: f.repository, transport: f.transport, resolvePhone: async () => resolved,
      createRuntime: async () => ({ receive: async () => { received++; }, shutdown() {} }) });
    try {
      assert.equal(await pilot.handle(incoming("matrix", { from: "test@lid", body: "Mi teléfono es 595900000001" })), true);
      assert.equal(received, enabled ? 1 : 0); assert.equal(f.outgoing.length, enabled ? 0 : 1);
      if (!enabled) assert.equal(f.outgoing[0].content, DEFAULT_MAINTENANCE_MESSAGE);
    } finally { await pilot.shutdown(); }
  }
});

test("silent fuera de lista: solo log enmascarado, sin IDs durables, mantenimiento, checkpoints, modelo, medios ni envíos", async () => {
  for (const identity of ["595900000002", null, "error"]) {
    for (const from of ["595900000002@c.us", "test-excluded@lid"]) {
      const f = deliveryFixture(), logs = [], repositoryCalls = [], resolutions = [];
      const repository = new Proxy(f.repository, { get(target, key) {
        return (...args) => { repositoryCalls.push(key); return target[key](...args); };
      } });
      const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "595900000001", AGENT_MAINTENANCE_MODE: "silent" }),
        repository, transport: f.transport, logger: value => logs.push(value),
        resolvePhone: async (...args) => { resolutions.push(args); if (identity === "error") throw new Error("Error privado " + from); return identity; },
        createRuntime: () => assert.fail("No abrir checkpoints ni crear el agente") });
      try {
        // Incluso sin ID: el descarte debe preceder a cualquier acceso al repositorio.
        assert.equal(await pilot.handle(incoming(null, { from, id: {}, body: "Soy 595900000001", hasMedia: true, type: "document",
          downloadMedia: () => assert.fail("No descargar adjuntos") })), true);
        assert.deepEqual(resolutions, [[from, { sideEffectFree: true }]]);
        assert.deepEqual(repositoryCalls, []); assert.equal(f.db.rows.size, 0);
        assert.deepEqual(f.outgoing, []); assert.deepEqual(f.pauses, []);
        assert.equal(logs.length, 1); assert.deepEqual(Object.keys(logs[0]).sort(), ["chat", "code"]);
        assert.equal(logs[0].code, "MAINTENANCE_SILENT"); assert.match(logs[0].chat, /^chat-[a-f0-9]{12}$/u);
        assert.equal(JSON.stringify(logs).includes(from), false); assert.equal(JSON.stringify(logs).includes("595900000002"), false);
        assert.equal(JSON.stringify(logs).includes("Soy"), false); assert.equal(JSON.stringify(logs).includes("Error privado"), false);
      } finally { await pilot.shutdown(); }
    }
  }
});

test("silent dentro de lista: conserva deduplicación y agente; no envía mantenimiento ni log de exclusión", async () => {
  const f = deliveryFixture(), logs = [], resolutions = []; let received = 0;
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "595900000001", AGENT_MAINTENANCE_MODE: "silent" }),
    repository: f.repository, transport: f.transport, logger: value => logs.push(value),
    resolvePhone: async (...args) => { resolutions.push(args); return "595900000001"; },
    createRuntime: async () => ({ receive: async () => { received++; }, shutdown() {} }) });
  try {
    await Promise.all([pilot.handle(incoming("silent-allowed")), pilot.handle(incoming("silent-allowed"))]);
    assert.equal(received, 1); assert.equal(resolutions.length, 2);
    assert.deepEqual(resolutions, Array.from({ length: 2 }, () => ["595900000001@c.us", { sideEffectFree: true }]));
    assert.equal(f.db.rows.size, 1);
    const [[path, row]] = f.db.rows.entries();
    assert.equal(path.startsWith(WHATSAPP_INBOX_COLLECTION + "/"), true); assert.equal(row.status, "completed");
    assert.deepEqual(f.outgoing, []); assert.deepEqual(logs, []);
  } finally { await pilot.shutdown(); }
});

test("resolución LID sin efectos: no escribe caché ni advierte; el default conserva la caché legacy", async () => {
  // Evaluar la función real sin importar Firebase/WhatsApp ni iniciar el grafo legacy.
  const source = await readFile(new URL("../src/config/whatsapp.js", import.meta.url), "utf8");
  const start = source.indexOf("export const resolvePhoneFromChatId = "), end = source.indexOf("export const handleIncomingWhatsAppMessage = ", start);
  assert.ok(start >= 0 && end > start);
  const f = deliveryFixture(), warnings = []; let readFails = false, networkFails = false, reads = 0, writes = 0;
  const db = { collection(name) {
    assert.equal(name, "lid_phone_map");
    return { doc: id => ({ async get() { reads++; if (readFails) throw new Error("Lectura privada"); return f.db.collection(name).doc(id).get(); },
      async set(...args) { writes++; return f.db.collection(name).doc(id).set(...args); } }) };
  } };
  const resolve = vm.runInNewContext(source.slice(start, end).replace("export const", "const") + "\nresolvePhoneFromChatId;", {
    db, whatsappClient: { async getContactLidAndPhone() { if (networkFails) throw new Error("Red privada"); return [{ pn: "595900000002@c.us" }]; } },
    Timestamp: { now: () => new Date(0) }, console: { warn: (...args) => warnings.push(args) },
  });
  try {
    assert.equal(await resolve("test-excluded@lid", { sideEffectFree: true }), "595900000002");
    assert.equal(writes, 0); assert.equal(f.db.rows.size, 0);
    readFails = true;
    assert.equal(await resolve("test-excluded@lid", { sideEffectFree: true }), "595900000002");
    networkFails = true;
    assert.equal(await resolve("test-excluded@lid", { sideEffectFree: true }), "");
    assert.equal(writes, 0); assert.deepEqual(warnings, []);
    readFails = false; networkFails = false;
    assert.equal(await resolve("test-legacy@lid"), "595900000002");
    assert.equal(reads, 4); assert.equal(writes, 1); assert.equal(f.db.rows.size, 1);
    assert.equal((await f.db.collection("lid_phone_map").doc("test-legacy").get()).data().phoneNumber, "595900000002");
    networkFails = true;
    assert.equal(await resolve("test-legacy-error@lid"), "");
    assert.equal(warnings.length, 1);
  } finally { f.transport.close(); }
});

test("duplicados concurrentes entre receptores y tras reiniciar: una sola ejecución, TTL exacto de siete días", async () => {
  const f = deliveryFixture(); let calls = 0;
  const options = { config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository, transport: f.transport,
    resolvePhone: async () => "595900000001", createRuntime: async () => ({ receive: async () => { calls++; }, shutdown() {} }) };
  const first = createWhatsAppPilot(options), second = createWhatsAppPilot(options);
  try {
    await Promise.all(Array.from({ length: 25 }, (_, index) => (index % 2 ? first : second).handle(incoming("same-id"))));
    assert.equal(calls, 1);
    const row = [...f.db.rows.entries()].find(([path]) => path.startsWith(WHATSAPP_INBOX_COLLECTION + "/"))[1];
    assert.equal(row.expiresAt.getTime() - row.receivedAt.getTime(), MESSAGE_ID_TTL_MS);
    assert.equal(row.status, "completed");
    await createWhatsAppPilot(options).handle(incoming("same-id")); assert.equal(calls, 1);
    await first.handle(incoming("different-id")); assert.equal(calls, 2);
    f.advance(MESSAGE_ID_TTL_MS);
    await second.handle(incoming("same-id")); assert.equal(calls, 3);
  } finally { await first.shutdown(); await second.shutdown(); }
});

test("la admisión preserva orden pero no espera el turno: mensajes distintos pueden entrar a la misma ráfaga", async () => {
  const f = deliveryFixture(), received = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository,
    transport: f.transport, resolvePhone: async () => "595900000001",
    createRuntime: async () => ({ receive(message) { received.push(message.id._serialized); if (received.length === 2) release(); return pending; }, shutdown() { release(); } }) });
  try {
    await Promise.all([pilot.handle(incoming("one")), pilot.handle(incoming("two"))]);
    assert.deepEqual(received, ["one", "two"]);
  } finally { await pilot.shutdown(); }
});

test("mantenimiento configurable reservado una vez por seis horas, incluso con concurrencia y reconstrucción; registra envío propio", async () => {
  const f = deliveryFixture(), text = "Aviso configurable de prueba";
  const options = { config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "", AGENT_MAINTENANCE_MESSAGE: text }),
    repository: f.repository, transport: f.transport, resolvePhone: async () => null, createRuntime: () => assert.fail("Sin modelo") };
  const pilot = createWhatsAppPilot(options);
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => pilot.handle(incoming("maintenance-" + i))));
    assert.equal(f.outgoing.length, 1); assert.equal(f.outgoing[0].content, text);
    const delivery = [...f.db.rows.entries()].find(([path]) => path.startsWith(WHATSAPP_OUTBOX_COLLECTION + "/"))[1];
    assert.equal(delivery.origin, "maintenance"); assert.equal(delivery.own, true);
    assert.equal(delivery.whatsappMessageId, "own-1"); assert.equal(delivery.status, "accepted");
    f.advance(MAINTENANCE_INTERVAL_MS - 1);
    await createWhatsAppPilot(options).handle(incoming("before-six-hours")); assert.equal(f.outgoing.length, 1);
    f.advance(1); await pilot.handle(incoming("at-six-hours")); assert.equal(f.outgoing.length, 2);
  } finally { await pilot.shutdown(); }
});

test("filtros y errores del piloto activo nunca vuelven al router; no descarga grupos, difusión, sistema o propios", async () => {
  const f = deliveryFixture(); let lookedUp = 0;
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository,
    transport: f.transport, resolvePhone: async () => { lookedUp++; return null; }, createRuntime: async () => { throw new Error("Error técnico"); } });
  try {
    for (const overrides of [{ fromMe: true }, { from: "group@g.us" }, { from: "list@broadcast" }, { from: "status@broadcast" },
      { from: "channel@newsletter" }, { from: "0@c.us" }, { type: "e2e_notification" }, { broadcast: true }]) {
      assert.equal(await pilot.handle(incoming("filtered", { ...overrides, hasMedia: true, downloadMedia: () => assert.fail("No descargar") })), true);
    }
    assert.equal(lookedUp, 0); assert.equal(f.db.rows.size, 0);
    await assert.rejects(pilot.handle(incoming("bad-runtime")), /Error técnico/);
    await assert.rejects(pilot.handle(incoming(null, { id: {} })), { code: "MESSAGE_ID_REQUIRED" });
  } finally { await pilot.shutdown(); }
});

test("apagar mientras se resuelve identidad impide crear runtime y enviar después del cierre", async () => {
  for (const mode of ["message", "silent"]) {
    const f = deliveryFixture(); let enter, release;
    const waiting = new Promise(resolve => { enter = resolve; });
    const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_MAINTENANCE_MODE: mode, AGENT_ALLOWLIST: "595900000001" }),
      repository: f.repository, transport: f.transport, logger: () => assert.fail("Sin log de exclusión tras apagar"),
      resolvePhone: () => { enter(); return new Promise(resolve => { release = resolve; }); },
      createRuntime: () => assert.fail("No crear agente tras apagar") });
    const pending = pilot.handle(incoming("shutdown")), rejected = assert.rejects(pending, { code: "PILOT_CLOSED" });
    await waiting; await pilot.shutdown(); release("595900000001"); await rejected;
    assert.deepEqual(f.outgoing, []);
    if (mode === "silent") assert.equal(f.db.rows.size, 0);
  }
});

test("vencimiento inválido falla explícitamente en vez de volver a procesar un ID", async () => {
  const f = deliveryFixture();
  try {
    const id = await f.repository.claimMessage("test@lid", "same");
    await f.db.collection(WHATSAPP_INBOX_COLLECTION).doc(id).update({ expiresAt: null });
    await assert.rejects(f.repository.claimMessage("test@lid", "same"), { code: "MESSAGE_RECORD_INVALID" });
    assert.notEqual(await f.repository.claimMessage("other@lid", "same"), null);
  } finally { f.transport.close(); }
});
