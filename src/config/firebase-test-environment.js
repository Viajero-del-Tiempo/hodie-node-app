// Regla única para cualquier inicialización Firebase de tests. Sin SDK ni dotenv.
export function isFirebaseTestProcess(env = process.env, argv = process.argv) {
  return env.HODIE_TEST_MODE === "1" || env.NODE_ENV === "test" || Boolean(env.NODE_TEST_CONTEXT)
    || argv.some(value => /(?:^|[\\/])test[\\/]/u.test(value) || /(?:^|[\\/])scripts[\\/]test-[^\\/]+\.js$/u.test(value));
}

export function requireTestFirestore(env = process.env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (typeof host !== "string" || !host.trim()) {
    throw Object.assign(new Error("Tests Firebase bloqueados: falta FIRESTORE_EMULATOR_HOST. Levantá el emulador; los tests nunca admiten producción ni ALLOW_PROD_FIRESTORE_TESTS."), { code: "TEST_FIRESTORE_EMULATOR_REQUIRED" });
  }
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/u.exec(host);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error("Los tests requieren FIRESTORE_EMULATOR_HOST local (localhost o loopback, con puerto válido)");
  }
  const projectId = env.CATALOG_TEST_PROJECT_ID || env.GCLOUD_PROJECT || "demo-hodie-catalogo";
  if (!/^demo-[a-z0-9-]+$/u.test(projectId) || env.GCLOUD_PROJECT && env.GCLOUD_PROJECT !== projectId
      || env.CATALOG_TEST_PROJECT_ID && env.CATALOG_TEST_PROJECT_ID !== projectId) {
    throw new Error("Los tests Firebase solo admiten un proyecto demo-* coherente; nunca un projectId real");
  }
  env.GCLOUD_PROJECT = projectId; env.CATALOG_TEST_PROJECT_ID = projectId;
  // El SDK del emulador no debe descubrir archivos de credenciales/ADC del usuario.
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.FIREBASE_SERVICE_ACCOUNT_PATH;
  delete env.FIREBASE_CONFIG_BASE64;
  return { host, projectId };
}

export function assertFirebaseTestInitialization(options, env = process.env) {
  const target = requireTestFirestore(env);
  if (options?.credential || options?.projectId && options.projectId !== target.projectId) {
    throw new Error("Un test no puede inicializar Firebase con credenciales ni proyecto reales");
  }
  return { ...options, projectId: target.projectId };
}
