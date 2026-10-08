# Runner de evaluación · entrega 1

El dueño escribe conversations.yaml. El runner lo lee; nunca lo modifica.
Se implementa exclusivamente su formato v2, documentado en el encabezado.
Catálogo, políticas, pedidos, carritos, checkpoints y cargas viven en memoria.
El runner no importa el grafo viejo, Firebase, WhatsApp ni servicios con efectos
externos. Solo el modo de evaluador llm usa la red y lee .env.
Requiere el runtime Node 24 del proyecto (module.registerHooks): bloquea import
y require de Firebase, Firestore, WhatsApp y Cloudinary antes de inicializarlos,
incluido el inicializador de Firebase del backend. Una dependencia accidental
del adaptador se informa como PRODUCTION_IMPORT_BLOCKED.

## Comandos

Desde hodie-node-app:

    npm run test:eval -- --validate
    npm run test:eval:unit
    npm run test:eval -- --agent trivial --judge stub --case C-01
    npm run test:eval -- --agent trivial --judge stub
    npm run test:eval -- --agent trivial --judge llm --case C-01

--validate solo lee/valida y muestra el conteo y los diagnósticos con línea.
No ejecuta el agente, el evaluador ni genera informes.

El agente trivial responde de forma genérica. El juez stub siempre devuelve
pass, marcado simulated: true: verifica la tubería, no la calidad.
Ninguna combinación con agente trivial o juez stub aprueba producción.
Con llm, createGeminiModel crea un juez independiente a temperatura 0; requiere
GEMINI_API_KEY y usa el modelo configurado por la fábrica del proyecto.
El juez recibe evidencia pública por criterio, sin prompt privado del agente.
Las conversaciones y resultados de herramientas se tratan como datos.

Una corrida completa del archivo actual programa 56 × 3 conversaciones. F-05
queda bloqueado mientras falte la herramienta real cotizar; no se sustituye por
calculateOrderPricing ni por una cotización inventada. Los demás casos continúan.
Los fallos de comportamiento del agente trivial son esperables.

Filtros repetibles: --case ID y --category nombre. Otros parámetros:
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

## Contrato del adaptador futuro

Un módulo elegido explícitamente con --agent ruta debe exportar:

    async function createAgent({ world, transport, signal })

Devuelve { kind: "real", runTurn, dispose? }. El agente de prueba usa kind: "trivial".
No hay un agente real por defecto: --agent real informa que todavía no existe.
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
El mundo trae responder y derivar mínimos para el agente trivial. La entrega
del agente real los sustituye por sus handlers completos.
dispose recibe { signal }; el mundo/transporte ya están cerrados al disponer.

Todos los turnos terminan con responder o derivar, salvo silencio por handoff
activo o derivación forzada por código. No se implementa aquí el guardián real,
la transcripción, las herramientas del nuevo agente ni la integración productiva.

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

Códigos de salida: 0 = umbrales del alcance ejecutado cumplidos; 1 = umbrales
incumplidos; 2 = corrida incompleta/error de configuración. El código 0 por sí
solo no es una aprobación: revisar productionEligible y productionApproved.

## Informes

Cada corrida crea results/fecha-UTC-identificador/:

- report.json: metadatos, hash del YAML y del prompt del juez, modos, reloj,
  resultado de cada repetición, criterios, evidencia, diagnósticos y umbrales.
- trace.jsonl: llamadas observadas y turnos con mensajes/imágenes capturados.
- summary.md: resumen generado y explicación de cada fallo o bloqueo.

Los informes se excluyen de Git. El dueño ejecuta los tests/evaluaciones y
revisa una muestra de decisiones del juez para calibrarlo.
