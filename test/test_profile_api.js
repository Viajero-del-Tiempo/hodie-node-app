import test from "node:test";
import assert from "node:assert/strict";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { shippingFixture } from "./helpers/customer-fixtures.js";

test("perfil propio: CRUD, predeterminados, whitelist y concurrencia real", async t => {
  const api = await openCustomerTestApi();
  try {
    const a = await api.createUser("user-a", { billingAddress: { street: "Postal anterior", city: "Ciudad Alfa" } });
    const b = await api.createUser("user-b");
    const get = async phone => (await api.request("/users/me", { phone })).body.user;
    const put = async body => api.request("/users/me", { phone: a.phoneNumber, method: "PUT", body });
    let profile = await get(a.phoneNumber);
    await t.test("agregar direcciones y facturación no cambia teléfono ni rol", async () => {
      const result = await put({ version: profile.version, displayName: "Nombre editado", addresses: [shippingFixture(), shippingFixture({ street: "Otra referencia" })],
        billingProfiles: [{ alias: "Personal", legalName: "Persona Alfa", ruc: "1234567-9" }, { alias: "Empresa", legalName: "Entidad Alfa", ruc: "12345678-9" }],
        uid: b.uid, phoneNumber: b.phoneNumber, role: "admin", active: false, billingAddress: { street: "No reemplazar" } });
      assert.equal(result.status, 200);
      profile = result.body.user;
      assert.equal(profile.addresses.length, 2); assert.equal(profile.billingProfiles.length, 2);
      assert.equal(profile.defaultAddressId, profile.addresses[0].id);
      assert.equal(profile.defaultBillingProfileId, profile.billingProfiles[0].id);
      const saved = (await api.db.collection("users").doc(a.uid).get()).data();
      assert.equal(saved.phoneNumber, a.phoneNumber); assert.equal(saved.role, "customer"); assert.equal(saved.active, true);
      assert.deepEqual(saved.billingAddress, { street: "Postal anterior", city: "Ciudad Alfa" });
      assert.equal((await get(b.phoneNumber)).displayName, "Cliente Alfa");
    });
    await t.test("editar, seleccionar predeterminados y borrar", async () => {
      const addresses = structuredClone(profile.addresses); addresses[1].street = "Referencia editada";
      const result = await put({ version: profile.version, addresses, defaultAddressId: addresses[1].id, defaultBillingProfileId: profile.billingProfiles[1].id });
      assert.equal(result.status, 200); profile = result.body.user;
      assert.equal(profile.defaultAddressId, addresses[1].id); assert.equal(profile.addresses[1].street, "Referencia editada");
      const removed = await put({ version: profile.version, addresses: [profile.addresses[0]], billingProfiles: [] });
      assert.equal(removed.status, 200); profile = removed.body.user;
      assert.equal(profile.defaultAddressId, profile.addresses[0].id); assert.equal(profile.defaultBillingProfileId, null);
    });
    await t.test("dos ediciones simultáneas: una guarda y otra conserva su borrador con 409", async () => {
      const before = await get(a.phoneNumber);
      const drafts = [{ version: before.version, displayName: "Nombre Uno" }, { version: before.version, displayName: "Nombre Dos" }];
      const copies = structuredClone(drafts);
      const results = await Promise.all(drafts.map(put));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      const conflict = results.find(result => result.status === 409).body;
      assert.equal(conflict.code, "PROFILE_VERSION_CONFLICT"); assert.equal(conflict.field, "version");
      assert.ok(conflict.changes.some(change => change.field === "displayName"));
      assert.deepEqual(drafts, copies);
    });
    await t.test("sesión, campos e IDs ajenos", async () => {
      assert.equal((await api.request("/users/me")).status, 401);
      assert.equal((await api.request("/users/me", { rawToken: "inválido" })).status, 401);
      const current = await get(a.phoneNumber);
      const invalid = await put({ version: current.version, addresses: [{ ...shippingFixture(), recipientName: "" }] });
      assert.equal(invalid.status, 400); assert.equal(invalid.body.field, "addresses[0].recipientName");
      assert.equal((await put({ version: current.version, addresses: [{ ...shippingFixture(), id: b.uid }] })).status, 400);
      await api.db.collection("users").doc(a.uid).update({ uid: b.uid });
      assert.equal((await api.request("/test/identity", { phone: a.phoneNumber })).body.uid, a.uid);
      await api.db.collection("users").doc(a.uid).update({ uid: a.uid });
    });
    await t.test("consulta de RUC propone número completo sin guardar ni confirmar por su cuenta", async () => {
      const before = await get(a.phoneNumber);
      const proposal = await api.request("/users/me/ruc/validate", { phone: a.phoneNumber, method: "POST", body: { ruc: "1234567" } });
      assert.equal(proposal.body.suggestedRuc, "1234567-9"); assert.equal(proposal.body.requiresConfirmation, true);
      assert.deepEqual(await get(a.phoneNumber), before);
      const pending = await put({ version: before.version, billingProfiles: [{ legalName: "Persona Alfa", ruc: "1234567" }] });
      assert.equal(pending.status, 400); assert.equal(pending.body.code, "RUC_COMPLETION_REQUIRED");
    });
  } finally { await api.close(); }
});
