import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { productVersion, assertProductVersion } from "../src/utils/catalog-version.util.js";
import { createProductController } from "../src/controllers/admin.product.controller.js";
import { makeLocalEnvironment, assertLocalEnvironment, readProductionSecret } from "../scripts/local-catalog.config.js";
import { productFixture } from "./helpers/catalog-fixtures.js";

const snapshot = (product, nanoseconds = 1) => ({ id: product.id, data: () => product, updateTime: { seconds: 1700000000, nanoseconds } });
test("versión: identifica stock y otros campos, y conserva el borrador", async () => {
  const product = productFixture("test-category");
  const version = productVersion(snapshot(product));
  assertProductVersion(snapshot(product), version);
  const changed = structuredClone(product);
  changed.variants[0].stock = 0;
  changed.variants[0].price = 7;
  changed.packagingOptions = [{ type: "test-pack", name: "Empaque ficticio", price: 5 }];
  const draft = { ...product, version, name: "Nombre editado" };
  const before = structuredClone(draft);
  let conflict;
  try { assertProductVersion(snapshot(changed, 2), version); } catch (error) { conflict = error; }
  assert.equal(conflict.status, 409);
  assert.equal(conflict.field, "version");
  assert.equal(conflict.code, "CATALOG_VERSION_CONFLICT");
  assert.ok(conflict.changes.some(change => change.field === "packagingOptions"));
  assert.deepEqual(conflict.changes.find(change => change.field === "variants[0].stock"), {
    field: "variants[0].stock", variantId: product.variants[0].id,
    sku: product.variants[0].sku, previous: 1, current: 0,
  });
  assert.ok(conflict.changes.some(change => change.field === "variants[0].price" && change.current === 7));
  assert.ok(conflict.message.includes(product.variants[0].sku));
  assert.ok(conflict.message.includes("1 a 0"));
  const controller = createProductController({ updateProduct: async () => { throw conflict; } });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.update({ params: { id: product.id }, body: draft, method: "PUT" }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body.changes, conflict.changes);
  assert.deepEqual(draft, before);
  for (const invalid of [undefined, "", "test-invalid", productVersion(snapshot({ ...product, id: "test-other-product" }))]) {
    assert.throws(() => assertProductVersion(snapshot(product), invalid), error => error.status === 400 && error.field === "version");
  }
});

test("entorno local: secreto nuevo, sin reutilizar .env, proyecto y host obligatorios", () => {
  const options = { inherited: { JWT_SECRET: "test-inherited" }, productionSecret: "test-production" };
  const one = makeLocalEnvironment(options);
  const two = makeLocalEnvironment(options);
  assert.notEqual(one.JWT_SECRET, two.JWT_SECRET);
  assert.equal(one.JWT_SECRET, one.LOCAL_CATALOG_JWT_SECRET);
  assertLocalEnvironment(one, options.productionSecret);
  for (const secret of ["test-production", "test-inherited", ""]) {
    assert.throws(() => makeLocalEnvironment({ ...options, generateSecret: () => secret }));
  }
  for (const override of [
    { LOCAL_CATALOG_MODE: undefined }, { FIRESTORE_EMULATOR_HOST: undefined },
    { FIRESTORE_EMULATOR_HOST: "remote.example:8080" }, { GCLOUD_PROJECT: "test-real-project" },
    { JWT_SECRET: "test-production", LOCAL_CATALOG_JWT_SECRET: "test-production" },
    { JWT_SECRET: "test-different" },
  ]) assert.throws(() => assertLocalEnvironment({ ...one, ...override }, options.productionSecret));
});


test("la comparación del secreto usa el valor de JWT_SECRET leído de .env", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-catalog-env-"));
  try {
    await writeFile(join(directory, ".env"), "JWT_SECRET='test-env-secret'\n");
    const productionSecret = readProductionSecret(directory);
    assert.equal(productionSecret, "test-env-secret");
    assert.throws(() => makeLocalEnvironment({ inherited: {}, productionSecret, generateSecret: () => productionSecret }));
    assert.throws(() => assertLocalEnvironment({ LOCAL_CATALOG_MODE: "1", GCLOUD_PROJECT: "demo-hodie-catalogo",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", JWT_SECRET: productionSecret, LOCAL_CATALOG_JWT_SECRET: productionSecret }, productionSecret));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
