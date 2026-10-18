import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requireTestFirestore } from "../src/config/firebase-test-environment.js";

const cwd = fileURLToPath(new URL("../", import.meta.url));
export async function runIsolatedEmulatorSuite(file, { env = process.env, seedLegacy = false } = {}) {
  const { host } = requireTestFirestore(env);
  const project = "demo-hodie-test-" + randomUUID().replaceAll("-", "").slice(0, 10);
  const bank = JSON.parse(await readFile(new URL("./fixtures/agent-bank.json", import.meta.url), "utf8"));
  const childEnv = { ...env, HODIE_TEST_MODE: "1", LOCAL_CATALOG_MODE: "0", GCLOUD_PROJECT: project, CATALOG_TEST_PROJECT_ID: project,
    AGENT_ENABLED: "false", AGENT_MAINTENANCE_MODE: "message", JWT_SECRET: randomBytes(48).toString("base64url"),
    DOTENV_CONFIG_PATH: fileURLToPath(new URL("../scripts/emulator.env", import.meta.url)),
    BANK_NAME: bank.bankName, BANK_ACCOUNT_HOLDER: bank.accountHolder, BANK_DOCUMENT_ID: bank.documentId,
    BANK_ACCOUNT_NUMBER: bank.accountNumber, BANK_CURRENCY: bank.currency, BANK_ALIAS: bank.alias };
  console.log(`\n=== ${file} | emulador ${host} | ${project} ===`);
  let status = 1;
  try {
    status = await new Promise(resolve => {
      const child = spawn(process.execPath, ["--import", seedLegacy ? "./test/legacy-bootstrap.js" : "./test/firebase-bootstrap.js", file], { cwd, env: childEnv, stdio: "inherit" });
      child.once("error", error => { console.error(error.message); resolve(1); });
      child.once("exit", code => resolve(code ?? 1));
    });
  } finally {
    // Exclusivamente el proyecto generado aquí; nunca el catálogo demo compartido.
    const response = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, {
      method: "DELETE", signal: AbortSignal.timeout(5000),
    }).catch(error => { console.error("No se pudo limpiar el proyecto aislado del emulador:", error.message); return null; });
    if (!response?.ok) {
      if (response) console.error(`Limpieza del proyecto ${project} rechazada por el emulador: HTTP ${response.status}`);
      status = 1;
    }
  }
  return status;
}
