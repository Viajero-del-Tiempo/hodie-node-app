import { randomUUID } from "node:crypto";
import { productVersion, assertProductVersion } from "../utils/catalog-version.util.js";
import { CatalogError, assertObject, validateProductForSave, validateCategory, validateDocumentId, validatePolicy } from "../validators/catalog.validator.js";

const fromDocument = document => document.exists ? { ...document.data(), id: document.id } : null;
const fromSnapshot = snapshot => snapshot.docs.map(fromDocument);

// No inicializa Firebase al importarse; el runtime y los tests inyectan la conexión.
export function createCatalogRepository(db, {
  timestampNow, controlDocumentId = "catalogWrites",
  generateProductId = () => db.collection("products").doc().id,
  generateVariantId = randomUUID,
}) {
  const controlId = validateDocumentId(controlDocumentId);
  const adminDocument = document => document.exists
    ? { ...fromDocument(document), version: productVersion(document) } : null;

  async function saveProduct(id, input, { create = false, patch = false } = {}) {
    assertObject(input, "body");
    const ref = db.collection("products").doc(validateDocumentId(id, "productId"));
    const controlRef = db.collection("counters").doc(controlId);
    // IDs nuevos preasignados: los reintentos de Firestore no regeneran variantes.
    const newIds = Array.isArray(input.variants)
      ? input.variants.filter(variant => variant && variant.id === undefined).map(() => generateVariantId()) : [];
    return db.runTransaction(async transaction => {
      const control = await transaction.get(controlRef);
      const document = await transaction.get(ref);
      if (create && document.exists) throw new CatalogError("id", "El producto ya existe", 409);
      if (!create && !document.exists) throw missing(id);
      const existingProduct = fromDocument(document);
      if (!create) {
        if (existingProduct.schemaVersion !== 2) throw new CatalogError("schemaVersion", "Este producto usa el modelo viejo y no se convierte desde el editor nuevo", 409);
        assertProductVersion(document, input.version);
      }
      let nextId = 0;
      const normalized = await validateProductForSave(patch ? { ...existingProduct, ...input } : input, {
        existingProduct, generateVariantId: () => newIds[nextId++],
        repository: {
          getCategory: categoryId => repository.getCategory(categoryId, { transaction }),
          findSlugConflict: (slug, excludedId) => repository.findSlugConflict(slug, excludedId, { transaction }),
          findSkuConflict: (sku, excludedId) => repository.findSkuConflict(sku, excludedId, { transaction }),
        },
      });
      const timestamp = timestampNow();
      const product = { ...normalized, id: ref.id,
        createdAt: existingProduct?.createdAt ?? timestamp, updatedAt: timestamp };
      if (create) transaction.create(ref, product);
      else transaction.set(ref, product);
      // Todos los escritores de SKU/slug actualizan el mismo documento.
      // No utiliza la caché y todas las lecturas preceden a las escrituras.
      transaction.set(controlRef, { revision: (control.data()?.revision ?? 0) + 1, updatedAt: timestamp });
      return product;
    });
  }
  function missing(id) {
    return new CatalogError("id", `Documento no encontrado: ${id}`, 404);
  }

  async function assertCategoryCanDeactivate(transaction, id) {
    const products = await transaction.get(db.collection("products").where("categoryId", "==", id));
    if (products.docs.some(document => document.data().active !== false)) {
      throw new CatalogError("active", "No se puede desactivar una categoría con productos activos", 409);
    }
  }

  const repository = {
    async readCatalog() {
      const [categories, products, policies] = await Promise.all([
        db.collection("categories").get(),
        db.collection("products").where("schemaVersion", "==", 2).get(),
        db.collection("policies").get(),
      ]);
      return { categories: fromSnapshot(categories), products: fromSnapshot(products), policies: fromSnapshot(policies) };
    },

    async getCategory(id, { transaction } = {}) {
      const ref = db.collection("categories").doc(validateDocumentId(id));
      return fromDocument(await (transaction ? transaction.get(ref) : ref.get()));
    },

    async getProduct(id, { transaction } = {}) {
      const ref = db.collection("products").doc(validateDocumentId(id, "productId"));
      return fromDocument(await (transaction ? transaction.get(ref) : ref.get()));
    },

    setProductVariants(transaction, id, variants) {
      transaction.update(db.collection("products").doc(validateDocumentId(id, "productId")), {
        variants, updatedAt: timestampNow(),
      });
    },

    async findSlugConflict(slug, excludedProductId, { transaction } = {}) {
      const query = db.collection("products").where("slug", "==", slug).limit(2);
      const snapshot = await (transaction ? transaction.get(query) : query.get());
      return snapshot.docs.find(document => document.id !== excludedProductId)?.id ?? null;
    },

    async findSkuConflict(sku, excludedProductId, { transaction } = {}) {
      // Dos resultados alcanzan para descartar el propio producto sin ocultar otro.
      // TEMPORAL hasta entrega 6: la segunda consulta cubre el SKU raíz viejo,
      // sin backfill. Se retira al eliminar esos productos en la puesta en marcha.
      const queries = [
        db.collection("products").where("skus", "array-contains", sku).limit(2),
        db.collection("products").where("sku", "==", sku).limit(2),
      ];
      const [current, legacy] = await Promise.all(queries.map(query => transaction ? transaction.get(query) : query.get()));
      return [...current.docs, ...legacy.docs].find(document => document.id !== excludedProductId)?.id ?? null;
    },

    async listAdminProducts() {
      const snapshot = await db.collection("products").where("schemaVersion", "==", 2).get();
      return snapshot.docs.map(adminDocument).sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id));
    },

    async getAdminProduct(id) {
      const document = await db.collection("products").doc(validateDocumentId(id, "productId")).get();
      if (document.exists && document.data().schemaVersion !== 2) {
        throw new CatalogError("schemaVersion", "Este producto usa el modelo viejo y no se convierte desde el editor nuevo", 409);
      }
      return adminDocument(document);
    },

    createProduct(input) { return saveProduct(generateProductId(), input, { create: true }); },
    updateProduct(id, input, options) { return saveProduct(id, input, options); },
    deactivateProduct(id, input) { return saveProduct(id, { version: input?.version, active: false }, { patch: true }); },
    reactivateProduct(id, input) { return saveProduct(id, { version: input?.version, active: true }, { patch: true }); },

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
  return repository;
}
