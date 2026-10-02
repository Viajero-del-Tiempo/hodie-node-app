import test from "node:test";
import assert from "node:assert/strict";
import { createTestScope, openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

test("API de catálogo con middlewares reales y Firestore aislado por ejecución", async t => {
  const context = await openCatalogTestFirestore();
  const scope = createTestScope(context.db);
  let server;
  let tokenBlacklist;
  let revokedToken;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  try {
    process.env.JWT_SECRET ||= scope.id("jwt-secret");
    // Auth importa el grafo actual, que construye modelos al cargar módulos.
    // Este placeholder permite cargarlo sin credenciales reales; no se invoca.
    process.env.GEMINI_API_KEY ||= scope.id("unused-llm-key");
    // Los imports de rutas se hacen después de la protección de Firestore.
    const [{ default: express }, { default: jwt }, { router: categories }, { router: policies }, auth, { JWT_SECRET }] = await Promise.all([
      import("express"), import("jsonwebtoken"),
      import("../src/routes/admin.category.routes.js"), import("../src/routes/admin.policy.routes.js"),
      import("../src/controllers/auth.controller.js"), import("../src/config/jwt.js"),
    ]);
    tokenBlacklist = auth.tokenBlacklist;
    const adminPhone = scope.id("admin-phone");
    const customerPhone = scope.id("customer-phone");
    for (const [suffix, phone, role] of [["admin", adminPhone, "admin"], ["customer", customerPhone, "customer"]]) {
      const id = scope.id(suffix);
      await scope.track("users", id).set({ uid: id, phoneNumber: phone, role, active: true, displayName: id });
    }
    const adminToken = jwt.sign({ phone: adminPhone }, JWT_SECRET, { expiresIn: "1h" });
    const customerToken = jwt.sign({ phone: customerPhone }, JWT_SECRET, { expiresIn: "1h" });
    const expiredToken = jwt.sign({ phone: adminPhone }, JWT_SECRET, { expiresIn: -1 });
    revokedToken = jwt.sign({ phone: adminPhone, testRun: scope.id("revoked") }, JWT_SECRET, { expiresIn: "1h" });
    tokenBlacklist.add(revokedToken);
    const app = express();
    app.use(express.json());
    app.use("/admin", categories);
    app.use("/admin", policies);
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      listening.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/admin`;
    const request = async (path, { method = "GET", body, token = adminToken } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const categoryId = scope.id("category");
    const policyId = scope.id("policy");
    scope.track("categories", categoryId);
    scope.track("policies", policyId);

    await t.test("todas las rutas requieren autenticación y rol admin", async () => {
      for (const resource of ["categories", "policies"]) {
        for (const [method, suffix] of [["GET", ""], ["GET", `/${scope.id("missing")}`], ["POST", ""], ["PUT", `/${scope.id("missing")}`], ["PATCH", `/${scope.id("missing")}`], ["DELETE", `/${scope.id("missing")}`]]) {
          for (const [token, status] of [[null, 401], ["test-invalid-token", 401], [expiredToken, 401], [revokedToken, 401], [customerToken, 403]]) {
            assert.equal((await request(`/${resource}${suffix}`, { method, token, ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: {} } : {}) })).status, status);
          }
        }
      }
    });

    await t.test("categorías: CRUD, validación por campo, conflictos y soft-delete", async () => {
      const input = { id: categoryId, name: scope.id("category-name"), order: 1 };
      const created = await request("/categories", { method: "POST", body: input });
      assert.equal(created.status, 201);
      assert.equal(created.body.category.id, categoryId);
      assert.equal((await request(`/categories/${categoryId}`)).status, 200);
      assert.equal((await request("/categories")).body.categories.some(category => category.id === categoryId), true);
      assert.equal((await request("/categories", { method: "POST", body: input })).status, 409);
      const invalid = await request(`/categories/${categoryId}`, { method: "PUT", body: { order: "1" } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.field, "order");
      assert.equal((await request(`/categories/${categoryId}`, { method: "PUT", body: { id: scope.id("changed") } })).body.field, "id");
      const updated = await request(`/categories/${categoryId}`, { method: "PATCH", body: { name: scope.id("updated-name") } });
      assert.equal(updated.status, 200);
      assert.equal((await request(`/categories/${categoryId}`)).body.category.name, updated.body.category.name);
      const productId = scope.id("product");
      const productRef = scope.track("products", productId);
      await productRef.set({ id: productId, name: scope.id("product-name"), categoryId, active: true });
      assert.equal((await request(`/categories/${categoryId}`, { method: "DELETE" })).status, 409);
      await productRef.update({ active: false });
      const deleted = await request(`/categories/${categoryId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.category.active, false);
      assert.equal(deleted.body.softDeleted, true);
      assert.equal((await request(`/categories/${categoryId}`, { method: "PUT", body: { active: true } })).status, 200);
      assert.equal((await request(`/categories/${scope.id("missing")}`)).status, 404);
      assert.equal((await request(`/categories/${scope.id("missing")}`, { method: "DELETE" })).status, 404);
    });

    await t.test("políticas: CRUD, IDs estables y timestamp manipulado descartado", async () => {
      const input = { id: policyId, title: scope.id("title"), text: scope.id("text"), updatedAt: "test-client" };
      assert.equal((await request("/policies", { method: "POST", body: input })).status, 201);
      assert.equal((await request("/policies", { method: "POST", body: input })).status, 409);
      assert.equal((await request("/policies")).body.policies.some(policy => policy.id === policyId), true);
      const invalid = await request(`/policies/${policyId}`, { method: "PATCH", body: { text: " " } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.field, "text");
      assert.equal((await request(`/policies/${policyId}`, { method: "PUT", body: { id: scope.id("changed") } })).body.field, "id");
      const updatedText = scope.id("updated-text");
      assert.equal((await request(`/policies/${policyId}`, { method: "PUT", body: { text: updatedText, updatedAt: 0 } })).status, 200);
      assert.equal((await request(`/policies/${policyId}`)).body.policy.text, updatedText);
      assert.equal((await context.db.collection("policies").doc(policyId).get()).data().updatedAt instanceof context.Timestamp, true);
      assert.equal((await request(`/policies/${policyId}`, { method: "DELETE" })).status, 200);
      assert.equal((await request(`/policies/${policyId}`)).status, 404);
      assert.equal((await request(`/policies/${policyId}`, { method: "DELETE" })).status, 404);
    });
  } finally {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (tokenBlacklist && revokedToken) tokenBlacklist.delete(revokedToken);
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      try { await scope.cleanup(); } finally { await context.close(); }
    }
  }
});
