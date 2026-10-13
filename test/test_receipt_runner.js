import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { receiptPng } from "./helpers/receipt-fixtures.js";
import { receiptAcknowledgement } from "../src/services/payment-receipt.repository.js";

test("runner registra comprobante sintético en tres repeticiones, acuse real, alerta durable y pedido intacto", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "RECEIPT-SYNTHETIC", context: { telefonoCliente: "595900000001" },
    turns: [{ user: "Voy a enviarte un comprobante" }, { user: "Este es el comprobante", attachment: "image" }],
    expect: { tools_called: ["registrar_comprobante"], handoff: "no" } })]), { judge: createStubJudge(),
    mediaResolver: async () => ({ data: receiptPng, mimeType: "image/png" }),
    createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("responder", { texto: "Envialo como imagen o PDF.", entendido: true }),
      reply("registrar_comprobante", { attachmentId: "attachment-2" }),
      reply("responder", { texto: "El modelo no puede confirmar pagos", entendido: true }),
    ]) }) });
  assert.equal(report.cases[0].repetitions.length, 3);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.equal(run.turns[1].outgoing[0].text, receiptAcknowledgement("test-order-a"));
    assert.deepEqual(run.after.orders, run.before.orders); assert.equal(run.after.paymentReceipts.length, 1);
    assert.equal(run.after.paymentReceipts[0].orderNumber, "test-order-a"); assert.equal(run.after.paymentReceipts[0].status, "associated");
    assert.equal(run.after.alertRequests.length, 1); assert.equal(run.after.alertRequests[0].delivered, false);
    assert.equal(run.modelUsage.agent.calls, 3);
    assert.equal(JSON.stringify(run.after.paymentReceipts).includes("publicId"), false);
  }
});
