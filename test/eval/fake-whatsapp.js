export function createFakeWhatsApp({ mediaResolver = null } = {}) {
  const outgoing = [];
  const attachments = new Map();
  let currentTurn = 0;
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("El transporte está cerrado"); };
  return {
    beginTurn(turn) { assertOpen(); currentTurn = turn; },
    async receive(input, turn, caseId) {
      assertOpen();
      attachments.clear();
      const messages = [input.user, ...(input.burst ?? [])].map(text => ({ text, type: "text" }));
      const metadata = [];
      if (input.attachment) {
        const id = "attachment-" + turn;
        const type = input.attachment;
        const descriptor = { id, type, filename: input.filename ?? null };
        if (type === "audio") {
          descriptor.mode = "transcribed";
          messages[0].text = "[audio transcripto] " + input.user;
        } else if (type === "image") {
          const media = await mediaResolver?.({ caseId, turn });
          if (media) {
            descriptor.mode = "file";
            descriptor.mimeType = media.mimeType;
            descriptor.size = media.data.length;
            attachments.set(id, { ...descriptor, data: Buffer.from(media.data) });
          } else {
            descriptor.mode = "described";
            descriptor.description = input.user;
            attachments.set(id, { ...descriptor });
          }
        } else {
          // Documentos/archivos: solo tipo y nombre, nunca contenido binario.
          descriptor.mode = "metadata";
        }
        messages[0].type = type;
        messages[0].attachmentId = id;
        metadata.push(descriptor);
      }
      return { turn, messages, attachments: metadata };
    },
    getAttachment(id) {
      const attachment = attachments.get(id);
      if (!attachment) return null;
      return { ...attachment, ...(attachment.data ? { data: Buffer.from(attachment.data) } : {}) };
    },
    endTurn() { attachments.clear(); },
    async sendText(text) {
      assertOpen();
      if (typeof text !== "string" || !text.trim()) throw new Error("Mensaje saliente vacío");
      outgoing.push({ id: "send-" + (outgoing.length + 1), turn: currentTurn, type: "text", text });
    },
    async sendImage({ source, caption = "" }) {
      assertOpen();
      if (typeof source !== "string" || !source) throw new Error("Falta la fuente de la imagen");
      outgoing.push({ id: "send-" + (outgoing.length + 1), turn: currentTurn, type: "image", source, caption });
    },
    getOutgoing: () => structuredClone(outgoing),
    close() { attachments.clear(); closed = true; },
  };
}
