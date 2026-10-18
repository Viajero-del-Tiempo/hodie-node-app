import { randomUUID } from "node:crypto";
import { createWhatsAppDeliveryRepository } from "../../src/services/whatsapp-delivery.repository.js";
import { createWhatsAppTransport } from "../../src/services/whatsapp-transport.service.js";

// Simulación de Firestore sin SDK ni credenciales. Transacciones serializadas,
// escrituras diferidas y rollback; conserva Date para expiresAt.
export function whatsappMemoryDatabase() {
  const rows = new Map(); let queue = Promise.resolve();
  const copy = value => structuredClone(value);
  const ref = path => ({ path, id: path.split("/").at(-1),
    async get() { const value = rows.get(path); return { id: this.id, ref: this, exists: value !== undefined, data: () => copy(value) }; },
    async set(value, options = {}) { rows.set(path, copy(options.merge ? { ...rows.get(path), ...value } : value)); },
    async create(value) { if (rows.has(path)) throw new Error("Documento duplicado"); rows.set(path, copy(value)); },
    async update(value) { if (!rows.has(path)) throw new Error("Documento inexistente"); rows.set(path, { ...rows.get(path), ...copy(value) }); },
    async delete() { rows.delete(path); },
  });
  function collection(name, filters = [], order = null, count = Infinity) {
    return { doc: (id = randomUUID()) => ref(name + "/" + id),
      where: (field, op, value) => collection(name, [...filters, { field, op, value }], order, count),
      orderBy: (field, direction = "asc") => collection(name, filters, { field, direction }, count),
      limit: limit => collection(name, filters, order, limit),
      async get() {
        let selected = [...rows.entries()].filter(([path]) => path.startsWith(name + "/") && path.split("/").length === 2)
          .filter(([, value]) => filters.every(item => item.op === "==" && value[item.field] === item.value));
        if (order) selected.sort(([, a], [, b]) => (a[order.field] < b[order.field] ? -1 : a[order.field] > b[order.field] ? 1 : 0) * (order.direction === "desc" ? -1 : 1));
        const docs = await Promise.all(selected.slice(0, count).map(([path]) => ref(path).get()));
        return { docs, empty: !docs.length };
      },
    };
  }
  return { rows, collection,
    runTransaction(action) {
      const task = queue.catch(() => {}).then(async () => {
        const writes = [];
        const result = await action({
          async get(reference) { if (writes.length) throw new Error("Lectura posterior a escritura"); return reference.get(); },
          set(reference, value) { writes.push(() => reference.set(value)); },
          create(reference, value) { writes.push(() => reference.create(value)); },
        });
        const before = copy(rows);
        try { for (const write of writes) await write(); }
        catch (error) { rows.clear(); for (const [key, value] of before) rows.set(key, value); throw error; }
        return result;
      }); queue = task.catch(() => {}); return task;
    },
  };
}
export class FakeMessageMedia {
  constructor(mimetype, data, filename) { Object.assign(this, { mimetype, data, filename }); }
}
export function deliveryFixture({ db = whatsappMemoryDatabase(), fetchImpl, send, now: suppliedNow, pause: suppliedPause } = {}) {
  let time = Date.parse("2026-01-01T00:00:00Z");
  const outgoing = [], pauses = [];
  const now = suppliedNow ?? (() => time);
  const repository = createWhatsAppDeliveryRepository({ db, now, timestampFromMillis: value => new Date(value) });
  const client = { async sendMessage(chatId, content, options) {
    if (send) await send(chatId, content, options);
    outgoing.push({ chatId, content, options, at: now() });
    return { id: { _serialized: "own-" + outgoing.length } };
  } };
  const transport = createWhatsAppTransport({ client, MessageMedia: FakeMessageMedia, repository, now,
    pause: suppliedPause ?? (async ms => { pauses.push(ms); time += ms; }),
    fetchImpl: fetchImpl ?? (async () => new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "Content-Type": "image/png" } })),
  });
  return { db, repository, client, transport, outgoing, pauses, now, advance: ms => { time += ms; } };
}
export const incoming = (id, overrides = {}) => ({ from: "595900000001@c.us", type: "chat", body: "Hola", id: { _serialized: id }, ...overrides });
