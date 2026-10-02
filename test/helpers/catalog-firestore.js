import { randomUUID } from "node:crypto";

export async function openCatalogTestFirestore() {
  await import("dotenv/config");
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  if (!emulator && process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
    throw new Error("Sin emulador, estos tests requieren ALLOW_PROD_FIRESTORE_TESTS=1. No se cargó Firebase ni se accedió a Firestore.");
  }
  // La protección anterior se ejecuta antes de cargar el SDK o la configuración.
  const [{ initializeApp, deleteApp }, { getFirestore, Timestamp }] = await Promise.all([
    import("firebase-admin/app"), import("firebase-admin/firestore"),
  ]);
  const app = emulator
    ? initializeApp({ projectId: process.env.CATALOG_TEST_PROJECT_ID || "demo-catalog-tests" }, `test-${randomUUID()}`)
    : (await import("../../src/config/firebase.js")).app;
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
