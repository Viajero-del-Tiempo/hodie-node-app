import { createOrderConfirmationConfig, normalizeConfirmationWords } from "./order-confirmation.config.js";

// Vocabulario del idioma, no del negocio. Aceptación conservadora de un mensaje
// completo: una afirmación seguida de cambios no autoriza confirmar datos.
const normalize = value => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().trim()
  .replace(/[¡!¿?.,;:]/gu, " ").replace(/\s+/gu, " ").trim();
const clientText = turn => turn.messages.map(message => message.text.replace(/^\[audio transcripto\]\s*/u, "")).join("\n").trim();
export function acceptsPending(pending, turn, value) {
  if (!pending?.shown || !turn || !Number.isSafeInteger(turn.sequence) || !Number.isSafeInteger(pending.shownSequence)
      || pending.shownSequence >= turn.sequence || pending.shownBatchId === turn.id) return false;
  const text = clientText(turn);
  if (value && text === value) return true; // Repetición literal solicitada.
  return /^(si|si confirmo|confirmo|si esta bien|esta bien|correcto|tal cual|asi mismo|acepto|continuar igual|si continuar igual)$/u.test(normalize(text));
}
export function acceptsRucMismatch(pending, turn) {
  // «Sí» ante «corregir o continuar» no dice qué opción eligió.
  if (!pending?.shown || !turn || !Number.isSafeInteger(turn.sequence) || !Number.isSafeInteger(pending.shownSequence)
      || pending.shownSequence >= turn.sequence || pending.shownBatchId === turn.id) return false;
  const text = clientText(turn);
  return text === pending.input || /^(continuar igual|si continuar igual|quiero continuar igual|confirmo continuar igual|acepto usarlo|confirmo usarlo|si usarlo asi|si continuar con ese ruc|continuar con el ruc ingresado)$/u.test(normalize(text));
}
export function wasProvided(text, turn) {
  return Boolean(turn?.messages.some(message => message.text.includes(text)));
}
export function pendingTextFor(cart) {
  const line = cart?.lines.find(line => line.customization.textDraft !== null);
  return line ? { kind: "text", lineId: line.id, value: line.customization.textDraft, cartId: cart.id } : null;
}

const affirmativeEmojis = /👍[\u{1f3fb}-\u{1f3ff}]?|✅|🙌[\u{1f3fb}-\u{1f3ff}]?|🙂|😊|🙏[\u{1f3fb}-\u{1f3ff}]?|❤\ufe0f?|🎉/gu;
export function isOrderAffirmation(text, config = createOrderConfirmationConfig({})) {
  // No borrar signos de pregunta ni emojis de duda/negación para aceptarlos.
  if (typeof text !== "string" || /[¿?❓❔]/u.test(text)) return false;
  const normalized = normalizeConfirmationWords(text.replace(affirmativeEmojis, " "));
  if (!normalized) return false;
  const words = normalized.split(" ");
  const entries = [...config.affirmations.map(value => ({ words: value.split(" "), affirmative: true })),
    ...config.neutralAdditions.map(value => ({ words: value.split(" "), affirmative: false }))];
  const visited = new Set();
  function accepts(index, affirmative) {
    if (index === words.length) return affirmative;
    const key = index + ":" + affirmative;
    if (visited.has(key)) return false;
    visited.add(key);
    return entries.some(entry => entry.words.every((word, offset) => words[index + offset] === word)
      && accepts(index + entry.words.length, affirmative || entry.affirmative));
  }
  return accepts(0, false);
}

export function acceptsOrderConfirmation(pending, turn, config) {
  if (!pending || !turn || !Number.isSafeInteger(turn.sequence) || !Number.isSafeInteger(pending.shownSequence)
      || pending.shownSequence >= turn.sequence || pending.shownBatchId === turn.id || !turn.messages?.length) return false;
  if (turn.messages.some(message => typeof message.text !== "string" || !["chat", "text", "audio", "ptt"].includes(message.type))) return false;
  return isOrderAffirmation(clientText(turn), config);
}

export function clientAskedQuestion(turn) {
  return Boolean(turn?.messages?.some(message => /[¿?❓❔]/u.test(message.text)
    || /^(cuanto|cuando|como|donde|que|quien|cual|por que|quisiera saber|quiero saber|me podes decir)\b/u
      .test(normalizeConfirmationWords(message.text))));
}
