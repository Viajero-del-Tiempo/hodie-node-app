import express from "express";
import { validateOrderIdentifier } from "../services/order-pricing.service.js";
import { validatePaymentReceipt } from "../validators/payment-receipt.validator.js";

export function createAdminReceiptRouter({ repository, storage, requireAuth, requireAdmin }) {
  const router = express.Router();
  router.use("/orders/:id/receipts", requireAuth, requireAdmin, (req, res, next) => {
    if (req.user?.active === false) return res.status(403).json({ error: "Usuario inactivo" });
    next();
  });
  const handle = action => async (req, res) => {
    try { validateOrderIdentifier(req.params.id, "id"); await action(req, res); }
    catch (error) { res.status(error.statusCode ?? 500).json({ error: error.statusCode ? error.message : "No se pudo acceder al comprobante", field: error.field }); }
  };
  router.get("/orders/:id/receipts", handle(async (req, res) => {
    const receipts = await repository.listForOrder(req.params.id);
    res.set("Cache-Control", "private, no-store").json({ receipts: receipts.map(value => ({ id: value.id,
      filename: value.filename, mimeType: value.mimeType, size: value.size, receivedAt: value.associatedAt,
      verification: "pending_manual" })) });
  }));
  router.get("/orders/:id/receipts/:receiptId/download", handle(async (req, res) => {
    validateOrderIdentifier(req.params.receiptId, "receiptId");
    const receipt = await repository.get(req.params.receiptId);
    if (!receipt || receipt.status !== "associated" || receipt.orderId !== req.params.id) return res.status(404).json({ error: "Comprobante no disponible" });
    const data = await storage.read(receipt.asset);
    validatePaymentReceipt({ data, mimeType: receipt.mimeType, filename: receipt.filename });
    if (data.length !== receipt.size) throw new Error("El tamaño del comprobante guardado cambió");
    res.set({ "Content-Type": receipt.mimeType, "Content-Length": String(data.length),
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(receipt.filename),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
    res.send(data); // No redirecciones, URLs ni firmas del proveedor al cliente.
  }));
  return router;
}
