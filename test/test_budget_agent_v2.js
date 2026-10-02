if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:unit).");
  process.exit(1);
}

import { HumanMessage } from "@langchain/core/messages";
import {
  budgetAgentNode,
  calculateQuoteTotals,
  extractQuantity,
} from "../src/agents/nodes/budget.node.js";
import { generateUniqueOrderNumber } from "../src/services/order.service.js";
import { db } from "../src/config/firebase.js";
import { whatsappClient } from "../src/config/whatsapp.js";

// Mock de envío de WhatsApp para entorno de pruebas
whatsappClient.sendMessage = async (to, msg) => {
  return { id: { id: "test-msg-id", fromMe: true } };
};

async function runTests() {
  console.log("=================================================");
  console.log("🧪 BATERÍA DE PRUEBAS - BUDGET AGENT v2");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  const assert = (condition, title, details = "") => {
    if (condition) {
      console.log(`✅ [PASS] ${title}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${title} - ${details}`);
      failed++;
    }
  };

  // -------------------------------------------------------------
  // TEST (A): QUÉ PASA SI FIRESTORE FALLA AL PEDIR PRODUCTOS O ESTÁ VACÍO
  // -------------------------------------------------------------
  console.log("--- TEST (A): Manejo de catálogo vacío o falla de Firestore ---");
  {
    const stateWithNoProducts = {
      messages: [new HumanMessage("Hola, quiero cotizar un regalo")],
      userPhoneNumber: "595981222333",
      user: { displayName: "Ana Gómez" },
      quoteContext: { step: "idle", quantity: 1 },
    };

    const originalCollection = db.collection.bind(db);
    db.collection = (colName) => {
      if (colName === "products") {
        return {
          where: () => ({
            get: async () => ({ empty: true, docs: [] }),
          }),
          get: async () => ({ empty: true, docs: [] }),
        };
      }
      return originalCollection(colName);
    };

    try {
      const result = await budgetAgentNode(stateWithNoProducts);
      assert(
        result.humanHandoffRequired === true,
        "Test A.1: Activa humanHandoffRequired: true ante catálogo vacío"
      );
      assert(
        result.activeAgent === null,
        "Test A.2: activeAgent queda en null (no retiene el control)"
      );
      assert(
        result.humanHandoffReason?.includes("Catálogo de productos no disponible"),
        "Test A.3: Motivo de handoff refleja indisponibilidad de catálogo en Firestore",
        result.humanHandoffReason
      );
      assert(
        result.messages[0].content.includes("no puedo acceder a nuestro catálogo") &&
        result.messages[0].content.includes("asesor"),
        "Test A.4: Mensaje al cliente explica amablemente la situación y deriva a un asesor"
      );
      assert(
        !result.messages[0].content.includes("Taza Mágica") &&
        !result.messages[0].content.includes("Termo"),
        "Test A.5: NUNCA ofrece catálogo simulado ni datos hardcodeados ficticios"
      );
    } finally {
      db.collection = originalCollection;
    }
  }

  // -------------------------------------------------------------
  // TEST (B): VERIFICACIÓN DE UNICIDAD Y NO COLISIÓN DE orderNumber
  // -------------------------------------------------------------
  console.log("\n--- TEST (B): Generación atómica de orderNumber sin colisiones ---");
  {
    let currentLastOrder = 10025;
    const originalRunTransaction = db.runTransaction.bind(db);

    db.runTransaction = async (updateFunction) => {
      const mockTransaction = {
        get: async (docRef) => ({
          exists: true,
          data: () => ({ lastOrderNumber: currentLastOrder }),
        }),
        set: (docRef, data) => {
          if (data.lastOrderNumber) {
            currentLastOrder = data.lastOrderNumber;
          }
        },
      };
      return await updateFunction(mockTransaction);
    };

    try {
      const promises = Array.from({ length: 20 }, () => generateUniqueOrderNumber());
      const results = await Promise.all(promises);

      const uniqueSet = new Set(results);
      assert(
        results.length === 20 && uniqueSet.size === 20,
        "Test B.1: 20 llamadas concurrentes generan 20 números de orden estrictamente únicos",
        `Generados: ${results.length}, Únicos: ${uniqueSet.size}`
      );

      const isSequential = results.every((num, idx) => {
        return Number(String(num).replace(/^hodie0*/i, "")) === 10026 + idx;
      });
      assert(
        isSequential,
        "Test B.2: La numeración es correlativa y secuencial (10026, 10027, ..., 10045)",
        `Secuencia: ${results.slice(0, 5).join(", ")} ... ${results.slice(-1)[0]}`
      );
    } finally {
      db.runTransaction = originalRunTransaction;
    }
  }

  // -------------------------------------------------------------
  // TEST (C): EXTRACCIÓN DE CANTIDAD PARA PRODUCTOS HIPOTÉTICOS
  // -------------------------------------------------------------
  console.log("\n--- TEST (C): Extracción de cantidad agnóstica de productos ---");
  {
    const cases = [
      { input: "Quiero 3 mates artesanales de algarrobo", expected: 3, label: "Quiero 3 mates" },
      { input: "Necesito 5 llaveros grabados en madera", expected: 5, label: "Necesito 5 llaveros" },
      { input: "Serían 4 agendas personalizadas 2026", expected: 4, label: "Serían 4 agendas" },
      { input: "Set matero personalizado x 6", expected: 6, label: "x 6 multiplicador" },
      { input: "Posavasos grabados cantidad: 8", expected: 8, label: "cantidad: 8 explícito" },
      { input: "12 unidades de botellas térmicas", expected: 12, label: "12 unidades al inicio" },
      { input: "Me gustaría 2 piezas para regalo", expected: 2, label: "2 piezas" },
      { input: "Quiero un mate artesanal", expected: null, label: "Mención sin número -> null (default 1)" },
      { input: "2", expected: null, label: "Número de opción aislado '2' -> no contamina cantidad" },
      { input: "Hola, me interesa el termo", expected: null, label: "Sin cantidad -> null" },
    ];

    for (const c of cases) {
      const extracted = extractQuantity(c.input);
      assert(
        extracted === c.expected,
        `Test C: ${c.label} -> Extrajo: ${extracted} (Esperado: ${c.expected})`
      );
    }
  }

  // -------------------------------------------------------------
  // TEST (D): NUEVO FLUJO DE DATOS DE ENVÍO PASO A PASO
  // -------------------------------------------------------------
  console.log("\n--- TEST (D): Flujo secuencial de datos de envío (shipping_info) ---");
  {
    const mockProducts = [
      {
        id: "prod-mate-01",
        name: "Mate Imperial Personalizado",
        sku: "MAT-001",
        price: 85000,
        stock: 15,
        packagingPrices: {
          caja: 20000,
          bolsa: 5000,
          estandar: 0,
        },
      },
    ];

    const originalCollection = db.collection.bind(db);
    const originalRunTransaction = db.runTransaction.bind(db);
    const mockOrders = new Map();
    db.collection = (colName) => {
      if (colName === "products") {
        return {
          doc: (id) => ({
            get: async () => {
              const p = mockProducts.find((x) => x.id === id);
              return { exists: Boolean(p), data: () => p };
            },
          }),
          where: () => ({
            get: async () => ({
              empty: false,
              docs: mockProducts.map((p) => ({ id: p.id, data: () => p })),
            }),
          }),
          get: async () => ({
            empty: false,
            docs: mockProducts.map((p) => ({ id: p.id, data: () => p })),
          }),
        };
      }
      if (colName === "orders") {
        return {
          doc: (id) => ({
            id,
            get: async () => ({
              id,
              exists: mockOrders.has(id),
              data: () => mockOrders.get(id),
            }),
            create: async (data) => {
              if (mockOrders.has(id)) {
                const error = new Error("El pedido simulado ya existe");
                error.code = 6;
                throw error;
              }
              mockOrders.set(id, { ...data });
              return { id, ...data };
            },
            set: async (data, options = {}) => {
              mockOrders.set(id, options.merge ? { ...mockOrders.get(id), ...data } : { ...data });
              return { id, ...data };
            },
            update: async (data) => {
              if (!mockOrders.has(id)) {
                const error = new Error("El pedido simulado no existe");
                error.code = 5;
                throw error;
              }
              mockOrders.set(id, { ...mockOrders.get(id), ...data });
              return { id, ...data };
            },
          }),
        };
      }
      return originalCollection(colName);
    };

    try {
      console.log("\n* Turno 1: packaging_selection -> transición a shipping_info (sub-paso name)");
      const stateT1 = {
        messages: [new HumanMessage("1")],
        userPhoneNumber: "595981555444",
        user: { uid: "usr-123", displayName: "María González" },
        quoteContext: {
          step: "packaging_selection",
          selectedProductId: "prod-mate-01",
          selectedProductName: "Mate Imperial Personalizado",
          selectedProductSku: "MAT-001",
          unitPrice: 85000,
          customizationDetails: "Grabado: 'Carlos 2026'",
          quantity: 2,
        },
      };

      const resT1 = await budgetAgentNode(stateT1);
      assert(
        resT1.quoteContext?.step === "shipping_info" &&
        resT1.quoteContext?.shippingStep === "name",
        "Test D.1: Transiciona a step 'shipping_info' con sub-paso 'name'",
        `Step: ${resT1.quoteContext?.step}, SubStep: ${resT1.quoteContext?.shippingStep}`
      );
      assert(
        resT1.messages[0].content.includes("nombre y apellido"),
        "Test D.2: Pide explícitamente el nombre y apellido del destinatario"
      );

      console.log("\n* Turno 2: Validación de nombre corto en sub-paso name");
      const stateT2_invalid = {
        messages: [new HumanMessage("A")],
        userPhoneNumber: "595981555444",
        quoteContext: {
          ...stateT1.quoteContext,
          ...resT1.quoteContext,
        },
      };
      const resT2_invalid = await budgetAgentNode(stateT2_invalid);
      assert(
        resT2_invalid.messages[0].content.includes("nombre y apellido completo"),
        "Test D.3: Rechaza input menor a 2 caracteres y vuelve a solicitar nombre"
      );

      console.log("\n* Turno 3: Envía nombre válido -> transición a sub-paso city");
      const stateT3 = {
        messages: [new HumanMessage("Carlos Benítez")],
        userPhoneNumber: "595981555444",
        quoteContext: {
          ...stateT1.quoteContext,
          ...resT1.quoteContext,
        },
      };
      const resT3 = await budgetAgentNode(stateT3);
      assert(
        resT3.quoteContext?.shippingStep === "city",
        "Test D.4: Avanza al sub-paso 'city'"
      );
      assert(
        resT3.quoteContext?.shippingAddress?.recipientName === "Carlos Benítez",
        "Test D.5: Almacena recipientName correctamente sin mezclarlo con otros campos"
      );
      assert(
        resT3.messages[0].content.includes("ciudad y departamento"),
        "Test D.6: Pregunta explícitamente por ciudad y departamento"
      );

      console.log("\n* Turno 4: Envía ciudad -> transición a sub-paso street");
      const stateT4 = {
        messages: [new HumanMessage("Caacupé, Cordillera")],
        userPhoneNumber: "595981555444",
        quoteContext: {
          ...stateT3.quoteContext,
          ...resT3.quoteContext,
        },
      };
      const resT4 = await budgetAgentNode(stateT4);
      assert(
        resT4.quoteContext?.shippingStep === "street",
        "Test D.7: Avanza al sub-paso 'street'"
      );
      assert(
        resT4.quoteContext?.shippingAddress?.city === "Caacupé" &&
        resT4.quoteContext?.shippingAddress?.department === "Cordillera",
        "Test D.8: Almacena ciudad y departamento estructurados"
      );
      assert(
        resT4.messages[0].content.includes("dirección exacta"),
        "Test D.9: Pregunta explícitamente por calle, número y referencias"
      );

      console.log("\n* Turno 5: Envía dirección -> transición a confirmation con resumen");
      const stateT5 = {
        messages: [new HumanMessage("Calle Boquerón c/ Curupayty, casa portón blanco")],
        userPhoneNumber: "595981555444",
        quoteContext: {
          ...stateT4.quoteContext,
          ...resT4.quoteContext,
        },
      };
      const resT5 = await budgetAgentNode(stateT5);
      assert(
        resT5.quoteContext?.step === "confirmation" &&
        resT5.quoteContext?.shippingStep === null,
        "Test D.10: Finaliza shipping_info y transiciona a step 'confirmation'"
      );
      assert(
        resT5.quoteContext?.shippingAddress?.street === "Calle Boquerón c/ Curupayty, casa portón blanco",
        "Test D.11: Almacena la dirección exacta completa"
      );
      assert(
        resT5.messages[0].content.includes("Carlos Benítez") &&
        resT5.messages[0].content.includes("Caacupé") &&
        resT5.messages[0].content.includes("Calle Boquerón"),
        "Test D.12: Mensaje de confirmación muestra todos los campos de envío organizados"
      );

      console.log("\n* Turno 6: Cliente confirma -> Verifica emisión con orderNumber secuencial y reset");
      const stateT6 = {
        messages: [new HumanMessage("Sí, confirmo")],
        userPhoneNumber: "595981555444",
        user: { uid: "usr-123", displayName: "María González" },
        quoteContext: {
          ...stateT5.quoteContext,
          ...resT5.quoteContext,
        },
      };

      db.runTransaction = async (fn) => {
        return await fn({
          get: async () => ({ exists: true, data: () => ({ lastOrderNumber: 20050 }) }),
          set: () => {},
        });
      };

      const resT6 = await budgetAgentNode(stateT6);
      assert(
        resT6.messages[0].content.includes("20051"),
        "Test D.13: Pedido generado con número secuencial atómico (#20051)"
      );
      assert(
        resT6.activeAgent === null,
        "Test D.14: activeAgent se libera (null) al finalizar la orden"
      );
      assert(
        resT6.quoteContext?.reset === true,
        "Test D.15: quoteContext dispara { reset: true } para limpiar el estado"
      );
    } finally {
      db.collection = originalCollection;
      db.runTransaction = originalRunTransaction;
    }
  }

  console.log("\n=================================================");
  console.log(`📊 RESULTADO FINAL: ${passed} PASADAS, ${failed} FALLIDAS`);
  console.log("=================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Error fatal en tests:", err);
  process.exit(1);
});
