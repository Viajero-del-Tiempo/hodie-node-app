import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertLocalEnvironment, localCatalog } from "./local-catalog.config.js";

// Se aborta antes de importar SDK, rutas, fixtures o credenciales.
assertLocalEnvironment(process.env);
const [
  { default: express }, { default: cors }, { default: jwt }, { db }, { Timestamp },
  { createAuthRouter }, { createAuthCodeController }, { createAuthSessionController }, { tokenBlacklist },
  { router: products }, { router: categories }, { router: policies }, { router: catalog },
  { router: users }, { createAdminImageRouter }, { seedCatalog },
  { createOrderRouter }, { createSendOrderController }, { createOrderProcessor }, { persistOrderSnapshot },
  { generateOrderPDF }, { requireAdmin }, { getAdminOrders, getAdminOrderById },
] = await Promise.all([
  import("express"), import("cors"), import("jsonwebtoken"), import("../src/config/firebase.js"), import("firebase-admin/firestore"),
  import("../src/routes/auth.routes.js"), import("../src/controllers/auth-code.controller.js"),
  import("../src/controllers/auth-session.controller.js"), import("../src/services/auth-session.service.js"),
  import("../src/routes/admin.product.routes.js"), import("../src/routes/admin.category.routes.js"),
  import("../src/routes/admin.policy.routes.js"), import("../src/routes/catalog.routes.js"),
  import("../src/routes/user.routes.js"), import("../src/routes/admin.image.routes.js"), import("./seed-catalog.js"),
  import("../src/routes/order.routes.js"), import("../src/controllers/order.controller.js"),
  import("../src/services/order-processing.service.js"), import("../src/services/order.service.js"),
  import("../src/services/pdf.service.js"), import("../src/middlewares/auth.middleware.js"), import("../src/controllers/admin.order.controller.js"),
]);
const imageDirectory = await mkdtemp(join(tmpdir(), "hodie-catalog-images-"));
let server;
try {
  await copyFile(new URL("../test/fixtures/catalog-image.png", import.meta.url), join(imageDirectory, "example.png"));
  const admin = await seedCatalog();
  const app = express();
  app.use(cors({ origin: "http://localhost:4200", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"] }));
  app.use("/admin", createAdminImageRouter(async ({ bytes, mimetype }) => {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mimetype];
    const name = randomUUID() + "." + extension;
    await writeFile(join(imageDirectory, name), bytes);
    return "http://localhost:3000/local-images/" + name;
  }));
  app.use("/admin", products);
  app.use(express.json());
  app.use("/local-images", express.static(imageDirectory));
  const sessionController = createAuthSessionController({ jwtSecret: process.env.JWT_SECRET, tokenBlacklist });
  const codeController = createAuthCodeController({
    db, timestampNow: () => Timestamp.now(), jwtSecret: process.env.JWT_SECRET, jwtExpiration: "1h",
    sendVerificationCode: async (phone, code) => console.log("OTP LOCAL para " + phone + ": " + code),
    sendErrorMessage: async () => {}, sendLimitError: async () => {},
  });
  app.use("/auth", createAuthRouter({ ...codeController, ...sessionController }));
  app.use("/users", users);
  const processOrder = createOrderProcessor({ db, timestampNow: () => Timestamp.now(),
    persistence: { persistOrderSnapshot }, generatePdf: generateOrderPDF,
    sendPdf: async (_phone, _path, order) => {
      console.log("PDF LOCAL generado para " + order.orderNumber + "; descargalo con sesión desde /users/me/orders/" + order.id + "/pdf");
      return true;
    },
    notifyFailure: async order => console.log("PDF LOCAL pendiente para " + order.orderNumber),
  });
  app.use("/orders", createOrderRouter(createSendOrderController({ processOrder, notifyStatus: async () => {} })));
  app.get("/admin/orders", requireAdmin, getAdminOrders);
  app.get("/admin/orders/:id", requireAdmin, getAdminOrderById);
  app.use("/catalog", catalog);
  app.use("/admin", categories, policies);
  app.get("/local-health", (_req, res) => res.json({ projectId: localCatalog.projectId, emulator: true }));
  server = await new Promise((resolve, reject) => {
    const listening = app.listen(localCatalog.apiPort, localCatalog.host, () => resolve(listening));
    listening.once("error", reject);
  });
  const token = jwt.sign({ phone: admin.phoneNumber }, process.env.JWT_SECRET, { expiresIn: "1h" });
  console.log("API local: http://localhost:3000 | Firestore UI: http://localhost:4000");
  const localPhone = admin.phoneNumber.startsWith("595") ? "0" + admin.phoneNumber.slice(3) : admin.phoneNumber;
  console.log("Login local: ingresá " + localPhone + " y usá el OTP que aparece en esta terminal.");
  console.log("JWT del administrador ficticio (válido 1 h): " + token);
  console.log("Catálogo, imágenes, sesión, perfil y checkout locales. No se envía WhatsApp ni se inicia el grafo.");
  await new Promise(resolve => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.terminate();
  await rm(imageDirectory, { recursive: true, force: true });
}
