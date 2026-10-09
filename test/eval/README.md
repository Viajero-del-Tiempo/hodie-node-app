# Runner de evaluación · entregas 1 y 2

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

Una corrida completa del archivo actual programa 56 × 3 conversaciones. F-05
queda bloqueado mientras falte la herramienta real cotizar; no se sustituye por
calculateOrderPricing ni por una cotización inventada. Los demás casos continúan.
Los fallos de comportamiento del agente trivial son esperables.

Filtros repetibles: --case ID, --cases ID,ID y --category nombre. --case y
--cases se unen sin duplicados; el orden de ejecución sigue el YAML.
La categoría se aplica como intersección. IDs inexistentes, listas con entradas
vacías o intersecciones vacías se rechazan antes de crear el modelo.
Otros parámetros:
--file ruta, --output directorio, --now fecha-ISO, --timeout-ms 60000,
--judge-timeout-ms 60000 y --media manifiesto.json.
El reloj inicial es el mismo en las tres repeticiones; avanza un segundo por
turno. Se conserva la antigüedad relativa de carrito e historial.

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

Todos los turnos terminan con responder o derivar, salvo silencio por handoff
activo o derivación forzada por código. No se implementan todavía el guardián
completo, la transcripción ni la integración productiva.

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

## Adjuntos

Los audios ya contienen transcripción: se antepone [audio transcripto].
burst se entrega como un único turno; no simula tiempos que el archivo no define.
La temporización real de ráfagas y transcripción se prueban en sus entregas.

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
