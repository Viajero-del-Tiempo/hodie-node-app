import "dotenv/config";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

let app;

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (process.env.LOCAL_CATALOG_MODE === "1" && (emulatorHost !== "127.0.0.1:8080" || process.env.GCLOUD_PROJECT !== "demo-hodie-catalogo")) {
  throw new Error("El catálogo local exige Firestore Emulator y el proyecto demo-hodie-catalogo");
}

if (getApps().length === 0 && emulatorHost) {
  // El SDK dirige las solicitudes al emulador. No se leen certificados ni ADC.
  const projectId = process.env.GCLOUD_PROJECT || process.env.CATALOG_TEST_PROJECT_ID;
  if (!projectId) throw new Error("El emulador requiere un projectId explícito");
  app = initializeApp({ projectId });
} else if (getApps().length === 0) {
  let serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    ? path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
    : path.join(process.cwd(), "serviceAccountKey.json");

  // Detección automática amigable: si no existe con el nombre exacto,
  // busca si colocaron el archivo con su nombre original descargado de Firebase Console
  if (!fs.existsSync(serviceAccountPath)) {
    try {
      const detectedFile = fs
        .readdirSync(process.cwd())
        .find(
          (file) =>
            file.endsWith(".json") &&
            (file.includes("firebase-adminsdk") || file.includes("serviceAccount"))
        );
      if (detectedFile) {
        serviceAccountPath = path.join(process.cwd(), detectedFile);
      }
    } catch (_) {}
  }

  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      app = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });
      console.log(`🔥 Firebase Admin inicializado correctamente con ${path.basename(serviceAccountPath)} (Proyecto: ${serviceAccount.project_id})`);
    } catch (err) {
      console.warn(
        `⚠️ Error leyendo archivo de credenciales (${serviceAccountPath}):`,
        err.message
      );
      app = initializeApp();
    }
  } else if (process.env.FIREBASE_CONFIG_BASE64) {
    try {
      const serviceAccount = JSON.parse(
        Buffer.from(process.env.FIREBASE_CONFIG_BASE64, "base64").toString("utf8")
      );
      app = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id,
      });
      console.log(`🔥 Firebase Admin inicializado desde FIREBASE_CONFIG_BASE64 (Proyecto: ${serviceAccount.project_id})`);
    } catch (err) {
      console.warn("⚠️ Error parseando FIREBASE_CONFIG_BASE64:", err.message);
      app = initializeApp();
    }
  } else {
    // Modo local / emulador / Google Application Default Credentials
    app = initializeApp();
    console.log("🔥 Firebase Admin inicializado con credenciales por defecto de entorno");
  }
} else {
  app = getApps()[0];
  if (emulatorHost && app.options.projectId !== (process.env.GCLOUD_PROJECT || process.env.CATALOG_TEST_PROJECT_ID)) {
    throw new Error("La aplicación Firebase existente no corresponde al proyecto del emulador");
  }
}

export const db = getFirestore(app);
export { app };
