import { Timestamp } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

// ==========================================
// 1. ENDPOINTS PARA EL CLIENTE AUTENTICADO (/users/me)
// ==========================================

/**
 * GET /users/me
 * Retorna el perfil del usuario autenticado a partir del teléfono en el JWT.
 */
export const getMyProfile = async (req, res) => {
  try {
    const phone = req.userPhone; // Inyectado por requireAuth

    const snapshot = await db
      .collection("users")
      .where("phoneNumber", "==", phone)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "Perfil de usuario no encontrado" });
    }

    const doc = snapshot.docs[0];
    return res.json({
      success: true,
      user: { uid: doc.id, ...doc.data() },
    });
  } catch (err) {
    console.error("Error en getMyProfile:", err);
    return res.status(500).json({ error: "Error obteniendo perfil de usuario" });
  }
};

/**
 * PUT /users/me
 * Actualiza el perfil (nombre, direcciones de envío/facturación) del usuario autenticado.
 */
export const updateMyProfile = async (req, res) => {
  try {
    const phone = req.userPhone;
    const { displayName, addresses, billingAddress, profile_status } = req.body;

    const snapshot = await db
      .collection("users")
      .where("phoneNumber", "==", phone)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const docRef = snapshot.docs[0].ref;
    const updateData = { updatedAt: Timestamp.now() };

    if (displayName !== undefined) updateData.displayName = displayName;
    if (addresses !== undefined) updateData.addresses = addresses;
    if (billingAddress !== undefined) updateData.billingAddress = billingAddress;
    if (profile_status !== undefined) updateData.profile_status = profile_status;

    await docRef.update(updateData);
    return res.json({ success: true, message: "Perfil actualizado correctamente" });
  } catch (err) {
    console.error("Error en updateMyProfile:", err);
    return res.status(500).json({ error: "Error actualizando perfil" });
  }
};

// ==========================================
// 2. ENDPOINTS PARA EL PANEL ADMINISTRADOR (/admin/users)
// ==========================================

/**
 * GET /admin/users
 * Lista todos los usuarios registrados ordenados por fecha de creación descendente.
 */
export const getAdminUsers = async (req, res) => {
  try {
    const snapshot = await db.collection("users").orderBy("createdAt", "desc").get();
    const users = snapshot.docs.map((doc) => ({
      uid: doc.id,
      ...doc.data(),
      active: doc.data().active !== false,
    }));
    return res.json({ success: true, users });
  } catch (err) {
    console.error("Error en getAdminUsers:", err);
    return res.status(500).json({ error: "Error obteniendo usuarios" });
  }
};

/**
 * POST /admin/users
 * Crea un usuario desde el panel de administración.
 */
export const createAdminUser = async (req, res) => {
  try {
    const { phoneNumber, displayName, role, profile_status, addresses, billingAddress } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: "El número de teléfono es obligatorio" });
    }

    // Verificar si ya existe usuario con ese teléfono
    const existing = await db
      .collection("users")
      .where("phoneNumber", "==", phoneNumber)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({ error: "Ya existe un usuario con ese número de teléfono" });
    }

    const newDocRef = db.collection("users").doc();
    const newUser = {
      uid: newDocRef.id,
      phoneNumber,
      displayName: displayName || "",
      role: role === "admin" ? "admin" : "customer",
      profile_status: profile_status || "incomplete",
      whatsapp_verified: false,
      addresses: addresses || [],
      billingAddress: billingAddress || null,
      active: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    await newDocRef.set(newUser);
    return res.status(201).json({ success: true, user: newUser });
  } catch (err) {
    console.error("Error en createAdminUser:", err);
    return res.status(500).json({ error: "Error creando usuario" });
  }
};

/**
 * PUT /admin/users/:id
 * Actualiza los datos de un usuario desde el panel de administración.
 * Protege contra la degradación accidental del único admin.
 */
export const updateAdminUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    delete updateData.uid;

    const userRef = db.collection("users").doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const currentData = userDoc.data();

    // PROTECCIÓN CRÍTICA: Si se intenta degradar el rol de un admin
    if (currentData.role === "admin" && updateData.role && updateData.role !== "admin") {
      const adminSnapshot = await db.collection("users").where("role", "==", "admin").get();
      if (adminSnapshot.size <= 1) {
        return res.status(400).json({
          error: "No se puede quitar el rol de administrador al único admin del sistema.",
        });
      }
    }

    updateData.updatedAt = Timestamp.now();
    await userRef.update(updateData);

    return res.json({ success: true, message: "Usuario actualizado correctamente" });
  } catch (err) {
    console.error("Error en updateAdminUser:", err);
    return res.status(500).json({ error: "Error actualizando usuario" });
  }
};

/**
 * PATCH /admin/users/:id/role
 * Modifica exclusivamente el rol de un usuario.
 * Protege contra la degradación accidental del único admin del sistema.
 */
export const updateAdminUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["admin", "customer"].includes(role)) {
      return res.status(400).json({ error: "Rol inválido. Valores permitidos: admin, customer" });
    }

    const userRef = db.collection("users").doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userData = userDoc.data();

    // PROTECCIÓN CRÍTICA: Contar admins si se intenta quitar el rol admin
    if (userData.role === "admin" && role !== "admin") {
      const adminSnapshot = await db.collection("users").where("role", "==", "admin").get();
      if (adminSnapshot.size <= 1) {
        return res.status(400).json({
          error: "No se puede quitar el rol de administrador al único admin del sistema.",
        });
      }
    }

    await userRef.update({
      role,
      updatedAt: Timestamp.now(),
    });

    return res.json({ success: true, message: `Rol actualizado a ${role}` });
  } catch (err) {
    console.error("Error en updateAdminUserRole:", err);
    return res.status(500).json({ error: "Error actualizando rol de usuario" });
  }
};

/**
 * DELETE /admin/users/:id
 * Aplica Soft-Delete (active: false) para preservar la integridad referencial de pedidos históricos.
 * Protege contra la eliminación del único admin del sistema.
 */
export const deleteAdminUser = async (req, res) => {
  try {
    const { id } = req.params;
    const userRef = db.collection("users").doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userData = userDoc.data();

    // PROTECCIÓN CRÍTICA: No permitir eliminar al único admin
    if (userData.role === "admin") {
      const adminSnapshot = await db.collection("users").where("role", "==", "admin").get();
      if (adminSnapshot.size <= 1) {
        return res.status(400).json({
          error: "No se puede eliminar al único administrador del sistema.",
        });
      }
    }

    // Soft-delete por defecto para preservar histórico de pedidos
    await userRef.update({
      active: false,
      deletedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    return res.json({
      success: true,
      message: "Usuario desactivado correctamente (soft-delete).",
    });
  } catch (err) {
    console.error("Error en deleteAdminUser:", err);
    return res.status(500).json({ error: "Error eliminando usuario" });
  }
};
