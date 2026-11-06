import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { makeLocalEnvironment, assertLocalCatalogTarget, assertLocalEnvironment, localCatalog, projectDirectory } from "./local-catalog.config.js";

// La configuración se valida antes de secretos, herramientas y puertos.
assertLocalCatalogTarget(process.env);
const env = makeLocalEnvironment();
assertLocalEnvironment(env);
const java = spawnSync("java", ["-version"], { encoding: "utf8" });
const version = ((java.stderr ?? "") + (java.stdout ?? "")).match(/version "(\d+)/)?.[1];
if (java.error || java.status !== 0 || Number(version) < 21 || !version) {
  throw new Error("Se requiere Java 21 o posterior en PATH para Firestore Emulator");
}
const cli = spawnSync("firebase", ["--version"], { encoding: "utf8" });
if (cli.error || cli.status !== 0) throw new Error("Se requiere Firebase CLI en PATH");
for (const port of [localCatalog.firestorePort, localCatalog.uiPort, localCatalog.hubPort, localCatalog.apiPort]) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("El puerto local " + port + " está ocupado")));
    probe.listen(port, localCatalog.host, () => probe.close(resolve));
  });
}
// Genera solamente el entorno Angular ignorado; no cambia entornos existentes.
const configured = spawnSync(process.execPath, [
  fileURLToPath(new URL("../../hodie-tienda/scripts/configure-emulator.mjs", import.meta.url)),
], { stdio: "inherit", env });
if (configured.status !== 0) throw new Error("No se pudo preparar el entorno Angular");
const children = [];
let stopping = false;
const stop = () => { stopping = true; for (const child of children) if (child.exitCode === null) child.kill("SIGINT"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const emulator = spawn("firebase", [
    "emulators:start", "--only", "firestore", "--project", localCatalog.projectId,
    "--config", fileURLToPath(new URL("./firebase.emulator.json", import.meta.url)),
  ], { cwd: projectDirectory, env, stdio: "inherit" });
  children.push(emulator);
  let emulatorError;
  emulator.once("error", error => { emulatorError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    if (emulatorError) throw emulatorError;
    if (emulator.exitCode !== null) throw new Error("Firestore Emulator terminó antes de iniciar");
    try {
      const response = await fetch("http://127.0.0.1:4400/emulators", { signal: AbortSignal.timeout(1000) });
      const running = await response.json();
      if (running.firestore?.port === localCatalog.firestorePort) { ready = true; break; }
    } catch { /* Todavía está iniciando el emulador. */ }
    await delay(1000);
  }
  if (!ready) { if (stopping) process.exitCode = 0; else throw new Error("Firestore Emulator no inició a tiempo"); }
  else {
    const api = spawn(process.execPath, [fileURLToPath(new URL("./local-catalog-server.js", import.meta.url))],
      { cwd: projectDirectory, env, stdio: "inherit" });
    children.push(api);
    const ended = child => new Promise(resolve => {
      child.once("error", () => resolve(1));
      child.once("exit", code => resolve(code));
    });
    const code = await Promise.race([ended(api), ended(emulator)]);
    if (!stopping) process.exitCode = code ?? 1;
  }
} finally {
  stop();
  // Los procesos propios reciben SIGINT y disponen de tiempo para cerrar.
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined
    : new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      timeout.unref();
    })));
}
