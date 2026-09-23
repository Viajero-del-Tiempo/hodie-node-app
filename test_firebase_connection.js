import "dotenv/config";
import fs from "fs";
import path from "path";
import { db } from "./src/config/firebase.js";

async function testRealFirebaseConnection() {
  console.log("=================================================");
  console.log("🔍 TEST DE CONEXIÓN REAL A FIREBASE FIRESTORE");
  console.log("=================================================\n");

  const expectedKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
  const resolvedKeyPath = path.resolve(process.cwd(), expectedKeyPath);

  // 1. Verificar existencia física del archivo de credenciales
  const keyExists = fs.existsSync(resolvedKeyPath);
  console.log(`📁 Archivo de credenciales configurado: ${resolvedKeyPath}`);
  console.log(`📄 ¿Archivo existe en disco?: ${keyExists ? "✅ SÍ" : "❌ NO"}\n`);

  if (!keyExists) {
    console.error("❌ ERROR: No se encontró el archivo de credenciales de la cuenta de servicio.");
    console.error("👉 Por favor genera y descarga la clave desde Firebase Console:");
    console.error("   Configuración del proyecto > Cuentas de servicio > Generar nueva clave privada");
    console.error(`   Y colócala en: ${resolvedKeyPath}\n`);
    process.exit(1);
  }

  try {
    const keyData = JSON.parse(fs.readFileSync(resolvedKeyPath, "utf8"));
    console.log(`🏷️  Proyecto ID en Service Account: ${keyData.project_id}`);
    console.log(`📧 Client Email: ${keyData.client_email}\n`);

    console.log("⏳ Conectando y leyendo colección 'products' en Firestore...");
    const productsSnap = await db.collection("products").limit(3).get();
    console.log(`✅ Conexión exitosa a 'products'. Documentos leídos: ${productsSnap.size}`);
    productsSnap.forEach((doc) => {
      const data = doc.data();
      console.log(`   📦 [${doc.id}] ${data.name || "(Sin nombre)"} - Precio: ${data.price || 0} Gs. - Stock: ${data.stock ?? "N/A"}`);
    });

    console.log("\n⏳ Conectando y leyendo colección 'orders' en Firestore...");
    const ordersSnap = await db.collection("orders").limit(3).get();
    console.log(`✅ Conexión exitosa a 'orders'. Documentos leídos: ${ordersSnap.size}`);
    ordersSnap.forEach((doc) => {
      const data = doc.data();
      console.log(`   📋 [${doc.id}] Pedido #${data.orderNumber || "S/N"} - Cliente: ${data.userDisplayName || data.userPhoneNumber} - Estado: ${data.status}`);
    });

    console.log("\n=================================================");
    console.log("🎉 ¡CONEXIÓN REAL A FIRESTORE CONFIRMADA Y OPERATIVA!");
    console.log("=================================================");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Error durante la conexión real a Firestore:");
    console.error(err);
    process.exit(1);
  }
}

testRealFirebaseConnection();
