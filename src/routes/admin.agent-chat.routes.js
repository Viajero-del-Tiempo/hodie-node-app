import express from "express";

export function createAdminAgentChatRouter({ control, requireAuth, requireAdmin, onResume = () => {} }) {
  const router = express.Router();
  router.get("/chats/agent/paused", requireAuth, requireAdmin, async (_req, res) => {
    try { const chats = await control.listPaused(); res.json({ success: true, engine: "agent", count: chats.length, chats }); }
    catch { res.status(500).json({ error: "No se pudieron consultar los chats pausados." }); }
  });
  router.post("/chats/agent/:id/resume-bot", requireAuth, requireAdmin, async (req, res) => {
    if (!Number.isSafeInteger(req.body?.version) || req.body.version < 0) return res.status(400).json({ field: "version", error: "Se requiere la versión del chat listado." });
    try {
      const current = await control.getById(req.params.id);
      if (!current) return res.status(404).json({ error: "Chat no encontrado." });
      const result = await control.resume(current.id, req.body.version);
      await onResume(result.chatId);
      res.json({ success: true, engine: "agent", id: result.id, version: result.version });
    } catch (error) {
      res.status(error.statusCode ?? 500).json({ code: error.code ?? "CHAT_RESUME_FAILED", field: "version",
        error: error.statusCode === 409 ? "El chat cambió desde que abriste la lista. Actualizala antes de reactivar." : "No se pudo reactivar el chat." });
    }
  });
  return router;
}
