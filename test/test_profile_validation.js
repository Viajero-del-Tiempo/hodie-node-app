import test from "node:test";
import assert from "node:assert/strict";
import { createProfileService, normalizeProfileLists, validateProfileUpdate } from "../src/services/profile.service.js";
import { memoryCustomerStore, shippingFixture } from "./helpers/customer-fixtures.js";

test("IDs, predeterminados y whitelist del perfil", () => {
  const update = validateProfileUpdate({ displayName: "Cliente Alfa", addresses: [shippingFixture()],
    billingProfiles: [{ alias: "Personal", legalName: "Persona Alfa", ruc: "1234567", confirmedRuc: "1234567-9" }],
    uid: "otro", phoneNumber: "otro", role: "admin", active: false, profile_status: "complete",
  }, {}, { generateId: (() => { let sequence = 0; return () => `test-${++sequence}`; })() });
  assert.equal(update.addresses[0].id, "test-1");
  assert.equal(update.defaultAddressId, "test-1");
  assert.equal(update.defaultBillingProfileId, "test-2");
  assert.equal(update.billingProfiles[0].ruc, "1234567-9");
  for (const field of ["phoneNumber", "uid", "role", "active", "profile_status", "billingAddress"]) assert.equal(update[field], undefined);
  assert.throws(() => validateProfileUpdate({ addresses: [{ ...shippingFixture(), id: "inventado" }] }, {}), error => error.field === "addresses[0].id");
  assert.throws(() => validateProfileUpdate({ addresses: [shippingFixture()], defaultAddressId: "ajeno" }, {}));
});
test("direcciones antiguas se conservan y adquieren ID estable sin inventar destinatario", () => {
  const original = { addresses: [{ alias: "Antes", street: "Referencia", city: "Ciudad Alfa", department: "" }],
    billingAddress: { street: "Postal anterior", city: "Ciudad Alfa" } };
  const normalized = normalizeProfileLists(original);
  assert.equal(normalizeProfileLists(original).addresses[0].id, normalized.addresses[0].id);
  const update = validateProfileUpdate({ addresses: normalized.addresses, displayName: "Nuevo nombre" }, original);
  assert.equal(update.addresses[0].recipientName, "");
  assert.equal(update.defaultAddressId, normalized.addresses[0].id);
  assert.deepEqual(update.billingProfiles, []);
  assert.deepEqual(original.billingAddress, { street: "Postal anterior", city: "Ciudad Alfa" });
});
test("servicio guarda con versión, identifica conflicto y conserva el borrador", async () => {
  const store = memoryCustomerStore({ "users/test-user": { phoneNumber: "test-phone", displayName: "Inicial", role: "customer", active: true, addresses: [] } });
  const service = createProfileService(store);
  const first = await service.get("test-phone");
  const saved = await service.update("test-phone", { version: first.version, displayName: "Nombre nuevo", addresses: [shippingFixture()] });
  assert.notEqual(saved.version, first.version);
  assert.equal(saved.addresses.length, 1);
  const draft = { version: first.version, displayName: "Mi borrador" };
  const before = structuredClone(draft);
  await assert.rejects(service.update("test-phone", draft), error => error.statusCode === 409 && error.changes.some(change => change.field === "displayName"));
  assert.deepEqual(draft, before);
  assert.equal((await service.get("test-phone")).displayName, "Nombre nuevo");
  await assert.rejects(service.update("test-phone", { displayName: "Sin versión" }), error => error.field === "version");
});
test("guardar desde checkout agrega sin reemplazar y no duplica", async () => {
  const store = memoryCustomerStore({ "users/test-user": { phoneNumber: "test-phone", addresses: [{ id: "test-first", ...shippingFixture() }], defaultAddressId: "test-first" } });
  const service = createProfileService(store);
  const details = { shippingAddress: shippingFixture({ street: "Otra referencia" }), billing: { invoiceRequested: false }, saveShippingAddress: true };
  await service.saveCheckoutDetails("test-user", details);
  await service.saveCheckoutDetails("test-user", details);
  const result = await service.get("test-phone");
  assert.equal(result.addresses.length, 2);
  assert.equal(result.defaultAddressId, "test-first");
});
test("editar o borrar registros y conservar discrepancia aceptada solo si no cambia", () => {
  const current = { addresses: [{ id: "test-a", ...shippingFixture() }, { id: "test-b", ...shippingFixture({ street: "Otra" }) }], defaultAddressId: "test-a",
    billingProfiles: [{ id: "test-bill", alias: "Personal", legalName: "Persona Alfa", ruc: "1234567-8", rucValidation: { status: "mismatch_confirmed", expectedDigit: 9 } }] };
  const update = validateProfileUpdate({ addresses: [current.addresses[1]], billingProfiles: current.billingProfiles }, current);
  assert.equal(update.defaultAddressId, "test-b");
  assert.equal(update.billingProfiles[0].ruc, "1234567-8");
  assert.throws(() => validateProfileUpdate({ billingProfiles: [{ ...current.billingProfiles[0], ruc: "1234567-7" }] }, current), error => error.code === "RUC_DV_MISMATCH");
  const empty = validateProfileUpdate({ addresses: [], billingProfiles: [] }, current);
  assert.equal(empty.defaultAddressId, null); assert.equal(empty.defaultBillingProfileId, null);
});
