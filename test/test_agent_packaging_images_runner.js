import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge, buildJudgePayload } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalCase, evalDataset } from "./helpers/eval-fixtures.js";
import { packagingImagesFixtures, packagingPresentation as request } from "./helpers/packaging-images-fixtures.js";
import { scriptedModel, reply } from "./helpers/consultation-fixtures.js";

test("runner conserva packagingOptions.imageUrl y entrega al juez producto/empaque/pie, más texto cuando no hay foto", async () => {
  const judge = createStubJudge(), evaluate = judge.evaluate, payloads = [];
  judge.evaluate = input => { payloads.push(buildJudgePayload(input)); return evaluate(input); };
  const report = await runEvaluation(evalDataset([evalCase({ id: "PACKAGING-PHOTOS", turns: [
    { user: "Mostrame los empaques de este producto" }, { user: "Recordame el primero" },
  ], expect: { must: ["Muestra la foto del empaque y da texto para la opción sin foto."], tools_called: ["ver_producto", "responder"], handoff: "no" } })], packagingImagesFixtures()), {
    judge, createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("ver_producto", { productId: "product-a" }),
      reply("responder", { texto: "Estas son las opciones.", entendido: true, empaquesMostrados: [request("pack/a", "variant-b"), request("pack-c", "variant-b")] }),
      reply("responder", { texto: "El primer empaque sigue disponible.", entendido: true, empaquesMostrados: [request("pack/a", "variant-b")] }),
    ]) }),
  });
  assert.equal(payloads.length, 3);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.turns[0].outgoing.map(item => item.type), ["text", "text", "image"]);
    const photo = run.turns[0].outgoing[2];
    assert.equal(photo.productId, "product-a"); assert.equal(photo.packagingType, "pack/a"); assert.equal(photo.caption, "Producto Alfa con Empaque Alfa — 160 Gs.");
    assert.equal(run.turns[0].outgoing[1].text, "Producto Alfa con Empaque Gamma — 150 Gs.");
    assert.deepEqual(run.turns[1].outgoing.map(item => item.type), ["text"]);
    assert.equal(run.tools.at(-1).result.packagingImages.skipped[0].reason, "YA_ENVIADA"); assert.equal(run.modelUsage.agent.calls, 3);
    assert.deepEqual(run.before.orders, run.after.orders); assert.deepEqual(run.before.catalog, run.after.catalog);
  }
  for (const payload of payloads) {
    const photo = payload.conversation.find(item => item.attachment?.packagingType === "pack/a");
    assert.equal(photo.attachment.productId, "product-a"); assert.equal(photo.attachment.caption, "Producto Alfa con Empaque Alfa — 160 Gs.");
    assert.equal(photo.attachment.data, undefined); assert.ok(photo.eventId);
    assert.equal(payload.referenceData.catalog.products[0].packagingOptions[0].imageUrl, "https://example.test/foto-sin-convencion.png");
  }
});
