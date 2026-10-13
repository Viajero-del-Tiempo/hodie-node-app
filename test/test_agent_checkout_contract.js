import test from "node:test";
import assert from "node:assert/strict";
import { createOrderPricingService } from "../src/services/order-pricing.service.js";
import { createSignedImageUploader } from "../src/services/cloudinary.service.js";
import { pricingFixture } from "./helpers/order-fixtures.js";
import { validateOrderBilling } from "../src/validators/billing.validator.js";
import { validateShippingAddress } from "../src/services/shipping.service.js";

test("contrato web: foto, pendientes y precios existentes idénticos con y sin códigos del agente", async () => {
  const f = pricingFixture();
  const web = createOrderPricingService({ catalog: f.service });
  const agent = createOrderPricingService({ catalog: f.service, structuredErrors: true });
  const input = [{ ...f.item, packagingType: "test-pack" }];
  const expected = { sanitizedItems: [{ productId: f.product.id, productName: "Producto Alfa", variantId: f.item.variantId,
    variantLabel: "Ámbar · Liso", sku: f.product.variants[0].sku, productSku: f.product.variants[0].sku,
    quantity: 2, price: 17, selectedPackaging: { type: "test-pack", name: "Empaque Alfa", price: 5, imageUrl: "https://example.test/pack.png" },
    imageUrl: "https://example.test/variant.png", customizationPending: true, customizationImagePending: true }],
    subtotal: 44, shippingCost: 0, total: 44 };
  assert.deepEqual(await web(input), expected); assert.deepEqual(await agent(input), expected);
  // El checkout actual no envía declined: no aparece un campo nuevo ni cambia pendiente.
  assert.equal(Object.hasOwn((await web(input)).sanitizedItems[0], "customizationDeclined"), false);
  const declined = await agent([{ ...input[0], customizationDeclined: true }]);
  assert.deepEqual(declined, { ...expected, sanitizedItems: [{ ...expected.sanitizedItems[0],
    customizationDeclined: true, customizationPending: false, customizationImagePending: false }] });
  assert.deepEqual(await web(input), expected);
  const informational = await createOrderPricingService({ catalog: f.service, structuredErrors: true, includeLineSubtotals: true })(input);
  assert.deepEqual(informational, { ...expected, lineSubtotals: [44] });
  assert.deepEqual(await web(input), expected); // opt-in no agrega campos al checkout.
});
test("contrato web: errores conservan status, campo y mensajes exactos; detalles solo opt-in", async () => {
  const f = pricingFixture();
  const web = createOrderPricingService({ catalog: f.service });
  const agent = createOrderPricingService({ catalog: f.service, structuredErrors: true });
  for (const [change, field, message, code] of [
    [{ packagingType: "missing" }, "packagingType", "El empaque no está configurado para este producto.", "EMPAQUE_INEXISTENTE"],
    [{ quantity: 0 }, "quantity", "Cantidad inválida: debe ser un entero de 1 a 100 unidades por ítem.", "CANTIDAD_INVALIDA"],
    [{ customization: "x".repeat(21) }, "customization", "La personalización admite hasta 20 caracteres.", "TEXTO_DEMASIADO_LARGO"],
    [{ quantity: 9 }, "quantity", `Stock insuficiente para 'Producto Alfa', variante 'Ámbar · Liso' (SKU: ${f.product.variants[0].sku}). Disponibles: 8 unidades; solicitadas: 9.`, "SIN_STOCK"],
  ]) {
    await assert.rejects(web([{ ...f.item, ...change }]), error => {
      assert.equal(error.statusCode, 400); assert.equal(error.field, field); assert.equal(error.message, message);
      assert.equal(Object.hasOwn(error, "code"), false);
      assert.deepEqual(Object.keys(error).sort(), ["field", "name", "statusCode"]); return true;
    });
    await assert.rejects(agent([{ ...f.item, ...change }]), error => {
      assert.equal(error.statusCode, 400); assert.equal(error.field, field); assert.equal(error.message, message);
      assert.equal(error.code, code); return true;
    });
  }
});
test("contrato web temporal viejo y datos fiscales/envío conservan su comportamiento", async () => {
  const f = pricingFixture(); delete f.product.schemaVersion;
  f.product.price = 11; f.product.sku = "OLD-SKU"; f.product.packagingPrices = { "old-pack": 3 };
  const result = await createOrderPricingService({ catalog: f.service })([{ productId: f.product.id, quantity: "2", selectedPackaging: "old-pack" }]);
  assert.equal(result.total, 28); assert.equal(result.sanitizedItems[0].variantId, undefined);
  assert.equal(result.sanitizedItems[0].customizationPending, true);
  assert.deepEqual(validateOrderBilling(undefined), { invoiceRequested: false });
  assert.equal(validateOrderBilling({ invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-9" }).ruc, "1234567-9");
  assert.throws(() => validateOrderBilling({ invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567" }), { code: "RUC_COMPLETION_REQUIRED" });
  const address = { recipientName: "Persona Alfa", street: "Referencia Alfa", city: "Minga Guazú", department: "Zona Alfa", recipientDocument: "1234567" };
  assert.equal(validateShippingAddress(address).recipientDocument, undefined);
  assert.equal(validateShippingAddress({ ...address, city: "Ciudad Alfa" }).recipientDocument, "1234567");
});
test("contrato de subida firmada anterior mantiene parámetros; señal opcional cancela sin efectos tardíos", async () => {
  const requests = [];
  const uploader = createSignedImageUploader({ config: { cloudName: "test-cloud", apiKey: "test-key", apiSecret: "test-secret", folder: "test-folder" },
    now: () => 1000, newId: () => "test-id", fetchImpl: async (url, options) => {
      requests.push({ url, options }); return { ok: true, json: async () => ({ secure_url: "https://example.test/custom.png" }) };
    } });
  assert.equal(await uploader({ base64: "YWJj", mimetype: "image/png" }), "https://example.test/custom.png");
  assert.deepEqual(Object.keys(requests[0].options).sort(), ["body", "method"]);
  assert.equal(requests[0].options.body.get("public_id"), "custom_1000_testid");
  assert.equal(requests[0].options.body.has("upload_preset"), false); assert.ok(requests[0].options.body.get("signature"));
  const controller = new AbortController(); controller.abort(new Error("cancelado"));
  await assert.rejects(uploader({ base64: "YWJj", mimetype: "image/png" }, { signal: controller.signal }), /cancelado/);
  assert.equal(requests.length, 1);
});
