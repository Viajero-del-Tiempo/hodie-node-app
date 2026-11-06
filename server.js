import dotenv from "dotenv";
import app, { receipts } from "./src/app.js";
import { initializeWhatsapp, shutdownAgentPilot, whatsappClient } from "./src/config/whatsapp.js";
import { cleanupStaleOrderPDFs } from "./src/services/pdf.service.js";
import { createProcessMemoryMonitor } from "./src/services/process-memory.service.js";
import { createServerShutdown } from "./src/services/server-shutdown.service.js";
import { startReceiptCleanup } from "./src/services/payment-receipt.service.js";

dotenv.config();

const startServer = async () => {
  const memory = createProcessMemoryMonitor();
  let httpServer, whatsappInitialization = null, stopReceiptCleanup = async () => {};
  const shutdown = createServerShutdown({ components: {
    guardianAndWorkers: shutdownAgentPilot,
    receiptCleanup: () => stopReceiptCleanup(),
    memory: () => memory.stop(),
    whatsapp: async () => {
      // Cerrar ahora aunque initialize esté esperando; si termina después,
      // volver a cerrar el navegador que pudo abrir durante el apagado.
      const starting = whatsappInitialization;
      await whatsappClient.destroy();
      if (starting) { await starting; await whatsappClient.destroy(); }
    },
    http: async () => {
      if (!httpServer) return;
      const closing = new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      httpServer.closeIdleConnections();
      await closing;
    },
  } });
  try {
    memory.start();
    stopReceiptCleanup = startReceiptCleanup(receipts.cleanup);
    cleanupStaleOrderPDFs();
    whatsappInitialization = initializeWhatsapp();
    await whatsappInitialization;
    whatsappInitialization = null;
    if (shutdown.isStopping()) return;
    const PORT = process.env.PORT || 3000;
    httpServer = app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
    httpServer.on("error", () => { void shutdown.stop("HTTP_START_FAILED", { failed: true }); });
  } catch {
    console.error(JSON.stringify({ code: "SERVER_START_FAILED" }));
    await shutdown.stop("SERVER_START_FAILED", { failed: true });
  }
};

void startServer();
