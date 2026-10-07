import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateOrderPDF } from "../src/services/pdf.service.js";
import { renderOrderBilling, renderOrderRecipient } from "../src/services/order-pdf-customer.service.js";
import { billingFixture, shippingFixture } from "./helpers/customer-fixtures.js";

function recorder() {
  const texts = [];
  const doc = { font() { return this; }, fontSize() { return this; }, moveDown() { return this; },
    text(value) { texts.push(value); return this; } };
  return { doc, texts };
}
test("PDF identifica consumidor final, históricos sin datos y solicitud con RUC", () => {
  for (const billing of [undefined, { invoiceRequested: false }, billingFixture({ ruc: "1234567-8", rucValidation: { status: "mismatch_confirmed", expectedDigit: 9 } })]) {
    const record = recorder();
    renderOrderBilling(record.doc, { billing });
    assert.ok(record.texts.some(text => text.includes("no es una factura")));
    if (!billing) assert.ok(record.texts.includes("Datos de facturación no registrados."));
    else if (!billing.invoiceRequested) assert.ok(record.texts.includes("Consumidor final."));
    else {
      assert.ok(record.texts.includes("RUC: 1234567-8"));
      assert.ok(record.texts.includes("Razón social: Persona de prueba Alfa"));
      assert.ok(record.texts.some(text => text.includes("no coincide")));
    }
  }
});
test("PDF solo imprime cédula para transportadora y usa destinatario del pedido", () => {
  for (const shippingMethod of ["local_gratis", "transportadora_contra_entrega"]) {
    const record = recorder();
    renderOrderRecipient(record.doc, { shippingMethod, shippingAddress: shippingFixture(), userDisplayName: "Titular diferente" });
    assert.ok(record.texts.includes("Destinatario: Destinatario Alfa"));
    assert.equal(record.texts.some(text => text.includes("Cédula")), shippingMethod === "transportadora_contra_entrega");
    assert.equal(record.texts.some(text => text.includes("Titular diferente")), false);
  }
});
test("genera PDF real con datos de la foto del pedido, sin red, y limpia el archivo de test", async () => {
  let path;
  const rendered = [];
  try {
    path = await generateOrderPDF({ orderNumber: "test-" + randomUUID(), createdAt: new Date(), userDisplayName: "Cliente Alfa", userPhoneNumber: "test-phone",
      shippingAddress: shippingFixture(), shippingMethod: "transportadora_contra_entrega", billing: billingFixture(),
      items: [{ productName: "Producto Alfa", productSku: "test-sku", quantity: 1, price: 10, selectedPackaging: null, imageUrl: "" }],
      subtotal: 10, shippingCost: 0, total: 10,
    }, { documentFactory(options) {
      const doc = new PDFDocument(options);
      const originalText = doc.text;
      doc.text = function(value, ...args) { rendered.push(value); return originalText.call(this, value, ...args); };
      return doc;
    }, loadImage: async () => { assert.fail("El caso sin imágenes no hace consultas de red"); } });
    assert.equal((await readFile(path)).subarray(0, 5).toString(), "%PDF-");
    assert.ok(rendered.includes("RUC: 1234567-9"));
    assert.ok(rendered.includes("Razón social: Persona de prueba Alfa"));
    assert.ok(rendered.some(value => typeof value === "string" && value.includes("no es una factura")));
  } finally { if (path && existsSync(path)) await unlink(path); }
});
