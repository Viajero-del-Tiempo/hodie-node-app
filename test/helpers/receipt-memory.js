import { fingerprint } from "../../src/services/cart.service.js";

// Simula únicamente Firestore. La selección y asociación usan el repositorio real.
export function receiptMemoryDatabase({ orders, receipts, alerts, faults = {}, assertOpen = () => {} }) {
  const stores = { orders, payment_receipts: receipts, agent_alerts: alerts }; let queue = Promise.resolve();
  const store = name => { if (!stores[name]) throw new Error("Colección no simulada: " + name); return stores[name]; };
  const values = name => store(name).list();
  const byId = (name, id) => values(name).find(row => (row.id ?? row.orderNumber) === id) ?? null;
  const ref = (name, id) => ({ id, name, path: name + "/" + id, get: async () => snapshot(name, id) });
  const snapshot = (name, id) => { const value = byId(name, id); return { id, ref: ref(name, id), exists: value !== null, data: () => structuredClone(value ?? undefined) }; };
  function query(name, conditions = [], limit = Infinity) {
    return { name, conditions, limitCount: limit,
      doc: id => ref(name, id),
      where: (key, op, value) => query(name, [...conditions, { key, op, value }], limit),
      limit: count => query(name, conditions, count),
      async get() {
        assertOpen(); const rows = values(name).filter(row => conditions.every(({ key, op, value }) => op === "==" ? row[key] === value
          : op === "in" ? value.includes(row[key]) : op === "<=" ? row[key] !== null && row[key] <= value : false)).slice(0, limit);
        return { empty: !rows.length, docs: rows.map(row => snapshot(name, row.id ?? row.orderNumber)) };
      },
    };
  }
  const db = { collection: name => query(name),
    runTransaction(action) {
      const task = queue.catch(() => {}).then(async () => {
        assertOpen(); const writes = [], reads = [];
        const result = await action({ async get(value) {
          if (writes.length) throw new Error("Lectura después de escribir");
          const snap = await value.get();
          if (value.id) reads.push({ ref: value, value: fingerprint(snap.data() ?? null) });
          return snap;
        }, create(value, data) { writes.push(() => { if (byId(value.name, value.id)) throw new Error("Duplicado"); store(value.name).set(value.id, data); }); },
        set(value, data) { writes.push(() => store(value.name).set(value.id, data)); },
        delete(value) { writes.push(() => store(value.name).delete(value.id)); } });
        assertOpen();
        for (const entry of reads) if (fingerprint(byId(entry.ref.name, entry.ref.id)) !== entry.value) throw new Error("Cambio concurrente en memoria");
        if (writes.length && faults.beforeCommit) { const error = faults.beforeCommit; faults.beforeCommit = null; throw error; }
        writes.forEach(write => write());
        if (writes.length && faults.afterCommit) { const error = faults.afterCommit; faults.afterCommit = null; throw error; }
        return structuredClone(result);
      }); queue = task.catch(() => {}); return task;
    },
  }; return db;
}
export function memoryPrivateReceiptStorage({ assertOpen = () => {} } = {}) {
  const files = new Map();
  return { files,
    descriptor: (id, extension) => ({ publicId: id + "." + extension, resourceType: "raw", deliveryType: "authenticated", format: extension }),
    async put(asset, file, { signal } = {}) { assertOpen(); signal?.throwIfAborted(); files.set(asset.publicId, Buffer.from(file.data)); },
    async read(asset) { assertOpen(); const bytes = files.get(asset.publicId); if (!bytes) throw new Error("Archivo no disponible"); return Buffer.from(bytes); },
    async delete(asset) { assertOpen(); files.delete(asset.publicId); },
  };
}
