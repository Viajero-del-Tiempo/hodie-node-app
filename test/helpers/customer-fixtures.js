import { randomUUID } from "node:crypto";

export const shippingFixture = (overrides = {}) => ({ alias: "Dirección de prueba", recipientName: "Destinatario Alfa",
  city: "Ciudad Alfa", department: "Departamento Alfa", street: "Referencia ficticia Alfa", recipientDocument: "1234567", ...overrides });
export const billingFixture = (overrides = {}) => ({ invoiceRequested: true, legalName: "Persona de prueba Alfa", ruc: "1234567-9", ...overrides });

export function memoryCustomerStore(initial = {}) {
  const documents = new Map(Object.entries(initial).map(([path, data]) => [path, structuredClone(data)]));
  const revisions = new Map([...documents.keys()].map(path => [path, 1]));
  const save = (path, data) => { documents.set(path, structuredClone(data)); revisions.set(path, (revisions.get(path) ?? 0) + 1); };
  function doc(collection, id = "test-" + randomUUID()) {
    const ref = { path: `${collection}/${id}`, id,
      async get() { return snapshot(ref); },
      async create(data) { if (documents.has(ref.path)) throw Object.assign(new Error("Existe"), { code: 6 }); save(ref.path, data); },
      async update(data) { if (!documents.has(ref.path)) throw new Error("No existe"); save(ref.path, { ...documents.get(ref.path), ...data }); },
    };
    return ref;
  }
  const snapshot = ref => ({ id: ref.id, ref, exists: documents.has(ref.path),
    updateTime: { seconds: revisions.get(ref.path) ?? 0, nanoseconds: 0 }, data: () => structuredClone(documents.get(ref.path)) });
  const db = {
    collection(collection) {
      return { doc: id => doc(collection, id), where(field, _operation, value) {
        return { limit(count) { return { async get() {
          const docs = [...documents.entries()].filter(([path, data]) => path.startsWith(collection + "/") && data[field] === value)
            .slice(0, count).map(([path]) => snapshot(doc(collection, path.slice(collection.length + 1))));
          return { docs, empty: docs.length === 0 };
        } }; } };
      } };
    },
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        async get(ref) { if (writes.length) throw new Error("Lectura después de escritura"); return snapshot(ref); },
        update(ref, data) { writes.push([ref.path, { ...documents.get(ref.path), ...data }]); },
        set(ref, data) { writes.push([ref.path, data]); },
      });
      writes.forEach(([path, data]) => save(path, data));
      return result;
    },
  };
  return { db, documents, timestampNow: () => ({ seconds: 100, nanoseconds: 0 }) };
}
