import { assertLocalEnvironment } from "../../scripts/local-catalog.config.js";
import { randomUUID } from "node:crypto";
import { createTestScope, openCatalogTestFirestore } from "./catalog-firestore.js";

export async function openCustomerTestApi() {
  // Estas suites NO admiten producción, aunque esté ALLOW_PROD_FIRESTORE_TESTS.
  assertLocalEnvironment(process.env);
  const context = await openCatalogTestFirestore();
  const scope = createTestScope(context.db);
  let server;
  try {
    const [{ default: express }, { default: jwt }, { requireAuth, loadActiveUser }, { JWT_SECRET },
      { createProfileService }, { createUserController }, { createCustomerOrderService }, { createCustomerOrderController },
      { createUserRouter }, { createOrderRouter }, { createSendOrderController }, { createOrderPersistence },
      { createOrderProcessor }, { createCatalogRepository }, { createCatalogService }, { createOrderPricingService },
      { FieldPath },
    ] = await Promise.all([
      import("express"), import("jsonwebtoken"), import("../../src/middlewares/auth.middleware.js"), import("../../src/config/jwt.js"),
      import("../../src/services/profile.service.js"), import("../../src/controllers/user.controller.js"),
      import("../../src/services/customer-order.service.js"), import("../../src/controllers/customer-order.controller.js"),
      import("../../src/routes/user.routes.js"), import("../../src/routes/order.routes.js"), import("../../src/controllers/order.controller.js"),
      import("../../src/services/order-persistence.service.js"), import("../../src/services/order-processing.service.js"),
      import("../../src/services/catalog.repository.js"), import("../../src/services/catalog.service.js"),
      import("../../src/services/order-pricing.service.js"), import("firebase-admin/firestore"),
    ]);
    const { db, Timestamp } = context;
    const timestampNow = () => Timestamp.now();
    const profiles = createProfileService({ db, timestampNow, generateId: () => scope.id("row-" + randomUUID()) });
    const orders = createCustomerOrderService({ db, documentId: () => FieldPath.documentId(),
      timestampFromParts: (seconds, nanos) => new Timestamp(seconds, nanos), cursorSecret: JWT_SECRET });
    const catalog = createCatalogService({ repository: createCatalogRepository(db, { timestampNow }) });
    const pricing = createOrderPricingService({ catalog });
    let sequence = 0;
    const persistence = createOrderPersistence({ db, timestampNow, calculatePricing: pricing,
      generateOrderId: () => {
        const id = scope.id("checkout-" + ++sequence);
        scope.track("orders", id); // Registro antes del primer write.
        return id;
      }, generateNumber: async () => scope.id("number-" + sequence),
    });
    const processOrder = createOrderProcessor({ db, persistence, timestampNow, generatePdf: async () => null, sendPdf: async () => true });
    let failProfileSave = false;
    const checkoutProfiles = { async saveCheckoutDetails(...args) {
      if (failProfileSave) throw new Error("Fallo de perfil simulado");
      return profiles.saveCheckoutDetails(...args);
    } };
    const app = express();
    app.use(express.json());
    app.use("/users", createUserRouter({ profile: createUserController(profiles), orders: createCustomerOrderController({ orders }) }));
    app.use("/orders", createOrderRouter(createSendOrderController({ processOrder, profiles: checkoutProfiles, notifyStatus: async () => {} })));
    // Endpoint de control para probar los middlewares reales y la identidad.
    app.get("/test/identity", requireAuth, loadActiveUser, (req, res) => res.json({ uid: req.user.uid }));
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); listening.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = phone => jwt.sign({ phone }, JWT_SECRET, { expiresIn: "1h" });
    async function request(path, { phone, method = "GET", body, rawToken } = {}) {
      const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json",
        ...(phone || rawToken ? { Authorization: `Bearer ${rawToken ?? token(phone)}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: response.headers.get("content-type")?.includes("application/pdf")
        ? Buffer.from(await response.arrayBuffer()) : await response.json() };
    }
    async function createUser(suffix, overrides = {}) {
      const uid = scope.id(suffix);
      const phoneNumber = scope.id(suffix + "-phone");
      const user = { uid, phoneNumber, displayName: "Cliente Alfa", role: "customer", active: true,
        whatsapp_verified: true, addresses: [], billingProfiles: [], createdAt: Timestamp.now(), ...overrides };
      await scope.track("users", uid).create(user);
      return user;
    }
    async function close() {
      try { await new Promise(resolve => server.close(resolve)); }
      finally { try { await scope.cleanup(); } finally {
        const applicationDb = (await import("../../src/config/firebase.js")).db;
        try { if (applicationDb !== context.db) await applicationDb.terminate(); }
        finally { await context.close(); }
      } }
    }
    return { ...context, scope, profiles, orders, request, token, createUser, close,
      simulateProfileSaveFailure(value) { failProfileSave = value; } };
  } catch (error) {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await scope.cleanup(); } finally { await context.close(); }
    throw error;
  }
}
