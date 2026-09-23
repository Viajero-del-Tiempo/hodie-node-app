import "dotenv/config";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

let app;

if (getApps().length === 0) {
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
}

export const db = getFirestore(app);
export { app };
