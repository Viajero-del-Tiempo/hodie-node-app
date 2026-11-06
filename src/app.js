import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { router as authRouter } from "./routes/auth.routes.js";
import { router as orderRouter } from "./routes/order.routes.js";
import { router as adminOrderRouter } from "./routes/admin.order.routes.js";
import { router as adminImageRouter } from "./routes/admin.image.routes.js";
import { router as adminProductRouter } from "./routes/admin.product.routes.js";
import { router as userRouter } from "./routes/user.routes.js";
import { router as adminUserRouter } from "./routes/admin.user.routes.js";
import { router as adminChatRouter } from "./routes/admin.chat.routes.js";
import { createAdminAgentChatRouter } from "./routes/admin.agent-chat.routes.js";
import { createAgentChatControl } from "./services/agent-chat-control.service.js";
import { cancelAgentChat } from "./config/whatsapp.js";
import { router as adminCategoryRouter } from "./routes/admin.category.routes.js";
import { router as adminPolicyRouter } from "./routes/admin.policy.routes.js";
import { createAdminAgentConfigRouter } from "./routes/admin.agent-config.routes.js";
import { createAgentConfigRepository } from "./services/agent-config.repository.js";
import { db } from "./config/firebase.js";
import { Timestamp } from "firebase-admin/firestore";
import { requireAuth, requireAdmin } from "./middlewares/auth.middleware.js";
import { router as catalogRouter } from "./routes/catalog.routes.js";

import { createReceiptInfrastructure } from "./services/payment-receipt.infrastructure.js";
import { createAdminReceiptRouter } from "./routes/admin.receipt.routes.js";

export const receipts = createReceiptInfrastructure({ db });
const app = express();

const allowedOrigins = [
  "http://localhost:4200", // Desarrollo Angular
  "https://hodie.com.py",  // ✅ Tu dominio en producción
  "https://www.hodie.com.py" // ✅ Por si lo visitas con www
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Catálogo e imágenes administran sus límites de JSON antes del parser general.
app.use("/admin", adminImageRouter, adminProductRouter);
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

app.use("/catalog", catalogRouter);
app.use("/auth", authRouter);
app.use("/orders", orderRouter);
app.use("/users", userRouter);
app.use("/admin", createAdminReceiptRouter({ ...receipts, requireAuth, requireAdmin }));
app.use("/admin", adminOrderRouter);
app.use("/admin", adminUserRouter);
app.use("/admin", createAdminAgentChatRouter({ control: createAgentChatControl({ db, timestampFromMillis: value => Timestamp.fromMillis(value) }), requireAuth, requireAdmin, onResume: cancelAgentChat }));
app.use("/admin", adminChatRouter);
app.use("/admin", adminCategoryRouter);
app.use("/admin", adminPolicyRouter);
app.use("/admin", createAdminAgentConfigRouter({ repository: createAgentConfigRepository({ db, timestampNow: () => Timestamp.now() }), requireAuth, requireAdmin }));

export default app;
