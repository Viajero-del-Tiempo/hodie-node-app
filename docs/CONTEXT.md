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
- Pricing: cantidad de 1 a 100 por ítem para todos. En el agente nuevo, la
  cantidad corporativa depende de la suma total del carrito y del documento
  agent_config/conversation; el bot ofrece una persona y deriva cuando acepta.
- Política de derivación: solo si el cliente pide una persona, hay un
  reclamo, pedido corporativo, dos fallas técnicas consecutivas del agente nuevo, o 4 intentos seguidos sin
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
  en `finally`, sin barridos ni escrituras sobre datos reales. El caso de
  búsqueda usa datos ficticios en `test/`, sin leer SPEC en runtime. No se
  invoca el LLM ni se inicializa WhatsApp en los tests nuevos.
- Ajustes aprobados el 2 de octubre de 2026: la regla de oro sobre nombres
  aplica a `src/`; los tests pueden usar datos ficticios independientes
  de los documentos. Los tres tests de catálogo en memoria se agregan
  a `test:unit`, conservando los tests preexistentes. Los de CRUD y API
  se agregan a `test:integration` con `ALLOW_PROD_FIRESTORE_TESTS=1`.
  Los tests preexistentes de `test:unit` pueden acceder a Firestore.
- No se cambian dependencias. El dueño ejecuta los
  tests, `git diff --stat` y `git diff`; el asistente no afirma resultados
  sin salida real de consola. No se hace commit, push ni deploy.

# DECISIONES DE CATÁLOGO — ENTREGA 2 (2 de octubre de 2026)

- Alcance: precios y stock por variante, whitelist del checkout y snapshots
  de pedidos. Sin cambios de tienda, UI admin, CRUD de productos ni bot.
- `order-pricing.service.js` valida con el catálogo inyectado. El servicio
  de catálogo agrega lecturas internas directas (sin caché), incluyendo
  documentos inactivos/viejos para validarlos explícitamente. La interfaz
  pública de catálogo sigue mostrando únicamente el modelo nuevo.
- Producto, categoría y variante deben estar activos para crear un ítem
  nuevo de versión 2. Cantidad entera estricta de 1 a 100; precio de variante
  y empaque del documento, nunca del body ni de `priceFrom`. Empaque estándar
  gratuito se guarda como `null`. Los tipos son libres y se validan contra
  `packagingOptions` de ese producto. Personalización respeta `allowed`,
  `allowsText`, `maxChars` y `allowsImage`, con banderas pendientes derivadas.
- Antes de guardar el pedido se suma la cantidad de líneas repetidas por
  producto/variante y se compara con stock fresco. Un faltante devuelve 400
  con variante/SKU y unidades disponibles. Esta lectura NO reserva stock:
  se vuelve a comprobar al pasar a un estado comprometido.
- La foto guarda `productId`, `variantId`, `productName`, `variantLabel`
  (valores según `optionNames`), `sku`, precio, cantidad, imagen y empaque.
  `productSku` se conserva como alias para el PDF y consumidores actuales.
  `persistOrderSnapshot` crea una sola vez; reprocesar un ID existente usa
  datos persistidos y conserva foto, totales, número, estado y `createdAt`.
  Una colisión concurrente de ID no sobrescribe la primera foto. Fallar la
  persistencia impide emitir el comprobante; fallar el PDF luego de guardar
  mantiene el pedido y la contingencia existente (`pdfDelivered`).
- `order-stock.service.js` concentra descuento/restitución y transición de
  estado. Pedido y productos se leen y escriben en una misma transacción;
  las cantidades se agrupan por producto y variante. Todas las lecturas
  preceden las escrituras y cada producto recibe una sola actualización de
  `variants`, preservando el resto del documento. El stock raíz no cambia.
  Firestore reintenta conflictos, evitando stock negativo entre pedidos y
  descuentos/restituciones duplicados sobre un mismo pedido. Cualquier
  referencia ausente o stock insuficiente revierte todo el cambio.
- Se conserva la máquina de estados actual: comprometidos `paid`,
  `preparing`, `shipped`, `delivered`; retornar a `pending` o cancelar
  restituye; cancelado no se reactiva. Restaurar acepta producto/variante
  desactivados. WhatsApp y la invalidación de caché ocurren tras commit,
  nunca dentro del callback reintentable. Estado repetido no notifica.
- Los ítems sin `variantId` se omiten sin consultar su producto. La API
  devuelve `stockWarnings` en listado, detalle y actualización; el mensaje
  del cambio de estado incluye el aviso que ya muestra el panel. En un
  pedido mixto, solo las líneas con variante modifican stock. Este manejo
  de pedidos históricos permanece tras la puesta en marcha.
- Se eliminó `updateOrderStatusAndNotify` y sus casos de test: la búsqueda
  en `src/` encontró solo su definición, sin consumidores productivos.
- COMPATIBILIDAD TEMPORAL, SE ELIMINA EN LA ENTREGA 6: hasta reemplazar el
  CRUD viejo (entrega 5), pricing admite documentos sin `schemaVersion` o
  con versión 1, con precio/SKU raíz y claves de `packagingPrices` e imágenes
  de `packagingImages`. No se usan nombres fijos de empaques: el nombre del
  snapshot viejo es la clave de catálogo. Un nombre descriptivo recibido
  solo se resuelve si sus palabras identifican una clave sin ambigüedad;
  otras descripciones se rechazan. Se mantiene la tolerancia previa a
  cantidades numéricas como texto solo para esos documentos. El body no
  decide el esquema: versión 2 exige variante; versión vieja rechaza un
  `variantId` recibido. También se retira en entrega 6 la consulta de SKU
  raíz que cubre esos productos. No hay backfill ni adaptación automática.
- Esta entrega prepara el backend para el deploy conjunto de entrega 6
  con el frontend y el agente conversacional nuevo:
  el checkout/bot antiguos todavía crean ítems sin variante y esas líneas
  no mueven stock. No se despliega aisladamente sobre la tienda actual.
- Tests nuevos en memoria: `test_order_variant_pricing.js` (fotos, precios,
  empaques, personalización, stock acumulado, compatibilidad) y
  `test_order_variant_stock.js` (agrupación, avisos, rollback, estados).
  Se agregan a `test:unit`. Integración: `test_order_variant_orders.js`
  (API real con middlewares, persistencia y reprocesamiento) y
  `test_order_variant_transactions.js` (pagos/cancelaciones simultáneos,
  variantes distintas, rollback y notificación posterior), en
  `test:integration` con `ALLOW_PROD_FIRESTORE_TESTS=1`. IDs `test-` únicos
  registrados antes de escribir y limpiados en `finally`, guardia antes
  del SDK, sin mensajes reales, invocaciones LLM ni escrituras al contador
  real. La concurrencia se comprueba contra Firestore, no con el doble en
  memoria. Se actualizan los tests existentes de inventario para variantes
  y la expectativa del nombre de empaque del modelo viejo.
- No se agregan dependencias. El dueño corre tests y `git diff`; el
  asistente no los ejecuta ni reconstruye sus salidas. Sin commit/push/deploy.
- Ajuste de regresión: la simulación de pedidos de `test_budget_agent_v2.js`
  implementa `get` (inexistente antes de crear), `create`, `set` y `update`
  en memoria y restaura también `runTransaction` en `finally`. No se cambia
  `order.service.js` para tolerar métodos ausentes de un doble de test.
  La revisión de las otras simulaciones no encontró otra referencia de
  pedido con el mismo hueco; el helper de stock ya implementa `get`.
- `test:unit` usa `test/run-unit.js`: ejecuta las mismas suites una por una
  en procesos separados, continúa aunque una falle y termina con código 1
  si hubo algún fallo (también si un proceso no arranca o termina por señal).
  Las salidas de los procesos se muestran directamente. Las cinco suites
  en memoria usan `node --test`; las ocho preexistentes mantienen
  `ALLOW_PROD_FIRESTORE_TESTS=1`. No cambia `test:integration` ni `test:llm`.

# CAMBIO DE PLAN DEL CATÁLOGO (2 de octubre de 2026)

- La tienda completa está en mantenimiento. El catálogo nuevo y el agente
  conversacional nuevo salen a producción juntos en la puesta en marcha
  (entrega 6). El agente nuevo tendrá su propia especificación. Hasta
  entonces, nada de esta rama se deploya, incluidas las entregas ya hechas.
- Se retira del plan el adaptador temporal para el BudgetAgent y su
  criterio de aceptación de cotización por WhatsApp. Se conservan los
  números de las entregas restantes: la tienda es entrega 4, el panel es
  entrega 5 y la puesta en marcha es entrega 6.
- El BudgetAgent actual no se toca: `src/agents/nodes/budget.node.js`
  queda fuera del alcance del catálogo y se elimina cuando se reemplace
  por el agente nuevo. No se agrega un adaptador al servicio de catálogo.
- La compatibilidad con productos del modelo viejo en pricing y en la
  consulta de SKU raíz se sigue eliminando en la puesta en marcha,
  antes del deploy conjunto. El manejo de pedidos históricos sin
  `variantId` permanece, con aviso y sin movimientos de stock.
- La entrega 4 se desarrollará en `hodie-tienda`, en la rama
  `feature/catalogo-variantes`, con un plan aprobado antes de escribir
  código de la tienda. No incluye cambios del panel admin (entrega 5).

# DECISIONES DE CATÁLOGO — ENTREGA 4 (3 de octubre de 2026)

- Tienda en `hodie-tienda`, rama `feature/catalogo-variantes`. Modelos y
  `CatalogService` nuevos para listado, tarjetas de inicio, detalle, carrito
  y checkout. `ProductService`, el modelo viejo y las listas de empaques del
  panel quedan hasta su reemplazo en entrega 5; no se adaptan productos
  viejos para mostrarlos en la tienda nueva. El criterio global de nombres
  fijos todavía no se declara cumplido mientras quede el panel antiguo.
- API pública mínima en el backend: `/catalog/categories`,
  `/catalog/products` (búsqueda, orden y paginación),
  `/catalog/products/by-slug/:slug` y `/catalog/products/:id` (referencias
  del carrito). Usa el servicio central, sin lecturas Firestore desde las
  pantallas nuevas. Página por defecto de 12, máximo 100; la búsqueda se
  pagina después de obtener todos los resultados, sin el límite implícito 5.
- Detalle web en `/store/<slug>`. El slug es único incluso entre productos
  desactivados: consulta directa indexada `slug == valor`, limitada a 2 y
  excluyendo el propio producto al editar. La validación no reserva el
  slug; la entrega 5 debe garantizar simultáneamente unicidad de SKU y slug
  en el guardado transaccional con el control compartido ya definido.
  Enlaces inexistentes/inactivos muestran "Este producto ya no está
  disponible" con acceso al catálogo, sin convertir IDs viejos a slugs.
- Selectores de ejes dinámicos en el orden de `optionNames`, con dependencia
  de los ejes anteriores y limpieza de selecciones posteriores. Variantes
  agotadas visibles y deshabilitadas. Precio, imágenes y stock pertenecen
  a la variante; la cantidad restante suma todas sus líneas del carrito.
  Empaques de `packagingOptions` con tipos/nombres/precios/imágenes reales;
  estándar gratuito es `null`, distinto de un empaque configurado gratuito.
- Personalización por línea cargada en detalle. Identidad estable mediante
  la tupla producto/variante/empaque/texto, quitando espacios extremos del
  texto como el servidor. Dos textos distintos quedan separados; iguales
  se suman. El carrito permite editar/quitar texto y fusiona coincidencias
  solo si respeta cantidad 1–100 por línea y stock agregado por variante.
  Vacío deja `customizationPending` solo cuando admite texto. El checkout
  únicamente muestra los textos, no los vuelve a pedir. Se respeta
  `allowed`, `allowsText`, `maxChars` por caracteres Unicode y `allowsImage`;
  las imágenes web siguen pendientes de envío por WhatsApp.
- Carrito local `schemaVersion: 2`; formato anterior, líneas sin variante
  o JSON dañado se descartan completos, con aviso visible una vez. No se
  deducen variantes. Totales e identidades se recalculan al cargar.
- Antes de confirmar, la tienda revisa datos del catálogo público (con
  caché). Si cambian pide revisión/reconfirmación; esta lectura no reserva
  ni garantiza stock fresco. El POST valida de nuevo en el servidor, envía
  ambos IDs y `packagingType` y conserva carrito/textos ante 400. El total
  del servidor se muestra tras éxito y el carrito se vacía solo al guardar.
- Tests frontend en `hodie-tienda/test/` con Jasmine/Karma ya instalados,
  fixtures ficticios, almacenamiento y HTTP simulados, sin importar
  `app.config` ni inicializar Firebase. Configuración de Angular/TypeScript
  incluye ese directorio. Test de API pública con Express y catálogo en
  memoria incluido en `test:unit`; CRUD real agrega la comprobación de slug
  a sus propios documentos `test-`. No se agregan dependencias ni se cambia
  `package.json`. `src/environments/` está excluido de Git; se conserva su
  configuración actual. La guía manual indica configurar localmente la URL
  de desarrollo como `http://localhost:3000` para verificar la API local.
- El BudgetAgent no se modifica. No se hace commit, push ni deploy. El dueño
  corre tests y build; el asistente no ejecuta tests ni reconstruye salidas.

# DECISIONES DE CATÁLOGO — ENTREGA 5a (6 de octubre de 2026)

- El alcance de esta ronda es entorno local, CRUD backend nuevo de productos
  y endpoint de imágenes. El panel Angular corresponde a 5b: ProductService,
  product.model.ts y packaging.model.ts quedan hasta esa ronda. El CRUD viejo
  deja de escribir productos; pricing y consulta de SKU raíz mantienen su
  compatibilidad temporal hasta entrega 6. No se convierten productos viejos.
- requireAdmin verifica el JWT y consulta role en users de Firestore; no
  confía en el rol declarado en el token. La validación de sesión y la
  blacklist se separan de WhatsApp. Los exports anteriores y contratos OTP,
  expiración, límites, sesión y logout se conservan, con pruebas HTTP en memoria.
- Los guardados de productos leen y escriben counters/catalogWrites dentro
  de la misma transacción que valida categoría, consulta slug y SKU, y guarda
  el documento. Todas las consultas ocurren antes de las escrituras. Los IDs
  de variantes nuevas se preasignan para mantenerse en reintentos. skus y
  priceFrom se derivan siempre; IDs existentes no se eliminan. DELETE solo
  desactiva, force=true se rechaza. Las rutas exigen requireAuth + requireAdmin.
- El admin lee datos frescos y recibe version basada en updateTime, sin
  persistirla. Toda edición/desactivación/reactivación la exige. Un cambio
  concurrente devuelve 409 con field, code y changes, identificando stock
  anterior/actual u otros grupos modificados. No se afirma la causa de un
  cambio sin evidencia. No se escribe el documento ni se altera el payload
  del borrador; la conservación visual del borrador se implementa en 5b.
- POST /admin/images valida base64, MIME/contenido y máximo de 10 MB, y usa
  subida firmada desde el backend. En modo local el mismo endpoint usa una
  carpeta temporal, sin Cloudinary. La subida de personalización conserva su
  contrato y carpeta. El frontend viejo sigue pendiente del reemplazo en 5b.
- npm run catalog:local levanta Firestore (8080), UI (4000), API (3000), con
  proyecto demo-hodie-catalogo y datos ficticios solo en test/fixtures.
  Exige Java 21 y Firebase CLI. Genera secreto JWT en cada ejecución y se
  niega a arrancar si coincide con JWT_SECRET de .env o del entorno heredado.
  El secreto no se imprime. La API imprime OTP local/JWT del admin ficticio;
  no inicia WhatsApp ni LLM. Desde 4b-1 monta también checkout y pedidos propios,
  con generación PDF real y transporte local; el resto conserva catálogo,
  CRUD, imágenes y perfil.
- Firebase local se inicializa antes de buscar certificados, con projectId
  explícito. El supervisor usa scripts/emulator.env para no cargar .env.
  Angular tiene configuración emulator y plantilla versionada en dev/;
  el archivo generado en src/environments/ sigue ignorado. Conserva los
  entornos actuales y conecta el SDK y la API al proyecto/puertos locales.
- Los tests de memoria nuevos están en test:unit y test:catalog:unit. Los
  de productos/API, concurrencia y conflictos de stock se agregan a
  test:integration. test:integration:emulator ejecuta integración contra el
  emulador ya levantado, sin habilitar producción. Los IDs y el documento de
  control de cada ejecución son test- y se limpian en finally, sin barridos.
- Guía de comandos y pruebas manuales: docs/VERIFICACION-catalogo-local.md.
  El dueño corre tests, build y git diff. El asistente no los ejecuta ni
  reconstruye sus salidas. No se hace commit, push ni deploy. El BudgetAgent
  no se modifica; la puesta en producción sigue siendo conjunta en entrega 6.

# DECISIONES DE PERFIL Y CHECKOUT — ENTREGA 4b-1 (7 de octubre de 2026)

- División aprobada: 4b-1 es solo backend, PDF, emulador y tests. Checkout,
  Mi perfil y detalle administrativo Angular corresponden a 4b-2. No se
  modifica el BudgetAgent ni se hace commit, push o deploy.
- El perfil del cliente se separa de admin.user.controller.js. GET/PUT
  /users/me exige sesión y usuario activo. PUT permite nombre, listas y
  predeterminados; ignora teléfono, UID, rol y estado enviados en el body.
  El UID de los middlewares sale del ID del documento, no de un campo uid.
- addresses agrega id, recipientName y recipientDocument. defaultAddressId
  y defaultBillingProfileId apuntan a registros propios. Los IDs nuevos los
  asigna el servidor; un ID ajeno o repetido se rechaza. Direcciones antiguas
  reciben IDs deterministas al leer y se materializan al primer guardado
  propio, sin backfill. Si faltan datos del destinatario, el checkout exige
  completarlos. Se conserva billingAddress postal; no se infiere RUC de él.
- billingProfiles guarda id, alias, legalName, ruc y rucValidation. Hay varios
  registros y un predeterminado. Datos de dirección/facturación son borradores
  del checkout hasta que el cliente confirma su guardado. El servidor limita
  cada lista a 30 registros y los textos a 200 caracteres.
- GET devuelve version basada en updateTime y hashes. PUT exige esa versión
  y guarda en una transacción. Un 409 PROFILE_VERSION_CONFLICT identifica los
  grupos que cambiaron y no altera el borrador recibido ni el documento.
- GET /orders/shipping-options?city comparte la regla existente: normaliza
  tildes, mayúsculas y espacios; Minga Guazú (incluido km/barrio) es local
  gratuito, el resto transportadora contra entrega. shippingCost sigue 0.
  POST /orders/order/send recalcula el método; cédula se exige y conserva
  solo para transportadora. Errores tienen field con la ruta del control.
- saveShippingAddress por defecto es true si no hay direcciones, false si
  hay alguna. saveBillingProfile por defecto false. El guardado opcional
  agrega sin reemplazar ni duplicar, conserva predeterminados y relee el
  perfil en una transacción. Si falla después de crear el pedido, se devuelve
  éxito con profileSaved=false y profileWarning: nunca se pide repetir la
  compra para guardar el perfil.
- RUC se valida como cadena numérica de longitud variable, sin prefijo 80
  ni ocho dígitos obligatorios. DV SET: pesos 2..11 desde la derecha,
  reiniciando en 2; módulo 11, restos 0/1 => 0, otros => 11-resto.
  Fuente: https://www.dnit.gov.py/documents/20123/224893/D%C3%ADgito%2BVerificador.pdf/fb9f86c8-245d-9dad-2dc1-ac3b3dc307a7
  POST /users/me/ruc/validate propone suggestedRuc sin guardar. Un número
  base no se completa sin confirmedRuc igual a la propuesta o reenvío del
  RUC completo que aceptó el cliente. Falta de confirmación => 400
  RUC_COMPLETION_REQUIRED. DV distinto => RUC_DV_MISMATCH; permite corregir
  o acknowledgeRucMismatch=true, guardando mismatch_confirmed y el RUC
  original. Nunca se cambia el dígito automáticamente ni se valida inscripción.
- Pedido nuevo tiene billing.invoiceRequested=false por defecto (consumidor
  final); true exige razón social/RUC. Dirección y billing son fotos completas
  e independientes del perfil. Un histórico sin billing se presenta como
  datos fiscales no registrados, no como consumidor final inferido.
- Origen y verificación no provienen del body web. Se guarda origin y
  phoneVerification { verified, source }. Web usa web_session; WhatsApp
  usa whatsapp_resolved o customer_supplied. El transporte nuevo pasa la
  evidencia en opciones identity, fuera de argumentos del LLM. Sin cambiar
  BudgetAgent actual, el servidor verifica coincidencia con chat PN o con
  lid_phone_map, sin iniciar WhatsApp ni inferirla de un teléfono escrito.
- GET /users/me/orders y /users/me/orders/:id filtran por teléfono de sesión
  y por evidencia: verificado con origen/fuente coherentes, o histórico con
  origin=web explícito y sin metadata de verificación. Una marca false nunca
  se convierte en true por ser web. Por decisión expresa del dueño se excluye
  TODO histórico sin origen explícito (también web), hasta revisar después
  cuáles habilitar. No se reconoce por IDs, UID, perfil actual o chat actual.
  Detalle y PDF de pedido ajeno/oculto devuelven 404. No hay migración masiva.
- Lectura de lista paginada por createdAt y documentId descendentes. Lee solo
  pedidos del teléfono autenticado, máximo 500 por petición; un bloque de
  históricos ocultos puede devolver lista vacía con nextCursor. El cursor
  está cifrado/autenticado y ligado al dueño. DTO omite chat, evidencia,
  controles internos de stock y otros datos administrativos; fechas ISO.
  El índice está en firestore.indexes.json para configurar en entrega 6.
- Persistencia y procesamiento se separan del transporte. Exports anteriores
  de order.service.js se mantienen. Compatibilidad de direcciones del bot
  viejo se elimina al reemplazar el BudgetAgent. Las reglas de pricing y
  movimientos de stock de entrega 2 se conservan.
- PDF imprime destinatario, cédula condicional y facturación desde el pedido;
  siempre aclara que es un resumen y no una factura. GET autenticado
  /users/me/orders/:id/pdf regenera ese PDF y elimina el temporal después de
  transmitirlo. Nombres incluyen timestamp/UUID; falla de generación elimina
  archivos incompletos. La entrega por WhatsApp sigue independiente del guardado.
- Emulador agrega clientes 0900000002 (dos direcciones, dos registros fiscales,
  pedidos visibles y ocultos) y 0900000003 (sin direcciones ni pedidos).
  Las fixtures están solo en test/; el seed no sobrescribe. El backend local
  usa checkout real con entrega local y lecturas administrativas, sin WhatsApp.
- Tests nuevos: test:customer:unit (sin Firestore) y test:customer:integration
  (solo emulador). También se agregan a test:unit y test:integration:emulator.
  Guardas antes del SDK, IDs test- por ejecución, limpieza finally, ningún
  acceso a producción ni a counters/orderNumber en las nuevas integraciones.
  El dueño ejecuta tests/build/diff; el asistente no reconstruye salidas.
  Guía: docs/VERIFICACION-perfil-backend.md. SPEC-agente.md incorpora decisión
  fiscal antes de cotizar, herramienta datos_facturacion y huella con billing.

# PANTALLAS DE PERFIL Y CHECKOUT — ENTREGA 4b-2 (7 de octubre de 2026)

- Angular incorpora /profile, /profile/orders y /profile/orders/:id, protegidas
  por authGuard y accesibles desde la navegación. El teléfono es de solo lectura.
  Listado/detalle/PDF usan únicamente /users/me/orders; nunca lecturas admin o
  consultas directas a Firestore. El detalle es de solo lectura y muestra fotos.
- Checkout selecciona el predeterminado, otra dirección o una nueva. Sin
  direcciones abre el formulario incluso si profile_status=complete. Guardar
  dirección viene marcado sin direcciones y desmarcado cuando hay alguna.
  No actualiza perfil antes de comprar: flags de guardado van en el POST.
- Formulario compartido de envío consulta modalidad en el backend al cambiar
  ciudad (250 ms para agrupar escritura). Cancela consultas anteriores; no tiene
  ciudades/reglas hardcodeadas. Cédula se exige y envía solo para transportadora.
- Factura desmarcada por defecto. Registros fiscales propios o datos nuevos usan
  validación RUC del backend, sin duplicar el algoritmo. Base numérica necesita
  confirmar propuesta; DV distinto necesita aceptación explícita. Editar RUC
  cancela consulta/reset de ambas confirmaciones. Aún guardado con discrepancia,
  elegirlo para otra compra vuelve a mostrar aviso y requiere aceptación.
- Mi perfil mantiene listas en borrador, IDs existentes y versión. Agregar,
  editar, borrar y predeterminados se guardan con un PUT; nuevos IDs salen del
  servidor. Un registro nuevo se guarda antes de poder elegirlo como default;
  el primero se vuelve predeterminado automáticamente en el servidor.
- 409 muestra explicación del servidor y conserva todo el borrador/version.
  Consultar perfil actual muestra datos sin pisarlo. Descartar es explícito;
  conservar usando la nueva versión tampoco guarda solo y advierte que las
  listas del borrador reemplazarán las actuales al guardar. Errores field se
  muestran junto al control o fila, y al abrir el editor junto al campo concreto.
- Checkout conserva revisión de catálogo, ambos IDs, empaques reales y texto
  por línea. 400 no borra datos/carrito. Compra guardada bloquea doble envío,
  incluso si falla navegación; profileWarning se muestra en confirmación.
- Mis pedidos recorre páginas vacías con cursor por históricos ocultos (hasta
  cinco páginas por acción; después ofrece continuar). No cambia la regla de
  históricos sin origen. PDF es descarga autenticada y no una factura.
- Detalle administrativo muestra destinatario/cédula y solicitud fiscal con
  razón social/RUC copiables y aviso de discrepancia. El panel de productos
  5b continúa pendiente; BudgetAgent no se toca ni hay deploys.
- dev-catalog valida proyecto/host explícitos heredados ANTES de generar el
  entorno, revisar herramientas o puertos; no los sobrescribe para ocultar una
  configuración errónea. Sin variables se usan los defaults locales seguros.
  La entrega 6 incluye firebase deploy --only firestore:indexes y su config
  productiva. No se ejecuta este paso ahora.
- Tests Angular nuevos en test/, sin Firebase/WhatsApp/red real; se adaptó el
  recorrido de tienda existente al contrato nuevo. Se agrega regresión de
  precedencia del supervisor a test_catalog_admin_contract.js. Sin nuevas
  dependencias ni cambios de package.json. Tests/build/diff los corre el dueño.
  Guía manual: hodie-tienda/docs/VERIFICACION-perfil-tienda.md.


# DECISIONES DE CATÁLOGO — ENTREGA 5b (8 de octubre de 2026)

- El panel Angular reemplaza los componentes anteriores de productos con un
  listado y editor de schemaVersion 2, más páginas de categorías y políticas
  incorporadas al menú admin. Conserva los guards y endpoints de la 5a.
  AdminCatalogService solo usa HTTP autenticado: no escribe desde el SDK ni
  intenta adaptar documentos viejos. Las APIs backend no se modifican.
- El editor carga nombre, slug, descripción, categoría, etiquetas, atributos,
  ejes, variantes, personalización y empaques del producto. Sugiere slug al
  crear hasta una edición manual; editar nombre nunca modifica el slug de un
  producto guardado. Las opciones se generan desde sus ejes libres. Renombrar
  un eje conserva sus valores. Precio y stock se editan por variante.
- Los IDs guardados de variantes se conservan; no hay acción para borrarlas
  y el handler también rechaza retirarlas. Las filas nuevas del borrador sí
  pueden quitarse y se envían sin ID para que lo asigne el servidor. Los IDs
  de categorías y políticas quedan de solo lectura al editar. SKU, slug y
  modelo siguen validándose en la transacción backend de la 5a; se envía la
  versión de lectura y nunca skus, priceFrom ni timestamps editables.
- Los errores se asocian al control de formulario indicado por field, incluidas
  rutas de arreglos y claves libres de opciones/atributos. Se conservan como
  validadores mientras ese campo no cambie, compartiendo el helper existente
  de errores persistentes. El rechazo por productos activos aparece junto a
  la activación de la categoría y conserva el resto del borrador.
- Ante CATALOG_VERSION_CONFLICT, el editor muestra el mensaje y los cambios
  informados por el servidor sin atribuirles una causa desconocida. Conserva
  borrador y versión. Consultar la versión actual no los reemplaza. La revisión
  compara original/borrador/actual, identifica variantes por ID e incorpora
  cambios remotos en campos no editados (incluido stock), conservando los
  cambios locales restantes. Si ambas versiones cambiaron un campo, exige
  elegir actual o borrador. No suma stock, no guarda automáticamente y exige
  revisar/guardar nuevamente. Atributos, ejes, etiquetas, personalización y
  empaques se comparan por grupo. Descartar el borrador es una acción explícita.
- Listado: categoría, precio desde calculado por el backend, cantidad de todas
  las variantes y estado, con búsqueda/filtros, editar, desactivar y reactivar
  con versión. Un rechazo no cambia el estado local; consultar datos actuales
  permite volver a intentar con la versión fresca. Categorías permiten alta,
  edición, orden y activación; políticas permiten temas libres, título y texto.
- Imágenes de variantes y empaques se suben únicamente a POST /admin/images.
  El mismo endpoint firma en producción y guarda localmente en el emulador.
  Se conserva un archivo fallido para reintentar o quitarlo y se bloquea el
  guardado mientras hay subidas pendientes. No hay presets del frontend.
  Quitar una imagen la retira del borrador, sin borrar archivos remotos.
- La búsqueda de referencias en src/ y test/ deja sin consumidores los modelos
  product.model.ts y packaging.model.ts, ProductService y CloudinaryService.
  Se eliminan con los componentes de producto anteriores, incluido su diálogo.
  No se cambian dependencias, package.json ni los entornos locales existentes.
- Tests Angular en memoria/HTTP simulado: servicio admin, editor, comparación
  de versiones, listados/categorías/políticas e imágenes; datos inventados en
  test/helpers/admin-catalog-fixtures.ts. Recorrido y comandos en
  hodie-tienda/docs/VERIFICACION-panel-catalogo.md. El dueño corre tests/build/diff;
  el asistente no los ejecuta ni reconstruye salidas. No se hace commit, push
  ni deploy y el BudgetAgent actual no se modifica.

# DECISIONES DEL AGENTE — ENTREGA 1 (8 de octubre de 2026)

- Rama feature/agente. Alcance aprobado: solo runner de evaluación, sin
  reemplazar ni modificar router, BudgetAgent, SupportAgent o WhatsApp.
  El dueño escribe test/eval/conversations.yaml; el asistente nunca lo modifica.
- Se implementa el formato estructurado v2 del encabezado. Contextos y claves
  anidadas desconocidas, formas inválidas o productos/variantes/empaques que no
  existen bloquean el caso con diagnóstico y línea. No se interpreta texto libre.
- telefonoCliente es verificado; su ausencia deja el teléfono sin resolver.
  historialPrevio se guarda antes del corte y no llega al modelo; duranteHandoff
  es histórico, no una derivación activa. conversacion es la sesión actual.
  Sesión nueva conserva el carrito vigente; se respeta su antigüedad y TTL 3 días.
- Catálogo, políticas, pedidos, carrito, checkpoints y cargas son copias en
  memoria independientes por repetición. Se reutiliza el servicio de catálogo
  con repositorio/reloj inyectados, sin Firebase, credenciales de Firestore,
  WhatsApp ni llamadas a servicios productivos. Solo el juez llm usa la red.
  El proceso bloquea imports/requires de SDKs productivos y el inicializador
  Firebase antes de cargarlos, con module.registerHooks del runtime Node 24.
- cotizacionMostrada exige la herramienta real cotizar sobre el carrito inicial.
  Registra lastQuote en turno 0 y mantiene sus llamadas en phase: setup, fuera
  de tools_called. Mientras no exista cotizar, el caso se informa bloqueado.
  No se sustituye por calculateOrderPricing ni se inventan totales/quoteId.
- El agente trivial prueba el runner sin conocer expectativas. El evaluador
  stub devuelve not_evaluated para comprobar la tubería, sin medir calidad.
  must, must_not y ofertas semánticas quedan sin evaluar; no acreditan casos ni
  sus umbrales. thresholdsPassed es false con stub. Las verificaciones
  determinísticas conservan su resultado. Un diagnóstico completo sale con
  código 3; bloqueos/errores conservan el 2. El informe distingue ejecución
  completa de evaluación de calidad con diagnostic y criteriaNotEvaluated.
  Ninguno habilita producción. El adaptador real se conectará en su entrega.
- El juez real usa createGeminiModel con temperatura 0, una invocación por
  criterio y evidencia pública seleccionada. No recibe prompt privado, mensajes
  system ni checkpoint del agente. Errores/JSON inválido/no observable no pasan.
- Registro canónico alineado con la tabla de SPEC-agente, incluido
  datos_facturacion. carrito es alias de toda la familia carrito_*.
- Tres ejecuciones independientes: seguridad 3/3, handoff correcto 3/3 por caso,
  resto al menos 90% pasando 2/3. ofrece verifica ausencia de handoff por código
  y oferta de persona semánticamente. Bloqueos/errores no reducen denominadores.
- Ráfagas ordenadas en un turno y audios con la transcripción del caso. Imágenes
  descriptivas se identifican; archivos reales pueden asociarse mediante
  manifiesto independiente. Bytes disponibles solo durante el turno. Una corrida
  parcial, simulada, incompleta o sin cobertura visual no aprueba producción.
- Informes generados en test/eval/results/ (JSON, JSONL, Markdown), excluidos de
  Git. Contrato del adaptador y comandos en test/eval/README.md.
- Dependencia de desarrollo yaml 2.9.1 y scripts test:eval/test:eval:unit aprobados.
  Se agregan seis suites en memoria a test:unit, conservando las existentes.
  El dueño corre tests/evaluaciones/diff. El asistente solo valida el archivo
  en modo lectura y no reconstruye salidas. Sin commit, push ni deploy.

# DECISIONES DEL AGENTE — ENTREGA 2 (8 de octubre de 2026)

- Agente de consulta independiente en src/agents/consultation, conectado solo
  al runner mediante agent-contract.js. No se modifica el grafo actual, router,
  BudgetAgent, SupportAgent ni whatsapp.js. Sin integración ni deploy.
- createGeminiModel es la única fábrica. Prompt versionado en
  src/agents/prompts/agente.md, derivado de SPEC, sin nombres, precios o listas
  del negocio. Sus restricciones de carrito/pedidos y comprobantes/derivación
  están en bloques TEMPORAL ENTREGA 4 y TEMPORAL ENTREGA 5; se retiran en esas
  entregas, junto con los controles de capacidad correspondientes.
- Herramientas disponibles: buscar_productos, ver_producto, enviar_imagenes,
  consultar_politicas, estado_pedido y responder. Servicio central de catálogo
  y repositorios/estado/transporte inyectados; en evaluación todo vive en memoria.
  Las categorías y los ejes de opciones proceden de datos, nunca de constantes.
  No se agregan herramientas administrativas ni operaciones de carrito/pedido.
- El gate del interceptor registra todos los intentos y valida argumentos antes
  de ejecutar handlers. Ocho llamadas por turno incluyendo intentos inválidos
  y cierre; la última queda reservada para responder. No hay efectos después
  del cierre ni envíos/escrituras tras cancelación. Errores recuperables son datos.
- Guardián mínimo: identidad confiable, handoff activo en silencio, hora de
  Paraguay, categorías, contexto de lectura y 20 mensajes de sesión actual.
  Ráfagas, audio, visión, detección completa de sesiones y límites horarios quedan
  para entrega 3. El runner mantiene el historial, sin duplicarlo en el adaptador.
- estado_pedido: identidad verificada y pedido propio devuelve estado/productos
  por lista permitida de campos, sin dirección, facturación ni teléfonos. Sin
  verificación, o con pedido de otro teléfono, exige número y teléfono de compra
  coincidentes y muestra solo el estado. No modifica identidad ni phoneVerified.
  Una falta de coincidencia devuelve la misma respuesta genérica. No se inventan
  fechas ni se deduce antigüedad de números; pedidos ambiguos requieren el número.
- responder actualiza entendido y su contador, sin aplicar todavía la escalada.
  La política original de derivación técnica inmediata quedó reemplazada por
  la política de dos fallas consecutivas del agente nuevo, documentada al final.
  El timeout interno es 50 s (runner: 60 s). Derivar como herramienta, índice y
  alerta al admin corresponden a entrega 5; no se simulan como implementados.
- Runner: --agent real usa el adaptador nuevo; --cases permite listas separadas
  por comas, combinables con --case y sin duplicados. README documenta los 27
  casos objetivo del plan, sin afirmar que hayan pasado. F-05 sigue bloqueado.
- Agente real y juez llm usan Gemini, sin iniciar servicios productivos. Con
  --agent real --judge stub el agente sigue llamando al modelo y los criterios
  siguen sin evaluar. La red no se habilita para Firestore, WhatsApp o Cloudinary.
- El resumen final separa modelUsage.agent/evaluator: invoke efectivos, fallos
  y tokens informados por proveedor, por turno, repetición y corrida. Consumo
  ausente o adaptador sin instrumentación se informa como incompleto/desconocido,
  nunca se reconstruye a partir de herramientas o criterios. El juez conserva
  el consumo ante JSON inválido y excluye invocaciones anteriores a la corrida.
- Tests en memoria con modelos inyectados, datos inventados y sin APIs externas;
  scripts test:agent:unit y actualización de test:eval:unit aprobados en el plan.
  Se agregan a test:unit. El dueño ejecuta tests/evaluaciones/diff; el asistente
  solo revisa código y sintaxis, sin afirmar resultados ni hacer commit/push.

# DECISIONES DEL AGENTE — ENTREGA 3

- Guardián completo en src/agents/guardian; consultation/guardian.js se renombra
  a consultation/server-context.js. Este último solo construye el contexto del
  servidor y la entrada del modelo. El prompt conserva intactos los bloques
  TEMPORAL ENTREGA 4 y 5; agrega únicamente la regla permanente para audio que
  no pudo transcribirse. Sin productos, empaques, categorías o precios en src/.
- No se modifica src/config/whatsapp.js, el router, el grafo actual ni el
  endpoint administrativo de reactivación. El router sigue atendiendo en
  producción hasta la puesta en marcha conjunta con el catálogo. En esa puesta
  en marcha se eliminan el filtro viejo, el router, BudgetAgent y SupportAgent.
  El filtro nuevo tiene un test de paridad que lee el código del filtro actual
  sin importar ni iniciar WhatsApp. No hay deploy ni migraciones en esta entrega.
- Buffer en RAM por chat: 8 s de silencio y máximo 30 s desde el primer mensaje.
  Un lote cerrado ya no incorpora mensajes posteriores. Se serializan los
  lotes del mismo chat; el plazo de 60 s empieza al cierre, incluye espera de
  ejecución y multimedia. Otros chats pueden continuar por su propio runtime.
  El adaptador usa también 60 s como límite interno del agente; el guardián
  controla el presupuesto total desde el cierre, sin reiniciarlo tras medios.
  Apagado explícito/SIGINT/SIGTERM registra guardian_shutdown con la cantidad
  de lotes pendientes descartados. SIGKILL no permite log de apagado. Un
  reinicio abrupto pierde las ráfagas en RAM: no se supone reentrega de WhatsApp.
- Sesión nueva solo con más de 6 h de inactividad, señal explícita del servidor
  o reactivación administrativa. Corta historial, reinicia incomprensiones e
  invalida lastQuote; conserva el carrito. Handoff nunca vence ni se reactiva
  por tiempo. En handoff solo actualiza último mensaje/fecha/tipo en el puerto
  de handoff_threads, sin resolver identidad, descargar o llamar modelos.
- Límite de 40 lotes por ventana móvil de 60 min. La admisión se persiste antes
  de descargar, transcribir o consultar al modelo. El lote 41 inicia un episodio:
  registra una solicitud de alerta y emite una sola vez «Estoy recibiendo muchos
  mensajes seguidos y tengo que hacer una pausa. Escribime de nuevo en un rato
  y seguimos.»; después guarda silencio. No
  activa handoff. Se desbloquea automáticamente al volver a tener cupo y no
  reinicia el límite por sesión ni al reconstruir el runtime.
- guardianRateLimit guarda admittedAt/blocked/episodeId; guardianAlerts guarda
  solicitudes y su estado de entrega. Son estado del servidor/checkpoint, no
  argumentos del modelo ni herramientas. Solo whatsapp.js enviará y acusará
  la entrega de alertas. El agente y el guardián nunca avisan al equipo.
- Estado persistido contiene solo mensajes de texto y controles de sesión,
  silencio y límite. El puerto state-store recibe un grafo/checkpointer
  inyectado; no importa SDKs ni el grafo productivo. Pruebas usan almacenamiento
  separado. No compartir colecciones actuales solo mediante namespace: el
  saver actual filtra namespace después de limitar la consulta a 25 snapshots.
  Conectar el grafo nuevo/checkpointer y adaptar resume-bot queda para puesta
  en marcha; no se presentan como activos durante esta entrega.
- Audio hasta 120 s; sin duración, respaldo comprobable de hasta 2 MB; sin
  ambas comprobaciones, pedir texto. El guardián transcribe con createGeminiModel
  sin herramientas; el texto entra literalmente como [audio transcripto]. Los
  fallos son datos del contexto para pedir resumen escrito. No inventa audio.
- Imagen hasta 5 MB, tres por turno; total audio+imágenes hasta 10 MB. Rangos
  y relaciones se validan en config.js. Se comprueba tamaño informado antes
  de descargar y tamaño real después. Documentos/videos/otros solo tipo/nombre.
  Imágenes van como contenido multimodal del turno, con metadatos/attachmentId
  en contexto; nunca como instrucciones. Bytes no se guardan en checkpoint ni
  informe; IDs efímeros pueden figurar en la traza, nunca en checkpoint. Se
  liberan los adjuntos también ante error o cancelación. No se
  sube a Cloudinary: personalización y comprobantes siguen en entregas 4 y 5.
- Runtime usa reloj/temporizadores inyectables. El runner entrega burst como
  lote declarado en un instante virtual, sin inventar intervalos del caso;
  las fronteras 8/30 s se prueban por separado. Los audios del YAML ya vienen
  transcriptos: no prueban calidad de transcripción. Consumo total del agente
  incluye transcripción y conserva su desglose por turno, separado del juez.
- P-06 tiene imagen sintética en test/eval/media/p06-reference.png y manifiesto
  guardian-manifest.json: caja rectangular oscura, sin marca, texto ni personas.
  No es un producto real ni acredita datos del catálogo. No publicar fotos con
  datos personales. Al cerrar la entrega 3, F-05 seguía bloqueado por cotizar
  y C-03 requería precios de la entrega 4. La sección 4A actualiza ese alcance.
  Derivación/escalada completa sigue en entrega 5.
- Scripts test:guardian:unit y suites en test:unit aprobados en el plan. Nuevos
  tests en memoria, con modelos inyectados, sin Firestore/WhatsApp ni red real.
  El dueño ejecuta tests/evaluaciones/diff; el asistente no reconstruye salidas,
  no hace commit/push ni modifica conversations.yaml.

## Agente nuevo: entrega 4A (implementación, pendiente de verificación del dueño)

- Solo carrito, envío/facturación, cotización y presentación. No crear_pedido,
  confirmación final, relación cotización→pedido, contador ni entrega PDF: son
  4B. El router, whatsapp.js, BudgetAgent y grafo productivos siguen intactos.
  Sin deploy hasta la puesta en marcha conjunta del catálogo y agente.
- cart.service trabaja con repositorio/reloj inyectados; carts separado del
  checkpoint, sin precios. Estado del chat guarda lastQuote y confirmaciones
  pendientes, nunca bytes ni attachmentId. IDs estables de línea y revisión
  del carrito; identidad producto+variante+empaque+texto como en la web. Una
  operación inválida conserva el borrador. La revisión evita pisar otro cambio.
  Los puertos cart.repository y order-quote.repository no inicializan Firebase
  ni se conectan a producción. La transacción del primero es solo sobre carts,
  nunca pedidos/contador. El runner sustituye ambos por memoria aislada por caso.
- TTL de tres días desde un cambio real; ver, cotizar o escribir el mismo dato
  no lo renueva. Sesión nueva conserva carrito no vencido. Vencimiento y cambios
  invalidan lastQuote. **Puesta en marcha pendiente:** configurar política TTL
  de Firestore para carts.expiresAt. El chequeo de vencimiento funciona también
  antes de que la limpieza física de Firestore ocurra.
- Pricing único: createOrderPricingService del checkout con structuredErrors
  opt-in. Mensajes, status y campos de errores web anteriores quedan iguales;
  no se cambian fórmulas, reserva ni descuento al pagar. customizationDeclined solo
  se habilita como customization.declined en el carrito y customizationDeclined
  en la entrada/foto de pricing. Si falta ese campo, el checkout actual conserva
  sus pendientes. Rechazo explícito limpia texto/imagen, distinto de pendiente.
- Texto entra como textDraft literal; responder lo repite y registra que se
  mostró. confirmarTexto exige aceptación del mensaje del cliente en un lote
  posterior. Se aceptan afirmaciones breves completas o repetición literal;
  mensajes mixtos con cambios piden otra confirmación. No se interpreta un
  «sí» del modelo, del historial o del mismo lote como aceptación del cliente.
- Envío y facturación son borradores sin confirmación por campo. Servicios de
  shipping/billing/RUC existentes se reutilizan sin modificarlos. Cédula solo
  para transportadora; se conserva el borrador al cambiar de ciudad pero se
  omite de la foto local. Teléfono escrito normalizado sigue sin verificación;
  identidad verificada viene únicamente del servidor. Perfiles fiscales solo
  del teléfono verificado propio, sin selector de usuario en las herramientas.
- RUC sin guion queda literal y genera propuesta DV, sin completarlo hasta
  aceptación posterior. DV discrepante ofrece corregir/continuar con aceptación
  explícita. Pasar la propuesta como ruc en lugar de confirmedRuc no saltea el
  protocolo; un RUC completo nuevo debe ser literal del mensaje, del perfil
  propio o propuesta aceptada. Cambiar RUC/razón social invalida esa aceptación.
- Cotizar incompleto devuelve DATO_FALTANTE, confirmable:false y Subtotal de
  productos, sin total final ni quoteId. Completo emite ID del servidor ligado
  al chat y huellas de carrito (líneas/envío/facturación/revisión) y pricing.
  responder(quoteIdMostrado) recalcula precios/stock y agrega el resumen del
  servidor; solo tras envío exitoso registra lastQuote con ID, huellas, hora,
  secuencia y lote. Cotizar no significa mostrado ni reserva stock.
- Imagen de personalización: valida línea completa antes de subir y acepta
  solo adjunto admitido del turno actual. Puerto de subida firmada con señal;
  el runner devuelve URL y guarda metadatos en memoria, sin red ni credenciales.
  Una imagen es referencia y requiere revisión del equipo para producción.
  Q-03/4 tiene dibujo sintético de vaca en q03-reference.png, sin texto/personas.
  **Pendiente:** limpieza de imágenes huérfanas en Cloudinary tras cambios,
  rechazo, eliminación, vencimiento de carrito o subida seguida de cancelación.
- Se quitó TEMPORAL ENTREGA 4, dejando intacto TEMPORAL ENTREGA 5. El prompt
  habilita 4A y declara crear_pedido todavía indisponible. CANTIDAD_CORPORATIVA
  espera entrega 5/derivar; no se agregan umbrales comerciales al código.
- Runner usa cotizar real para cotizacionMostrada y marca turno previo: F-05
  deja de estar bloqueado por herramienta ausente. Objetivos 4A: P-07, C-03,
  Q-01..Q-05, M-01..M-06, F-01..F-05, E-01 y E-02; no es una afirmación de que
  pasen. Quedan O-02/O-03/O-04/H-01/H-03 para comprobantes/derivación/escalada.
- test:agent:purchase:unit y las nuevas suites de test:unit usan memoria y
  modelos inyectados. test_agent_checkout_contract fija el contrato previo:
  snapshots, pendientes sin declined, mensajes/campos/status y subida firmada.
  Antes y después deben correrse test_order_variant_pricing.js,
  test:customer:unit, test:catalog:unit y test:integration:emulator; comandos y
  selecciones de regresión de entregas 2/3 en test/eval/README.md. El dueño corre
  tests/evaluaciones/diff; no se reconstruye ninguna salida.

## Corrección de 4A tras la primera evaluación real

- cotizar acepta lineas opcionales para consultar importes sin armar carrito:
  productId, variantId, quantity y packagingType opcional. Reutiliza pricing y
  stock agregado del servidor. Devuelve items[].subtotal y productsTotal,
  confirmable:false y ningún quoteId/total final; no altera carrito, TTL,
  repositorio de cotizaciones ni lastQuote. responder añade el cálculo fresco
  solo en ese turno. Sin lineas conserva la cotización del carrito.
- Los subtotales por línea del pricing son opt-in (includeLineSubtotals), sin
  cambios al resultado, fórmulas o mensajes del checkout web por defecto.
- packagingType omitido deja empaque sin decidir; null explícito guarda
  packaging.declined:true. Elegir un tipo real lo desmarca. Leer un carrito
  anterior sin esa marca no convierte null en una decisión. En el contexto
  estructurado del runner, empaque:null expresa sin empaque; omitir la clave
  expresa pendiente. No se cambia conversations.yaml ni su esquema.
- carrito_ver/agregar/modificar/quitar devuelven pendientes del servidor:
  todas las personalizaciones, luego los empaques por línea (solo con opciones
  en el producto), envío y facturación. Empaque pendiente impide emitir una
  cotización confirmable. Las opciones incluyen nombre y precio del catálogo.
- Prompt: seguir pendientes, ofrecer empaques con precios, diseño/dibujo del
  cliente sujeto a revisión humana antes de confirmar y cierre cordial sin
  insistencia si posterga, conservando carrito según la política consultada.
  TEMPORAL ENTREGA 5 sigue intacto; no se implementa creación de pedidos.
- Medición descriptiva, sin cambiar límites/checks/umbrales: latencia por
  invoke del agente/transcriptor/evaluador y herramienta; p50/p95/máximo por
  grupo y turno. Un timeout guarda interruptedPhase (modelo, herramienta y
  nombre, contexto, medios, etc.). Se conserva tiempo observado de operaciones
  interrumpidas, marcado incompleto; ausencia de muestras es null, no cero.
- Tokens de consumo siguen siendo los informados por Gemini. fixedInput separa
  sistema, esquemas efectivamente anunciados en esa llamada y contexto inicial
  del servidor como **estimación local caracteres/4**, con caracteres medidos.
  No se presentan como tokens exactos ni facturados: Gemini no devuelve ese
  desglose. No agrega llamadas de conteo ni guarda texto privado del prompt;
  historial/resultados/multimedia no pertenecen a esos bloques fijos.
- Tests nuevos se agregan a suites existentes, sin tocar package.json ni
  dependencias. Comandos en test/eval/README.md; los ejecuta el dueño.

## Corrección de 4A, parte 2: preparación del test y medición de latencia

- La aserción confirmable:true del test de datos de envío suponía un empaque
  resuelto, pero preparaba la línea omitiéndolo. Con la distinción nueva queda
  pendiente y la cotización correctamente no es confirmable. Se corrige solo
  la preparación con packagingType:null explícito; se conservan confirmable:true,
  cédula omitida en dirección local, borrador preservado y controles de identidad.
- AGENT_THINKING_BUDGET configura exclusivamente el modelo del agente nuevo.
  Ausente: no se pasa thinkingBudget y se conserva el default del proveedor.
  Presente: entero no negativo seguro, incluyendo cero; rechaza vacío, decimales,
  negativos y no numéricos. No se inventa un rango máximo común entre modelos:
  los valores admitidos por el modelo elegido los valida Gemini. Se reutiliza
  createGeminiModel, sin cambiar su default ni el juez o la transcripción.
- --agent-thinking-budget N pasa override al adaptador; tiene prioridad sobre
  la variable y no escribe .env. Metadata por repetición y corrida registra modelo,
  presupuesto enviado, modo y origen. Con un modelo directamente inyectado no se
  presenta una opción solicitada como efectivamente aplicada a ese doble.
- CallDetails agrega callInTurn, que reinicia en cada turno y se numera por
  componente (consulta/transcripción). El informe incluye latencias por posición
  y distribución p50/p95/máximo de llamadas por turno. Incluye turnos silenciosos
  con cero conocido y llamadas interrumpidas; un adaptador sin esa medición deja
  datos desconocidos, no ceros inventados. El evaluador se mantiene separado.
- Envío y facturación también devuelven líneas enriquecidas y pendientes
  generales del carrito, con opciones reales y diagnóstico fiscal conservado.
  Prompt: usar el resultado de la modificación, sin carrito_ver redundante.
- No cambia el límite de 60 s, no se agrega plazo por llamada ni reintentos.
  YAML, checks, umbrales y TEMPORAL ENTREGA 5 siguen intactos. No se conecta al
  flujo productivo. Tests en las suites existentes, sin nuevas dependencias;
  comandos y comparación reproducible en test/eval/README.md. Los corre el dueño.

## Decisión posterior al experimento de pensamiento: default 512 y subtotal pendiente

- Datos reportados por Arnaldo (5 casos × 3 repeticiones): sin fijar → 5/5,
  turno p95 35 s; 512 → 4/5, turno p95 11 s, 34% menos tokens. La única falla
  con 512 (y con 0) fue Q-02: después de elegir empaque omitía cotizar/informar
  el subtotal y seguía con envío. Son resultados informados por el dueño;
  el asistente no ejecutó el experimento ni afirma resultados de la corrección.
- Por decisión de Arnaldo, el agente nuevo ahora envía thinkingBudget:512 por
  defecto. Esto reemplaza el default sin fijar de la sección anterior. Siguen
  teniendo prioridad AGENT_THINKING_BUDGET y --agent-thinking-budget, con la
  validación existente. No cambia la configuración del juez ni del audio.
- Una modificación real por carrito_agregar/modificar que deje una línea con
  personalización y empaque resueltos registra subtotalPending en el checkpoint:
  ID del carrito, huella de líneas y revisión del cambio. No guarda precios ni
  modifica el TTL. Leerlo devuelve informar_subtotal primero en pendientes,
  antes de personalización/empaque de otras líneas y de envío/facturación.
- Cotizar exitosamente (del carrito, aunque dé DATO_FALTANTE, o informativa)
  limpia ese pendiente. No se requiere otro paso de confirmación. Un fallo de
  pricing no lo limpia; tampoco una lectura, envío/facturación o cambio sin
  efecto. Otro cambio real completo lo reactiva. Vencimiento/incompatibilidad
  con el contenido actual lo descarta. Una cotización en curso no limpia el
  pendiente de una modificación posterior. Se mantienen huellas/lastQuote y
  el carácter informativo sin alterar líneas de cotizar(lineas).
- Prompt: si pendientes empieza con informar_subtotal, cotizar y comunicar el
  subtotal antes de seguir. No se agregan precios, fórmulas ni frases del caso
  al código. Sin cambios a YAML, checks, umbrales, TEMPORAL ENTREGA 5 o 60 s.
- Tests en test_agent_cart y test_consultation_agent, incluidos en los scripts
  existentes; el dueño corre las suites y la nueva evaluación.

## Agente, entrega 4B: pedidos y PDF durable (pendiente de verificación del dueño)

- `crear_pedido(quoteId)` requiere la cotización vigente mostrada y una afirmación
  en un lote posterior a la pregunta final. El servidor valida el mensaje completo,
  incluidas las ráfagas. Preguntas, cambios y afirmaciones que responden a otra
  pregunta no autorizan la compra. Las listas JSON `AGENT_ORDER_AFFIRMATIONS` y
  `AGENT_ORDER_NEUTRAL_ADDITIONS` son configurables y validadas; por defecto admiten
  afirmaciones naturales y agregados neutros como "gracias" o "el pedido".
- Una consulta sobre una cotización vigente sin cambios se responde y rearma
  solo con la pregunta corta de confirmación. Un cambio requiere cotizar y
  mostrar el resumen nuevo. Cualquier otra pregunta desactiva la autorización
  anterior. El modelo no puede sustituir la evidencia del cliente.
- `order-confirmation.repository` recibe una conexión explícita; no inicializa
  Firebase. La transacción lee carrito, cotización, confirmación, productos,
  categorías y contador antes de escribir pedido, relación quoteId→orderId,
  contador y trabajo PDF, y borrar carrito/confirmación. Recalcula precios y stock
  con el pricing compartido. No descuenta stock. Solicitudes simultáneas o
  repetidas del mismo quoteId devuelven el mismo pedido; repetir un quoteId viejo
  no borra un carrito nuevo. La relación durable permite recuperar un commit
  aunque falle la respuesta o el proceso reinicie.
- Snapshot y formato de número se extraen de `order-persistence` para reutilizar
  las mismas funciones. El contador sigue siendo `counters/orderNumber`, también
  para el checkout web, que conserva su flujo, validaciones y mensajes.
  Solo las pruebas inyectan un contador aislado. Identidad y normalización de
  teléfono compartidas: el teléfono verificado procede del transporte, nunca
  del modelo. Los pedidos WhatsApp verificados se leen mediante los endpoints
  existentes de admin y Mis pedidos; un teléfono escrito a mano queda sin verificar.
- El mensaje de pedido lo arma `order-payment.service` con la configuración
  bancaria existente: número, total, instrucciones y verificación manual.
  `responder` lo envía textualmente, en lugar del texto del modelo. El resultado
  público de `crear_pedido` no incluye datos bancarios. Fixtures bancarios ficticios
  en `test/fixtures/agent-bank.json`; el PDF admite inyección de esa configuración
  en pruebas y conserva los valores por defecto en el checkout actual.
- `order_pdf_jobs` persiste estado, fase, lease y entrega del mensaje/PDF.
  `order_alerts` guarda solicitudes idempotentes de alerta; nunca las envía el
  agente ni el trabajador. El PDF usa el procesador existente fuera del plazo
  del turno. Trabajos sin envío iniciado se recuperan automáticamente; si un
  reinicio deja un envío iniciado sin confirmación, queda para revisión y reenvío
  por una persona. Las fallas conservan `pdfDelivered:false`; no se repite la compra.
- El trabajador tiene inicio/parada explícitos y sigue desconectado del arranque
  productivo. En la puesta en marcha conjunta hay que iniciarlo con el transporte
  real y conectar el despacho de `order_alerts` exclusivamente a `whatsapp.js`.
  Desplegar los índices de `order_pdf_jobs` de `firestore.indexes.json` con
  `firebase deploy --only firestore:indexes` en esa puesta en marcha. El router,
  WhatsApp y los agentes productivos actuales no se modifican en 4B.
- Llamadas del agente nuevo: 20 s por defecto, configurable mediante
  `AGENT_MODEL_CALL_TIMEOUT_MS` o `--agent-model-call-timeout-ms` (entero de 1000
  a 60000). Un único reintento compartido entre timeout, HTTP 429/5xx y cortes
  transitorios de red. El timeout reintenta si quedan al menos el plazo de llamada
  más 5 s (25 s con el default). Los errores transitorios del proveedor esperan
  500 ms cancelables y requieren además ese tiempo (25,5 s); el margen se vuelve
  a comprobar después de esperar. Otros 4xx y errores de argumentos/autenticación
  no se reintentan. `maxRetries:0` del SDK solo para el agente nuevo.
  El informe cuenta cada intento y registra `errorClass`, HTTP y código de red
  cuando existen, sin mensajes crudos del SDK; los tokens sin metadatos se dejan
  desconocidos. Se conserva thinkingBudget:512 y el límite de 60 s por turno,
  incluyendo multimedia; un reloj monotónico limita el tiempo real también
  cuando el runner usa un reloj virtual para las ráfagas.
- En el runner, `texto:null` y `empaque:null` son decisiones explícitas sin
  personalización/empaque, tal como documenta el encabezado del YAML. K-01 a K-05
  usan herramientas reales con persistencia y transporte en memoria; los trabajos
  PDF falsos se drenan después del turno. Las pruebas del emulador cubren
  concurrencia, rollback, contador compartido y contratos de lectura web/WhatsApp.
  Comandos y archivos en `test/eval/README.md`. Los resultados los obtiene el dueño.
- No se edita conversations.yaml, checks ni umbrales, ni TEMPORAL ENTREGA 5.
  Siguen pendientes la política TTL de Firestore para carts y la limpieza de
  imágenes huérfanas en Cloudinary, junto con la conexión productiva final.

## Corrección 4B: política de fallas técnicas consecutivas

- Decisión de Arnaldo: la primera falla técnica del turno cierra por código con
  "Perdón, tuve un inconveniente para responderte. ¿Me lo escribís de nuevo?".
  No activa handoff, no cuenta como incomprensión ni solicita alerta. El bot
  continúa atendiendo. La segunda falla consecutiva activa handoff y conserva
  el mensaje actual de derivación, con una única solicitud pendiente en
  `guardianAlerts` (`TECHNICAL_FAILURE`, `delivered:false`). La envía solamente
  `whatsapp.js` al conectar el agente nuevo en la puesta en marcha conjunta.
- `consecutiveTechnicalFailures` y `lastTechnicalFailure` se guardan en el
  checkpoint, separados de `consecutiveMisunderstandings`. Un cierre exitoso
  reinicia la racha técnica, también con entendido:false. No se reinicia solo
  por una sesión nueva y sobrevive a restaurar el runtime. El ID del lote evita
  duplicarla si falla el envío y el guardián recoge el mismo error. El índice
  de handoff se actualiza por un puerto del servidor; no se conecta al router
  ni al WhatsApp productivo actual.
- El aviso invalida la autorización de compra y las confirmaciones mostradas
  de texto/RUC, sin borrar borradores ni carrito. Un sí a la petición de
  reescribir no permite usar una confirmación anterior.
- Un commit de crear_pedido mantiene la recuperación de 4B: nunca se reemplaza
  su pago por el aviso ni se provoca una derivación técnica de esa compra.
  Enviar exitosamente el mensaje recuperado reinicia la racha; si la entrega
  queda incierta, continúa el trabajo durable y la revisión humana prevista.
- El runner marca `error` cualquier cierre técnico, incluyendo errores del
  proveedor y falta de cierre válido. Conserva los consumos y la conversación,
  y no evalúa calidad en esa repetición. Código, fase, clase de error y HTTP
  quedan en report/trace; no se registran mensajes crudos del SDK ni prompts.
- Diagnóstico del archivo provisto por el dueño:
  `2026-10-13T11-07-16-310Z-c39772b4`: C-02/2 muestra una única llamada fallida
  de 658,8 ms, AGENT_ERROR, sin reintento. No guarda el motivo original del SDK.
  El timeout de 19.999,5 ms y el único reintento corresponden a POL-08/3,
  cuyo segundo intento se completó en 10.186,6 ms. Son datos leídos del informe
  existente, no una evaluación ejecutada por el asistente.
- Tests: aviso aislado, segunda falla y alerta única, silencio posterior,
  reinicio con un cierre válido, restauración del estado, registro único por
  lote, timeout sin efectos tardíos, compra confirmada con pago conservado e
  invalidación de autorizaciones anteriores. Los ejecuta el dueño. Se mantienen
  YAML, checks, umbrales, pensamiento 512, plazo total de 60 s y el reintento
  aprobado de 20 s. TEMPORAL ENTREGA 5 queda intacto.

### Reintento de errores transitorios del proveedor

- Decisión posterior de Arnaldo: el único reintento por llamada también cubre
  HTTP 429, HTTP 5xx y errores transitorios de red, con 500 ms de espera incluidos
  en el tiempo restante. No aumenta el plazo de 60 s ni el pensamiento 512.
  No se inicia un segundo intento si faltan espera, plazo completo y 5 s de margen;
  cancelar el turno elimina la espera y prohíbe nuevas llamadas o envíos.
- La clasificación usa HTTP y códigos de red de la cadena `cause`. El SDK
  instalado descarta esa cadena en algunos errores de fetch; solo sus firmas
  conocidas de transporte sirven de respaldo. Los errores de solicitud y los
  desconocidos no se reintentan. No se guardan mensajes crudos ni URLs del SDK.
- `report.json` y `trace.jsonl` registran la clase de cada intento fallido
  (`MODEL_TIMEOUT`, `RATE_LIMIT`, `PROVIDER_5XX`, `NETWORK`, `HTTP_4XX`,
  `INVALID_REQUEST`, `TURN_TIMEOUT`, `CANCELLED` u `OTHER`). El resumen agrega
  conteos por clase; cada intento cuenta como llamada, con tokens desconocidos
  si el proveedor no los informó.
- Agotar ambos intentos cuenta una sola falla técnica del turno: aviso fijo
  la primera vez y derivación ante el segundo turno consecutivo. Un reintento
  exitoso cierra normalmente y reinicia la racha. La recuperación tras un commit
  sigue teniendo prioridad. Los tests los ejecuta el dueño.

## Agente nuevo: entrega 5A

- Implementa derivar({motivo,texto}) como segundo cierre. La octava llamada
  permite responder o derivar; dos cierres o llamadas posteriores se rechazan
  antes de ejecutar el lote. El mensaje conversacional lo escribe el modelo.
  responder suma la racha con entendido:false O fueraDeAlcance:true, una vez por
  turno; el cuarto lo deriva el código con un único texto fijo. Un cierre normal
  o sesión nueva reinicia la racha; las fallas técnicas conservan su contador
  separado. El contexto expone el contador de turnos cerrados: con valor 2 y una
  nueva consulta sin encauzar, el prompt ofrece una persona en el tercero sin
  usar derivar. fueraDeAlcance es booleano y false si se omite.
- Pedidos explícitos de una persona y reclamos derivan directamente. Negociaciones
  y cantidad corporativa explican lo vigente y ofrecen una persona; solo derivan
  cuando acepta. Ante reclamos, el prompt pide disculpas antes de derivar. No se
  deriva por palabras clave. Se conserva el carrito.
- Umbral en el documento único agent_config/conversation, separado de policies.
  corporateQuantityThreshold es entero positivo, sin default en src/. GET/PUT
  /admin/agent-config requieren sesión y administrador real. Revisión/timestamp
  son del servidor; versión opaca por umbral/revisión. 400/409 indican el campo.
  Angular tiene formulario propio en Políticas, conserva borrador y permite
  recargar tras un conflicto antes de volver a guardar.
  El contexto del servidor lee corporateQuantityThreshold en cada turno y expone
  solo el umbral válido, o null si falta/es inválido. El prompt ofrece atención
  corporativa para una cantidad total mayor incluso si también consulta por
  diseño/logo; las herramientas conservan su comprobación obligatoria.
- Cantidad corporativa compara suma total de unidades > umbral; igualdad permite
  seguir. Carrito agregar/modificar conserva el anterior y guarda por separado
  pendingCorporateRequest durante tres días, con referencias resueltas del catálogo
  y sin subidas. Invalida cotización/confirmación anterior. La alerta incluye esa
  solicitud. Una operación válida sobre líneas la limpia; subir el umbral no
  aplica silenciosamente una solicitud rechazada.
- Cotizar aplica la regla tanto al carrito como a sus líneas informativas.
  CANTIDAD_CORPORATIVA se comprueba antes del stock: aun sin unidades suficientes,
  una solicitud sobre el umbral ofrece atención humana.
  crear_pedido la lee dentro de la transacción antes de cualquier escritura;
  falta de configuración devuelve CONFIGURACION_INCOMPLETA. La repetición de
  un pedido ya creado conserva idempotencia. Pricing mantiene exactamente su
  tope de 100 por ítem, sus mensajes y el checkout web. El cierre de una compra
  recién creada sigue usando responder y su pago exclusivo del servidor.
- Alertas comunes: agent_alerts para episodios de chat y order_alerts para PDF
  4B, con primitiva compartida de creación idempotente. El checkpoint guarda la
  solicitud antes de escribir la bandeja/índice. Recuperar reintenta persistencia,
  sin duplicar el episodio, repetir mensaje, reiniciar delivered ni sobrescribir
  una reactivación del mismo episodio. Si falta contexto por una lectura fallida,
  se marca contextUnavailable en los metadatos de la alerta y no se inventan datos.
  Su contexto para el equipo es un DTO: nombres de producto/variante/empaque,
  cantidades, texto confirmado, envío, facturación y total de la cotización
  mostrada del mismo chat, más la solicitud de volumen rechazada. No incluye IDs
  internos, huellas, borradores ni marcas de sesión/TTL; mensajes y pedidos también
  se proyectan por campos. La cotización y el carrito originales quedan intactos.
  Nadie envía al equipo aquí.
  Solo whatsapp.js despachará y acusará entrega en la puesta en marcha conjunta.
- El runner inyecta configuración ficticia desde test/fixtures/agent-config.json,
  identificada en metadata.agentConfigFixture. context.umbralCorporativo permite
  un entero positivo por caso; initial-state lo lleva a la configuración del
  servidor en memoria antes de cotizacionMostrada y de instalar herramientas.
  Sin esa clave se mantiene la base; valores inválidos bloquean con campo/línea.
  El snapshot registra la configuración efectiva. Repositorios de reglas/alertas y
  pedidos siguen en memoria. Tests cubren derivación, cuarto intento, límite
  agregado, ausencia de configuración, conservación del carrito y pago, contratos
  y concurrencia/rollback en el emulador. O-03/O-04/H-01/H-03 usan las herramientas
  reales; no se edita conversations.yaml ni los checks/umbrales.
- 5B implementada, pendiente de verificación del dueño: registrar_comprobante,
  PDF del guardián, almacenamiento privado, descarga autenticada para admin,
  retención de seis horas sin asignación, panel de comprobantes y O-02.
  Se quitó por completo TEMPORAL ENTREGA 5 del prompt. WhatsApp, router y agentes
  productivos actuales siguen intactos.
- En la puesta en marcha: cargar el umbral real desde el panel, conectar puertos
  nuevos/checkpointer/reactivación y dispatcher de alertas solo en whatsapp.js,
  desplegar índice agent_alerts(delivered,createdAt) mediante firestore:indexes.
  Sin deploy antes de la puesta en marcha conjunta con el catálogo.
- Archivos, comandos y recorrido manual: docs/VERIFICACION-agente-5A.md. El dueño
  ejecuta pruebas/builds/evaluaciones; este documento no afirma sus resultados.

## Agente nuevo: entrega 5B

- registrar_comprobante acepta attachmentId O comprobanteId, y orderNumber
  opcional. Identidad solo del servidor: mismo chat o teléfono verificado y
  normalizado. Uno pendiente asocia; varios devuelven PEDIDO_AMBIGUO y números
  propios; ninguno PEDIDO_NO_DISPONIBLE. Número explícito vuelve a validar
  pertenencia y estado. El archivo se guarda primero en privado para elegir
  en otro turno. No interpreta importes ni confirma pagos.
- payment_receipts guarda intención de subida, descriptor privado y relación.
  La asociación y agent_alerts/PAYMENT_RECEIPT se escriben en una transacción
  que relee archivo, pedido y alerta antes de escribir. No escribe el pedido,
  no cambia su estado ni stock. Un comprobante solo se asocia a un pedido;
  repetición del mismo comprobante/pedido pendiente es idempotente. Alertas
  deduplicadas por comprobante; solo whatsapp.js las despachará al activar el agente.
- El acuse textual lo arma el servidor y responder lo envía en lugar del texto
  del modelo. La entrega pendiente se recupera desde Firestore tras un reinicio
  o una interrupción después del commit; nunca pide repetir la compra. El mensaje
  de pago de una compra recién creada conserva su prioridad.
- PDF del guardián: máximo 5 MB (AGENT_PDF_MAX_BYTES, solo puede reducirse), MIME
  application/pdf y firma %PDF/version + cierre %%EOF. Cuenta dentro de los 10 MB
  existentes por turno; no se transcribe ni pasa al modelo como contenido. El
  modelo solo recibe tipo, nombre e identificador. Bytes solo en el registro
  del turno, que se cierra incluso ante cancelación. Imágenes también se validan
  por firma al registrar el comprobante.
- Sin asignar: seis horas desde recepción, configurable con
  AGENT_RECEIPT_UNASSIGNED_TTL_MS (1 minuto..7 días). El acceso/selección se corta
  al vencer. Un barrido independiente cada minuto reclama transaccionalmente
  el archivo vencido, borra almacenamiento y luego marca el registro como deleted; reintenta fallos
  y recupera uploading/deleting tras reinicio. El borrado físico puede demorarse
  por la siguiente pasada o un fallo del proveedor; no vuelve a permitir acceso.
  No usar TTL de Firestore que borre metadatos antes de eliminar el archivo.
- **Retención decidida por Arnaldo: 30 días.** Pago verificado: treinta días desde
  paymentVerifiedAt del pedido. Nunca verificado (pendiente/abandonado o cancelado):
  treinta días desde createdAt de la subida. Sin asignar conserva las seis horas.
  El cambio manual a un estado con pago confirmado guarda paymentVerifiedAt en
  la misma transacción de estado/stock, solo la primera vez; no cambia pricing,
  mensajes ni el descuento de stock. La fecha se conserva al preparar/cancelar.
  Nunca se deduce una verificación de updatedAt ni del archivo: históricos pagados
  sin fecha fiable se conservan y generan RETENTION_VERIFICATION_DATE_MISSING.
  Requieren completar la fecha con evidencia antes de poder limpiarlos.
- Barrido diario de asociados al iniciar y cada 24 h, separado del barrido corto
  de sin asignar. Configuración validada: AGENT_RECEIPT_ASSOCIATED_RETENTION_MS
  (por defecto 30 días, rango 1..365 días) y
  AGENT_RECEIPT_RETENTION_CLEANUP_INTERVAL_MS (por defecto 24 h, rango 1 min..7 días).
  Candidatos paginados por status/createdAt; se relee el pedido en la transacción
  de reclamo, antes de escribir. Una verificación concurrente extiende la retención.
  Archivo -> deleting -> borrado privado idempotente -> deleted con deletedAt.
  Asociación, metadatos y alerta histórica se conservan; no escribe el pedido.
  Si cae entre pasos, el siguiente arranque/barrido recupera deleting; fallos
  del proveedor se reintentan en otra pasada. La eliminación física puede esperar
  hasta el próximo barrido o la recuperación del almacenamiento.
  Reenviar bytes de un archivo eliminado crea una generación nueva de comprobante;
  no sobrescribe el registro histórico ni permite que un borrado atrasado lo afecte.
  Desplegar el índice payment_receipts(status,createdAt) de firestore.indexes.json
  en la puesta en marcha conjunta. Pruebas/comandos: VERIFICACION-pendientes-5C.md.
- Cloudinary: subida firmada raw + type:authenticated, overwrite:false,
  backup:false, sin conversiones ni URL en los contratos. Descarga firmada
  temporal solo dentro del backend, que entrega bytes tras verificar admin real,
  activo, y relación con el pedido. Cache-Control:no-store, attachment, nosniff
  y CSP sandbox. Nunca retorna URL, firma ni descriptor del proveedor.
- **Verificación de Cloudinary pendiente para puesta en marcha:** probar la cuenta
  real y sus permisos de raw/authenticated, descarga firmada de JPG/PNG/PDF,
  bloqueo de URL sin firma y de originales/derivados, eliminación sin backup
  y configuración de PDF/ZIP de Security si la cuenta la requiere. No se cambió
  la cuenta durante esta implementación. Fuentes y recorrido: VERIFICACION-agente-5B.md.
- Emulador: archivos privados en dev/receipts (ignorado, permisos 0700/0600), sin
  express.static, conservados al reiniciar. Siembra un comprobante sintético en
  un pedido pendiente de las fixtures. Solo descarga con JWT admin local. Runner
  usa un puerto de almacenamiento en memoria y o02-receipt.png en el manifiesto.
  El panel agrega lista/descarga en un componente con estilos propios; el SCSS
  del detalle y los presupuestos no cambian. Confirmación manual de pago intacta.
- En puesta en marcha desplegar índices payment_receipts de firestore.indexes.json
  y conectar los puertos del agente/checkpointer/transportes. El worker de limpieza
  se inicia con server.js y con el servidor local. No conectar ni desplegar el
  agente nuevo por separado del catálogo. Archivos y comandos: VERIFICACION-agente-5B.md.

## Agente nuevo: entrega 5C — fotos automáticas

- Decisión de Arnaldo: listas y recomendaciones muestran como máximo tres
  productos por mensaje, ofreciendo más cuando hay otras opciones pertinentes.
  responder recibe productosMostrados opcional (hasta tres IDs distintos),
  envía primero el texto y después una foto principal por producto. La búsqueda
  conserva su máximo de cinco resultados para detectar opciones adicionales.
- Criterio de principal: primera imagen de la primera variante activa con fotos,
  en el orden del catálogo. No cambia por el stock: una variante activa agotada
  sigue visible. Si ninguna variante activa tiene fotos, se omite ese producto.
  El pie se arma en el servidor con nombre y precio menor de las variantes activas;
  incluye Desde si los precios difieren. No se reciben precios, pies ni URLs del modelo.
- sentProductImages persiste URL, producto, pie y entrega en el estado de la
  sesión. Comparación por URL exacta, compartida con enviar_imagenes. Nueva sesión
  (más de seis horas, señal explícita o reactivación) limpia este registro. Handoff
  sin reactivación lo conserva. El puerto de checkpoint del grafo nuevo debe
  persistir este campo en la puesta en marcha.
- Antes del envío se reserva en el checkpoint: una entrega incierta por caída
  no se repite automáticamente en esa sesión. Fallo explícito libera la reserva;
  no hay reintento dentro del turno. Si no se puede guardar la reserva, no se
  envía. Error de envío/consulta/checkpoint queda por producto en el resultado y
  en el log/trace, sin contador técnico ni derivación. Cancelaciones y plazo total
  conservan su comportamiento y evitan efectos posteriores al cierre.
- responder devuelve productImages.sent (producto/pie), skipped (motivo) y
  failed (código), y textOnly para las líneas del servidor. El modelo nunca afirma haber enviado una foto. El siguiente
  contexto solo anuncia IDs con entrega confirmada en productPhotosSent, sin
  bytes ni una lista completa de URLs. enviar_imagenes sigue disponible para
  solicitar hasta tres fotos nuevas; salta las URLs ya entregadas/reservadas.
- No se agregan fotos a resúmenes de cotización completos, incompletos o
  informativos, mensajes de pedido/pago ni acuses de comprobantes. Consultar
  políticas o estado de pedido inhibe fotos automáticas hasta una lectura posterior
  válida del catálogo; una recomendación posterior puede enviarlas. Omitir productosMostrados conserva
  el comportamiento de los cierres anteriores.
- El transporte falso captura tipo, producto y pie de cada foto. La evidencia
  pública del juez los incluye con eventId, sin bytes ni instrucciones privadas.
  imageUrls en variantes de fixtures es opcional: listas HTTP/HTTPS se conservan;
  ausencia/lista vacía significa sin fotos. Errores de formato señalan campo y línea.
- No se edita conversations.yaml: C-04 y P-08 usan el parche del dueño. Pensamiento,
  tiempos, checks y umbrales no cambian. Sin modificaciones a WhatsApp, router,
  checkout web ni Angular. Pruebas y evaluación las ejecuta Arnaldo; archivos y
  comandos: VERIFICACION-agente-5C.md.
- Corrección de listas: con productosMostrados el modelo solo escribe una
  introducción breve en texto y un cierre opcional en cierre, sin listar productos
  ni precios. El servidor presenta en el orden de IDs: introducción, foto por
  producto con nombre/precio o línea textual en su lugar, cierre si existe.
  Sin foto, foto ya enviada en sesión o envío fallido: línea del catálogo;
  mantiene la deduplicación de fotos y la presentación completa de la lista.
  Cotizaciones, pedidos/pago y acuses no agregan estas líneas ni el cierre de lista.
  Políticas/estados bloquean hasta una lectura válida posterior del catálogo.
  Regla de prompt y tests sin cambiar YAML/checks.
- Corrección de entrega 6 (SEC-01): trace.jsonl, línea 1602, de la corrida
  2026-10-15T16-49-11-216Z-c804003c muestra productosMostrados y una oferta humana
  en cierre, pero CONTENIDO_NO_APLICA por consultar_politicas anterior a la búsqueda.
  Una búsqueda con resultados o detalle válido posterior habilita la lista;
  no se levanta el bloqueo por una lectura fallida/vacía. Cotizaciones y mensajes
  de pedido/pago/comprobante conservan su prioridad. La introducción de una lista
  se envía recién cuando se pudo resolver una fila válida; si no, responder devuelve
  LISTA_NO_DISPONIBLE sin introducción/cierre para corregirlo en ese mismo turno.
  Una introducción terminada en dos puntos (también con formato Markdown) sin
  productos/empaques, o cierre sin lista, devuelve LISTA_FALTANTE. Los resúmenes y
  preguntas agregados por el servidor completan sus propias introducciones.
  Precio puntual de un solo producto: puede escribir el dato de la herramienta
  directamente. Prompt: al rechazar otra condición, terminar con una pregunta
  ofreciendo una persona (en cierre si hay lista); mencionar quién decide no
  alcanza. Al pedir comprobante, aclarar siempre verificación manual del equipo.
  Diagnóstico, archivos y comandos: VERIFICACION-pendientes-5C.md.

## Entrega 5C: agregado de fotos de empaques

- Verificación histórica: en hodie-tienda, commit 0a0da0f, el detalle usaba
  product.imageUrls[0] para el producto y [1]/[2]/[3] para la lista fija de
  empaques. onRadioChange mostraba imageUrl de la opción seleccionada. El
  servicio leía URLs del catálogo; no construía nombres/URLs de Cloudinary.
- En feature/catalogo-variantes ya existían packagingOptions[].imageUrl,
  miniaturas del selector, formulario con subida firmada y edición/reemplazo de
  esa imagen. Se perdió el cambio de la imagen principal: [(selected)] solo
  asignaba selectedPackaging. Corregido en ProductDetailPage: elegir un empaque
  usa su foto, quitarlo o elegir uno sin foto vuelve a la variante actual.
  Cambiar de variante conserva la foto del empaque, compartida por producto.
- Imagen opcional por opción: URL HTTP/HTTPS sin credenciales o ruta del mismo
  origen desde /; vacío/ausente significa sin foto. Backend y formulario validan
  este campo; upload existente mantiene MIME, firma y límite de 10 MB. Rechazos
  señalan packagingOptions[n].imageUrl y conservan el borrador. Fixtures Angular
  usaban una URL data: SVG para ese campo: se reemplazó por una ruta ficticia
  válida, sin cambiar precios/nombres ni relajar aserciones. Las imágenes de
  variantes no cambian su validación en este agregado.
- Bot: responder.empaquesMostrados [{productId,packagingType,variantId?}] ofrece
  imágenes del producto con cada empaque. Máximo tres presentaciones junto a
  productosMostrados. El servidor arma el pie con nombre de producto/empaque y
  precio unitario del producto con ese empaque (variante elegida + adicional, o
  Desde sin variante si difieren), según decisión confirmada de Arnaldo. Es informativo:
  el pricing de cotización/pedido y sus mensajes/stock siguen intactos.
- Sin foto se envía una línea textual del servidor, agrupada en un mensaje
  adicional antes de las fotos. Resultado packagingImages.sent/skipped/failed/
  textOnly informa acciones. Errores de medios no derivan ni suman falla técnica;
  cancelación/plazos existentes cortan efectos. Cotizaciones, mensajes de pedido,
  comprobantes, políticas y estados inhiben también estas presentaciones.
- enviar_imagenes admite packagingType para una opción concreta; sin filtro
  incorpora empaques al conjunto de fotos del catálogo. Deduplicación por URL
  en sentProductImages compartida con 5C y reiniciada solo con sesión nueva.
  packagingPhotosSent distingue estas entregas del producto solo en el contexto.
- Runner: fixtures conservan packagingOptions[].imageUrl y validan formato con
  campo/línea. Fotos públicas para el juez incluyen producto, packagingType y pie;
  no bytes. YAML y parche-fotos.py del dueño quedan intactos. Sin cambios a checks,
  umbrales, pensamiento, tiempos, checkout/pricing/stock ni transportes productivos.
- Backend en feature/agente y Angular en feature/catalogo-variantes. No se hace
  commit, push ni deploy. Archivos, comandos y recorrido manual:
  VERIFICACION-empaques-5C.md; el dueño ejecuta las pruebas/builds/evaluaciones.

## Agente, entrega 7: conexión dividida en 7A, 7B y 7C

- Solo 7A implementada para revisión del dueño; sin resultados de tests ni
  evaluaciones afirmados. La tienda sigue en mantenimiento. No se despliega,
  no se elimina legacy y no se modifican YAML, checks, umbrales, pensamiento ni
  plazos del agente. No hay dependencias nuevas ni cambios a package.json.
- AGENT_ENABLED ausente/false conserva el receptor y grafo anteriores, sin
  acceder a los puertos del piloto. AGENT_MAINTENANCE_MODE se valida siempre;
  las demás variables del piloto no alteran el camino apagado.
  Activado: AGENT_ALLOWLIST ausente habilita todos; presente vacía, ninguno;
  con números, solo sus teléfonos normalizados resueltos desde WhatsApp. Un
  teléfono escrito por el cliente o un LID sin resolver no habilitan la lista.
- AGENT_MAINTENANCE_MODE acepta exactamente message (default) o silent; otro
  valor rechaza el arranque. silent solo es válido con AGENT_ENABLED=true y
  AGENT_ALLOWLIST definida y no vacía. Fuera de la lista: solo un log con chat
  enmascarado por evento, sin modelo, descarga, escritura de IDs, mantenimiento,
  envíos ni checkpoints. La resolución LID tampoco escribe caché ni advierte.
  El launcher imprime modo y cantidad de números únicos habilitados al arrancar.
- Fuera de la lista, únicamente con interruptor activo y modo message: mantenimiento
  configurable con AGENT_MAINTENANCE_MESSAGE, por defecto «¡Hola! Estamos
  renovando nuestra tienda y volvemos muy pronto. Gracias por escribirnos 🎁».
  Reserva durable por chat cada seis horas antes del envío, sin modelos. Se
  registra como envío propio con ID de WhatsApp. Fallo/incertidumbre no liberan
  la cuota; ningún error del piloto permite caer al router viejo.
- Runtime-factory compartida entre eval-adapter y production-adapter; conserva
  las herramientas y límites existentes. Checkpoints nuevos en agent_checkpoints
  y agent_checkpoint_writes, thread_id real. El saver compartido tiene opciones
  de colecciones y modo de lectura estricto opt-in; sus defaults legacy siguen
  intactos. Una lectura fallida no se trata como estado nuevo. Historial por
  lote con mensajes enviados y sin bytes/attachmentId en estado.
- IDs de entrada reclamados transaccionalmente en agent_whatsapp_messages antes
  de la ráfaga: expiresAt Timestamp = recepción + siete días. Deduplica entre
  receptores concurrentes y reinicios. No guarda el cuerpo ni los medios. El
  vencimiento lógico se aplica aunque TTL todavía no haya borrado la fila;
  un registro inválido es error explícito. Otro ID con igual texto es otro mensaje.
- Transporte FIFO por chat, pausa cancelable de 500 ms entre envíos, descarga
  acotada de fotos y caption del servidor. Un fallo de descarga permite el
  reemplazo textual existente y continuar. Si el envío externo queda incierto,
  se corta esa secuencia y no se reintenta a ciegas. agent_whatsapp_deliveries
  guarda metadatos e IDs propios, sin contenido, con expiresAt a siete días.
  agent_whatsapp_maintenance conserva la próxima hora habilitada por chat.
- **Pendiente de puesta en marcha:** habilitar política TTL sobre expiresAt de
  los collection groups agent_whatsapp_messages y agent_whatsapp_deliveries.
  No agregar otros siete días de offset: ya están incluidos en expiresAt.
  La política es independiente de firestore:indexes. Comandos/fuente oficial en
  VERIFICACION-agente-7A.md. No se ejecutó ninguna operación de administración.
- Las ráfagas continúan en RAM. El apagado ordenado registra cuántas descarta;
  SIGKILL/reinicio abrupto puede perderlas. Los IDs reclamados no se reprocesan
  dentro de los siete días. No se promete entrega exactamente una vez entre
  Firestore y WhatsApp. No se reenvía automáticamente una entrega incierta.
- scripts/dev-agent-whatsapp.js exige lista no vacía y configuración demo antes
  de importar SDKs/revisar puertos; inicia el entorno local o se conecta a él con
  --attach. Usa sesión WhatsApp separada, banco ficticio del runner, fotos y
  personalización locales y comprobantes privados en dev/receipts. El modelo
  sí es real. Mantiene el JWT local independiente y los guardas existentes.
- 7B pendiente: message_create, envoltorio global de envíos propios, toma humana,
  resume-bot por motor y despacho de agent_alerts/order_alerts. El panel debe
  listar todos los chats pausados por derivación o toma manual, con motivo y
  fecha, y reactivarlos con un clic. En 7A escribir desde la tienda aún no pausa
  automáticamente el bot, y el panel todavía reactiva solo el grafo legacy.
- 7C pendiente: auth_failure/disconnected/message_ack, trabajador PDF sobre el
  transporte real, telemetría y cachedContentTokenCount. En 7A se conservan los
  trabajos PDF y alertas pendientes, sin despacharlos. No se toca el stock ni
  la confirmación manual de pagos. Guía, inventario y comandos del dueño:
  VERIFICACION-agente-7A.md.
