import dotenv from "dotenv";
import app from "./src/app.js";
import { initializeWhatsapp } from "./src/config/whatsapp.js";
import { cleanupStaleOrderPDFs } from "./src/services/pdf.service.js";

dotenv.config();

const startServer = async () => {
  // Limpieza de PDFs residuales de ejecuciones anteriores
  cleanupStaleOrderPDFs();

  // Iniciar servicios
  await initializeWhatsapp();

  

  // Iniciar el servidor web
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`)
  );
};

startServer();
