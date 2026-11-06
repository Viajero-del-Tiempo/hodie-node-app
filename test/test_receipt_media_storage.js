import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMediaPreparer } from "../src/agents/guardian/media.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { createTurnAttachments } from "../src/agents/guardian/attachments.js";
import { createPrivateReceiptStorage } from "../src/services/payment-receipt.storage.js";
import { receiptPng, receiptPdf } from "./helpers/receipt-fixtures.js";

test("guardián valida MIME/firma/tamaño PDF, cuenta total y nunca lo manda al modelo", async () => {
  const large = Buffer.alloc(5 * 1024 * 1024, 32); receiptPdf.copy(large); large.write("%%EOF\n", large.length - 6);
  const config = createGuardianConfig(), registry = createTurnAttachments();
  const entries = { a: { data: large, mimeType: "application/pdf" }, b: { data: large, mimeType: "application/pdf" },
    c: { data: receiptPdf, mimeType: "application/pdf" } };
  const descriptors = Object.keys(entries).map(id => ({ id, type: "document", mimeType: "application/pdf", filename: "prueba.pdf" }));
  const media = createMediaPreparer({ config, getAttachment: id => entries[id] });
  try {
    const turn = await media.prepare({ messages: [], attachments: descriptors }, { registry });
    assert.equal(turn.mediaBytes, 10 * 1024 * 1024); assert.equal(turn.imageInputs.length, 0);
    assert.equal(registry.get("a").data.length, large.length); assert.equal(registry.get("c"), null);
    assert.equal(turn.mediaIssues[0].code, "MEDIA_SIZE_LIMIT"); assert.equal(media.getModelUsage().calls, 0);
  } finally { registry.close(); }
  for (const [data, mimeType, expected] of [[Buffer.from("no es PDF"), "application/pdf", "PDF_SIGNATURE_INVALID"],
    [receiptPdf, "text/plain", "MEDIA_TYPE_UNSUPPORTED"], [Buffer.alloc(config.pdfMaxBytes + 1), "application/pdf", "MEDIA_SIZE_LIMIT"]]) {
    const registry = createTurnAttachments();
    const media = createMediaPreparer({ config, getAttachment: () => ({ data, mimeType }) });
    const turn = await media.prepare({ messages: [], attachments: [{ id: "d", type: "document", mimeType: "application/pdf" }] }, { registry });
    assert.equal(turn.mediaIssues[0].code, expected); assert.equal(registry.get("d"), null); registry.close();
  }
});
test("Cloudinary raw/authenticated: firma subida/borrado, descarga interna limitada y no devuelve URL", async () => {
  const config = { cloudName: "fixture-cloud", apiKey: "fixture-key", apiSecret: "fixture-secret" }; const calls = [];
  const storage = createPrivateReceiptStorage({ config, now: () => 1000000, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/upload")) {
      assert.equal(options.body.get("type"), "authenticated"); assert.equal(options.body.get("overwrite"), "false"); assert.equal(options.body.get("backup"), "false");
      const params = ["backup", "overwrite", "public_id", "timestamp", "type"].map(key => key + "=" + options.body.get(key)).join("&");
      assert.equal(options.body.get("signature"), createHash("sha1").update(params + config.apiSecret).digest("hex"));
      return Response.json({ resource_type: "raw", type: "authenticated", public_id: options.body.get("public_id"), secure_url: "https://irrelevante.invalid" });
    }
    if (url.includes("/destroy")) { assert.equal(options.body.get("type"), "authenticated"); return Response.json({ result: "ok" }); }
    const query = new URL(url).searchParams;
    assert.equal(query.get("type"), "authenticated"); assert.equal(query.get("expires_at"), "1060"); assert.equal(query.has("format"), false);
    return new Response(receiptPng);
  } });
  const asset = storage.descriptor("a".repeat(64), "png");
  assert.equal(await storage.put(asset, { data: receiptPng, mimeType: "image/png", filename: "prueba.png" }), undefined);
  assert.deepEqual(await storage.read(asset), receiptPng); await storage.delete(asset);
  assert.ok(calls.every(call => call.url.startsWith("https://api.cloudinary.com/") && call.options.redirect === "error"));
  assert.equal(JSON.stringify(asset).includes("https:"), false);
  const publicUpload = createPrivateReceiptStorage({ config, fetchImpl: async () => Response.json({ resource_type: "raw", type: "upload" }) });
  await assert.rejects(publicUpload.put(asset, { data: receiptPng, mimeType: "image/png", filename: "prueba.png" }));
  const oversized = createPrivateReceiptStorage({ config, fetchImpl: async () => new Response(Buffer.alloc(6 * 1024 * 1024)) });
  await assert.rejects(oversized.read(asset));
});
