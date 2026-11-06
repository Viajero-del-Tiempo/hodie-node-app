import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { WHATSAPP_SEND_PAUSE_MS } from "../config/agent-whatsapp.config.js";

const deliveryError = (code, cause) => Object.assign(new Error("No se pudo entregar el mensaje"), { code, cause });
export const createWhatsAppSendQueue = () => ({ queues: new Map(), lastSentAt: new Map(), uncertainChats: new Set() });
// Inyecta Client/MessageMedia: importar este módulo nunca inicia WhatsApp.
export function createWhatsAppTransport({ client, MessageMedia, repository, getSignal = () => null,
  now = Date.now, pause = (ms, signal) => delay(ms, undefined, { signal }), fetchImpl = fetch,
  imageMaxBytes = 10 * 1024 * 1024, allowLocalImages = false, onSent = () => {}, logger = () => {}, beforeSend = async () => {},
  sendQueue = createWhatsAppSendQueue() }) {
  const { queues, lastSentAt, uncertainChats } = sendQueue, localQueues = new Map();
  const lifetime = new AbortController();
  let closed = false;
  async function downloadImage(source, signal) {
    const url = new URL(source);
    const local = allowLocalImages && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (!local && url.protocol !== "https:") throw deliveryError("IMAGE_URL_INVALID");
    const response = await fetchImpl(url, { signal, redirect: "error" });
    if (!response.ok || !/^image\/(jpeg|png|webp|gif)$/iu.test(response.headers.get("content-type")?.split(";")[0] ?? "")) throw deliveryError("IMAGE_DOWNLOAD_FAILED");
    if (Number(response.headers.get("content-length")) > imageMaxBytes) throw deliveryError("IMAGE_TOO_LARGE");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > imageMaxBytes) throw deliveryError("IMAGE_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw deliveryError("IMAGE_DOWNLOAD_FAILED");
    return new MessageMedia(response.headers.get("content-type").split(";")[0], Buffer.concat(chunks).toString("base64"));
  }
  function enqueue(chatId, type, build, metadata, options = {}) {
    const signal = AbortSignal.any([options.signal ?? getSignal(), lifetime.signal].filter(Boolean));
    let deliveryStarted = false;
    const task = (queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (closed) throw deliveryError("TRANSPORT_CLOSED");
      if (uncertainChats.has(chatId)) throw deliveryError("SEND_SEQUENCE_STOPPED");
      signal?.throwIfAborted();
      const elapsed = now() - (lastSentAt.get(chatId) ?? -Infinity);
      if (elapsed < WHATSAPP_SEND_PAUSE_MS) await pause(WHATSAPP_SEND_PAUSE_MS - elapsed, signal);
      signal?.throwIfAborted();
      if (closed) throw deliveryError("TRANSPORT_CLOSED");
      // Descarga cancelable antes de marcar iniciado el envío externo.
      const { content, sendOptions = {} } = await build(signal);
      signal?.throwIfAborted();
      const id = await repository.beginOutgoing(chatId, { type, origin: options.origin ?? "agent" });
      try {
        signal?.throwIfAborted();
        await beforeSend(chatId, { type, origin: options.origin ?? "agent" });
        await options.beforeSend?.();
        signal?.throwIfAborted();
      } catch (error) {
        await repository.finishOutgoing(id, { status: "cancelled", code: error.code ?? "PRE_SEND_CANCELLED" });
        throw error;
      }
      let sent;
      try {
        deliveryStarted = true;
        sent = await client.sendMessage(chatId, content, { ...sendOptions, sendSeen: false, appSignal: signal });
        lastSentAt.set(chatId, now());
        if (!sent?.id?._serialized) throw deliveryError("SEND_UNCERTAIN");
      } catch (error) {
        if (error.deliveryStarted === false) {
          await repository.finishOutgoing(id, { status: "cancelled", code: error.code ?? "PRE_SEND_CANCELLED" });
          throw error;
        }
        lastSentAt.set(chatId, now()); uncertainChats.add(chatId);
        // La API no permite demostrar que un rechazo no llegó a enviar.
        try { await repository.finishOutgoing(id, { status: "uncertain", code: error.code ?? "SEND_FAILED" }); }
        catch { logger({ code: "WHATSAPP_DELIVERY_RECORD_FAILED", type }); }
        logger({ code: "WHATSAPP_SEND_UNCERTAIN", type });
        throw deliveryError("SEND_UNCERTAIN", error);
      }
      try { await repository.finishOutgoing(id, { status: "accepted", whatsappMessageId: sent.id._serialized }); }
      catch (error) { uncertainChats.add(chatId); logger({ code: "WHATSAPP_DELIVERY_RECORD_FAILED", type }); throw deliveryError("SEND_UNCERTAIN", error); }
      signal?.throwIfAborted();
      if (closed) throw deliveryError("TRANSPORT_CLOSED");
      await onSent(chatId, { type, ...metadata });
      return sent;
    }).catch(error => {
      if (error.deliveryStarted === undefined) error.deliveryStarted = deliveryStarted;
      throw error;
    });
    queues.set(chatId, task);
    localQueues.set(chatId, task);
    task.finally(() => { if (queues.get(chatId) === task) queues.delete(chatId); }).catch(() => {});
    task.finally(() => { if (localQueues.get(chatId) === task) localQueues.delete(chatId); }).catch(() => {});
    return task;
  }
  return {
    beginTurn(chatId) { if (localQueues.has(chatId)) throw deliveryError("CONCURRENT_DELIVERY"); uncertainChats.delete(chatId); },
    sendText(chatId, text, options) { return enqueue(chatId, "text", async () => ({ content: text }), { text }, options); },
    sendImage(chatId, { source, caption, productId, packagingType, signal }) {
      return enqueue(chatId, "image", async activeSignal => ({ content: await downloadImage(source, activeSignal), sendOptions: { caption } }),
        { caption, productId, packagingType }, { signal });
    },
    sendPdf(chatId, path, order, options = {}) {
      return enqueue(chatId, "pdf", async signal => {
        const bytes = await readFile(path, { signal });
        if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw deliveryError("PDF_FILE_INVALID");
        return { content: new MessageMedia("application/pdf", bytes.toString("base64"),
          "pedido-" + String(order.orderNumber).replace(/[^\w-]/gu, "_") + ".pdf"), sendOptions: { sendMediaAsDocument: true } };
      }, {}, { ...options, origin: "order_pdf" });
    },
    close() { closed = true; lifetime.abort(deliveryError("TRANSPORT_CLOSED")); },
  };
}
