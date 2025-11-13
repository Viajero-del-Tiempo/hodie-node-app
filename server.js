import dotenv from 'dotenv';
import app from './src/app.js';

dotenv.config();

const startServer = async () => {
  // Iniciar el servidor web
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
};

startServer();
