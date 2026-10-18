import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createAdminAgentChatRouter } from "../src/routes/admin.agent-chat.routes.js";
import { createAgentChatControl } from "../src/services/agent-chat-control.service.js";
import { whatsappMemoryDatabase } from "./helpers/whatsapp-fixtures.js";

test("panel backend: protección, lista de ambas pausas, reactivación por versión sin mensajes y 409 concurrente", async t => {
  const db = whatsappMemoryDatabase(), control = createAgentChatControl({ db, now: () => 100000 });
  const first = await control.ensure("595900000001@c.us", "595900000001"), second = await control.ensure("test-agent@lid", null);
  await control.pause(first.chatId, { reason: "toma_manual" }); await control.pause(second.chatId, { reason: "derivacion" });
  await control.touch(first.chatId, "Mensaje ".repeat(100));
  const resumed = [], app = express(); app.use(express.json());
  app.use("/admin", createAdminAgentChatRouter({ control, onResume: id => resumed.push(id),
    requireAuth: (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401),
    requireAdmin: (req, res, next) => req.headers.authorization === "admin" ? next() : res.sendStatus(403) }));
  const server = await new Promise(resolve => { const current = app.listen(0, "127.0.0.1", () => resolve(current)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, authorization, body) => fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(authorization ? { authorization } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const auth of [undefined, "customer"]) {
    assert.equal((await request("/chats/agent/paused", auth)).status, auth ? 403 : 401);
    assert.equal((await request(`/chats/agent/${first.id}/resume-bot`, auth, { version: 1 })).status, auth ? 403 : 401);
  }
  const list = await (await request("/chats/agent/paused", "admin")).json();
  assert.equal(list.count, 2); assert.deepEqual(new Set(list.chats.map(row => row.reason)), new Set(["toma_manual", "derivacion"]));
  assert.equal(JSON.stringify(list).includes("595900000001"), false); assert.equal(JSON.stringify(list).includes("test-agent@lid"), false);
  assert.equal(list.chats.find(row => row.id === first.id).lastCustomerMessage.length, 200);
  assert.equal((await request(`/chats/agent/${first.id}/resume-bot`, "admin", {})).status, 400);
  assert.equal((await request("/chats/agent/invalid/resume-bot", "admin", { version: 1 })).status, 404);
  await control.pause(first.chatId, { reason: "toma_manual", eventId: "new-manual" });
  assert.equal((await request(`/chats/agent/${first.id}/resume-bot`, "admin", { version: 1 })).status, 409);
  assert.equal((await request(`/chats/agent/${first.id}/resume-bot`, "admin", { version: 2 })).status, 200);
  assert.deepEqual(resumed, [first.chatId]); assert.equal((await control.get(first.chatId)).generation, 1);
  assert.equal((await request(`/chats/agent/${first.id}/resume-bot`, "admin", { version: 2 })).status, 409);
  assert.equal((await (await request("/chats/agent/paused", "admin")).json()).count, 1);
});
