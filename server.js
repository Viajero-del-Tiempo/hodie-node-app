import dotenv from "dotenv";
import app, { receipts } from "./src/app.js";
import { initializeWhatsapp } from "./src/config/whatsapp.js";
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
};

startServer();
