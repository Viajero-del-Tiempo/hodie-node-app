export class CustomerDataError extends Error {
  constructor(field, message, statusCode = 400, details = {}) {
    super(message);
    this.name = "CustomerDataError";
    this.field = field;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export function objectInput(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerDataError(field, "Se requiere un objeto válido.");
  }
  return value;
}

export function textInput(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new CustomerDataError(field, "El campo debe ser texto.");
  const text = value.trim();
  if (text.length > max) throw new CustomerDataError(field, `El campo supera el máximo de ${max} caracteres.`);
  if (required && !text) throw new CustomerDataError(field, "Completá este campo.");
  return text;
}

export function booleanInput(value, field, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new CustomerDataError(field, "El campo debe ser verdadero o falso.");
  return value;
}

export function sendCustomerError(res, error) {
  const status = error.statusCode ?? error.status;
  if (status && status < 500) {
    const details = Object.fromEntries(["field", "code", "suggestedRuc", "expectedDigit", "requiresConfirmation", "changes"]
      .filter(key => error[key] !== undefined).map(key => [key, error[key]]));
    return res.status(status).json({ error: error.message, ...details });
  }
  console.error("Error en datos del cliente:", error.message);
  return res.status(500).json({ error: "No se pudieron procesar los datos." });
}
