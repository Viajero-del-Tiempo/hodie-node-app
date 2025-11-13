import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { router as authRouter } from "./routes/auth.routes.js";

const app = express();

const allowedOrigins = [
  "http://localhost:4200", // Desarrollo Angular
  "https://hodie.com.py",  // ✅ Tu dominio en producción
  "https://www.hodie.com.py" // ✅ Por si lo visitas con www
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
// 👉 Ruta base para probar el servidor
app.get("/", (req, res) => {
  res.send("🚀 Servidor funcionando correctamente");
});

// 👉 Ruta para cron-job.org
app.get("/ping", (req, res) => {
  console.log("🔄 Ping recibido:", new Date().toLocaleString());
  res.status(200).send("pong 🏓");
});
app.use("/auth", authRouter);

export default app;
