import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

/**
 * Fábrica centralizada de clientes LLM Gemini para el proyecto HoDie.
 * Lee exclusivamente las variables de entorno GEMINI_API_KEY y GEMINI_MODEL.
 *
 * @param {Object} [options={}]
 * @param {number} [options.temperature=0] - Temperatura de muestreo (default: 0)
 * @param {number} [options.thinkingBudget] - Presupuesto de pensamiento (0 para desactivar razonamiento extendido)
 * @returns {ChatGoogleGenerativeAI}
 */
export const createGeminiModel = ({ temperature = 0, thinkingBudget } = {}) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY no configurada en variables de entorno");
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  const config = {
    model: modelName,
    apiKey,
    temperature,
  };

  if (typeof thinkingBudget === "number") {
    config.thinkingConfig = {
      thinkingBudget,
    };
  }

  return new ChatGoogleGenerativeAI(config);
};
