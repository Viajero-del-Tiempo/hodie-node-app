import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";

export const whatsappClient = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./sessions",
    clientId: "client-one",
  }),
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
      "--disable-software-rasterizer",
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

whatsappClient.on("ready", async () => {
  console.log("✅ WhatsApp listo");
  console.log(
    "📌 WhatsApp Web Version:",
    await whatsappClient.getWWebVersion(),
  );
});

whatsappClient.on("message", async (mensaje) => {
  try {
    if (!mensaje.body) return;

    // Usamos mensaje.from directamente para evitar el bug de compatibilidad de whatsapp-web.js con WA Web 2.3000.x-alpha
    // (mensaje.getChat() llama internamente a Client.getChatById que falla en Puppeteer evaluate con error 'r: r')
    const chatId = mensaje.from;
    const texto = mensaje.body.toLowerCase().trim();

    switch (texto) {
      case "hola":
        await whatsappClient.sendMessage(chatId, "Hola 👋", {
          quotedMessageId: mensaje.id._serialized,
          sendSeen: false,
        });
        break;
      case "info":
        await whatsappClient.sendMessage(
          chatId,
          "ℹ️ Podés encontrar más información en nuestro sitio web: https://hodie.com.py",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "ubicación":
      case "ubicacion":
        await whatsappClient.sendMessage(
          chatId,
          "📍 Nos encontramos en la ciudad de Minga Guazú, Alto Paraná - Paraguay. Realizamos envíos a todo el país. Para ver nuestro catálogo completo, visitá: https://hodie.com.py",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "precios":
      case "precio":
      case "¿precios?":
      case "¿precio?":
        await whatsappClient.sendMessage(
          chatId,
          "💰 Nuestros precios están disponibles en: https://hodie.com.py",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "catalogo":
      case "catálogo":
        await whatsappClient.sendMessage(
          chatId,
          "🛍️ Aquí tenés nuestro catálogo completo: https://hodie.com.py",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "buenos dias":
      case "buenos días":
        await whatsappClient.sendMessage(
          chatId,
          "☀️ ¡Muy buenos días! ¿En qué puedo ayudarte hoy?😊",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "buen día":
      case "buen dia":
        await whatsappClient.sendMessage(
          chatId,
          "☀️ ¡buen día! En qué puedo ayudarte?",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "buenas tardes":
        await whatsappClient.sendMessage(
          chatId,
          "🌇 ¡Buenas tardes! ¿En qué puedo ayudarte?",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "buenas noches":
        await whatsappClient.sendMessage(
          chatId,
          "🌙 ¡Buenas noches! ¿En qué puedo ayudarte? 😊",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "gracias":
        await whatsappClient.sendMessage(chatId, "¡De nada! 😊", {
          quotedMessageId: mensaje.id._serialized,
          sendSeen: false,
        });
        break;
      case "chau":
      case "adiós":
      case "adios":
      case "hasta luego":
        await whatsappClient.sendMessage(
          chatId,
          "👋 ¡Hasta luego! Que tengas un excelente día.",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      case "ayuda":
        await whatsappClient.sendMessage(
          chatId,
          "🆘 Para asistencia, visitá: https://hodie.com.py",
          {
            quotedMessageId: mensaje.id._serialized,
            sendSeen: false,
          },
        );
        break;
      default:
        break;
    }
    console.log("Mensaje recibido:", mensaje.body, "de:", mensaje.from);
  } catch (error) {
    console.error("Error processing message:", error);
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
