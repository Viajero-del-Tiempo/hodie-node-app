import test from "node:test";
import assert from "node:assert/strict";
import { validateAgentConfig, assertCorporateQuantity } from "../src/services/agent-config.service.js";
import { createAgentConfigRepository } from "../src/services/agent-config.repository.js";
import { createAgentConfigController } from "../src/controllers/admin.agent-config.controller.js";
import { agentMemoryFirestore } from "./helpers/agent-memory-firestore.js";

test("configuración valida el campo, versión y whitelist, sin valor comercial por defecto", () => {
  assert.deepEqual(validateAgentConfig({ corporateQuantityThreshold: 9, version: null }), { corporateQuantityThreshold: 9, version: null });
  for (const value of [undefined, null, 0, -1, 1.1, "9", true, Infinity]) assert.throws(() => validateAgentConfig({ corporateQuantityThreshold: value, version: null }), error => error.field === "corporateQuantityThreshold");
  assert.throws(() => validateAgentConfig({ corporateQuantityThreshold: 9, version: null, text: "Falso" }), error => error.field === "text");
  assert.throws(() => assertCorporateQuantity([], null), { code: "CONFIGURACION_INCOMPLETA" });
  assert.deepEqual(assertCorporateQuantity([{ quantity: 4 }, { quantity: 5 }], { corporateQuantityThreshold: 9 }), { totalUnits: 9, threshold: 9 });
  assert.throws(() => assertCorporateQuantity([{ quantity: 4 }, { quantity: 6 }], { corporateQuantityThreshold: 9 }), error => error.code === "CANTIDAD_CORPORATIVA" && error.totalUnits === 10 && error.threshold === 9);
});
test("documento único y guardado transaccional rechazan sobrescritura con versión vieja", async () => {
  const db = agentMemoryFirestore(), repository = createAgentConfigRepository({ db, timestampNow: () => new Date(0) });
  assert.equal(await repository.get(), null);
  const initial = await repository.save({ corporateQuantityThreshold: 9, version: null });
  const results = await Promise.allSettled([repository.save({ corporateQuantityThreshold: 10, version: initial.version }),
    repository.save({ corporateQuantityThreshold: 11, version: initial.version })]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const rejected = results.find(item => item.status === "rejected").reason;
  assert.equal(rejected.statusCode, 409); assert.equal(rejected.field, "corporateQuantityThreshold"); assert.equal(rejected.code, "CONFIGURACION_CAMBIO");
  assert.ok(rejected.message.includes(String((await repository.get()).corporateQuantityThreshold)));
  assert.equal((await repository.get()).corporateQuantityThreshold, 10);
});
test("controlador devuelve errores por campo y no altera la configuración rechazada", async () => {
  const repository = createAgentConfigRepository({ db: agentMemoryFirestore(), timestampNow: () => new Date(0) });
  const controller = createAgentConfigController(repository);
  const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } });
  const invalid = response(); await controller.save({ body: { corporateQuantityThreshold: 0, version: null } }, invalid);
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.body.field, "corporateQuantityThreshold"); assert.equal(await repository.get(), null);
  const first = response(); await controller.save({ body: { corporateQuantityThreshold: 8, version: null } }, first);
  assert.equal(first.body.config.corporateQuantityThreshold, 8);
  const conflict = response(); await controller.save({ body: { corporateQuantityThreshold: 12, version: null } }, conflict);
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.body.field, "corporateQuantityThreshold"); assert.equal((await repository.get()).corporateQuantityThreshold, 8);
});
