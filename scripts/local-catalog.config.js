import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
export const localCatalog = Object.freeze({
  projectId: "demo-hodie-catalogo", host: "127.0.0.1", firestorePort: 8080,
  apiPort: 3000, uiPort: 4000, hubPort: 4400,
});
export function readProductionSecret(directory = projectDirectory) {
  try { return parse(readFileSync(join(directory, ".env"))).JWT_SECRET; }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
export function makeLocalEnvironment({ inherited = process.env, productionSecret = readProductionSecret(), generateSecret = () => randomBytes(48).toString("base64url") } = {}) {
  const secret = generateSecret();
  if (!secret || secret === productionSecret || secret === inherited.JWT_SECRET) {
    throw new Error("El secreto JWT local debe ser propio y distinto al de producción");
  }
  return {
    ...inherited, LOCAL_CATALOG_MODE: "1", LOCAL_CATALOG_JWT_SECRET: secret, JWT_SECRET: secret,
    FIRESTORE_EMULATOR_HOST: localCatalog.host + ":" + localCatalog.firestorePort,
    GCLOUD_PROJECT: localCatalog.projectId, CATALOG_TEST_PROJECT_ID: localCatalog.projectId,
    // Evita que imports diferidos vuelvan a cargar las credenciales de .env.
    DOTENV_CONFIG_PATH: fileURLToPath(new URL("./emulator.env", import.meta.url)),
  };
}
export function assertLocalEnvironment(env, productionSecret = readProductionSecret()) {
  if (env.LOCAL_CATALOG_MODE !== "1" || env.GCLOUD_PROJECT !== localCatalog.projectId
      || env.FIRESTORE_EMULATOR_HOST !== localCatalog.host + ":" + localCatalog.firestorePort) {
    throw new Error("Se requiere el proyecto demo y Firestore Emulator local; no se cargaron datos");
  }
  if (!env.LOCAL_CATALOG_JWT_SECRET || env.JWT_SECRET !== env.LOCAL_CATALOG_JWT_SECRET
      || env.JWT_SECRET === productionSecret) {
    throw new Error("El secreto JWT local debe ser propio y distinto al de .env");
  }
}
