import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge, buildJudgePayload } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase } from "./helpers/eval-fixtures.js";
import { productsWithImages } from "./helpers/product-images-fixtures.js";
import { scriptedModel, reply } from "./helpers/consultation-fixtures.js";

test("runner y juez reciben evidencia pública de tres fotos, con producto/pie, sin repetirlas ni bytes", async () => {
  const payloads = [], judge = createStubJudge(), evaluate = judge.evaluate;
  judge.evaluate = input => { payloads.push(buildJudgePayload(input)); return evaluate(input); };
  const report = await runEvaluation(evalDataset([evalCase({ id: "PRODUCT-PHOTOS", turns: [
    { user: "Mostrame opciones" }, { user: "Recordame esas opciones" },
  ], expect: { must: ["Envía una foto de cada opción presentada."], tools_called: ["buscar_productos", "responder"], handoff: "no" } })], productsWithImages()), {
    judge, createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("buscar_productos", { consulta: "producto" }), messages => {
        const products = JSON.parse(messages.at(-1).content).products.slice(0, 3);
        return reply("responder", { texto: "Estas son algunas opciones.", cierre: "¿Querés ver más opciones?",
          entendido: true, productosMostrados: products.map(product => product.id) });
      }, reply("responder", { texto: "Seguimos con las mismas tres opciones.", entendido: true, productosMostrados: ["product-a", "product-b", "product-c"] }),
    ]) }),
  });
  assert.equal(payloads.length, 3); assert.equal(report.cases[0].repetitions.length, 3);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.turns[0].outgoing.map(message => message.type), ["text", "image", "image", "image", "text"]);
    assert.equal(run.turns[0].outgoing[0].text, "Estas son algunas opciones.");
    assert.equal(run.turns[0].outgoing.at(-1).text, "¿Querés ver más opciones?");
    assert.deepEqual(run.turns[0].outgoing.slice(1, -1).map(message => message.productId), ["product-a", "product-b", "product-c"]);
    assert.deepEqual(run.turns[1].outgoing.map(message => message.type), ["text", "text", "text", "text"]);
    assert.deepEqual(run.turns[1].outgoing.slice(1).map(message => message.text), ["Producto de prueba 1 — 100 Gs.", "Producto de prueba 2 — 200 Gs.", "Producto de prueba 3 — 300 Gs."]);
    assert.equal(run.tools.at(-1).result.productImages.skipped.length, 3);
    assert.equal(run.modelUsage.agent.calls, 3); assert.deepEqual(run.after.orders, run.before.orders);
  }
  for (const payload of payloads) {
    const photos = payload.conversation.filter(message => message.attachment?.mode === "sent");
    assert.deepEqual(photos.map(message => message.attachment.productId), ["product-a", "product-b", "product-c"]);
    assert.deepEqual(photos.map(message => message.attachment.caption), ["Producto de prueba 1 — 100 Gs.", "Producto de prueba 2 — 200 Gs.", "Producto de prueba 3 — 300 Gs."]);
    assert.ok(photos.every(message => message.attachment.type === "image" && message.attachment.data === undefined && message.eventId));
    assert.ok(payload.referenceData.catalog.products[0].variants[0].imageUrls.includes("https://example.test/a.png"));
    assert.equal(payload.agentPrompt, undefined); assert.equal(payload.checkpoint, undefined);
  }
});

test("runner admite un producto sin imágenes y no inventa evidencia de fotos", async () => {
  const fixtures = productsWithImages(); for (const product of fixtures.products) product.variants[0].imageUrls = [];
  const payloads = [], judge = createStubJudge(), evaluate = judge.evaluate;
  judge.evaluate = input => { payloads.push(buildJudgePayload(input)); return evaluate(input); };
  const report = await runEvaluation(evalDataset([evalCase({ id: "PRODUCT-NO-PHOTO" })], fixtures), {
    judge, createAgent: input => createAgent({ ...input, model: scriptedModel([reply("responder", {
      texto: "Esta es una opción.", entendido: true, productosMostrados: ["product-a"],
    })]) }),
  });
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.turns[0].outgoing.map(message => message.type), ["text", "text"]);
    assert.equal(run.turns[0].outgoing[1].text, "Producto de prueba 1 — 100 Gs.");
    assert.deepEqual(run.tools[0].result.productImages, { sent: [], skipped: [{ productId: "product-a", reason: "SIN_IMAGENES" }], failed: [],
      textOnly: [{ productId: "product-a", caption: "Producto de prueba 1 — 100 Gs." }] });
  }
  assert.ok(payloads.every(payload => !payload.conversation.some(message => message.attachment?.mode === "sent")));
});
