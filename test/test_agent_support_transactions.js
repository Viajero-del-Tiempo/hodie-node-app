import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalEnvironment } from "../scripts/local-catalog.config.js";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { createAgentAlertRepository } from "../src/services/agent-alert.repository.js";
import { createAgentAlertService } from "../src/services/agent-alert.service.js";

assertLocalEnvironment(process.env); // Antes de importar SDK o credenciales.

test("5A: configuración y alertas en emulador aislado", async t => {
  const api = await openCustomerTestApi({ includeAgentConfig: true });
  try {
    const admin = await api.createUser("config-admin", { role: "admin" }), customer = await api.createUser("config-customer");
    await t.test("GET/PUT rechazan anónimo y cliente; admin guarda y recibe errores por campo", async () => {
      for (const method of ["GET", "PUT"]) {
        assert.equal((await api.request("/admin/agent-config", { method, body: method === "PUT" ? { corporateQuantityThreshold: 7, version: null } : undefined })).status, 401);
        assert.equal((await api.request("/admin/agent-config", { method, phone: customer.phoneNumber,
          body: method === "PUT" ? { corporateQuantityThreshold: 7, version: null } : undefined })).status, 403);
      }
      assert.equal(await api.agentConfig.get(), null);
      const invalid = await api.request("/admin/agent-config", { phone: admin.phoneNumber, method: "PUT", body: { corporateQuantityThreshold: 0, version: null } });
      assert.equal(invalid.status, 400); assert.equal(invalid.body.field, "corporateQuantityThreshold");
      const saved = await api.request("/admin/agent-config", { phone: admin.phoneNumber, method: "PUT", body: { corporateQuantityThreshold: 7, version: null } });
      assert.equal(saved.status, 200); assert.equal(saved.body.config.corporateQuantityThreshold, 7);
      assert.equal((await api.request("/admin/agent-config", { phone: admin.phoneNumber })).body.config.version, saved.body.config.version);
    });
    await t.test("dos administradores concurrentes con la misma versión: un guardado y un 409", async () => {
      const current = await api.agentConfig.get();
      const values = await Promise.all([8, 9].map(corporateQuantityThreshold => api.request("/admin/agent-config", { method: "PUT", phone: admin.phoneNumber,
        body: { corporateQuantityThreshold, version: current.version } })));
      assert.deepEqual(values.map(value => value.status).sort(), [200, 409]);
      assert.equal(values.find(value => value.status === 409).body.field, "corporateQuantityThreshold");
    });
    await t.test("misma solicitud desde varias instancias: un documento durable y delivered no se reinicia", async () => {
      const alert = { id: api.scope.id("episode"), type: "HANDOFF", chatId: api.scope.id("chat"), createdAt: Date.now(), delivered: false };
      const ref = api.scope.track("agent_alerts", alert.id);
      const service = () => createAgentAlertService({ repository: createAgentAlertRepository({ db: api.db }) });
      await Promise.all(Array.from({ length: 5 }, () => service().request(alert)));
      assert.deepEqual((await ref.get()).data(), alert);
      await ref.update({ delivered: true }); assert.equal((await service().request(alert)).delivered, true);
    });
    await t.test("rollback de alerta preparada y cancelación no escriben", async () => {
      const id = api.scope.id("rollback"), ref = api.scope.track("agent_alerts", id);
      const repository = createAgentAlertRepository({ db: { collection: name => api.db.collection(name),
        runTransaction: action => api.db.runTransaction(async tx => { await action(tx); throw new Error("Rollback de prueba"); }) } });
      await assert.rejects(repository.request({ id, type: "HANDOFF", chatId: api.scope.id("chat") }));
      assert.equal((await ref.get()).exists, false);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(createAgentAlertService({ repository: createAgentAlertRepository({ db: api.db }) }).request({ id, type: "HANDOFF", chatId: api.scope.id("chat") }, { signal: controller.signal }));
      assert.equal((await ref.get()).exists, false);
    });
  } finally { await api.close(); }
});
