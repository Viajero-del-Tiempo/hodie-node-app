import { CatalogError, validateCategory, validateDocumentId, validatePolicy } from "../validators/catalog.validator.js";

const fromDocument = document => document.exists ? { ...document.data(), id: document.id } : null;
const fromSnapshot = snapshot => snapshot.docs.map(fromDocument);

// No inicializa Firebase al importarse; el runtime y los tests inyectan la conexión.
export function createCatalogRepository(db, { timestampNow }) {
  function missing(id) {
    return new CatalogError("id", `Documento no encontrado: ${id}`, 404);
  }

  async function assertCategoryCanDeactivate(transaction, id) {
    const products = await transaction.get(db.collection("products").where("categoryId", "==", id));
    if (products.docs.some(document => document.data().active !== false)) {
      throw new CatalogError("active", "No se puede desactivar una categoría con productos activos", 409);
    }
  }

  return {
    async readCatalog() {
      const [categories, products, policies] = await Promise.all([
        db.collection("categories").get(),
        db.collection("products").where("schemaVersion", "==", 2).get(),
        db.collection("policies").get(),
      ]);
      return { categories: fromSnapshot(categories), products: fromSnapshot(products), policies: fromSnapshot(policies) };
    },

    async getCategory(id) {
      return fromDocument(await db.collection("categories").doc(validateDocumentId(id)).get());
    },

    async findSkuConflict(sku, excludedProductId) {
      // Dos resultados alcanzan para descartar el propio producto sin ocultar otro.
      // La segunda consulta cubre el SKU raíz del esquema viejo, sin backfill.
      const [current, legacy] = await Promise.all([
        db.collection("products").where("skus", "array-contains", sku).limit(2).get(),
        db.collection("products").where("sku", "==", sku).limit(2).get(),
      ]);
      return [...current.docs, ...legacy.docs].find(document => document.id !== excludedProductId)?.id ?? null;
    },

    async createCategory(input) {
      const category = validateCategory(input);
      const ref = db.collection("categories").doc(category.id);
      await db.runTransaction(async transaction => {
        if ((await transaction.get(ref)).exists) throw new CatalogError("id", "La categoría ya existe", 409);
        if (!category.active) await assertCategoryCanDeactivate(transaction, category.id);
        transaction.create(ref, category);
      });
      return category;
    },

    async updateCategory(id, input) {
      const ref = db.collection("categories").doc(validateDocumentId(id));
      return db.runTransaction(async transaction => {
        const existing = fromDocument(await transaction.get(ref));
        if (!existing) throw missing(id);
        const category = validateCategory(input, { existing });
        if (!category.active) await assertCategoryCanDeactivate(transaction, id);
        transaction.set(ref, category);
        return category;
      });
    },

    async deactivateCategory(id) {
      return this.updateCategory(id, { active: false });
    },

    async createPolicy(input) {
      const policy = validatePolicy(input);
      const ref = db.collection("policies").doc(policy.id);
      return db.runTransaction(async transaction => {
        if ((await transaction.get(ref)).exists) throw new CatalogError("id", "La política ya existe", 409);
        const stored = { ...policy, updatedAt: timestampNow() };
        transaction.create(ref, stored);
        return stored;
      });
    },

    async updatePolicy(id, input) {
      const ref = db.collection("policies").doc(validateDocumentId(id));
      return db.runTransaction(async transaction => {
        const existing = fromDocument(await transaction.get(ref));
        if (!existing) throw missing(id);
        const policy = { ...validatePolicy(input, { existing }), updatedAt: timestampNow() };
        transaction.set(ref, policy);
        return policy;
      });
    },

    async deletePolicy(id) {
      const ref = db.collection("policies").doc(validateDocumentId(id));
      await db.runTransaction(async transaction => {
        if (!(await transaction.get(ref)).exists) throw missing(id);
        transaction.delete(ref);
      });
    },
  };
}
