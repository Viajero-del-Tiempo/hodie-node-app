# Entrega 7C: ciclo de conexión, PDF y observabilidad

Implementada para revisión. Arnaldo ejecuta tests y evaluación. No se ejecutaron
suites, evaluaciones, inventarios productivos ni deploy. No hay dependencias
nuevas, cambios al YAML, pensamiento, plazos del modelo ni checks/umbrales.

## Conexión y recuperación

El servidor y el launcher usan whatsapp-lifecycle.service.js. authenticated
solo registra progreso; ready abre admisión y arranca los dos trabajadores del
piloto. disconnected cierra la admisión, cancela los runtimes/ráfagas y salidas
sin iniciar, suspende trabajadores y programa una sola reconexión. Espera 5 s,
10 s, 20 s, hasta cinco minutos. No superpone initialize. ready limpia el
reintento y reinicia la progresión; apagar retira listeners y cancela timers.

auth_failure detiene atención, trabajadores y reconexión. No borra LocalAuth
ni llama a logout. Guarda una solicitud WHATSAPP_AUTH_FAILURE en agent_alerts,
una vez por episodio/proceso; fallos de almacenamiento reintentan el mismo ID.
No incluye el mensaje crudo del SDK. Resolver el acceso y reiniciar permite
despachar la alerta pendiente cuando vuelva ready. destroy de la versión local
del SDK cierra Chromium y no elimina LocalAuth; el SDK sí tiene un flujo propio
para una revocación LOGOUT explícita del dispositivo.

AGENT_ENABLED=false conserva el routing legacy. Tiene ciclo y ACK, pero no
inicia los trabajadores nuevos. Los unitarios legacy que invocan el receptor
sin inicializar un cliente mantienen sus filtros originales; la prueba de
paridad inyecta explícitamente una conexión lista.

Los ACK se correlacionan por ID, esperando envíos propios aún en curso y
admitiendo PN/LID. Se guardan en agent_whatsapp_own_messages: ack monotónico,
lastAckEvent y ackAt. Un ID ajeno no crea un registro propio. Nunca cambian
status de pedidos/pagos, pdfDelivered ni abren reintentos. No se registra el
contenido. Su TTL de siete días ya estaba documentado en 7B.

Las ráfagas siguen en RAM. Al cortar el runtime se registra cuántos lotes se
descartan. Los IDs ya reclamados no se vuelven a procesar tras reconectar.
No se promete recuperar texto que no alcanzó un checkpoint ni entrega exacta
una vez entre WhatsApp y Firestore.
Antes de abrir otro runtime del mismo chat se espera la escritura de checkpoint
que ya estuviera en curso en el cancelado; las escrituras aún sin iniciar se
rechazan. Esto evita que una persistencia anterior pise al turno nuevo al reconectar.

## PDF

El trabajador existente usa generateOrderPDF y el transporte real compartido.
Texto, imágenes y PDF de un chat comparten FIFO y pausa de 500 ms entre envíos.
Los registros agent_whatsapp_deliveries y agent_whatsapp_own_messages guardan
metadatos/ID, sin texto ni bytes. El PDF sale como documento, con archivo del
servidor y validación de firma; se elimina el temporal en finally.

El job se reclama con lease. sending/receipt_sending se confirman al salir de
la cola, antes de la operación externa. Si la conexión, el control humano o
la lista impiden iniciar el envío, se conserva pendiente. Los errores de
generación/formato solicitan atención. Un envío iniciado sin resultado seguro
deja attention y alerta: no se reenvía ni al reiniciar. rendering/queued con
lease abandonado son recuperables. La aceptación del SDK no prueba lectura
del cliente. No se descuenta stock, no se confirma pago y no se repite compra.

La recuperación de un mensaje de pago faltante usa el texto durable del
servidor. Si el pedido ya cambió de estado, conserva la regla existente de
no volver a pedir que lo pague. Handoff y silent se aplican antes del envío;
un job de un chat pausado o excluido queda pendiente. Solo alertas pueden
salir hacia ALERTS_PHONE fuera de lista.

Se reutilizan los índices existentes de order_pdf_jobs en
firestore.indexes.json: status/availableAt y status/leaseUntil. El deploy de
índices sigue siendo parte de la puesta en marcha conjunta; no se ejecutó.

## Telemetría y memoria

- agent_turn: chat enmascarado, batch, groupedMessages, medios por tipo/bytes,
  resultado, duración, herramientas ordenadas, handoff y consumo separado de
  agente/transcripción. Incluye turnos cancelados y silenciosos procesados.
  Duración desde el cierre del lote, incluida su espera en cola (queueWaitMs)
  y multimedia; no incluye los ocho segundos de recolección de la ráfaga.
- agent_tool: chat enmascarado, lote, nombre validado, código y duración. No
  recibe argumentos ni copia respuestas libres. Una terminación tardía se
  atribuye al lote original, sin contaminar el siguiente.
- usage_metadata.cachedContentTokenCount e input_token_details.cache_read,
  o usageMetadata crudo, son representaciones alternativas: no se suman entre
  sí ni se agregan otra vez a total_tokens. La falta de dato queda null por
  llamada, con cacheUsageReportedCalls para distinguirla de cero informado.
- report.json/trace.jsonl/summary.md muestran caché, agente, transcripción y
  evaluador separados. El agregado agent previo sigue incluyendo transcripción;
  modelUsageByComponent lo desglosa. No cambia ningún veredicto de calidad.
- process_memory al iniciar y cada diez minutos: rss/heapUsed en bytes. Con
  rss > MEMORY_WARN_MB × 1024², level:warn y MEMORY_WARN. Default 700, entero
  positivo validado. Es memoria de Node; Chromium consume RAM aparte. No hay
  reinicio automático ni cambios de límites al superar el umbral.

## Comandos para Arnaldo

Unitarios nuevos, todos con cliente falso y reloj inyectado; PDFs sintéticos
temporales y Firestore en memoria, sin conexiones productivas:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
node --import ./test/firebase-bootstrap.js --test test/test_whatsapp_lifecycle.js test/test_whatsapp_pdf_worker.js test/test_agent_telemetry.js
```

Incluyen autenticación/ready, reconexión creciente y única, auth_failure durable,
ACK temprano PN/LID, corte de admisión/turno, FIFO/PDF y autoría, dos workers,
reinicio por fase, suspensión antes/durante envío, error de formato, silent y
alertas al equipo; también caché sin duplicación, componentes, reporte y memoria.

Regresión en memoria:

```bash
node --import ./test/firebase-bootstrap.js --test test/test_whatsapp_agent_routing.js test/test_whatsapp_transport.js test/test_whatsapp_production.js test/test_whatsapp_human_control.js test/test_whatsapp_alert_dispatcher.js test/test_admin_agent_chats.js
npm run test:guardian:unit
npm run test:agent:unit
npm run test:agent:purchase:unit
npm run test:agent:support:unit
npm run test:unit
```

Integración existente, con emulador levantado por npm run catalog:local en otra
terminal. Se mantienen las guardas obligatorias sin credenciales reales:

```bash
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --agent-whatsapp-only
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --agent-orders-only
```

Regresión completa con Gemini real, a ejecutar por el dueño:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

Piloto con WhatsApp de prueba y emulador local existente, sin tocar producción:

```bash
read -r -p 'Número del cliente de prueba: ' PILOT_PHONE
read -r -p 'Número receptor de alertas del equipo: ' PILOT_ALERTS_PHONE
MEMORY_WARN_MB=700 AGENT_ENABLED=true AGENT_ALLOWLIST="$PILOT_PHONE" AGENT_MAINTENANCE_MODE=silent ALERTS_PHONE="$PILOT_ALERTS_PHONE" node scripts/dev-agent-whatsapp.js --attach
```

Recorrido manual:

1. Observar process_memory al arrancar, authenticated y ready. Antes de ready
   no hay atención ni despacho. No borrar sesiones para provocar auth_failure:
   esa condición se cubre con el cliente falso.
2. Consultar catálogo y mandar ráfaga/audio sintético. Revisar agent_tool y
   agent_turn, orden, mensajes agrupados y consumo separado sin datos privados.
3. Crear un pedido ficticio completo en el emulador. Debe llegar el mensaje de
   pago del servidor y después un PDF; job done/pdfDelivered:true, estado pending.
   Los dos registros de entrega guardan IDs. No hacer pagos reales.
4. Ver ACK enmascarados y metadatos propios. Un ACK no cambia el estado pending.
5. En un entorno de prueba con desconexión controlada, comprobar suspensión y
   progresión de reconexión, sin modelos ni envíos nuevos mientras está offline.
   Al volver ready, se recuperan solo trabajos sin envío iniciado. Las carreras
   exactas y envíos inciertos se ejercitan con los unitarios, sin repetir compras.
6. Pausar con intervención humana y comprobar que PDF pendiente espera; reactivar
   desde el panel. Un contacto excluido no recibe mensajes ni PDF en silent.
7. Observar otra muestra de memoria a los diez minutos. Un umbral bajo explícito
   en una ejecución local debe advertir sin reiniciar ni cambiar el comportamiento.

## Archivos

```text
src/services/whatsapp-lifecycle.service.js          nuevo
src/services/agent-telemetry.service.js             nuevo
src/services/process-memory.service.js             nuevo
test/test_whatsapp_lifecycle.js                    nuevo
test/test_whatsapp_pdf_worker.js                   nuevo
test/test_agent_telemetry.js                       nuevo
docs/VERIFICACION-agente-7C.md                     nuevo
src/config/whatsapp.js
src/services/whatsapp-agent.bootstrap.js
src/services/whatsapp-agent.service.js
src/services/whatsapp-alert-dispatcher.service.js
src/services/whatsapp-client.service.js
src/services/whatsapp-transport.service.js
src/services/order-pdf-job.service.js
src/utils/model-usage.util.js
src/agents/consultation/runtime-factory.js
src/agents/consultation/production-adapter.js
src/agents/guardian/runtime.js
server.js
scripts/dev-agent-whatsapp.js
test/eval/metrics.js
test/eval/report.js
test/helpers/whatsapp-fixtures.js
test/test_whatsapp_production.js
test/test_guardian_filters.js
test/run-unit.js
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-7B.md
```

No se modifican package.json ni índices: no hay dependencias nuevas y los
índices necesarios ya existen. No se toca Angular. Las nuevas suites se
incorporan al runner test:unit existente, que continúa todas ante fallos.
