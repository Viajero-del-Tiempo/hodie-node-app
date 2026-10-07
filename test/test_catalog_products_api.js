import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCatalogRepository } from "../src/services/catalog.repository.js";
import { createCatalogService } from "../src/services/catalog.service.js";
import { createOrderStockService } from "../src/services/order-stock.service.js";
import { newProductInput } from "./helpers/catalog-fixtures.js";
import { createTestScope, openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

test("API de productos nuevos, permisos, stock y unicidad transaccional", { timeout: 180000 }, async t => {
  const context = await openCatalogTestFirestore();
  const { db, Timestamp } = context;
  const scope = createTestScope(db);
  const originalSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET ||= scope.id("jwt");
    const [{ default: express }, { default: jwt }, { createAdminProductRouter }, { createAdminImageRouter },
      { JWT_SECRET }, { tokenBlacklist }] = await Promise.all([
      import("express"), import("jsonwebtoken"), import("../src/routes/admin.product.routes.js"),
      import("../src/routes/admin.image.routes.js"), import("../src/config/jwt.js"), import("../src/services/auth-session.service.js"),
    ]);
    const controlId = scope.id("catalog-writes");
    scope.track("counters", controlId);
    let productSequence = 0;
    const repository = createCatalogRepository(db, { timestampNow: () => Timestamp.now(), controlDocumentId: controlId,
      generateProductId: () => {
        const id = scope.id("product-" + (++productSequence));
        scope.track("products", id); // Registrar antes de la escritura, también si falla.
        return id;
      },
      generateVariantId: () => scope.id("variant-" + randomUUID()),
    });
    const service = createCatalogService({ repository });
    const categoryId = scope.id("category");
    await scope.track("categories", categoryId).set({ id: categoryId, name: "Categoría Alfa", order: 0, active: true });
    for (const role of ["admin", "customer"]) {
      const id = scope.id(role);
      await scope.track("users", id).set({ uid: id, role, phoneNumber: scope.id(role + "-phone"), active: true });
    }
    const token = jwt.sign({ phone: scope.id("admin-phone"), role: "customer" }, JWT_SECRET, { expiresIn: "1h" });
    const customerToken = jwt.sign({ phone: scope.id("customer-phone"), role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
    const app = express();
    let uploads = 0;
    app.use("/admin", createAdminImageRouter(async () => { uploads++; return "https://example.test/catalog.png"; }));
    app.use("/admin", createAdminProductRouter(service));
    app.use(express.json());
    server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const request = async (path, { method = "GET", body, auth = token, raw } = {}) => {
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/admin" + path, {
        method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer " + auth } : {}) },
        ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    let inputSequence = 0;
    const input = overrides => {
      const n = ++inputSequence;
      const product = newProductInput(categoryId, { name: "Producto Ficticio " + n, slug: scope.id("slug-" + n), ...overrides });
      product.variants[0].sku = scope.id("sku-" + n);
      product.variants[0].stock = 8;
      return product;
    };
    await t.test("cada ruta exige JWT y rol de Firestore, ignorando el rol del token", async () => {
      const revoked = jwt.sign({ phone: scope.id("admin-phone"), test: "revoked" }, JWT_SECRET);
      tokenBlacklist.add(revoked);
      try {
        for (const [method, path] of [
          ["GET", "/products"], ["GET", "/products/" + scope.id("missing")],
          ["POST", "/products"], ["PUT", "/products/" + scope.id("missing")],
          ["PATCH", "/products/" + scope.id("missing")], ["DELETE", "/products/" + scope.id("missing")],
          ["PATCH", "/products/" + scope.id("missing") + "/reactivate"], ["POST", "/images"],
        ]) {
          for (const [auth, status] of [
            [null, 401], ["test-invalid", 401], [revoked, 401], [customerToken, 403],
            [jwt.sign({ phone: scope.id("admin-phone") }, "test-foreign-secret"), 401],
          ]) assert.equal((await request(path, { method, auth, ...(["GET", "DELETE"].includes(method) ? {} : { body: {} }) })).status, status);
        }
        assert.equal((await request("/products")).status, 200); // Token dice customer, usuario real admin.
      } finally { tokenBlacklist.delete(revoked); }
    });
    await t.test("el rol se vuelve a consultar en cada petición", async () => {
      const ref = db.collection("users").doc(scope.id("admin"));
      try {
        await ref.update({ role: "customer" });
        assert.equal((await request("/products")).status, 403);
      } finally { await ref.update({ role: "admin" }); }
    });
    await t.test("alta/edición generan IDs, timestamps y derivados; nunca borran variantes", async () => {
      const payload = input();
      payload.variants.push({ ...payload.variants[0], sku: scope.id("inactive-sku"),
        options: { "test-axis": "Otra opción" }, price: 2, stock: 0, active: false });
      Object.assign(payload, { priceFrom: 999, skus: ["test-forged"], createdAt: 0 });
      const created = await request("/products", { method: "POST", body: payload });
      assert.equal(created.status, 201);
      const product = created.body.product;
      assert.equal(product.schemaVersion, 2);
      assert.equal(product.priceFrom, 1);
      assert.deepEqual(product.skus, payload.variants.map(variant => variant.sku));
      assert.ok(product.version);
      assert.ok(product.variants.every(variant => variant.id));
      const persisted = (await db.collection("products").doc(product.id).get()).data();
      assert.equal(Object.hasOwn(persisted, "version"), false);
      assert.ok(persisted.createdAt instanceof Timestamp);
      const removed = await request("/products/" + product.id, { method: "PUT", body: { ...product, variants: product.variants.slice(0, 1) } });
      assert.equal(removed.status, 400);
      assert.equal(removed.body.field, "variants");
      const edited = await request("/products/" + product.id, { method: "PUT", body: { ...product, name: "Producto Editado" } });
      assert.equal(edited.status, 200);
      assert.deepEqual(edited.body.product.variants.map(variant => variant.id), product.variants.map(variant => variant.id));
      const noVersion = await request("/products/" + product.id, { method: "PATCH", body: { name: "Otra edición" } });
      assert.equal(noVersion.status, 400);
      assert.equal(noVersion.body.field, "version");
      const current = edited.body.product;
      assert.equal((await service.getProduct(product.id)).id, product.id);
      assert.equal((await request("/products/" + product.id + "?force=true", { method: "DELETE", body: { version: current.version } })).status, 400);
      const disabled = await request("/products/" + product.id, { method: "DELETE", body: { version: current.version } });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.product.active, false);
      assert.equal(await service.getProduct(product.id), null);
      assert.equal((await db.collection("products").doc(product.id).get()).exists, true);
      const listed = await request("/products");
      assert.ok(listed.body.products.some(item => item.id === product.id && item.active === false));
      const activated = await request("/products/" + product.id + "/reactivate", { method: "PATCH", body: { version: disabled.body.product.version } });
      assert.equal(activated.status, 200);
      assert.equal((await service.getProduct(product.id)).id, product.id);
      const conflictInput = input();
      conflictInput.variants[0].sku = scope.id("inactive-sku");
      const conflict = await request("/products", { method: "POST", body: conflictInput });
      assert.equal(conflict.status, 400);
      assert.equal(conflict.body.field, "variants[0].sku");
    });
    await t.test("dos altas simultáneas con SKU o slug común dejan solo una", async () => {
      for (const field of ["sku", "slug"]) {
        const a = input();
        const b = input();
        if (field === "sku") b.variants[0].sku = a.variants[0].sku;
        else b.slug = a.slug;
        const results = await Promise.all([a, b].map(body => request("/products", { method: "POST", body })));
        assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
        assert.equal(results.find(result => result.status === 400).body.field, field === "sku" ? "variants[0].sku" : "slug");
        const query = field === "sku"
          ? db.collection("products").where("skus", "array-contains", a.variants[0].sku)
          : db.collection("products").where("slug", "==", a.slug);
        assert.equal((await query.get()).size, 1);
      }
    });
    await t.test("dos ediciones del mismo producto no pierden cambios", async () => {
      const created = (await request("/products", { method: "POST", body: input() })).body.product;
      const results = await Promise.all(["Edición Uno", "Edición Dos"].map(name =>
        request("/products/" + created.id, { method: "PUT", body: { ...created, name } })));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.ok(results.find(result => result.status === 409).body.changes.some(change => change.field === "name"));
    });
    await t.test("un pago cambia stock; el 409 explica unidades y deja pedido/draft intactos", async () => {
      const product = (await request("/products", { method: "POST", body: input() })).body.product;
      const orderId = scope.id("stock-order");
      const ref = scope.track("orders", orderId);
      await ref.set({ status: "pending", items: [{ productId: product.id, variantId: product.variants[0].id, quantity: 2 }] });
      const stock = createOrderStockService({ db, catalog: service, timestampNow: () => Timestamp.now(), warn: () => {} });
      await stock.transitionOrderStatus(orderId, "paid");
      const draft = { ...product, description: "Borrador todavía sin guardar" };
      const original = structuredClone(draft);
      const conflict = await request("/products/" + product.id, { method: "PUT", body: draft });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.field, "version");
      assert.ok(conflict.body.error.includes(product.variants[0].sku));
      assert.ok(conflict.body.error.includes("8 a 6"));
      assert.equal(conflict.body.changes.find(change => change.variantId).current, 6);
      assert.deepEqual(draft, original);
      const fresh = (await request("/products/" + product.id)).body.product;
      assert.equal(fresh.variants[0].stock, 6);
      assert.notEqual(fresh.description, draft.description);
      assert.equal((await ref.get()).data().status, "paid");
    });
    await t.test("documentos viejos no se convierten ni aparecen en el listado nuevo", async () => {
      const legacyId = scope.id("legacy-product");
      await scope.track("products", legacyId).set({ name: "Producto Viejo Ficticio", price: 5, stock: 2, sku: scope.id("legacy-sku"), active: true });
      const fetched = await request("/products/" + legacyId);
      assert.equal(fetched.status, 409);
      assert.equal(fetched.body.field, "schemaVersion");
      assert.equal((await request("/products")).body.products.some(product => product.id === legacyId), false);
      const payload = input();
      payload.variants[0].sku = scope.id("legacy-sku");
      assert.equal((await request("/products", { method: "POST", body: payload })).body.field, "variants[0].sku");
    });
    await t.test("imágenes: endpoint protegido y validación antes de subir", async () => {
      const base64 = (await readFile(new URL("./fixtures/catalog-image.png", import.meta.url))).toString("base64");
      const valid = await request("/images", { method: "POST", body: { base64, mimetype: "image/png" } });
      assert.equal(valid.status, 201);
      assert.equal(uploads, 1);
      const invalid = await request("/images", { method: "POST", body: { base64, mimetype: "text/plain" } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.field, "mimetype");
      const broken = await request("/images", { method: "POST", raw: "{" });
      assert.equal(broken.status, 400);
      assert.equal(broken.body.field, "body");
      assert.equal(uploads, 1);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (server) await new Promise(resolve => server.close(resolve));
    try { await scope.cleanup(); } finally { await context.close(); }
  }
});
