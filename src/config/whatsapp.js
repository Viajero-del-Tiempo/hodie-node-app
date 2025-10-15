import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";

export const whatsappClient = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

whatsappClient.on("qr", (qr) => {
  console.log("📱 Escaneá este QR para iniciar sesión en WhatsApp:");
  qrcode.generate(qr, { small: true });
});

whatsappClient.on("ready", () => console.log("✅ WhatsApp listo"));
whatsappClient.on("disconnected", (reason) =>
  console.log("❌ Desconectado:", reason)
);

whatsappClient.on("message", async (mensaje) => {
  const texto = mensaje.body?.toLowerCase().trim();
  if (!texto) return;

  console.log(`📩 Mensaje recibido de ${mensaje.from}: ${mensaje.body}`);

  switch (texto) {
    case "hola":
      await mensaje.reply("¡Hola! 👋 ¿Cómo estás?");
      break;
    case "precio":
      await mensaje.reply(
        "💰 Nuestros precios están disponibles en: https://hodie.com.py"
      );
      break;
    case "catálogo":
      await mensaje.reply(
        "🛍️ Aquí tenés nuestro catálogo completo: https://hodie.com.py"
      );
      break;
    case "buenos días":
      await mensaje.reply(
        "☀️ ¡Muy buenos días! Espero que tengas un excelente día 😊"
      );
      break;
    case "buen día":
    case "buen dia":
      await mensaje.reply("☀️ ¡buen día! En qué puedo ayudarte?");
      break;
    case "gracias":
      await mensaje.reply("¡De nada! 😊");
      break;
    case "chau":
    case "adiós":
    case "hasta luego":
      await mensaje.reply("👋 ¡Hasta luego! Que tengas un excelente día.");
      break;

    default:
      await mensaje.reply(
        "📦 Si querés ver nuestro catálogo, escribí *catálogo* o hacé clic en este enlace:\nhttps://hodie.com.py"
      );
      break;
  }
});

await whatsappClient.initialize();
