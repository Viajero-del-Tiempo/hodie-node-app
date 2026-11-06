import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "dotenv";
import { assertLocalCatalogTarget, assertLocalEnvironment, makeLocalEnvironment, projectDirectory, localCatalog } from "./local-catalog.config.js";
import { createProcessMemoryMonitor } from "../src/services/process-memory.service.js";
import { createAgentWhatsAppConfig } from "../src/config/agent-whatsapp.config.js";

// Proyecto/host primero, antes de importar SDKs, crear sesiones o revisar puertos.
assertLocalCatalogTarget(process.env);
const config = createAgentWhatsAppConfig(process.env);
if (!config.enabled || !config.allowlist?.length) throw new Error("El piloto local exige AGENT_ENABLED=true y AGENT_ALLOWLIST no vacía");
if (!process.argv.includes("--worker")) console.info(`Piloto WhatsApp: mantenimiento=${config.maintenanceMode}; números habilitados=${config.allowlist.length}`);

if (process.argv.includes("--worker")) {
  assertLocalEnvironment(process.env);
  const memory = createProcessMemoryMonitor(); memory.start();
  const [{ default: pkg }, { default: qrcode }, { db }, { Timestamp }, { createWhatsAppPilotInfrastructure },
    { createLocalReceiptStorage }, { validatePaymentReceipt }] = await Promise.all([
    import("whatsapp-web.js"), import("qrcode-terminal"), import("../src/config/firebase.js"), import("firebase-admin/firestore"),
    import("../src/services/whatsapp-agent.bootstrap.js"), import("../src/services/payment-receipt.local-storage.js"),
    import("../src/validators/payment-receipt.validator.js"),
  ]);
  const { Client, LocalAuth, MessageMedia } = pkg;
  const mediaDirectory = join(projectDirectory, "sessions", "agent-pilot-local", "images");
  await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
  const mediaServer = createServer(async (req, res) => {
    const match = /^\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/u.exec(req.url ?? "");
    if (req.method !== "GET" || !match) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = await readFile(join(mediaDirectory, match[1] + "." + match[2]));
      res.writeHead(200, { "Content-Type": "image/" + (match[2] === "jpg" ? "jpeg" : match[2]), "Content-Length": bytes.length }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { mediaServer.once("error", reject); mediaServer.listen(3001, "127.0.0.1", resolve); });
  const client = new Client({ authStrategy: new LocalAuth({ dataPath: join(projectDirectory, "sessions", "agent-pilot-local"), clientId: "pilot" }),
    puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-setuid-sandbox"] } });
  const bankConfig = JSON.parse(await readFile(new URL("../test/fixtures/agent-bank.json", import.meta.url), "utf8"));
  const resolvePhone = async chatId => {
    if (chatId.endsWith("@c.us")) return chatId.slice(0, -5);
    const rows = await client.getContactLidAndPhone([chatId]);
    const pn = rows?.[0]?.pn;
    return typeof pn === "string" && pn.endsWith("@c.us") ? pn.slice(0, -5) : null;
  };
  const pilot = await createWhatsAppPilotInfrastructure({ config, client, MessageMedia, db,
    timestampNow: () => Timestamp.now(), timestampFromMillis: value => Timestamp.fromMillis(value), resolvePhone, bankConfig,
    allowLocalImages: true, receiptStorage: createLocalReceiptStorage(join(projectDirectory, "dev", "receipts")),
    uploadCustomizationImage: async ({ base64, mimetype }, { signal } = {}) => {
      signal?.throwIfAborted();
      if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(mimetype?.toLowerCase())) throw new Error("Formato de personalización no admitido");
      const file = validatePaymentReceipt({ data: Buffer.from(base64, "base64"), mimeType: mimetype, filename: "imagen" });
      if (!file.mimeType.startsWith("image/")) throw new Error("Se requiere una imagen");
      const name = createHash("sha256").update(file.data).digest("hex") + "." + file.extension;
      await writeFile(join(mediaDirectory, name), file.data, { signal, mode: 0o600 });
      return "http://127.0.0.1:3001/" + name;
    },
  });
  client.on("qr", qr => qrcode.generate(qr, { small: true }));
  client.on("ready", () => console.info("Piloto WhatsApp listo. Firestore demo; control humano, alertas y trabajador PDF activos."));
  client.on("message", message => { void pilot.handle(message).catch(error => console.error(JSON.stringify({ code: error.code ?? "PILOT_ERROR" }))); });
  client.on("message_create", message => { void pilot.handleCreated(message).catch(error => console.error(JSON.stringify({ code: error.code ?? "MESSAGE_CREATE_FAILED" }))); });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 5000);
    try { memory.stop(); await pilot.shutdown(); await client.destroy(); mediaServer.closeAllConnections(); mediaServer.close(); await db.terminate(); }
    finally { clearTimeout(timeout); process.exit(0); }
  };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
  try { await pilot.start(); } catch (error) { memory.stop(); await pilot.shutdown(); mediaServer.close(); throw error; }
} else {
  // Solo toma del .env los parámetros del modelo; nunca credenciales/banco/DB.
  let values = {};
  try { values = parse(await readFile(new URL("../.env", import.meta.url))); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const inherited = { ...process.env };
  for (const name of ["GEMINI_API_KEY", "GEMINI_MODEL", "AGENT_THINKING_BUDGET", "AGENT_MODEL_CALL_TIMEOUT_MS"]) if (inherited[name] === undefined && values[name] !== undefined) inherited[name] = values[name];
  const bank = JSON.parse(await readFile(new URL("../test/fixtures/agent-bank.json", import.meta.url), "utf8"));
  const env = { ...makeLocalEnvironment({ inherited }), BANK_NAME: bank.bankName, BANK_ACCOUNT_HOLDER: bank.accountHolder,
    BANK_DOCUMENT_ID: bank.documentId, BANK_ACCOUNT_NUMBER: bank.accountNumber, BANK_CURRENCY: bank.currency, BANK_ALIAS: bank.alias };
  assertLocalEnvironment(env);
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY para el piloto real");
  await new Promise((resolve, reject) => { const probe = probeServer(); probe.once("error", reject); probe.listen(3001, "127.0.0.1", () => probe.close(resolve)); });
  const children = []; let stopping = false;
  const ended = child => new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", code => resolve(code ?? 1)); });
  const stop = () => { stopping = true; for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const attach = process.argv.includes("--attach");
    const catalog = attach ? null : spawn(process.execPath, [fileURLToPath(new URL("./dev-catalog.js", import.meta.url))], { cwd: projectDirectory, env, stdio: "inherit" });
    if (catalog) children.push(catalog);
    const catalogEnded = catalog ? ended(catalog) : new Promise(() => {});
    let ready = false;
    for (let attempt = 0; attempt < (attach ? 1 : 150) && !stopping; attempt++) {
      if (catalog && (catalog.exitCode !== null || catalog.signalCode !== null)) throw new Error("El entorno local terminó antes de iniciar");
      try {
        const response = await fetch("http://127.0.0.1:3000/local-health", { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (health.emulator === true && health.projectId === localCatalog.projectId) { ready = true; break; }
      } catch { /* Esperar al servidor que valida y carga los fixtures locales. */ }
      await delay(1000);
    }
    if (!ready) { if (!stopping) throw new Error(attach ? "Levantá primero npm run catalog:local" : "El entorno local no inició a tiempo"); }
    else {
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { cwd: projectDirectory, env, stdio: "inherit" });
      children.push(worker); const code = await Promise.race([catalogEnded, ended(worker)]);
      if (!stopping) process.exitCode = code;
    }
  } finally {
    stop();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    })));
  }
}
