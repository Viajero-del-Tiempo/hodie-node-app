import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import express from "express";
import jwt from "jsonwebtoken";
import { createAuthCodeController } from "../src/controllers/auth-code.controller.js";
import { createAuthSessionController } from "../src/controllers/auth-session.controller.js";
import { CODE_EXPIRATION_MINUTES, RATE_LIMIT_WINDOW_MINUTES, MAX_CODE_REQUESTS } from "../src/config/auth.js";

test("cargar rutas y validación de sesión no carga WhatsApp ni Firebase", async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.includes("config/firebase") || specifier.includes("whatsapp") || specifier.includes("agents/")) {
      throw new Error("Dependencia externa cargada por auth: " + specifier);
    }
    return next(specifier, context);
  } });
  try { await import("../src/routes/auth.routes.js"); }
  finally { hooks.deregister(); }
});

test("regresión HTTP: request, verify, session y logout preservan contratos", async t => {
  const secret = "test-auth-secret";
  const storage = {};
  const users = new Map();
  const sent = [];
  const errors = [];
  const limits = [];
  let clock = 1700000000000;
  let sequence = 0;
  let failDelivery = false;
  let failDatabase = false;
  const ref = id => ({
    id, async set(value) { users.set(id, structuredClone(value)); },
    async update(value) { users.set(id, { ...users.get(id), ...value }); },
  });
  const db = { collection(collection) {
    assert.equal(collection, "users");
    return {
      doc: () => ref("test-user-" + (++sequence)),
      where(field, operator, phone) {
        assert.equal(field, "phoneNumber"); assert.equal(operator, "==");
        return { limit(count) { assert.equal(count, 1); return { async get() {
          if (failDatabase) throw new Error("test-database-failure");
          const entry = [...users].find(([, user]) => user.phoneNumber === phone);
          return { empty: !entry, docs: entry ? [{ id: entry[0], data: () => structuredClone(entry[1]), ref: ref(entry[0]) }] : [] };
        } }; } };
      },
    };
  } };
  const blacklist = new Set();
  const codeController = createAuthCodeController({
    db, timestampNow: () => ({ testTime: clock }), jwtSecret: secret, jwtExpiration: "30d",
    inMemoryStorage: storage, now: () => clock,
    sendVerificationCode: async (phone, code) => { if (failDelivery) throw new Error("test-delivery-failure"); sent.push({ phone, code }); },
    sendErrorMessage: async phone => errors.push(phone),
    sendLimitError: async phone => limits.push(phone),
  });
  const { createAuthRouter } = await import("../src/routes/auth.routes.js");
  const app = express();
  app.use(express.json());
  app.use("/auth", createAuthRouter({ ...codeController, ...createAuthSessionController({ jwtSecret: secret, tokenBlacklist: blacklist }) }));
  const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const request = async (path, body = {}, token) => {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/auth/" + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await t.test("request exige teléfono, envía OTP, limita y libera tras la ventana", async () => {
      assert.equal((await request("request")).status, 400);
      const phone = "test-rate-phone";
      for (let i = 0; i < MAX_CODE_REQUESTS; i++) {
        assert.deepEqual(await request("request", { phone }), { status: 200, body: { success: true, message: "Código enviado por WhatsApp" } });
      }
      assert.equal(sent.length, MAX_CODE_REQUESTS);
      assert.match(sent.at(-1).code, /^\d{6}$/);
      assert.equal((await request("request", { phone })).status, 429);
      assert.deepEqual(limits, [phone]);
      clock += RATE_LIMIT_WINDOW_MINUTES * 60000 + 1;
      assert.equal((await request("request", { phone })).status, 200);
      failDelivery = true;
      assert.equal((await request("request", { phone: "test-delivery-phone" })).status, 500);
      failDelivery = false;
    });
    await t.test("verify crea cliente, verifica existente sin cambiar rol y firma JWT", async () => {
      assert.equal((await request("verify")).status, 400);
      const phone = "test-customer-phone";
      await request("request", { phone });
      const invalid = await request("verify", { phone, code: "test-invalid" });
      assert.deepEqual(invalid, { status: 400, body: { error: "Código inválido" } });
      assert.ok(errors.includes(phone));
      const valid = await request("verify", { phone, code: storage[phone].code });
      assert.equal(valid.status, 200);
      assert.equal(jwt.verify(valid.body.token, secret).phone, phone);
      const decoded = jwt.decode(valid.body.token);
      assert.equal(decoded.exp - decoded.iat, 30 * 24 * 60 * 60);
      assert.equal(valid.body.user.role, "customer");
      assert.equal(valid.body.user.active, true);
      assert.equal(valid.body.user.whatsapp_verified, true);
      assert.equal(users.size, 1);
      const id = valid.body.user.uid;
      users.set(id, { ...users.get(id), role: "admin", displayName: "Administrador ficticio", whatsapp_verified: false });
      const again = await request("verify", { phone, code: storage[phone].code });
      assert.equal(again.body.user.uid, id);
      assert.equal(again.body.user.role, "admin");
      assert.equal(again.body.user.displayName, "Administrador ficticio");
      assert.equal(users.size, 1);
      assert.equal(users.get(id).whatsapp_verified, true);
      failDatabase = true;
      assert.equal((await request("verify", { phone, code: storage[phone].code })).status, 500);
      failDatabase = false;
      clock += CODE_EXPIRATION_MINUTES * 60000;
      assert.deepEqual(await request("verify", { phone, code: storage[phone].code }), { status: 400, body: { error: "Código expirado" } });
    });
    await t.test("session rechaza ausente, inválido, expirado y revocado; logout sigue siendo idempotente", async () => {
      const token = jwt.sign({ phone: "test-session-phone" }, secret, { expiresIn: "1h" });
      assert.deepEqual(await request("session", {}, token), { status: 200, body: { success: true, message: "Sesión válida", phone: "test-session-phone" } });
      for (const invalid of [undefined, "test-invalid", jwt.sign({ phone: "test" }, secret, { expiresIn: -1 }), jwt.sign({ phone: "test" }, "test-other-secret")]) {
        assert.equal((await request("session", {}, invalid)).status, 401);
      }
      assert.deepEqual(await request("logout", {}, token), { status: 200, body: { success: true, message: "Sesión cerrada correctamente" } });
      assert.equal(blacklist.has(token), true);
      assert.deepEqual(await request("session", {}, token), { status: 401, body: { error: "Token inválido (cerrado)" } });
      assert.equal((await request("logout", {}, token)).status, 200);
      assert.equal((await request("logout")).status, 200);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
