// Repositorio inyectado; no SDK, contador, relación con pedidos ni entrega PDF.
export function createOrderQuoteRepository({ db }) {
  return {
    async get(id) { const doc = await db.collection("order_quotes").doc(id).get(); return doc.exists ? doc.data() : null; },
    async set(id, value) { await db.collection("order_quotes").doc(id).create(value); },
  };
}
