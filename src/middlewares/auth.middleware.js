import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwt.js";
import { db } from "../config/firebase.js";
import { tokenBlacklist } from "../controllers/auth.controller.js";

/**
 * Middleware para validar que el usuario tenga un token JWT válido y no revocado.
 * Inyecta req.userPhone y req.token en la petición.
 */
export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: "Token inválido (sesión cerrada)" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.phone) {
      return res.status(401).json({ error: "Token inválido: falta información del teléfono" });
    }

    req.userPhone = decoded.phone;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
};

/**
 * Middleware para validar que la petición provenga de un usuario autenticado
 * con rol de administrador (role === 'admin') en la colección 'users'.
 * Inyecta req.user (con uid y datos del usuario) en la petición.
 */
export const requireAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: "Token inválido (sesión cerrada)" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.phone) {
      return res.status(401).json({ error: "Token inválido: falta información del teléfono" });
    }

    // Consultar usuario en Firestore mediante Admin SDK
    const snapshot = await db
      .collection("users")
      .where("phoneNumber", "==", decoded.phone)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(403).json({ error: "Usuario no registrado en el sistema" });
    }

    const userData = snapshot.docs[0].data();
    if (userData.role !== "admin") {
      return res.status(403).json({ error: "Acceso denegado: se requieren permisos de administrador" });
    }

    req.user = { uid: snapshot.docs[0].id, ...userData };
    req.token = token;
    next();
  } catch (err) {
    console.error("Error en requireAdmin middleware:", err.message);
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
};
