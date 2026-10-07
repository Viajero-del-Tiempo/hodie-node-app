import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { JWT_SECRET } from "../config/jwt.js";
import { createCustomerOrderService } from "../services/customer-order.service.js";
import { sendCustomerError } from "../utils/customer-data.util.js";

export const customerOrderService = createCustomerOrderService({ db, documentId: () => FieldPath.documentId(),
  timestampFromParts: (seconds, nanos) => new Timestamp(seconds, nanos), cursorSecret: JWT_SECRET,
});
export function createCustomerOrderController({ orders = customerOrderService,
  generatePdf = async order => (await import("../services/pdf.service.js")).generateOrderPDF(order),
} = {}) {
  return {
    async list(req, res) {
      try { return res.json({ success: true, ...await orders.list(req.userPhone, req.query) }); }
      catch (error) { return sendCustomerError(res, error); }
    },
    async get(req, res) {
      try { return res.json({ success: true, order: await orders.get(req.userPhone, req.params.id) }); }
      catch (error) { return sendCustomerError(res, error); }
    },
    async pdf(req, res) {
      let path;
      try {
        const order = await orders.getSnapshot(req.userPhone, req.params.id);
        path = await generatePdf(order);
        const number = String(order.orderNumber ?? order.id).replace(/[^\w-]/g, "_");
        res.attachment(`pedido-${number}.pdf`);
        await pipeline(createReadStream(path), res);
      } catch (error) {
        if (res.headersSent) res.destroy(error);
        else sendCustomerError(res, error);
      } finally {
        if (path) {
          try { await unlink(path); }
          catch (error) { if (error.code !== "ENOENT") console.warn("No se pudo eliminar el PDF descargado:", error.message); }
        }
      }
    },
  };
}
