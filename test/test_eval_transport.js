import test from "node:test";
import assert from "node:assert/strict";
import { createFakeWhatsApp } from "./eval/fake-whatsapp.js";

test("entrega ráfaga ordenada como un único turno y captura todos los envíos", async () => {
  const transport = createFakeWhatsApp();
  try {
    const turn = await transport.receive({ user: "Primero", burst: ["Segundo", "Tercero"] }, 1, "TEST");
    assert.deepEqual(turn.messages.map(message => message.text), ["Primero", "Segundo", "Tercero"]);
    transport.beginTurn(1);
    await transport.sendText("Respuesta");
    await transport.sendImage({ source: "memory://image-a", caption: "Imagen" });
    assert.deepEqual(transport.getOutgoing().map(message => [message.turn, message.type]), [[1, "text"], [1, "image"]]);
  } finally { transport.close(); }
});
test("audio llega como transcripción literal y documentos solo como metadatos", async () => {
  const transport = createFakeWhatsApp();
  try {
    const audio = await transport.receive({ user: "Mensaje hablado", attachment: "audio" }, 1, "TEST");
    assert.equal(audio.messages[0].text, "[audio transcripto] Mensaje hablado");
    assert.equal(audio.attachments[0].mode, "transcribed");
    const document = await transport.receive({ user: "Adjunto", attachment: "document", filename: "test.pdf" }, 2, "TEST");
    assert.equal(document.attachments[0].filename, "test.pdf");
    assert.equal(transport.getAttachment(document.attachments[0].id), null);
  } finally { transport.close(); }
});
test("imágenes descriptivas se identifican y los adjuntos vencen al terminar el turno", async () => {
  const transport = createFakeWhatsApp();
  try {
    const turn = await transport.receive({ user: "Descripción ficticia", attachment: "image" }, 1, "TEST");
    assert.equal(turn.attachments[0].mode, "described");
    assert.equal(transport.getAttachment(turn.attachments[0].id).description, "Descripción ficticia");
    transport.endTurn();
    assert.equal(transport.getAttachment(turn.attachments[0].id), null);
  } finally { transport.close(); }
});
test("bytes de una imagen real solo están en el almacén efímero, no en el turno serializable", async () => {
  const bytes = Buffer.from([1, 2, 3]);
  const transport = createFakeWhatsApp({ mediaResolver: async () => ({ data: bytes, mimeType: "image/png" }) });
  try {
    const turn = await transport.receive({ user: "Imagen", attachment: "image" }, 1, "TEST");
    assert.equal(turn.attachments[0].mode, "file");
    assert.equal(turn.attachments[0].data, undefined);
    const attachment = transport.getAttachment(turn.attachments[0].id);
    assert.deepEqual(attachment.data, bytes);
    attachment.data[0] = 99;
    assert.equal(transport.getAttachment(turn.attachments[0].id).data[0], 1);
    transport.endTurn();
    assert.equal(transport.getAttachment(turn.attachments[0].id), null);
  } finally { transport.close(); }
});
