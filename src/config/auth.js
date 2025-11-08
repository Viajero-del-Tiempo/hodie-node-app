// src/config/auth.js

// Tiempo en minutos que el código de verificación es válido.
export const CODE_EXPIRATION_MINUTES = 5;

// Ventana de tiempo en minutos para el límite de solicitudes.
export const RATE_LIMIT_WINDOW_MINUTES = 60; // 1 hora

// Número máximo de solicitudes de código permitidas dentro de la ventana de tiempo.
export const MAX_CODE_REQUESTS = 5;
