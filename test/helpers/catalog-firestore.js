import { randomUUID } from "node:crypto";
import { requireTestFirestore } from "../../src/config/firebase-test-environment.js";

export async function openCatalogTestFirestore() {
  const { projectId } = requireTestFirestore();
  // La protección anterior se ejecuta antes de cargar el SDK o la configuración.
  const [{ initializeApp, deleteApp }, { getFirestore, Timestamp }] = await Promise.all([
    import("firebase-admin/app"), import("firebase-admin/firestore"),
  ]);
  const app = initializeApp({ projectId }, `test-${randomUUID()}`);
  const db = getFirestore(app);
  return { db, Timestamp, async close() { try { await db.terminate(); } finally { await deleteApp(app); } } };
}

export function createTestScope(db) {
  const prefix = `test-${randomUUID()}`;
  const references = new Map();
  return {
    id: suffix => `${prefix}-${suffix}`,
    track(collection, id) {
      if (!id.startsWith(`${prefix}-`)) throw new Error("Solo se registran documentos de esta ejecución de test");
      const ref = db.collection(collection).doc(id);
      references.set(ref.path, ref);
      return ref;
    },
    async cleanup() {
      const results = await Promise.allSettled([...references.values()].map(ref => ref.delete()));
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "No se pudo completar la limpieza de los documentos de este test");
    },
  };
}
