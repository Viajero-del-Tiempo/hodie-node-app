import { db } from "../config/firebase.js";

export const ALLOWED_PACKAGING_KEYS = ["caja", "bolsa", "envoltorio"];

/**
 * Valida la estructura y tipos del campo packagingPrices.
 * Claves permitidas: 'caja', 'bolsa', 'envoltorio'.
 * Valores permitidos: números no negativos.
 *
 * @param {any} packagingPrices
 * @returns {{ valid: boolean, error?: string }}
 */
export const validatePackagingPrices = (packagingPrices) => {
  if (packagingPrices === undefined || packagingPrices === null) {
    return { valid: true };
  }

  if (typeof packagingPrices !== "object" || Array.isArray(packagingPrices)) {
    return {
      valid: false,
      error: "El campo 'packagingPrices' debe ser un objeto válido.",
    };
  }

  for (const [key, value] of Object.entries(packagingPrices)) {
    if (!ALLOWED_PACKAGING_KEYS.includes(key)) {
      return {
        valid: false,
        error: `Clave de empaque inválida: '${key}'. Las claves permitidas son: ${ALLOWED_PACKAGING_KEYS.join(", ")}`,
      };
    }

    const num = Number(value);
    if (typeof value !== "number" || isNaN(num) || num < 0) {
      return {
        valid: false,
        error: `El precio para el empaque '${key}' debe ser un número mayor o igual a 0. Se recibió: ${value}`,
      };
    }
  }

  return { valid: true };
};

/**
 * GET /admin/products
 * Lista todos los productos en Firestore (activos e inactivos) ordenados por nombre.
 */
export const getAdminProducts = async (req, res) => {
  try {
    const snapshot = await db.collection("products").orderBy("name").get();
    const products = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      active: doc.data().active !== false, // Por defecto true si no está definido
    }));
    return res.json({ success: true, products });
  } catch (err) {
    console.error("Error en getAdminProducts:", err);
    return res.status(500).json({ error: "Error obteniendo productos" });
  }
};

/**
 * GET /admin/products/:id
 * Obtiene un producto por ID.
 */
export const getAdminProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("products").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    return res.json({
      success: true,
      product: { id: doc.id, ...doc.data(), active: doc.data().active !== false },
    });
  } catch (err) {
    console.error("Error en getAdminProductById:", err);
    return res.status(500).json({ error: "Error obteniendo producto" });
  }
};

/**
 * POST /admin/products
 * Crea un producto nuevo con validación rigurosa de packagingPrices.
 * Se inicializa con active: true por defecto.
 */
export const createAdminProduct = async (req, res) => {
  try {
    const productData = req.body;
    if (!productData.name || typeof productData.name !== "string" || !productData.name.trim()) {
      return res.status(400).json({ error: "El nombre del producto es obligatorio." });
    }

    if (productData.price === undefined || typeof productData.price !== "number" || productData.price < 0) {
      return res.status(400).json({ error: "El precio debe ser un número mayor o igual a 0." });
    }

    if (productData.stock !== undefined && (typeof productData.stock !== "number" || productData.stock < 0)) {
      return res.status(400).json({ error: "El stock debe ser un número entero mayor o igual a 0." });
    }

    // Validación rigurosa de empaques
    const packagingValidation = validatePackagingPrices(productData.packagingPrices);
    if (!packagingValidation.valid) {
      return res.status(400).json({ error: packagingValidation.error });
    }

    const newDocRef = db.collection("products").doc();
    const newProduct = {
      ...productData,
      id: newDocRef.id,
      name: productData.name.trim(),
      price: Number(productData.price),
      stock: Number(productData.stock || 0),
      sku: productData.sku || `HOD-${Date.now().toString().slice(-5)}`,
      active: true, // Soft-delete flag: producto activo
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await newDocRef.set(newProduct);
    return res.status(201).json({ success: true, product: newProduct });
  } catch (err) {
    console.error("Error en createAdminProduct:", err);
    return res.status(500).json({ error: "Error creando producto" });
  }
};

/**
 * PUT /admin/products/:id
 * Actualiza un producto existente con validación rigurosa de packagingPrices.
 */
export const updateAdminProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    delete updateData.id;

    if (updateData.name !== undefined && (!updateData.name || typeof updateData.name !== "string")) {
      return res.status(400).json({ error: "El nombre del producto no puede estar vacío." });
    }

    if (updateData.price !== undefined && (typeof updateData.price !== "number" || updateData.price < 0)) {
      return res.status(400).json({ error: "El precio debe ser un número mayor o igual a 0." });
    }

    if (updateData.stock !== undefined && (typeof updateData.stock !== "number" || updateData.stock < 0)) {
      return res.status(400).json({ error: "El stock debe ser un número mayor o igual a 0." });
    }

    // Validación rigurosa de empaques
    if (updateData.packagingPrices !== undefined) {
      const packagingValidation = validatePackagingPrices(updateData.packagingPrices);
      if (!packagingValidation.valid) {
        return res.status(400).json({ error: packagingValidation.error });
      }
    }

    const docRef = db.collection("products").doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    updateData.updatedAt = new Date();
    await docRef.update(updateData);

    return res.json({ success: true, message: "Producto actualizado correctamente" });
  } catch (err) {
    console.error("Error en updateAdminProduct:", err);
    return res.status(500).json({ error: "Error actualizando producto" });
  }
};

/**
 * DELETE /admin/products/:id
 * Por defecto realiza un SOFT-DELETE marcando active: false y deletedAt.
 * Si se envía query parameter ?force=true, realiza un hard-delete físico.
 */
export const deleteAdminProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const forceHardDelete = req.query.force === "true";

    const docRef = db.collection("products").doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    if (forceHardDelete) {
      await docRef.delete();
      return res.json({
        success: true,
        message: "Producto eliminado definitivamente de la base de datos (hard-delete)",
      });
    }

    // Soft-delete por defecto
    await docRef.update({
      active: false,
      deletedAt: new Date(),
      updatedAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Producto desactivado correctamente (soft-delete). Ya no aparecerá en el catálogo.",
      softDeleted: true,
    });
  } catch (err) {
    console.error("Error en deleteAdminProduct:", err);
    return res.status(500).json({ error: "Error eliminando producto" });
  }
};

/**
 * PATCH /admin/products/:id/reactivate
 * Reactiva un producto previamente descontinuado o soft-deleted.
 */
export const reactivateAdminProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("products").doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    await docRef.update({
      active: true,
      deletedAt: null,
      updatedAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Producto reactivado correctamente en el catálogo.",
    });
  } catch (err) {
    console.error("Error en reactivateAdminProduct:", err);
    return res.status(500).json({ error: "Error reactivando producto" });
  }
};
