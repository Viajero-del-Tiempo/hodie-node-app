import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSignedImageUploader } from "../src/services/cloudinary.service.js";
import { createAdminImageController } from "../src/controllers/admin.image.controller.js";
import { validateCatalogImage, MAX_CATALOG_IMAGE_BYTES } from "../src/validators/catalog-image.validator.js";

const base64 = (await readFile(new URL("./fixtures/catalog-image.png", import.meta.url))).toString("base64");
test("subida firmada: contrato Cloudinary, carpetas y ausencia de preset/secreto en el body", async () => {
  const requests = [];
  const config = { cloudName: "test-cloud", apiKey: "test-key", apiSecret: "test-secret", folder: "test-customizations" };
  const upload = createSignedImageUploader({ config, now: () => 1700000000000, newId: () => "test-id",
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ secure_url: "https://example.test/image.png" }) }; },
  });
  assert.equal(await upload({ base64, mimetype: "image/png" }), "https://example.test/image.png");
  await upload({ base64, mimetype: "image/png" }, { folder: "test-catalog", prefix: "catalog" });
  for (const [index, request] of requests.entries()) {
    const folder = index ? "test-catalog" : "test-customizations";
    const prefix = index ? "catalog" : "custom";
    assert.equal(request.url, "https://api.cloudinary.com/v1_1/test-cloud/image/upload");
    assert.equal(request.options.method, "POST");
    const body = request.options.body;
    assert.equal(body.get("folder"), folder);
    assert.equal(body.get("api_key"), config.apiKey);
    assert.equal(body.get("public_id"), prefix + "_1700000000000_testid");
    assert.equal(body.get("signature"), createHash("sha1").update("folder=" + folder + "&public_id=" + prefix + "_1700000000000_testid&timestamp=1700000000test-secret").digest("hex"));
    assert.equal(body.has("api_secret"), false);
    assert.equal(body.has("upload_preset"), false);
    assert.equal(body.get("file"), "data:image/png;base64," + base64);
  }
});
test("imagen admin: valida contenido, MIME, tamaño y no sube archivos inválidos", async () => {
  const valid = validateCatalogImage({ base64, mimetype: "image/png" });
  assert.ok(valid.bytes.length > 0);
  let uploads = 0;
  const controller = createAdminImageController(async () => { uploads++; return "https://example.test/local.png"; });
  const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const ok = response();
  await controller({ body: { base64, mimetype: "image/png" } }, ok);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.imageUrl, "https://example.test/local.png");
  for (const [body, status, field] of [
    [{ base64: "invalid!", mimetype: "image/png" }, 400, "base64"],
    [{ base64, mimetype: "image/svg+xml" }, 400, "mimetype"],
    [{ base64, mimetype: "image/jpeg" }, 400, "base64"],
    [{ base64: Buffer.alloc(MAX_CATALOG_IMAGE_BYTES + 1).toString("base64"), mimetype: "image/png" }, 413, "base64"],
  ]) {
    const res = response();
    await controller({ body }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.field, field);
  }
  assert.equal(uploads, 1);
  const unavailable = createAdminImageController(async () => { throw Object.assign(new Error("test-secret-in-upstream"), { code: "CLOUDINARY_API_ERROR" }); });
  const res = response();
  await unavailable({ body: { base64, mimetype: "image/png" } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.field, "image");
  assert.equal(JSON.stringify(res.body).includes("test-secret"), false);
});
