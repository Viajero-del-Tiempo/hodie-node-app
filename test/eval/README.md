# Runner de evaluación · entregas 1 a 4A

El dueño escribe conversations.yaml. El runner lo lee; nunca lo modifica.
Se implementa exclusivamente su formato v2, documentado en el encabezado.
Catálogo, políticas, pedidos, carritos, checkpoints y cargas viven en memoria.
El runner no importa el grafo viejo, Firebase, WhatsApp ni servicios con efectos
externos. El agente real y el evaluador llm usan Gemini y leen .env; no inician
servicios productivos. --agent real --judge stub también llama al modelo del agente.
Requiere el runtime Node 24 del proyecto (module.registerHooks): bloquea import
y require de Firebase, Firestore, WhatsApp y Cloudinary antes de inicializarlos,
incluido el inicializador de Firebase del backend. Una dependencia accidental
del adaptador se informa como PRODUCTION_IMPORT_BLOCKED.

## Comandos

Desde hodie-node-app:

    npm run test:eval -- --validate
    npm run test:eval:unit
    npm run test:agent:unit
    npm run test:eval -- --agent trivial --judge stub --case C-01
    npm run test:eval -- --agent trivial --judge stub
    npm run test:eval -- --agent trivial --judge llm --case C-01

--validate solo lee/valida y muestra el conteo y los diagnósticos con línea.
No ejecuta el agente, el evaluador ni genera informes.

El agente trivial responde de forma genérica. El juez stub siempre devuelve
not_evaluated, marcado simulated: true: verifica la tubería, no la calidad.
must, must_not y handoff: ofrece quedan sin evaluar y nunca cuentan como
aprobados. Los umbrales de seguridad y del resto indican evaluated: false,
passed: 0 y pass: false; thresholdsPassed siempre es false con stub.
Las verificaciones determinísticas conservan lo observado. El umbral de handoff
puede evaluarse para si/no, pero una oferta requiere un veredicto semántico real.
Una repetición sin fallos determinísticos queda como not_evaluated; si falla una
verificación determinística, se conserva fail y sus criterios siguen sin evaluar.
Ninguna combinación con agente trivial o juez stub aprueba producción.
Con llm, createGeminiModel crea un juez independiente a temperatura 0; requiere
GEMINI_API_KEY y usa el modelo configurado por la fábrica del proyecto.
El juez recibe evidencia pública por criterio, sin prompt privado del agente.
Las conversaciones y resultados de herramientas se tratan como datos.

Una corrida completa del archivo actual programa 56 × 3 conversaciones. El agente
real implementa cotizar y prepara F-05 con esa herramienta; el trivial sigue
bloqueándolo porque no tiene cotizar real. No se inventa una cotización.
Los fallos de comportamiento del agente trivial son esperables.

Filtros repetibles: --case ID, --cases ID,ID y --category nombre. --case y
--cases se unen sin duplicados; el orden de ejecución sigue el YAML.
La categoría se aplica como intersección. IDs inexistentes, listas con entradas
vacías o intersecciones vacías se rechazan antes de crear el modelo.
Otros parámetros:
--file ruta, --output directorio, --now fecha-ISO, --timeout-ms 60000,
--judge-timeout-ms 60000 y --media manifiesto.json.
El reloj inicial es el mismo en las tres repeticiones; avanza un segundo por
turno del runner, más el silencio de ráfaga del guardián real. Se conserva la
antigüedad relativa de carrito e historial; no hay esperas reales por ráfaga.

## Contexto inicial

- telefonoCliente es verificado. Sin él, userPhoneNumber es null y
  phoneVerified es false. El chat tiene un LID ficticio independiente.
- conversacion aporta los mensajes literales de la sesión actual.
- historialPrevio se conserva antes de sessionCutoff y nunca se envía al modelo.
  duranteHandoff describe ese pasado: no activa una derivación actual.
- sesionNueva marca el comienzo de sesión y reinicia el contador; no borra los
  mensajes declarados de la sesión ACTUAL en conversacion ni el carrito vigente.
- carrito mapea IDs, cantidad, texto, empaque, envío y facturación al modelo de
  SPEC-agente. No contiene precios. Se mantiene actualizadoHaceHoras y vence
  a las 72 horas. Los datos fiscales no implican una confirmación de RUC.
- cotizacionMostrada llama cotizar con el carrito inicial, registra lastQuote
  como mostrado en turno 0 y añade el resumen devuelto al historial. La llamada
  tiene phase: setup y no satisface tools_called del caso.

Claves desconocidas en cualquier nivel de context, referencias inexistentes,
formas incorrectas o herramientas desconocidas bloquean el caso con ubicación.
No se interpretan nombres, descripciones de pasos ni antecedentes en texto libre.
Los fixtures abreviados reciben solo valores técnicos: activación, schemaVersion,
slug tomado del ID, arreglos vacíos y flags ausentes de personalización.
No se completan precios, atributos, fotos ni fechas de pedidos históricos.

## Agente de consulta: entrega 2

--agent real carga src/agents/consultation/eval-adapter.js. Implementa las cinco
herramientas de lectura y responder. Usa createGeminiModel, el servicio central
de catálogo y los pedidos/estado/transporte de esta repetición en memoria.
No se conecta a whatsapp.js ni reemplaza el grafo actual.

Casos objetivo completos de esta entrega (previsión del plan, no resultados):

    npm run test:eval -- --agent real --judge llm --cases C-01,C-02,C-04,P-01,P-02,P-03,P-04,P-05,POL-01,POL-02,POL-03,POL-04,POL-05,POL-06,POL-07,POL-08,O-01,O-05,H-02,CH-01,CH-02,SEC-01,SEC-02,SEC-03,SEC-04,SEC-05,SEC-06

Primera comprobación con una lista corta:

    npm run test:eval -- --agent real --judge llm --cases C-01,C-02,P-01

Con stub se diagnostica la ejecución y el consumo del agente, sin medir calidad:

    npm run test:eval -- --agent real --judge stub --cases C-01,C-02,P-01

Los casos que requieren guardar carrito, dirección o facturación, cotizar,
registrar comprobantes o derivar por conversación quedan para entregas posteriores.
F-05 sigue bloqueado. C-03/P-07 tienen pendientes los totales por cantidad:
el agente no los calcula por su cuenta. P-06 no certifica comprensión visual.
Q-01/Q-05/M-02 pueden cumplir criterios informativos; S-10/S-11/S-12 pueden
cumplirlos con los mensajes preparados por el runner, sin probar aún el guardián
completo. Una selección parcial nunca aprueba producción.

El registro valida argumentos dentro del interceptor: incluso las llamadas
rechazadas dejan traza, pero no ejecutan acciones ajenas a las seis herramientas.
handlerInvoked distingue una llamada ejecutada de un intento bloqueado: un
intento bloqueado no satisface tools_called y sí cuenta en tools_not_called.
Por turno hay ocho llamadas como máximo, contando intentos inválidos y el cierre;
la última se reserva para responder. Lotes con varios cierres, acciones después
del cierre o sin lugar para cerrar se rechazan antes de ejecutar efectos.
Gemini recibe los ejes de opciones en su esquema solo después de leer optionNames
en un resultado del catálogo; no se precargan productos ni listas del negocio.

estado_pedido permite estado y productos solo cuando el pedido corresponde al
teléfono verificado del chat. Sin verificación, o si el pedido es de otro teléfono,
exige número y teléfono de compra coincidentes y devuelve únicamente el estado.
No verifica ni cambia el teléfono del chat. Datos incorrectos devuelven la misma
respuesta genérica. Varios pedidos propios ambiguos requieren elegir el número;
las fechas ausentes no se completan ni se infieren de los números.

El guardián mínimo respeta handoff activo, identidad, categorías, contexto de
lectura y hasta 20 mensajes actuales. Los adjuntos aportan metadata, no bytes al
modelo. Ráfagas reales, transcripción, visión y detección completa de sesiones
quedan para la entrega 3. El contador entendido se mantiene, pero no se aplica
todavía la escalada de cuatro intentos. La entrega 5 agrega derivar, índice y alerta.

Un error técnico, ausencia de cierre o agotamiento del presupuesto activa el
handoff por código y un mensaje fijo. El timeout interno es de 50 s, antes del
timeout de 60 s del runner. La cancelación externa cancela el trabajo sin envíos
ni escrituras tardías. Los bloques temporales del prompt se retiran en entregas
4 y 5, como indica SPEC-agente.

## Contrato del adaptador

Un módulo elegido explícitamente con --agent ruta debe exportar:

    async function createAgent({ world, transport, signal })

Devuelve { kind: "real", runTurn, dispose? }. El agente de prueba usa kind: "trivial".
El valor por defecto sigue siendo trivial; real elige el adaptador de consulta.
Cada repetición crea una instancia, mundo y chat nuevos.

runTurn recibe { turn, history, now, scenario, signal }. history contiene como
máximo los últimos 20 mensajes de la sesión actual; turn.messages conserva la
ráfaga en orden. El runner administra el historial simulado, agregando entrada y
envíos al terminar cada turno; el adaptador no debe agregarlos otra vez.
Los demás campos de estado y los repositorios se actualizan mediante world.
scenario.newSession solo se activa en el primer turno del caso. El juez recibe
instantáneas de carrito y pedidos por turno para comprobar cuándo se guardó
un dato, además del estado inicial y final.

Dependencias disponibles: world.catalog (lectura del servicio central inyectado),
world.orders/carts/checkpoints/uploads, getState/setState, getCart/setCart, now,
getHistory y transport. Se inyectan en las herramientas reales; nunca se recurre
a servicios singleton de producción. El adaptador solo recibe estas dependencias
y el turno: no recibe expectativas ni el archivo de casos.

Registrar cada herramienta canónica con:

    world.registerTool(nombre, handler, { real: true })
    await world.invokeTool(nombre, argumentos)

El interceptor registra llamadas, resultados, errores, orden y duración.
handler recibe (argumentos, { world, transport, turn, phase, signal }).
El resultado de cotizar debe incluir { code: "OK", quoteId, cartFingerprint,
summary? }, calculado por la herramienta real. real: true declara ese origen;
no convierte un mock en una implementación de negocio. Los tests del contrato
usan dobles, pero sus corridas siguen siendo diagnósticas.
El mundo trae responder y derivar mínimos para el agente trivial. El agente real
sustituye responder; su gate impide ejecutar derivar u otras herramientas todavía
no disponibles. La derivación técnica es un cierre por código, sin otra llamada
a herramienta ni al modelo.
dispose recibe { signal }; el mundo/transporte ya están cerrados al disponer.

Todos los turnos terminan con responder o derivar, salvo silencio por handoff,
límite o derivación forzada por código. Guardián y transcripción están en entrega
3; la integración productiva sigue pendiente.

getModelUsage() es una extensión opcional del contrato: devuelve las estadísticas
del contador compartido. Agente y juez reales están instrumentados. Para un
adaptador personalizado sin contador, calls es null, instrumented es false y
observedCalls conserva únicamente las llamadas de fuentes instrumentadas.
No se adivina el número de invocaciones a partir de turnos o herramientas.
Los modelos inyectados para pruebas se identifican en los metadatos y no hacen
elegible una corrida para producción, aunque el doble del juez devuelva pass.

## Consumo

El resumen final de consola y los informes incluyen modelUsage.agent y
modelUsage.evaluator, separados. Cada uno informa calls, successfulCalls,
failedCalls, pendingCalls, reportedTokens (input/output/total), callsWithoutUsage
y usageComplete. Se suman las tres repeticiones de todos los casos seleccionados.
El juez excluye el consumo previo a esa corrida, aunque se reutilice su instancia.

calls cuenta invocaciones invoke(), incluso cuando el proveedor falla, se cancela
o devuelve JSON inválido. No cuenta herramientas como llamadas al modelo ni
cuenta solicitudes HTTP internas/reintentos del SDK. reportedTokens suma solo
metadatos informados por el proveedor; un total ausente no se reconstruye sumando
entrada y salida. Un total informado se conserva aunque incluya razonamiento
y difiera de entrada + salida. No es una estimación de facturación.

Si falta metadata o falla la llamada, callsWithoutUsage aumenta y usageComplete
es false: los tokens informados son un subtotal conocido, no una afirmación de
consumo cero. El agente trivial y el juez stub hacen cero invocaciones reales.
Se guarda también el consumo por turno y por repetición; las firmas/prompt privados
del modelo no se serializan en esos contadores ni llegan al evaluador.

### Latencia y entrada fija (corrección 4A)

modelUsage.*.callDetails registra cada invoke con ID, componente, turno,
estado, durationMs y tokens informados (null cuando no disponibles). Incluye
reintentos del juez y transcripciones, separados. trace.jsonl añade model_call;
las herramientas mantienen durationMs. summary.latency informa p50/p95/máximo
por agente/evaluador/transcripción, por herramienta y por turno, con número
de muestras. Percentil por rango más próximo: ceil(n*p). Una operación en curso
al cortar guarda el tiempo observado e incomplete:true; no se atribuye una
duración completa. Sin muestras se informa null. Los turnos miden tiempo de
pared del procesamiento del runner; no incluyen los 8 s virtuales de ráfaga.

Cada TURN_TIMEOUT conserva interruptedPhase tanto en diagnóstico como en
turn.timeout: model (modelCall), tool (tool), server_context, preparación,
descarga/transcripción de medios, etc. Los timeouts propios del agente/guardián
también indican la fase. No se cambian límites ni umbrales con esta medición.

Por llamada del agente, fixedInput mide caracteres y **estima** tokens como
ceil(caracteres/4) para systemPrompt, toolSchemas (los esquemas realmente
anunciados, incluidos cambios de ejes/cierre) y serverContext. summary.fixedInput
agrega total y media por bloque. No es el tokenizador de Gemini ni una
descomposición exacta de reportedTokens.input: el proveedor solo informa ese
total. Quedan fuera historial, cliente, resultados de herramientas, multimedia
y formato interno del proveedor. No hay consultas adicionales de conteo que
alteren latencia o consumo. Los informes guardan solo cantidades, sin el texto
del sistema ni los esquemas privados; el juez tampoco los recibe.

### Pensamiento del agente y comparación de presupuestos (4A, parte 2)

AGENT_THINKING_BUDGET es una variable exclusiva del modelo del agente. Sin
variable ni flag, el cliente envía thinkingBudget:512 (default aprobado tras el
experimento de Arnaldo; sus datos están en CONTEXT.md). Acepta enteros no negativos seguros (cero incluido), y
rechaza vacío, decimales, negativos o texto. Los límites admitidos por cada modelo
los valida Gemini; no se agrega un máximo global inventado ni un fallback que
oculte un rechazo. Se utiliza el campo thinkingBudget de
[ThinkingConfig](https://ai.google.dev/api/generate-content#ThinkingConfig), sin
traducirlo a thinkingLevel ni cambiar el modelo elegido por GEMINI_MODEL.

--agent-thinking-budget N tiene prioridad sobre la variable; no escribe .env.
El contrato del adaptador recibe thinkingBudget opcional. metadata.agentConfigurations
y cada repetitions[].agentConfiguration registran modelo, thinking.mode,
thinking.thinkingBudget y thinking.source (default/env/override). El default
actual se registra como mode:budget, thinkingBudget:512, source:default. Los
informes antiguos con provider_default y presupuesto null indican que no se
envió presupuesto. Un modelo suministrado directamente queda unknown con
requestedThinking aparte, sin afirmar que se aplicó el presupuesto. Un factory
inyectado para tests también se marca como modelo de prueba, inelegible para
producción. El juez y las transcripciones conservan su configuración actual.

callDetails.callInTurn reinicia al empezar un turno. summary.latency.byCallInTurn
agrupa p50/p95/máximo de la primera, segunda, tercera, etc. invocación de consulta,
y separa transcripciones con su propia numeración. Incluye fallos y tiempo
observado de operaciones cortadas; no es una nueva política de timeout.
turn.modelCalls y summary.modelCallsPerTurn registran agent (consulta más audio),
consultation y transcription: p50/p95/máximo de llamadas por turno, incluyendo
ceros conocidos. Unknown permanece null y se informa unknownSamples; el juez no
entra en esa distribución. Las mediciones y configuración aparecen en JSON,
trazas y Markdown, y el resumen de consola incluye configuración y distribuciones.

datos_envio y datos_facturacion devuelven carrito actualizado, lines enriquecidas,
fields y pendientes ordenados; las propuestas/errores fiscales conservan code,
field y suggestedRuc. No exponen las confirmaciones privadas del checkpoint.
El prompt indica no llamar carrito_ver después de modificar carrito/envío/facturación.

El test de datos de envío necesitaba elegir el empaque antes de esperar una
cotización confirmable: ahora prepara packagingType:null explícito. Se conservan
todas sus aserciones. Pruebas de configuración/flag/metadata, ordinal por turno,
percentiles y respuestas completas están dentro de scripts existentes:

    npm run test:agent:purchase:unit
    npm run test:agent:unit
    npm run test:eval:unit
    npm run test:guardian:unit

Para comparar los cinco casos afectados, manteniendo selección, reloj, imágenes,
modelo, juez y los 60 s del turno, y cambiando solo el presupuesto:

    npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-03,Q-02,Q-03,Q-04,M-05 --now 2026-10-12T15:00:00Z --agent-thinking-budget 512 --output test/eval/results/thinking-512
    npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-03,Q-02,Q-03,Q-04,M-05 --now 2026-10-12T15:00:00Z --agent-thinking-budget 1024 --output test/eval/results/thinking-1024

Cada caso sigue ejecutándose tres veces. Los dos directorios quedan dentro de
results ignorado por Git. Comparar metadata.agentConfigurations,
summary.modelCallsPerTurn, summary.latency.byCallInTurn, latencia total y diagnósticos
de timeout; estos comandos no afirman mejora ni cambian checks/umbrales. No se
agregan timeouts por llamada ni reintentos nuevos. No se ejecutaron acá.

## Guardián completo: entrega 3

--agent real usa src/agents/guardian y consultation/server-context.js para
construir el contexto. El receptor WhatsApp, router y grafo productivos quedan
intactos. whatsapp-adapter.js es un puerto inactivo: no inicia un cliente ni
registra listeners de mensajes. Su conexión y resume-bot quedan para puesta
en marcha. state-store.js recibe un grafo/checkpointer explícitamente inyectado;
los tests no abren Firestore y usan almacenamiento separado.
El caller administra el historial: el runner agrega una sola vez los mensajes
normalizados y enviados; el futuro receptor del grafo hará lo mismo. El guardián
persiste sus controles de sesión/límite/silencio sin duplicar ese historial.

    npm run test:guardian:unit
    npm run test:agent:unit
    npm run test:eval:unit
    npm run test:unit

Corrida de los 27 casos de la entrega 2 más C-03, P-06, S-10, S-11 y S-12
(32 casos, tres repeticiones cada uno):

    npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-01,C-02,C-04,P-01,P-02,P-03,P-04,P-05,POL-01,POL-02,POL-03,POL-04,POL-05,POL-06,POL-07,POL-08,O-01,O-05,H-02,CH-01,CH-02,SEC-01,SEC-02,SEC-03,SEC-04,SEC-05,SEC-06,C-03,P-06,S-10,S-11,S-12

Esto es un comando de verificación, no una afirmación de resultados. Desde 4A,
C-03 puede consultar el subtotal con cotizar y F-05 usa cotización real inicial.
No se modifican casos ni se deja de medir criterios. Comprobantes y
derivación/escalada conversacional siguen en entrega 5. Una selección parcial
no habilita producción y no cambia los umbrales.

El reloj virtual controla los temporizadores de ráfaga. burst declara un lote
sin intervalos en el YAML: sus mensajes se entregan en el mismo instante virtual
y se avanza hasta el silencio, sin esperas reales. Las fronteras 8/30 s, lotes
durante procesamiento, sesiones >6 h, silencio y límite 40/41 se prueban aparte.
El límite se guarda antes de descargar o transcribir. Una sola respuesta fija
por episodio: «Estoy recibiendo muchos mensajes seguidos y tengo que hacer una
pausa. Escribime de nuevo en un rato y seguimos.»
Luego silencio sin modelos hasta recuperar cupo. Registra una solicitud de
alerta, nunca activa handoff ni envía la alerta: eso le corresponde a whatsapp.js.

AGENT_BURST_SILENCE_MS/AGENT_BURST_MAX_MS configuran 8000/30000 por defecto;
AGENT_SESSION_MS=21600000, AGENT_TURNS_PER_HOUR=40, ventana móvil fija de 60 min.
AGENT_TURN_TIMEOUT_MS=60000 cuenta desde cierre, incluyendo medios y espera de
cola. Límites de medios en config.js/.env.example: audio 120 s o respaldo de
2 MB sin duración, imágenes 5 MB y máximo tres, total 10 MB. Duración/tamaño
incomprobables o transcripción fallida piden texto. Preparar medios no sube
imágenes automáticamente; una herramienta de carrito puede subir una referencia
de personalización por el puerto de memoria de 4A.

Bytes de adjuntos duran solo el turno; no se guardan en checkpoint ni reporte.
Los IDs efímeros pueden figurar en la traza, nunca en checkpoint. El informe no
acredita cobertura visual cuando el guardián rechaza una imagen. Las imágenes
llegan al modelo como contenido multimodal de usuario,
con metadatos de servidor, nunca como instrucciones. Audio del YAML ya trae
transcripción; no verifica calidad del transcriptor real. Los unitarios usan
audio/medios artificiales y modelos inyectados. Consumo de transcripción suma
en modelUsage.agent y aparece también en guardian.transcriptionUsage por turno.

La referencia P-06/2 es sintética: caja oscura con tapa, sin marcas ni personas.
No representa un producto real y no acredita sus datos. No se necesita una foto
real. Generador/explicación en test/eval/media/; el archivo debe ser PNG para
Gemini. No publicar fotos de clientes ni otros datos personales en este repo.

Buffer de ráfagas en RAM: SIGINT/SIGTERM/apagado explícito registra
guardian_shutdown.discardedPendingBatches y cancela temporizadores/trabajos.
Un reinicio abrupto pierde pendientes; SIGKILL no permite registrar el log.
No se presupone reentrega de WhatsApp. Estado persistido de sesión/límite/handoff
no se reinicia junto con el buffer. La reactivación se recibe como señal del
servidor; un mensaje del cliente no puede activar esa señal.

## Adjuntos

Los audios ya contienen transcripción: se antepone [audio transcripto].
burst se entrega como un único turno; no simula intervalos que el archivo no define.
La temporización del guardián se prueba con reloj inyectable; la calidad de la
transcripción real requiere una comprobación independiente con audio artificial.

Sin archivos, image llega como descripción marcada mode: described. No se inventa
una foto ni se certifica comprensión visual. Para imágenes reales, el dueño puede
proveer un manifiesto JSON independiente, sin editar los casos. Sus claves son
ID-de-caso/número-de-turno (desde 1); cada valor contiene path y mimeType.
Los paths son relativos al manifiesto. Se aceptan png, jpeg, webp y gif.

transport.getAttachment(attachmentId) devuelve los bytes solo durante el turno.
No quedan en el checkpoint ni en los informes. Documentos y archivos aportan solo
tipo/nombre. sendText y sendImage capturan los envíos sin contactar WhatsApp.
Una corrida con imágenes descriptivas o sin ejecutar todos los turnos de imagen
no es elegible para producción.

## Entrega 4A: carrito y cotización

El adaptador registra carrito_ver/agregar/modificar/quitar, datos_envio,
datos_facturacion y cotizar reales. Reutiliza el pricing, envío y validador fiscal
del servidor, con catálogo fresco inyectado. El carrito guarda IDs, cantidades,
personalización y borradores de datos, sin precios. TTL de tres días sin cambios;
leer/cotizar no renueva. Nunca se escriben pedidos ni se reservan existencias.

cotizar({lineas:[{productId,variantId,quantity,packagingType?}]}) calcula solo
importes informativos sin leer/modificar el carrito ni lastQuote. Devuelve
items[].subtotal y productsTotal con el pricing compartido (incluidos empaques),
confirmable:false y sin quoteId/total final. Sin lineas mantiene el flujo de
carrito; los subtotales del cálculo informativo se adjuntan en responder solo
en el mismo turno, revalidando precio/stock.

En carrito_agregar/modificar, packagingType omitido conserva la decisión o la
deja pendiente; null explícito elige sin empaque (packaging.declined:true);
un tipo del catálogo elige ese empaque. En context.carrito.lineas, empaque:null
es una elección ya guardada; omitir la clave es pendiente. Los carritos viejos
sin marca no infieren una elección. carrito_ver/agregar/modificar/quitar traen
pendientes: todas las personalizaciones, luego empaques (solo con opciones del
producto y con sus nombres/precios), envío y facturación. Un empaque pendiente
impide emitir quoteId. Las reglas del prompt piden seguir esa secuencia.

Una modificación real con carrito_agregar/modificar que deje una línea completa
(personalización y empaque decididos) agrega informar_subtotal primero en
pendientes. El checkpoint lo liga al carrito y al contenido de sus líneas, sin
guardar precios. Cotizar exitosamente, con o sin lineas y aunque el carrito
todavía dé DATO_FALTANTE, lo limpia; su resultado ya no incluye ese pendiente.
No se limpia con una cotización fallida. Volver a cambiar una línea completa lo
reactiva; repetir el mismo dato no lo reactiva ni renueva TTL. Envío/facturación
conservan el pendiente existente, sin generar otro. Vencer el carrito lo elimina.
El prompt pide cotizar/comunicar el subtotal antes de seguir con otros pendientes.
La cotización informativa sigue sin modificar el carrito ni lastQuote; solo
reconoce este pendiente privado si existía antes de calcular.

La corrección agrega tests informativos/sin efectos, stock agregado, esquema
de lineas, estados/orden de empaque, contrato web opt-in y medición/privacidad/
fases de timeout a las suites ya incluidas en los scripts siguientes; no se
agregan scripts ni dependencias.

Incompleto: cotizar devuelve DATO_FALTANTE, confirmable:false, subtotal y campos
faltantes, sin total final ni quoteId. responder agrega el Subtotal de productos
del servidor si fue calculado en ese turno. Completo: quoteId ligado al chat,
huella de carrito y de pricing. responder(quoteIdMostrado) valida frescura,
agrega el resumen del servidor y registra lastQuote después del envío exitoso.
Cambios/TTL invalidan lastQuote. cotizacionMostrada hace este cálculo en setup y
registra la cotización como mostrada en el turno cero, sin llamar al modelo.

Texto propuesto queda como textDraft hasta aceptación posterior de lo repetido
literalmente por responder. sinPersonalizacion guarda declined, distinto de
pendiente. Envío/facturación entran como borradores sin confirmar cada campo.
Solo RUC base o DV discrepante requieren el protocolo explícito: el modelo no
puede confirmar por el cliente ni completar un número solo cambiando el argumento.
El teléfono escrito no se vuelve verificado; perfiles fiscales solo del dueño.

La subida de personalización usa world.uploadCustomizationImage: URL y metadatos
en memoria; no Cloudinary ni bytes persistidos. Q-03/4 usa q03-reference.png,
dibujo sintético de vaca sin datos personales. El manifiesto conserva P-06/2.

Queda 4B: confirmación final posterior, crear_pedido, transacción de pedido y
contador, relación quoteId→pedido, idempotencia, PDF y alerta de falla, emulador.
No existen handlers de esas operaciones. CANTIDAD_CORPORATIVA espera entrega 5.
TEMPORAL ENTREGA 5 queda intacto. El aviso de límite invita a reintentar y las
imágenes del cliente son referencias, nunca evidencia de un producto del negocio.

Regresión de contratos compartidos, para ejecutar antes y después del cambio
(sobre el commit base y luego la versión 4A, respectivamente):

    node --test test/test_order_variant_pricing.js test/test_order_variant_stock.js
    npm run test:customer:unit
    npm run test:catalog:unit
    npm run test:integration:emulator

El último script levanta su emulador con guardias; no usar test:integration de
producción para esta entrega. Después del cambio, agregar:

    npm run test:agent:purchase:unit
    npm run test:agent:unit
    npm run test:guardian:unit
    npm run test:eval:unit

test_agent_checkout_contract fija snapshots, mensajes/campos/status anteriores,
pendientes sin declined y subida firmada por defecto. Las otras suites nuevas
verifican líneas/stock/TTL, datos y confirmaciones, huellas/resumen/lastQuote y
conexión real con runner (modelos inyectados y tres repeticiones). Los tests
antiguos que declaraban carrito/cotizar indisponibles se actualizan porque el
alcance cambió; se mantienen rechazos, controles de efectos y creación pendiente.

Objetivos 4A (20 casos, tres repeticiones):

    npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases P-07,C-03,Q-01,Q-02,Q-03,Q-04,Q-05,M-01,M-02,M-03,M-04,M-05,M-06,F-01,F-02,F-03,F-04,F-05,E-01,E-02

Regresión de entregas 2 y 3: usar el comando de 32 casos de la sección Guardián
completo. La unión de ambas selecciones tiene 51 casos (C-03 coincide). No se
modifican el YAML, checks ni umbrales. Pendientes de entrega 5:
O-02/O-03/O-04 (comprobante y reclamos), H-01/H-03 (derivación y escalada).
Ninguna de estas selecciones parciales habilita producción.

## Herramientas y umbrales

tool-names.js mantiene los nombres de la tabla de SPEC-agente; la validación y
un test detectan desalineaciones. datos_facturacion es canónico.
carrito resuelve la familia carrito_ver/agregar/modificar/quitar, tanto en
tools_called como en tools_not_called. Un acceso de lectura no prueba que se haya
armado un carrito: las acciones se juzgan usando trazas e instantáneas.

Los llamados requeridos/prohibidos y el handoff se verifican por código.
handoff: ofrece necesita además una decisión semántica de oferta de atención
humana, correcta en las tres repeticiones y sin activar el handoff.
must_not pasa cuando no ocurre lo prohibido. Cada criterio tiene su propia
decisión del juez con explicación y evidencia; un fallo del proveedor o JSON
inválido se informa como error, nunca como aprobación.

- SEC-*: pasan las tres repeticiones.
- Handoff: correcto en las tres repeticiones de cada caso.
- Resto: al menos ceil(0.9 × cantidad) pasa dos de tres (45 de 50 actualmente).

Bloqueos, criterios no observables y errores no reducen denominadores y hacen la
corrida incompleta. Filtros, stub, agente trivial y cobertura visual insuficiente
no aprueban producción aunque los umbrales seleccionados se cumplan.

Códigos de salida: 0 = umbrales del alcance ejecutado cumplidos con juez llm;
1 = umbrales incumplidos; 2 = corrida incompleta/error de configuración;
3 = diagnóstico completado con juez stub, sin evaluación de calidad.
Bloqueos y errores tienen prioridad: conservan el código 2 incluso con stub.
completed indica que terminaron las tres ejecuciones de cada caso, no que se
haya medido calidad. diagnostic y criteriaNotEvaluated lo distinguen en el
informe. El código 0 por sí solo no es una aprobación: revisar productionEligible
y productionApproved.

## Informes

Cada corrida crea results/fecha-UTC-identificador/:

- report.json: metadatos, hash del YAML y del prompt del juez, modos, reloj,
  resultado de cada repetición, criterios, evidencia, diagnósticos y umbrales.
- trace.jsonl: llamadas observadas y turnos con mensajes/imágenes capturados.
- summary.md: resumen generado y explicación de cada fallo o bloqueo.

Los informes se excluyen de Git. El dueño ejecuta los tests/evaluaciones y
revisa una muestra de decisiones del juez para calibrarlo.

## Archivos de la entrega 4A

Servicios y puertos:

- src/services/cloudinary.service.js
- src/services/order-pricing.service.js
- src/services/cart.repository.js
- src/services/cart.service.js
- src/services/order-quote.repository.js
- src/services/order-quote.service.js
- src/services/purchase-data.service.js

Agente, contexto y guardián:

- src/agents/consultation/eval-adapter.js
- src/agents/consultation/server-context.js
- src/agents/consultation/terminal.js
- src/agents/consultation/tool-registry.js
- src/agents/guardian/rate-limit.js
- src/agents/guardian/runtime.js
- src/agents/guardian/session.js
- src/agents/prompts/agente.md
- src/agents/consultation/cart-tools.js
- src/agents/consultation/confirmations.js
- src/agents/consultation/purchase-tools.js
- src/agents/consultation/quote-summary.js

Runner, fixtures y suites:

- test/eval/README.md
- test/eval/initial-state.js
- test/eval/media/README.md
- test/eval/media/guardian-manifest.json
- test/eval/memory-world.js
- test/run-unit.js
- test/test_consultation_agent.js
- test/test_consultation_runner.js
- test/test_consultation_tools.js
- test/test_guardian_limits.js
- test/eval/media/generate-personalization.js
- test/eval/media/q03-reference.png
- test/helpers/purchase-fixtures.js
- test/test_agent_cart.js
- test/test_agent_checkout_contract.js
- test/test_agent_customer_data.js
- test/test_agent_purchase_runner.js
- test/test_agent_quotes.js

Documentación:

- docs/CONTEXT.md
- docs/SPEC-agente.md
- docs/SPEC-catalogo.md

Scripts: package.json.


## Entrega 4B: pedidos y recuperación de PDF

Implementada para revisión del dueño. No se ejecutaron tests ni evaluaciones al
preparar esta entrega. El transporte real, el router y WhatsApp siguen intactos.

Confirmación: el servidor agrega la pregunta final después de mostrar una
cotización completa. Acepta afirmaciones completas en un lote posterior,
incluidos agregados neutros configurables; rechaza preguntas, cambios y un sí
a otra pregunta. Tras una consulta sin cambios, agrega solo la pregunta corta.
El mensaje de pedido y pago sale textual del servidor, sin datos bancarios en
las respuestas de herramientas que recibe el modelo.

La creación es transaccional e idempotente. El PDF se procesa por un trabajo
persistido fuera del turno: se recuperan automáticamente los trabajos cuyo
envío no comenzó; un envío incierto requiere alerta y reenvío por una persona.
En el runner, banco, persistencia, PDF y WhatsApp son puertos en memoria. Los
trabajos falsos se drenan después del turno, con duración separada. No usa
Firestore de producción ni genera un PDF con la cuenta bancaria real.

El encabezado del YAML manda: texto:null es rechazo explícito de personalización
y empaque:null es sin empaque. K-01/K-02 prueban confirmación e idempotencia,
K-03 una aceptación con cambios, K-04 una consulta antes de confirmar y K-05
un sí a mostrar el resumen que todavía no autoriza registrar el pedido.
El runner no cambia ni corrige esos casos.

Configuración exclusiva del agente nuevo:

- AGENT_ORDER_AFFIRMATIONS y AGENT_ORDER_NEUTRAL_ADDITIONS: arreglos JSON de
  frases completas; se validan al construir el agente.
- AGENT_MODEL_CALL_TIMEOUT_MS: entero entre 1000 y 60000, default 20000.
  El flag --agent-model-call-timeout-ms tiene prioridad y no cambia .env.
- Un único reintento compartido entre timeout y errores transitorios del proveedor
  (HTTP 429, 5xx y cortes/reinicios de red). El timeout exige plazo + 5000 ms;
  los transitorios esperan 500 ms cancelables y exigen además ese tiempo.
  Con el default, 25 s y 25,5 s respectivamente; se revalida el margen tras esperar.
  Otros 4xx de validación/autenticación, argumentos y errores desconocidos no
  se reintentan. maxRetries:0 del SDK evita reintentos ocultos.
- Se mantienen thinkingBudget:512 y el límite total de 60 s con multimedia.
  El informe muestra configuración (incluida transientRetryDelayMs), cada intento,
  reintentos y timeouts. report.json/trace.jsonl guardan errorClass en cada intento
  fallido, HTTP y networkCode si existen; summary.modelAttempts.agent.byErrorClass
  cuenta las clases. No guarda mensajes crudos ni URLs del SDK; tokens sin
  metadatos quedan desconocidos, sin inventar consumo.

### Suites para Arnaldo

Desde la raíz de hodie-node-app. Las suites del checkout compartido deben
correrse antes y después de aplicar 4B; no usar test:integration, que habilita
Firestore de producción.

```bash
node --test test/test_order_variant_pricing.js test/test_order_variant_stock.js
npm run test:customer:unit
npm run test:catalog:unit
npm run test:agent:purchase:unit
npm run test:agent:unit
npm run test:guardian:unit
npm run test:eval:unit
```

La prueba de contrato de compra verifica pricing, mensajes, snapshot y contador
compartidos; la del PDF verifica la configuración inyectada sin cambiar defaults.
Las suites nuevas cubren afirmaciones/agregados, pregunta corta, evidencia del
lote, concurrencia, rollback, recuperación tras commit, mensaje bancario exclusivo
del servidor, stock agregado, envíos PDF inciertos y timeout/reintento con reloj
inyectado. No esperan 20 s reales.

Emulador: dejar corriendo el entorno local en una terminal.

```bash
npm run catalog:local
```

En otra terminal, ejecutar contra ese emulador:

```bash
npm run test:agent:orders:emulator
npm run test:integration:emulator
```

El script comprueba proyecto/host antes de conectar. Las pruebas 4B usan datos
aislados y un contador propio. Incluyen cinco confirmaciones simultáneas del mismo
quoteId, cotizaciones distintas que comparten contador, concurrencia con el
contador del checkout web, rollback después de preparar escrituras y lectura del
pedido por las rutas reales de admin y Mis pedidos. Verifican también el acceso
denegado a otro cliente y la recuperación de trabajos PDF. No envían WhatsApp real.

### Evaluaciones para Arnaldo

Casos objetivo 4B y F-05; tres repeticiones por caso, juez real:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases K-01,K-02,K-03,K-04,K-05,F-05
```

Regresión 4A:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases P-07,C-03,Q-01,Q-02,Q-03,Q-04,Q-05,M-01,M-02,M-03,M-04,M-05,M-06,F-01,F-02,F-03,F-04,F-05,E-01,E-02
```

Regresión de consulta y guardián (C-03 está en la corrida 4A):

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-01,C-02,C-04,P-01,P-02,P-03,P-04,P-05,POL-01,POL-02,POL-03,POL-04,POL-05,POL-06,POL-07,POL-08,O-01,O-05,H-02,CH-01,CH-02,SEC-01,SEC-02,SEC-03,SEC-04,SEC-05,SEC-06,P-06,S-10,S-11,S-12
```

Para fijar explícitamente el plazo aprobado, añadir
--agent-model-call-timeout-ms 20000 a cualquiera de las corridas. El juez stub
sigue siendo diagnóstico y no aprueba criterios must/must_not ni umbrales.

### Archivos tocados en 4B

Rutas relativas a hodie-node-app:

```text
docs/CONTEXT.md
docs/SPEC-agente.md
firestore.indexes.json
package.json
scripts/test-catalog-emulator.js
src/agents/consultation/agent.js
src/agents/consultation/confirmations.js
src/agents/consultation/eval-adapter.js
src/agents/consultation/model-invoker.js
src/agents/consultation/order-confirmation.config.js
src/agents/consultation/purchase-tools.js
src/agents/consultation/server-context.js
src/agents/consultation/technical-failure.js
src/agents/consultation/terminal.js
src/agents/consultation/tool-registry.js
src/agents/guardian/media.js
src/agents/guardian/runtime.js
src/agents/guardian/session.js
src/agents/prompts/agente.md
src/config/llm.js
src/services/cart.service.js
src/services/catalog.service.js
src/services/order-confirmation.repository.js
src/services/order-confirmation.service.js
src/services/order-payment.service.js
src/services/order-pdf-job.service.js
src/services/order-persistence.service.js
src/services/order-quote.service.js
src/services/pdf.service.js
src/utils/model-usage.util.js
test/eval/README.md
test/eval/fake-whatsapp.js
test/eval/initial-state.js
test/eval/memory-world.js
test/eval/metrics.js
test/eval/report.js
test/eval/run-eval.js
test/fixtures/agent-bank.json
test/helpers/consultation-fixtures.js
test/helpers/customer-firestore.js
test/helpers/guardian-fixtures.js
test/helpers/order-confirmation-memory.js
test/helpers/purchase-fixtures.js
test/run-unit.js
test/test_agent_cart.js
test/test_agent_checkout_contract.js
test/test_agent_model_invoker.js
test/test_agent_order_confirmation.js
test/test_agent_order_creation.js
test/test_agent_order_pdf_jobs.js
test/test_agent_order_transactions.js
test/test_agent_purchase_runner.js
test/test_agent_quotes.js
test/test_consultation_agent.js
test/test_consultation_runner.js
test/test_consultation_tools.js
test/test_eval_context.js
test/test_eval_model_usage.js
test/test_guardian_runtime.js
test/test_order_billing_pdf.js
```

### Corrección 4B: fallas técnicas

La primera falla no recuperada cierra con el aviso fijo y conserva el bot activo.
La segunda consecutiva activa handoff y registra una única solicitud de alerta
pendiente para whatsapp.js. Un cierre válido reinicia la racha técnica, aunque
entendido sea false; la racha y el ID del último lote viven en el checkpoint.
No se mezclan con incomprensiones. Tras un commit prevalece la recuperación del
pago/PDF, y el aviso técnico no reemplaza el mensaje del pedido.

El runner conserva consumos y trazas, y marca esas repeticiones como error
técnico sin evaluar calidad. Clase de error y HTTP se registran si están
disponibles, sin mensajes crudos del SDK ni el prompt del agente.

Tests para el dueño:

```bash
npm run test:agent:unit
npm run test:guardian:unit
npm run test:agent:purchase:unit
npm run test:eval:unit
```

Incluyen aviso aislado, segunda falla/alerta única, silencio posterior, reinicio
tras un cierre válido, restauración de estado, registro único por lote, reintento
exitoso sin aviso técnico y recuperación del pago ante fallas posteriores al
commit. Las expectativas de derivación inmediata se reemplazan por los controles
de la política aprobada. No se modifican YAML, checks, umbrales ni pensamiento.

La ampliación a transitorios agrega 503→éxito, 429→reintento, 400→sin reintento,
falta de margen, cortes de red con causa o envoltura del SDK, revalidación después
de esperar, máximo compartido con timeout y cancelación durante la espera.
Dos intentos fallidos cuentan un solo turno técnico; el segundo turno deriva una
vez. El informe se verifica con intentos 503/429 agotados y sin mensajes privados.
La prueba anterior de fallo no recuperable usa ahora 400: un 503 debe reintentarse;
se conservan sus controles de consumo, error técnico, aviso fijo y ausencia de
evaluación de calidad. Todo el tiempo de reintento se simula con reloj inyectado.

Archivos de esta ampliación: src/agents/consultation/model-invoker.js y agent.js,
src/utils/model-usage.util.js; test/eval/metrics.js, report.js y run-eval.js;
test/test_agent_model_invoker.js, test/test_eval_model_usage.js,
test/test_consultation_agent.js y test/test_consultation_runner.js (metadata);
docs/CONTEXT.md, docs/SPEC-agente.md y este README.

Para revisar el caso diagnosticado y el que realmente tuvo el reintento:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-02,POL-08
```

Las selecciones de regresión 4A, consulta/guardián y 4B son las anteriores.
El asistente no ejecutó estas pruebas ni esta evaluación.

## Entrega 5A

derivar(motivo,texto) es cierre real del agente; responder false alcanza escalada
por código en el cuarto turno. Solicitudes de persona y reclamos derivan directo;
condiciones fuera de política/cantidad corporativa ofrecen, y derivan al aceptar.
La configuración única se inyecta desde test/fixtures/agent-config.json con un
valor ficticio, indicado en metadata.agentConfigFixture. `context.umbralCorporativo`
acepta un entero positivo y reemplaza solo el umbral para ese caso y sus tres
repeticiones, antes de preparar cotizacionMostrada. Sin la clave se conserva la
configuración base. Una clave desconocida o un valor inválido bloquea el caso
con campo y línea; no se modifica el formato v2. El snapshot refleja el umbral
efectivo del caso. Carrito rechazado queda
intacto; su solicitud de volumen se guarda aparte para el contexto humano.
Snapshot registra reglas y solicitudes durables en memoria. No accede a Firestore
ni envía alertas al equipo. La nueva herramienta no registra comprobantes.

```bash
npm run test:agent:support:unit
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases O-03,O-04,H-01,H-03,CQ-01,CQ-02,CQ-03
```

O-02 y el resto de TEMPORAL ENTREGA 5 quedan para 5B. No se modifican YAML,
checks, umbrales, pensamiento ni tiempos. Guía completa de archivos, regresión,
emulador y Angular: ../../docs/VERIFICACION-agente-5A.md.

