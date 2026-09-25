import { Timestamp } from "firebase-admin/firestore";

/**
 * Convierte de manera uniforme cualquier representación de fecha a una instancia nativa Date.
 * Maneja:
 * - Firestore Timestamp (instancia o duck-typed con .toDate())
 * - Firestore Timestamp serializado ({ _seconds, _nanoseconds } o { seconds, nanoseconds })
 * - Objeto plano { seconds }
 * - Timestamp numérico en milisegundos (13 dígitos) o segundos (10 dígitos)
 * - Date nativo de JavaScript
 * - String ISO o numérico
 *
 * @param {any} value
 * @returns {Date | null}
 */
export const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;

  // 1. Instancia nativa de Date
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  // 2. Instancia de Firestore Timestamp o con método .toDate()
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch {
      // Fallback si toDate() falla
    }
  }

  // 3. Objeto Firestore serializado ({ _seconds, _nanoseconds } o { seconds, nanoseconds })
  if (typeof value === "object") {
    const sec = value._seconds !== undefined ? value._seconds : value.seconds;
    const nanosec =
      value._nanoseconds !== undefined
        ? value._nanoseconds
        : value.nanoseconds || 0;

    if (typeof sec === "number") {
      return new Date(sec * 1000 + Math.floor(nanosec / 1000000));
    }
  }

  // 4. Número
  if (typeof value === "number" && !isNaN(value)) {
    // 10 dígitos: segundos (época Unix estándar)
    if (value < 10000000000) {
      return new Date(value * 1000);
    }
    // 13 dígitos: milisegundos
    return new Date(value);
  }

  // 5. String
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const num = Number(value);
      return toDate(num);
    }
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

/**
 * Convierte cualquier representación de fecha a una instancia genuina de Firestore Timestamp.
 * Si el valor ya es Timestamp, lo devuelve intacto.
 * Si es nulo o indefinido, devuelve Timestamp.now() si fallbackToNow es true.
 *
 * @param {any} value
 * @param {boolean} [fallbackToNow=true]
 * @returns {Timestamp | null}
 */
export const toFirestoreTimestamp = (value, fallbackToNow = true) => {
  if (value instanceof Timestamp) return value;
  if (
    value &&
    typeof value.toDate === "function" &&
    typeof value.toMillis === "function"
  ) {
    return value;
  }

  const d = toDate(value);
  if (d) {
    return Timestamp.fromDate(d);
  }

  if (fallbackToNow) {
    return Timestamp.now();
  }

  return null;
};
