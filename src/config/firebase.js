import admin from 'firebase-admin';
import dotenv from 'dotenv';
dotenv.config();

// IMPORTANTE:
// 1. Ve a tu consola de Firebase -> Configuración del proyecto -> Cuentas de servicio.
// 2. Haz clic en "Generar nueva clave privada" y guarda el archivo JSON.
// 3. Copia TODO el contenido de ese archivo JSON en una única línea.
// 4. Pega esa línea en tu archivo .env como el valor de FIREBASE_SERVICE_ACCOUNT_KEY_JSON.
//
// Ejemplo en .env:
// FIREBASE_SERVICE_ACCOUNT_KEY_JSON={"type":"service_account","project_id":"...", ...}

// Lee la variable de entorno que contiene el JSON de la clave de servicio.
const serviceAccountKeyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON;

if (!serviceAccountKeyJson) {
  throw new Error(
    "La variable de entorno FIREBASE_SERVICE_ACCOUNT_KEY_JSON no está definida. Por favor, configúrala en tu archivo .env."
  );
}

// Parsea el JSON string a un objeto JavaScript.
const serviceAccount = JSON.parse(serviceAccountKeyJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export const db = admin.firestore();
console.log('✅ Firebase conectado');
