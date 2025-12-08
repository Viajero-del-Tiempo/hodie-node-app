import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";

export const whatsappClient = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./sessions",
    clientId: "client-one",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
    bypassCSP: true,
   ignoreHTTPSErrors: true,
  },
  authTimeoutMs: 60000,
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
    case "info":
      await mensaje.reply(
        "ℹ️ Podés encontrar más información en nuestro sitio web: https://hodie.com.py"
      );
      break;
    case "ubicación":
    case "ubicacion":
      await mensaje.reply(
        "📍 Nos encontramos en Chaco Boreal 1021 casi Capitán Dominguez, Caacupé, Paraguay."
      );
      break;
    case "precios":
    case "precio":
      await mensaje.reply(
        "💰 Nuestros precios están disponibles en: https://hodie.com.py"
      );
      break;
    case "catalogo":
    case "catálogo":
      await mensaje.reply(
        "🛍️ Aquí tenés nuestro catálogo completo: https://hodie.com.py"
      );
      break;
    case "buenos dias":
    case "buenos días":
      await mensaje.reply("☀️ ¡Muy buenos días! ¿En qué puedo ayudarte hoy?😊");
      break;
    case "buen día":
    case "buen dia":
      await mensaje.reply("☀️ ¡buen día! En qué puedo ayudarte?");
      break;
    case "buenas tardes":
      await mensaje.reply("🌇 ¡Buenas tardes! ¿En qué puedo ayudarte?");
      break;
    case "buenas noches":
      await mensaje.reply("🌙 ¡Buenas noches! ¿En qué puedo ayudarte? 😊");
      break;
    case "gracias":
      await mensaje.reply("¡De nada! 😊");
      break;
    case "chau":
    case "adiós":
    case "adios":
    case "hasta luego":
      await mensaje.reply("👋 ¡Hasta luego! Que tengas un excelente día.");
      break;
    case "ayuda":
      await mensaje.reply("🆘 Para asistencia, visitá: https://hodie.com.py");
      break;
    default:
      break;
  }
});

export const initializeWhatsapp = async () => {
  try {
    await whatsappClient.initialize();
  } catch (error) {
    console.error("Error initializing WhatsApp client:", error);
  }
};

export { MessageMedia };
