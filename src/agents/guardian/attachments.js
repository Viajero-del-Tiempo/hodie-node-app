export function createTurnAttachments() {
  const entries = new Map();
  let closed = false;
  return {
    put(id, { data, mimeType }) {
      if (closed) throw new Error("Adjuntos del turno cerrados");
      if (!id || !Buffer.isBuffer(data) || !data.length || typeof mimeType !== "string") throw new Error("Adjunto inválido");
      entries.set(id, { data: Buffer.from(data), mimeType });
    },
    get(id) {
      const item = entries.get(id);
      return closed || !item ? null : { ...item, data: Buffer.from(item.data) };
    },
    close() { entries.clear(); closed = true; },
  };
}
export function assertCheckpointState(state) {
  function walk(value, key = "") {
    if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) throw new Error("Bytes fuera del turno: " + key);
    if (!value || typeof value !== "object") return;
    for (const [name, item] of Object.entries(value)) {
      if (["attachmentId", "imageInputs", "inputParts", "base64"].includes(name)) throw new Error("Dato efímero en checkpoint: " + name);
      walk(item, name);
    }
  }
  walk(state);
  if (!Array.isArray(state.messages) || state.messages.some(message =>
    typeof message.content !== "string" || !["user", "assistant"].includes(message.role))) throw new Error("Historial persistido inválido");
  return state;
}
