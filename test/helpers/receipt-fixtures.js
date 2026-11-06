import { readFileSync } from "node:fs";
import { createMemoryWorld, createClock } from "../eval/memory-world.js";
import { createFakeWhatsApp } from "../eval/fake-whatsapp.js";
import { buildInitialState } from "../eval/initial-state.js";
import { evalFixtures } from "./eval-fixtures.js";
import { createReceiptTools } from "../../src/agents/consultation/receipt-tools.js";
import { createResponder } from "../../src/agents/consultation/terminal.js";
import { createToolRegistry } from "../../src/agents/consultation/tool-registry.js";
import { createPaymentReceiptConfig } from "../../src/services/payment-receipt.config.js";

export const receiptPng = readFileSync(new URL("../eval/media/o02-receipt.png", import.meta.url));
const content = "BT /F1 18 Tf 40 100 Td (COMPROBANTE FICTICIO - SIN DATOS PERSONALES) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream"];
let pdf = "%PDF-1.4\n"; const offsets = [];
for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += (index + 1) + " 0 obj\n" + object + "\nendobj\n"; }
const xref = pdf.length;
pdf += "xref\n0 6\n0000000000 65535 f \n" + offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")
  + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
export const receiptPdf = Buffer.from(pdf);
export function receiptFixture({ fixtures = evalFixtures(), context = { telefonoCliente: "595900000001" }, receiptFaults = {}, receiptConfig = createPaymentReceiptConfig({}) } = {}) {
  const clock = createClock(1000000), transport = createFakeWhatsApp();
  const world = createMemoryWorld(fixtures, { clock, transport, receiptFaults });
  world.initialize(buildInitialState(context, fixtures, { chatId: "receipt-test@lid", now: clock.now() }));
  let turn = { id: "turn-1" }; const attachments = new Map();
  const runtime = { now: clock.now, getState: world.getState, setState: world.setState, transport,
    receiptRepository: world.receiptRepository, receiptStorage: world.receiptStorage, receiptConfig,
    getTurnContext: () => turn, getTurnAttachment: id => attachments.get(id) ?? null };
  const registry = createToolRegistry({ ...createReceiptTools(runtime), responder: createResponder(runtime) });
  world.setToolGate(registry.check);
  for (const name of ["registrar_comprobante", "responder"]) world.registerTool(name, (args, context) => registry.dispatch(name, args, context), { real: true });
  world.beginTurn(1, new AbortController().signal);
  attachments.set("file", { data: receiptPng, mimeType: "image/png", filename: "comprobante-ficticio.png" });
  return { world, runtime, clock, transport, attachments,
    call: (name, args = {}) => world.invokeTool(name, args),
    nextTurn() { turn = { id: "turn-2" }; attachments.clear(); world.beginTurn(2, new AbortController().signal); },
    close: world.close };
}
