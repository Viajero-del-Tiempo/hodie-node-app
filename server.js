import dotenv from "dotenv";
import app, { receipts } from "./src/app.js";
import { initializeWhatsapp, shutdownAgentPilot, whatsappClient } from "./src/config/whatsapp.js";
import { createAgentWhatsAppConfig } from "./src/config/agent-whatsapp.config.js";
import { cleanupStaleOrderPDFs } from "./src/services/pdf.service.js";

import { startReceiptCleanup } from "./src/services/payment-receipt.service.js";

dotenv.config();

const startServer = async () => {
  const stopReceiptCleanup = startReceiptCleanup(receipts.cleanup);
  // Limpieza de PDFs residuales de ejecuciones anteriores
  cleanupStaleOrderPDFs();

  // Iniciar servicios
  await initializeWhatsapp();

  

  // Iniciar el servidor web
  const PORT = process.env.PORT || 3000;
  const httpServer = app.listen(PORT, () =>
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`)
  );
  httpServer.once("close", () => { void stopReceiptCleanup(); });
  if (createAgentWhatsAppConfig(process.env).enabled) {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 5000);
      let code = 0;
      try {
        await shutdownAgentPilot();
        await stopReceiptCleanup();
        await whatsappClient.destroy();
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
      } catch { code = 1; console.error(JSON.stringify({ code: "PILOT_SHUTDOWN_FAILED" })); }
      finally { clearTimeout(deadline); process.exit(code); }
    };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
  }
};

startServer();
