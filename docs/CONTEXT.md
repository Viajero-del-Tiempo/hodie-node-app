Vas a trabajar en el proyecto HoDie, una tienda de regalos personalizados de
Paraguay. Este es un hilo nuevo: no asumas nada que no esté en este mensaje o
en el código. Leé todo antes de actuar.

# CONTEXTO DEL PROYECTO

## Repositorios
- hodie-node-app: backend Node.js 22 (ESM) + Express + LangGraph + whatsapp-web.js.
- hodie-tienda: frontend Angular (tienda + panel admin), en Firebase Hosting.

## Infraestructura
- VM GCP e2-micro (1 GB RAM + 2 GB swap), proceso pm2 "hodie-backend",
  Nginx + Certbot, dominio api.hodie.com.py (Cloudflare en modo DNS only).
- Deploy manual por GitHub Actions (workflow_dispatch):
  "cd ~/hodie-node-app && git pull origin main && bash deploy.sh".
  deploy.sh: npm ci → descarga de Chrome de puppeteer → verificación de que
  el parche de whatsapp-web.js esté aplicado → pm2 restart hodie-backend.
- Firestore de PRODUCCIÓN (proyecto hodie-tienda-de-regalos), accedido solo
  con Admin SDK. Reglas cerradas salvo lectura pública de products.
  Colecciones: products, orders, users, counters, langgraph_checkpoints,
  langgraph_checkpoint_writes, handoff_threads, lid_phone_map.

## WhatsApp
- whatsapp-web.js vendorizado en vendor/whatsapp-web.js-58ddf15.tgz, con el
  parche del PR #201925 aplicado por patch-package (postinstall).
- thread_id de LangGraph = whatsappChatId (@c.us o @lid).
- userPhoneNumber se resuelve con getContactLidAndPhone + caché en
  lid_phone_map. NUNCA se guarda un LID como si fuera un teléfono.
- Mensajes serializados por chat (runInThreadQueue, timeout de 60 s con
  AbortController). Se ignoran grupos, estados, 0@c.us y tipos de mensaje
  no permitidos.

## Agentes (LangGraph)
- router → budget (cotización), support (FAQ, estado de pedidos,
  comprobantes) o handoff (derivación a humano). Checkpointer en Firestore.
- LLM: Gemini centralizado en `src/config/llm.js` (`createGeminiModel({ temperature, thinkingBudget })`)
  usando `GEMINI_API_KEY` y `GEMINI_MODEL`. Router y extracción de grabado usan `thinkingBudget: 0`.
- ALERTA AL ADMIN EN UN SOLO LUGAR: `notifyAdminHandoffAlert` NUNCA se invoca desde los nodos
  (`budget`, `support`, `handoff` ni `handleMisunderstanding`). La alerta al admin se envía
  exclusivamente desde `whatsapp.js` cuando `humanHandoffRequired` transiciona de `false` a `true`, con reintentos.
  Los nodos únicamente configuran el estado del grafo.
- Handoff: el bot queda en silencio hasta que un admin lo reactiva desde el
  panel (`POST /admin/chats/:threadId/resume-bot`, con `updateState` y `asNode`
  `human_handoff_node`). Reactivar inicia una sesión nueva. Nunca se
  reactiva solo por tiempo.
- Escalada compartida (4 intentos) vía `src/agents/escalation.service.js`:
  - Fuera de cotización (SupportAgent): paso 1 reformula; pasos 2 y 3 muestran menú
    (1. Catálogo, 2. Cotizar, 3. Estado de pedido) + ofrecen Asesor y activan `awaitingMenuChoice: true`;
    paso 4 deriva a humano.
  - En cotización (BudgetAgent): pasos 1, 2 y 3 repreguntan el MISMO dato requerido con ejemplo
    concreto y ofrecen escribir "Asesor", preservando `quoteContext` intacto; paso 4 deriva a humano
    preservando `quoteContext`.
- Inactividad de más de 6 horas = sesión nueva (salvo handoff activo).

## Pedidos
- Precios SIEMPRE recalculados en el servidor desde Firestore. El body del
  checkout pasa por una whitelist. La identidad sale del JWT. Estado
  inicial siempre "pending". createdAt con Timestamp.now() del servidor.
- orderNumber atómico con formato hodieNNNNNN (counters/orderNumber).
- Guardar el pedido y enviar el PDF son independientes (pdfDelivered).
- PDFs: generados en `os.tmpdir()` con timestamp único (`pedido-${order.orderNumber}-${Date.now()}.pdf`),
  y eliminados inmediatamente en un bloque `finally` tras el envío (éxito o fallo). Sin timeouts.
  Al inicio del servidor, `cleanupStaleOrderPDFs()` purga archivos residuales.
- Personalización por ítem (texto, imagen en Cloudinary con subida firmada
  solo durante el paso de personalización, o pendiente).

## Reglas de negocio (no cambiarlas sin preguntar)
- Tienda en Barrio Centro, Minga Guazú, Alto Paraná.
- Envío: gratis en Minga Guazú; resto del país por transportadora con flete
  pago contra entrega. shippingCost siempre 0 en el pedido.
- Pago 100% manual por transferencia; el admin confirma.
- La compra web exige login con OTP por WhatsApp.
- Cantidad de 1 a 100; más de 100 = pedido corporativo → handoff.
- Política de derivación: solo si el cliente pide una persona, hay un
  reclamo, pedido corporativo, falla técnica, o 4 intentos seguidos sin
  entenderlo (1: reformular; 2 y 3: menú contextual o repregunta de dato + ofrecer asesor;
  4: derivar manteniendo quoteContext). Si un producto está sin stock en cotización,
  ofrecer alternativas similares disponibles (stock > 0) y ofrecer asesor, sin
  derivar automáticamente. Nunca inventar datos.

# REGLAS DE TRABAJO (obligatorias)

1. EVIDENCIA REAL: todo resultado de tests, evaluaciones o comandos se
   entrega como salida CRUDA copiada de la consola. Nunca redactes tablas
   de resultados a mano. Los diffs salen de "git diff", completos, sin "...".
2. NO AFIRMES LO QUE NO VERIFICASTE: no cites archivos, funciones, issues,
   URLs ni tests que no hayas comprobado que existen. Si no estás seguro,
   decilo.
3. NADA DE REGLAS A MEDIDA DE LOS TESTS: no agregues palabras o frases
   específicas de un caso de prueba para hacerlo pasar. Soluciones
   generales, validadas con variantes que no estén en ningún conjunto de
   casos. Si una solución depende de listas de palabras, explicá qué
   frases reales podrían fallar.
4. FIRESTORE ES PRODUCCIÓN: cualquier borrado o modificación masiva va
   primero en modo dry-run y espera mi confirmación. Los tests crean sus
   propios datos (con prefijo test-), nunca tocan productos, pedidos ni
   usuarios reales, y limpian todo en un finally (incluidos los
   langgraph_checkpoint_writes).
5. NO INVENTES DATOS DEL NEGOCIO: productos, materiales, colores, precios
   y políticas salen de Firestore o de este documento. Si falta algo,
   preguntame.
6. DEPENDENCIAS: nunca edites node_modules. Cualquier cambio en
   package.json requiere mi aprobación antes.
7. ALCANCE: para cambios no triviales, primero un plan y esperás mi
   aprobación. No toques código fuera del alcance pedido. No hagas commit
   ni push salvo que te lo pida; antes de cualquier commit, mostrame
   git status.
8. Respondé en español.

# PRIMERA TAREA (solo esto; no toques código de producción todavía)

A) Guardá este mensaje completo como docs/CONTEXT.md en hodie-node-app.
   Después revisá el código y listame cualquier discrepancia entre este
   documento y lo que realmente hace el código. No corrijas nada: solo
   reportalo.

B) Ordená la carpeta temp/. Para cada archivo, clasificalo en:
   - TEST DE REGRESIÓN (vale la pena mantener): se mueve a test/.
   - SCRIPT DE UN SOLO USO ya ejecutado (limpiezas, backfills,
     migraciones): se borra.
   - DEPURACIÓN o restos: se borra.
   Presentame la tabla de clasificación y esperá mi aprobación antes de
   mover o borrar nada. Verificá también si temp/ está en .gitignore: los
   tests de test/ tienen que quedar versionados en git, y agregá scripts
   en package.json para correrlos ("npm run test:..."), separando los que
   usan el LLM real de los que no.

# DECISIONES DE CATÁLOGO — ENTREGA 1 (1 de octubre de 2026)

- Alcance aprobado: servicio de catálogo, validaciones del modelo nuevo y
  CRUD backend de `categories` y `policies`. No incluye tienda, interfaz
  del panel, precios de pedidos, stock por variante ni adaptador del bot.
- Servicio central en `src/services/catalog.service.js`, repositorio
  Firestore separado e inyección de almacenamiento y reloj para tests.
  La inicialización de Firebase es diferida; los tests en memoria no
  cargan credenciales. El servicio nuevo solo expone productos de
  `schemaVersion: 2` y no convierte productos viejos.
- Una variante, una vez creada, nunca se elimina: solo se desactiva con
  `active: false`, aunque ningún pedido la referencie. Al editar se
  preservan todos los IDs existentes. El servidor genera IDs para
  variantes nuevas; no se consultan pedidos para permitir eliminaciones.
- `priceFrom` y `skus` se derivan en el servidor, ignorando lo recibido.
  `skus` incluye los SKU de todas las variantes, incluso las inactivas.
  `priceFrom` es el menor precio activo o `null` si no hay variantes activas.
- Unicidad de SKU: consultas indexadas y limitadas con `array-contains`
  sobre `products.skus`, excluyendo el propio producto al editar. Durante
  la transición, otra consulta indexada comprueba `products.sku` del
  esquema viejo. La comparación es exacta tras quitar espacios extremos.
  No se lee todo el catálogo ni se hace backfill. La validación aislada
  no reserva SKU: antes de habilitar el CRUD nuevo de productos, los
  guardados deben serializar comprobación y escritura mediante una
  transacción con un documento compartido de control, por ejemplo en
  `counters`. Una consulta previa sola no garantiza unicidad concurrente.
- Búsqueda: nombre, etiquetas, nombre de categoría, valores de opciones
  y de atributos. Normaliza acentos, diéresis, mayúsculas y plurales
  regulares, preservando `ñ`. Usa palabras vacías del castellano y verbos
  de consulta, nunca un diccionario del negocio. Las reglas generales
  de plurales pueden tener falsos positivos en terminaciones ambiguas;
  no cubren todos los irregulares. Las palabras de la lista gramatical
  se omiten aunque aparezcan en etiquetas. Una consulta compuesta solo
  por ellas se trata como consulta vacía.
- Admite coincidencias parciales. Orden: cantidad de términos encontrados;
  después nombre, etiquetas, categoría, opciones y atributos, priorizando
  coincidencias exactas dentro de cada campo. Desempate: nombre completo,
  orden de categoría, nombre normalizado e ID. Cada resultado incluye
  `matchedTerms` normalizados, sin palabras vacías ni duplicados.
  Las coincidencias y filtros de opciones no mezclan variantes distintas.
- `onlyAvailable` es `false` por defecto. Variantes activas con stock cero
  siguen visibles y cada variante trae `available`, calculado de su stock.
  Productos o categorías inactivos y productos sin variantes activas no
  aparecen en búsqueda ni detalle público. El límite de búsqueda es 5
  por defecto. Consulta vacía: orden de categoría, nombre e ID.
- Caché por proceso de 5 minutos para categorías, productos y políticas.
  Escrituras exitosas invalidan; las fallidas no. Una invalidación durante
  una carga impide reutilizar datos anteriores. Las validaciones contra
  Firestore y la comprobación de productos para desactivar categorías no
  dependen de esa caché.
- APIs nuevas con `requireAuth` y `requireAdmin`, acotados a sus rutas:
  `/admin/categories` y `/admin/policies`; GET, POST, PUT, PATCH y DELETE.
  Los IDs son slugs estables. DELETE de categoría la desactiva y se
  rechaza con 409 si tiene productos activos. DELETE de política elimina
  ese documento. Listados admin incluyen categorías inactivas; timestamps
  de políticas son del servidor. Campos inválidos: 400 con `field`;
  documento inexistente: 404; conflicto: 409.
- Validaciones nuevas preparadas para el futuro CRUD de productos. El
  controlador viejo solo agrega invalidación tras sus escrituras; no se
  cambia su modelo ni se declara cumplido el criterio global que todavía
  detecta nombres y empaques fijos del código anterior.
- Tests nuevos: `test_catalog_search.js`, `test_catalog_validation.js`,
  `test_catalog_service.js`, `test_catalog_crud.js` y
  `test_catalog_admin_api.js`, con helpers de fixtures y Firestore dentro
  de `test/helpers/`. Los tres primeros son en memoria. Los dos últimos
  admiten emulador; sin emulador exigen `ALLOW_PROD_FIRESTORE_TESTS=1`
  antes de cargar Firebase. IDs por ejecución con prefijo `test-`, limpieza
  en `finally`, sin barridos ni escrituras sobre datos reales. Los nombres
  del caso documental de búsqueda se leen de SPEC en runtime. No se
  invoca el LLM ni se inicializa WhatsApp en los tests nuevos.
- No se cambian dependencias ni `package.json`. El dueño ejecuta los
  tests, `git diff --stat` y `git diff`; el asistente no afirma resultados
  sin salida real de consola. No se hace commit, push ni deploy.
