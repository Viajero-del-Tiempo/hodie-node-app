import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { acceptsMessage, createMessageDeduplicator } from "../src/agents/guardian/filters.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";

test("filtro nuevo tiene paridad con el código actual sin importar ni iniciar WhatsApp", async () => {
  const source = await readFile(new URL("../src/config/whatsapp.js", import.meta.url), "utf8");
  const types = source.match(/export const ALLOWED_MESSAGE_TYPES = new Set\((\[[\s\S]*?\])\);/);
  const filters = source.match(/export const handleIncomingWhatsAppMessage = async \(mensaje\) => \{([\s\S]*?)\/\/ 3\./);
  const empty = source.match(/if \(!mensaje.body && !mensaje.hasMedia && mensaje.type !== "location"\) return;/);
  assert.ok(types && filters && empty, "Si cambia el filtro productivo hay que revisar explícitamente la paridad");
  const current = vm.runInNewContext("(mensaje) => { const ALLOWED_MESSAGE_TYPES = new Set(" + types[1] + ");"
    + filters[1] + empty[0] + " return true; }");
  const base = { from: "test@lid", body: "Hola", type: "chat", fromMe: false, hasMedia: false };
  const variants = [{}, { fromMe: true }, { from: "" }, { from: undefined }, { from: "0@c.us" }, { from: "test@g.us" },
    { from: "status@broadcast" }, { type: "e2e_notification" }, { type: "call_log" }, { type: undefined },
    { body: "", hasMedia: false }, { body: "", type: "location" }, { body: "", hasMedia: true },
    ...["chat", "image", "document", "audio", "video", "sticker", "ptt", "location"].map(type => ({ type }))];
  for (const variant of variants) { const message = { ...base, ...variant }; assert.equal(acceptsMessage(message), Boolean(current(message)), JSON.stringify(variant)); }
});
test("duplicados no forman otro lote y el registro libera identificadores viejos", () => {
  const seen = createMessageDeduplicator(100);
  assert.equal(seen.accept("same", 0), true);
  assert.equal(seen.accept("same", 99), false);
  assert.equal(seen.accept("same", 100), true);
});
test("config valida rangos, relaciones y límites máximos de medios", () => {
  const config = createGuardianConfig();
  assert.equal(config.silenceMs, 8000); assert.equal(config.burstMaxMs, 30000);
  assert.equal(config.turnsPerHour, 40); assert.equal(config.turnTimeoutMs, 60000);
  assert.equal(config.audioMaxSeconds, 120); assert.equal(config.audioFallbackBytes, 2 * 1024 * 1024);
  assert.equal(config.imageMaxBytes, 5 * 1024 * 1024); assert.equal(config.imagesPerTurn, 3);
  assert.equal(config.totalMediaBytes, 10 * 1024 * 1024);
  for (const env of [{ AGENT_BURST_SILENCE_MS: "no" }, { AGENT_TURNS_PER_HOUR: "0" }, { AGENT_IMAGES_PER_TURN: "4" },
    { AGENT_AUDIO_MAX_SECONDS: "121" }, { AGENT_TOTAL_MEDIA_BYTES: "10485761" },
    { AGENT_IMAGE_MAX_BYTES: "5242881" }, { AGENT_AUDIO_FALLBACK_BYTES: "2097153" },
    { AGENT_BURST_SILENCE_MS: "10000", AGENT_BURST_MAX_MS: "9000" }]) assert.throws(() => createGuardianConfig(env));
});
