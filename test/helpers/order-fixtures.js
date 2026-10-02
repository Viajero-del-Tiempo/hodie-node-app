import { categoryFixture, memoryCatalog, productFixture, testId } from "./catalog-fixtures.js";

export function pricingFixture() {
  const category = categoryFixture({ name: "Categoría Alfa" });
  const product = productFixture(category.id, { name: "Producto Alfa", optionNames: ["tono", "diseño"] });
  product.variants[0] = {
    ...product.variants[0], options: { tono: "Ámbar", diseño: "Liso" }, price: 17, stock: 8,
    imageUrls: ["https://example.test/variant.png"],
  };
  product.variants.push({ ...product.variants[0], id: testId(), sku: testId(), options: { tono: "Azul", diseño: "Liso" }, price: 31, stock: 4 });
  product.packagingOptions = [{ type: "test-pack", name: "Empaque Alfa", price: 5, imageUrl: "https://example.test/pack.png" }];
  product.customization = { allowed: true, allowsText: true, maxChars: 20, allowsImage: true, notes: "" };
  const memory = memoryCatalog({ categories: [category], products: [product] });
  const item = { productId: product.id, variantId: product.variants[0].id, quantity: 2 };
  return { category, product, item, ...memory };
}

// Transacciones en memoria para reglas y rollback; la concurrencia se prueba
// aparte contra el motor de Firestore, no se simula con este helper.
export function memoryOrderStore(products = [], orders = []) {
  const documents = new Map([
    ...products.map(product => [`products/${product.id}`, structuredClone(product)]),
    ...orders.map(order => [`orders/${order.id}`, structuredClone(order)]),
  ]);
  const reads = [];
  let invalidations = 0;
  const snapshot = ref => ({ exists: documents.has(ref.path), data: () => structuredClone(documents.get(ref.path)) });
  const db = {
    collection: collection => ({ doc: id => ({ path: `${collection}/${id}`, get: async () => snapshot({ path: `${collection}/${id}` }) }) }),
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          if (writes.length) throw new Error("Lectura después de escritura");
          reads.push(ref.path);
          return snapshot(ref);
        },
        update(ref, update) { writes.push({ ref, update: structuredClone(update) }); },
      };
      const result = await callback(transaction);
      for (const { ref, update } of writes) documents.set(ref.path, { ...documents.get(ref.path), ...update });
      return result;
    },
  };
  const catalog = {
    async getProductForPricing(id, { transaction } = {}) {
      const ref = db.collection("products").doc(id);
      const doc = await (transaction ? transaction.get(ref) : ref.get());
      return doc.exists ? doc.data() : null;
    },
    setProductVariants(transaction, id, variants) { transaction.update(db.collection("products").doc(id), { variants, updatedAt: 123 }); },
    invalidateCache() { invalidations++; },
  };
  return { db, catalog, documents, reads, invalidations: () => invalidations };
}
