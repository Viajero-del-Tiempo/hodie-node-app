import express from "express";
import bodyParser from "body-parser";
import { router as authRouter } from "./routes/auth.routes.js";

const app = express();
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
