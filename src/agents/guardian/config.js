const MB = 1024 * 1024;
const fields = {
  silenceMs: ["AGENT_BURST_SILENCE_MS", 8000, 1, 30000],
  burstMaxMs: ["AGENT_BURST_MAX_MS", 30000, 1, 120000],
  sessionMs: ["AGENT_SESSION_MS", 6 * 60 * 60 * 1000, 60000, 7 * 24 * 60 * 60 * 1000],
  turnsPerHour: ["AGENT_TURNS_PER_HOUR", 40, 1, 1000],
  turnTimeoutMs: ["AGENT_TURN_TIMEOUT_MS", 60000, 1, 60000],
  audioMaxSeconds: ["AGENT_AUDIO_MAX_SECONDS", 120, 1, 120],
  audioFallbackBytes: ["AGENT_AUDIO_FALLBACK_BYTES", 2 * MB, 1, 2 * MB],
  imageMaxBytes: ["AGENT_IMAGE_MAX_BYTES", 5 * MB, 1, 5 * MB],
  imagesPerTurn: ["AGENT_IMAGES_PER_TURN", 3, 1, 3],
  totalMediaBytes: ["AGENT_TOTAL_MEDIA_BYTES", 10 * MB, 1, 10 * MB],
};
export function createGuardianConfig(env = {}, overrides = {}) {
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(fields, key)) throw new Error("Configuración desconocida: " + key);
  const config = { windowMs: 60 * 60 * 1000 };
  for (const [key, [variable, fallback, min, max]] of Object.entries(fields)) {
    const raw = overrides[key] ?? env[variable] ?? fallback;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(variable + " fuera de rango (" + min + ".." + max + ")");
    config[key] = value;
  }
  if (config.silenceMs > config.burstMaxMs) throw new Error("El silencio no puede superar el máximo de ráfaga");
  if (config.imageMaxBytes > config.totalMediaBytes || config.audioFallbackBytes > config.totalMediaBytes) {
    throw new Error("El límite individual no puede superar el total de medios");
  }
  return Object.freeze(config);
}
