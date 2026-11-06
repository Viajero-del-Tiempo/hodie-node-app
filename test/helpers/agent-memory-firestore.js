export function agentMemoryFirestore({ faults = {} } = {}) {
  const rows = new Map(); let queue = Promise.resolve();
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const snapshot = ref => ({ exists: rows.has(ref.path), data: () => clone(rows.get(ref.path)) });
  const db = {
    collection: name => ({ doc: id => ({ path: name + "/" + id, get: async () => snapshot({ path: name + "/" + id }) }) }),
    runTransaction(action) {
      const task = queue.catch(() => {}).then(async () => {
        const writes = [];
        const result = await action({
          async get(ref) { if (writes.length) throw new Error("Lectura después de escribir"); return snapshot(ref); },
          set: (ref, value) => writes.push(() => rows.set(ref.path, clone(value))),
          create: (ref, value) => writes.push(() => { if (rows.has(ref.path)) throw new Error("Documento duplicado"); rows.set(ref.path, clone(value)); }),
        });
        if (faults.beforeCommit) throw faults.beforeCommit;
        writes.forEach(write => write()); return result;
      });
      queue = task.catch(() => {}); return task;
    },
    peek: (collection, id) => clone(rows.get(collection + "/" + id)),
  };
  return db;
}
