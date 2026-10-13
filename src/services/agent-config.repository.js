import { AGENT_CONFIG_COLLECTION, AGENT_CONFIG_ID, validateAgentConfig } from "./agent-config.service.js";
import { cartIssue, fingerprint } from "./cart.service.js";

// Sin inicializar Firebase: el entorno y las pruebas inyectan la base.
export function createAgentConfigRepository({ db, timestampNow, documentId = AGENT_CONFIG_ID }) {
  const ref = db.collection(AGENT_CONFIG_COLLECTION).doc(documentId);
  const present = snapshot => snapshot.exists ? { corporateQuantityThreshold: snapshot.data().corporateQuantityThreshold,
    version: fingerprint([snapshot.data().corporateQuantityThreshold, snapshot.data().revision ?? 0]), updatedAt: snapshot.data().updatedAt } : null;
  return {
    async get({ signal } = {}) { signal?.throwIfAborted(); const snapshot = await ref.get(); signal?.throwIfAborted(); return present(snapshot); },
    async save(input, { signal } = {}) {
      const value = validateAgentConfig(input);
      signal?.throwIfAborted();
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(ref), current = present(snapshot);
        if (value.version !== (current?.version ?? null)) throw Object.assign(cartIssue("CONFIGURACION_CAMBIO", "corporateQuantityThreshold",
          current ? "El umbral cambió a " + current.corporateQuantityThreshold + " desde que abriste el formulario. Recargá para revisarlo; tu borrador se conserva."
            : "La configuración fue eliminada. Recargá para revisarla; tu borrador se conserva."), { statusCode: 409 });
        const stored = { corporateQuantityThreshold: value.corporateQuantityThreshold,
          revision: (snapshot.exists ? snapshot.data().revision ?? 0 : 0) + 1, updatedAt: timestampNow() };
        signal?.throwIfAborted();
        tx.set(ref, stored);
        return { corporateQuantityThreshold: stored.corporateQuantityThreshold, version: fingerprint([stored.corporateQuantityThreshold, stored.revision]), updatedAt: stored.updatedAt };
      });
    },
  };
}
