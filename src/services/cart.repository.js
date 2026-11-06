import { cartIssue, timestampMillis } from "./cart.service.js";

// Puerto inactivo hasta la puesta en marcha. El llamador provee una conexión
// separada de pruebas; este módulo no inicializa Firebase.
export function createCartRepository({ db, timestampFromMillis, now = Date.now, beforeTransaction }) {
  return {
    async get(chatId) {
      const snapshot = await db.collection("carts").doc(chatId).get();
      return snapshot.exists ? { ...snapshot.data(), updatedAt: timestampMillis(snapshot.data().updatedAt),
        expiresAt: timestampMillis(snapshot.data().expiresAt) } : null;
    },
    async set(chatId, cart, { expectedRevision, signal } = {}) {
      signal?.throwIfAborted();
      const ref = db.collection("carts").doc(chatId);
      await db.runTransaction(async tx => {
        await beforeTransaction?.(tx);
        const snapshot = await tx.get(ref);
        const current = snapshot.exists && timestampMillis(snapshot.data().expiresAt) > now() ? snapshot.data() : null;
        if ((current?.revision ?? (current ? 0 : null)) !== expectedRevision) throw cartIssue("CARRITO_CAMBIO", "cart", "El carrito cambió; volvé a consultarlo.");
        signal?.throwIfAborted();
        tx.set(ref, { ...cart, updatedAt: timestampFromMillis(cart.updatedAt), expiresAt: timestampFromMillis(cart.expiresAt) });
      });
    },
  };
}
