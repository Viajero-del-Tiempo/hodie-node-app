import jwt from "jsonwebtoken";

export function createAuthSessionController({ jwtSecret, tokenBlacklist }) {
  return {
    async session(req, res) {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) return res.status(401).json({ error: "Token no proporcionado" });
      if (tokenBlacklist.has(token)) return res.status(401).json({ error: "Token inválido (cerrado)" });
      try {
        const decoded = jwt.verify(token, jwtSecret);
        return res.json({ success: true, message: "Sesión válida", phone: decoded.phone });
      } catch {
        return res.status(401).json({ error: "Token inválido o expirado" });
      }
    },
    async logout(req, res) {
      const token = req.headers.authorization?.split(" ")[1];
      if (token) tokenBlacklist.add(token);
      return res.json({ success: true, message: "Sesión cerrada correctamente" });
    },
  };
}
