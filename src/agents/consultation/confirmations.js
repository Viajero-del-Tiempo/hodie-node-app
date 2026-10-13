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
