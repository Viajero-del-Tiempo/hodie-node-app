# Entrega 7B: control humano y despacho de alertas

Implementada para revisión. Arnaldo ejecuta tests y evaluaciones; no se afirman
resultados. No se despliega, no se elimina legacy y no se implementa Angular.

## Envíos propios y mantenimiento silencioso

`installWhatsAppClient` envuelve una sola vez `sendMessage` del cliente compartido.
Alcanza agente, mantenimiento, OTP, estados, PDF, legacy y alertas sin cambiar los
textos. El único criterio de autoría es el ID devuelto por WhatsApp. No compara
texto, captions ni archivos. Registra ID/chat/`expiresAt` en
`agent_whatsapp_own_messages`, sin cuerpo ni bytes. Los IDs duran siete días.
La correlación admite PN/LID distintos para el mismo ID. Para los envíos en
curso usa el teléfono resuelto en el servidor, sin esperar chats ajenos; una
intervención manual pausa también los identificadores del mismo teléfono
verificado. El índice interno guarda la huella del teléfono, no lo expone en
el DTO del panel y no une carritos ni perfiles.

Si `message_create` llega antes de resolver `sendMessage`, espera los envíos en
curso de ese chat, incluida la persistencia del ID. Un fallo de persistencia o
un envío incierto durante esa espera produce un diagnóstico; no se interpreta
automáticamente como intervención humana. No hay espera artificial por texto.

Con `silent`, el envoltorio impide también envíos originados fuera del agente
(por ejemplo OTP/estados) hacia números excluidos. No llama al SDK ni escribe
registros propios. Solo el despachador, mediante un origen interno que se retira
antes de llamar al SDK, puede enviar alertas a `ALERTS_PHONE` fuera de la lista.
Ese teléfono se normaliza con las mismas reglas existentes. Un valor inválido
rechaza el arranque. Ausente o vacío: advertencia al iniciar, solicitudes intactas.

Pendiente de puesta en marcha, junto con los TTL documentados en 7A:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=agent_whatsapp_own_messages --enable-ttl --project=PROYECTO
```

No se ejecutó este comando. `expiresAt` ya incluye los siete días.

## Bloqueo, cancelación y recuperación

- Un `message_create` individual `fromMe`, no reconocido por ID, pausa un chat
  existente del motor nuevo. Grupos, estados, difusión y sistema se ignoran.
- `agent_chat_controls` es la autoridad: chat interno, motor, teléfono
  enmascarado, `paused`, motivo `toma_manual`/`derivacion`, fecha, versión y
  generación de sesión. Solo `resume` puede quitar la pausa.
- Cada intervención manual tiene deduplicación durable por ID, con TTL de siete
  días. Una repetición del evento no vuelve a pausar un chat ya reactivado.
- Se aborta el guardián y se cierra su transporte. Lo ya iniciado en WhatsApp
  puede terminar; los envíos aún no iniciados se cancelan, incluso si esperaban
  resolver el teléfono para aplicar la lista blanca. No se vacía el carrito ni
  se pierde el borrador de texto/RUC. Se invalida la autorización de cotización
  y la confirmación durable del pedido.
- El snapshot actual vive en el documento raíz
  `agent_checkpoints/{chatId}`. Cada escritura lee la versión del control en la
  misma transacción. Los históricos de 7A se conservan y sirven como fuente de
  migración; ningún turno viejo puede escribir tras pausa/reactivación.
- `derivar` y las escaladas usan el mismo control. Pausa, snapshot y solicitud
  de alerta se guardan juntos. Solo se permite completar su mensaje de
  derivación; no continúan fotos ni otros envíos pendientes.
- La transacción de crear pedido y el guardado de su confirmación comprueban
  también el control. El checkout web y el runner no activan este puerto nuevo.
  El carrito usa la misma comprobación en el adaptador productivo.
- Los listeners de Firestore cancelan runtimes al cambiar el control desde otro
  proceso, incluido el worker del piloto. Cada nueva entrada vuelve a comprobar
  la versión. Un fallo de lectura se propaga; no abre una sesión vacía.
- La reactivación exige la versión vista por el administrador. Una nueva toma
  manual concurrente hace fallar esa reactivación con 409. Si la reactivación
  ocurre primero, la intervención manual posterior vuelve a pausar el chat.
- Al reactivar, aumenta la generación. El próximo mensaje abre sesión nueva:
  corta historial anterior y autorizaciones, preservando carrito/borradores y
  el límite móvil de uso. No envía mensajes al cliente. No hay comando de chat,
  reanudación por tiempo ni herramienta del modelo que reactive.
- Al arrancar se recuperan los índices del motor nuevo de 7A y sus solicitudes
  pendientes del checkpoint. Las alertas entregadas nunca se reinician.

El intervalo entre aceptación externa de un mensaje y persistencia de su ID no
es atómico con WhatsApp. Tras una caída en ese intervalo, un saliente sin ID
registrado puede requerir revisión humana. No se atribuye autoría por contenido.
Las ráfagas continúan en RAM con la limitación documentada en 7A.

## Contrato del panel para Angular

Ambos endpoints exigen sesión válida y administrador activo consultado en DB.
No basta el rol escrito en el token.

`GET /admin/chats/agent/paused`

```json
{
  "success": true,
  "engine": "agent",
  "count": 1,
  "chats": [{
    "id": "identificador-opaco",
    "engine": "agent",
    "phoneMasked": "…0001",
    "reason": "toma_manual",
    "pausedAt": "2026-10-18T12:00:00.000Z",
    "version": 3,
    "lastCustomerMessage": "Texto de hasta 200 caracteres"
  }]
}
```

Incluye todas las pausas del motor nuevo, sin restringirse a la lista blanca.
Fecha ISO, orden descendente, ambos motivos. Sin teléfono ni chatId crudos.
Un LID sin teléfono usa un identificador enmascarado estable.

`POST /admin/chats/agent/:id/resume-bot`, JSON `{"version": 3}`.
Devuelve `{"success":true,"engine":"agent","id":"…","version":4}`.
400: versión ausente/inválida; 401/403: permisos; 404: chat inexistente; 409:
estado cambiado o ya reactivado. Error con `field:"version"`, código y mensaje
que pide actualizar la lista. No cambia el cliente ni envía un saludo.

Legacy conserva `GET /admin/chats/handoff` y
`POST /admin/chats/:threadId/resume-bot`. La lista legacy excluye el motor nuevo.
La reactivación existente determina el motor antes de leer su grafo: si recibe
un threadId del agente nuevo, exige `version` y usa el control nuevo; la respuesta
indica `engine`. Angular se implementa en otro paso en feature/catalogo-variantes.

## Alertas

Se recorren `agent_alerts` y `order_alerts` con `delivered:false`. Los IDs por
episodio de los productores siguen deduplicando solicitudes. Cada candidata
se reclama en una transacción con token y lease; dos trabajadores no envían la
misma solicitud. No se borran solicitudes ni contexto histórico.

La fase `claimed` todavía no envió: es recuperable si vence el lease. Antes del
SDK se persiste `sending`. Un rechazo del SDK, falta de ID, caída tras esa marca
o fallo al acusar entrega dejan `dispatch.status:uncertain`, sin reenvío ciego.
Requiere revisión/reenvío humano. Un fallo demostrablemente anterior al envío
o WhatsApp aún no listo deja `pending` con `nextAttemptAt`: espera creciente
1 s, 2 s, 4 s, hasta una hora. El barrido es de un segundo y se detiene al cerrar.
El dispatcher no interpreta como seguro un error arbitrario del SDK.

El aviso al equipo contiene un tipo de atención controlado y referencia opaca;
no copia contexto, mensajes, teléfonos, cédulas/RUC, datos bancarios, importes,
nombres de archivos ni enlaces de comprobantes. El contenido completo sigue
en el backend para la revisión autorizada. No confirma pagos ni cambia pedidos.
7C mantiene pendiente el trabajador PDF real, ACK, desconexión y telemetría.

## Comandos para Arnaldo

Unitarios, sin WhatsApp/Gemini/Firestore reales:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
node --test test/test_whatsapp_human_control.js test/test_whatsapp_alert_dispatcher.js test/test_admin_agent_chats.js
node --test test/test_whatsapp_agent_routing.js test/test_whatsapp_transport.js test/test_whatsapp_production.js
AGENT_ENABLED=false npm run test:guardian:unit
AGENT_ENABLED=false npm run test:agent:unit
AGENT_ENABLED=false npm run test:agent:purchase:unit
AGENT_ENABLED=false npm run test:agent:support:unit
```

Con `npm run catalog:local` levantado en otra terminal:

```bash
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --agent-whatsapp-only
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --agent-orders-only
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --customer-only
```

La suite añadida rechaza destinos fuera del emulador antes de abrir Firebase.
Comprueba pausa/reactivación concurrentes, checkpoint y confirmación tardíos,
carrito intacto, reclamo de alerta concurrente y permisos reales del endpoint
(incluso cliente con rol admin falsamente escrito en el token). Usa sus propios
documentos y los limpia. No envía alertas reales ni toca otras alertas del demo.
Las otras dos selecciones conservan la regresión de transacciones de compra y
el contrato del checkout/perfil. Las consultas nuevas de controles y alertas
usan igualdad simple; no requieren índices compuestos adicionales.

Regresión del runner, con consumo real de Gemini:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

Piloto real contra el emulador existente, lista obligatoria. ALERTS_PHONE es el
número receptor del equipo; se toma del entorno explícito del launcher:

```bash
read -r -p 'Número del cliente de prueba: ' PILOT_PHONE
read -r -p 'Número receptor de alertas del equipo: ' PILOT_ALERTS_PHONE
AGENT_ENABLED=true AGENT_ALLOWLIST="$PILOT_PHONE" AGENT_MAINTENANCE_MODE=silent ALERTS_PHONE="$PILOT_ALERTS_PHONE" node scripts/dev-agent-whatsapp.js --attach
```

Recorrido manual (API con token del administrador ficticio del entorno local):

1. Cliente habilitado consulta y recibe respuesta; los eventos de esos envíos
   quedan reconocidos por ID y no pausan. Provocar un OTP desde la app tampoco
   pausa. Un contacto excluido no recibe avisos, OTP ni estados en `silent`.
2. Desde el teléfono enlazado escribir al cliente mientras el bot procesa una
   ráfaga/lista. Se cancela el turno y lo no iniciado; el chat aparece en el GET
   con toma_manual, fecha y último texto truncado. Nuevas entradas actualizan
   ese último texto sin modelo ni descarga. El carrito sigue en Firestore.
3. Pedir una persona. Sale un único cierre de derivación y se observa la misma
   pausa con motivo derivacion; la alerta queda entregada o pendiente según la
   configuración del equipo. No contiene datos sensibles.
4. Consultar el GET y conservar su versión. Generar otra intervención manual y
   reactivar con la versión anterior: 409. Recargar y reactivar con la nueva:
   éxito, sin mensaje automático. Un «sí» posterior no confirma la cotización
   vieja. El cliente puede continuar su carrito en la nueva sesión.
5. Hacer dos POST simultáneos con la misma versión: uno gana, el otro recibe
   409. La suite del emulador recorre también el conflicto con pausa simultánea.
6. Reiniciar el worker conservando la base: las pausas y los IDs persisten.
   Un duplicado de message_create no vuelve a bloquear tras la reactivación.
7. Arrancar sin ALERTS_PHONE: advertencia y alertas pendientes. Configurarlo y
   reiniciar: despacho. Para fases inciertas y caída entre marcas, usar la suite
   con cliente falso; no provocar transferencias ni repetir compras reales.

No se ejecutaron pruebas, evaluaciones, deploy ni cambios de Cloudinary.

## Archivos creados y modificados

Todos en hodie-node-app; no se modifica hodie-tienda.

```text
src/services/agent-chat-control.service.js                 nuevo
src/services/whatsapp-client.service.js                   nuevo
src/services/whatsapp-alert-dispatcher.service.js         nuevo
src/routes/admin.agent-chat.routes.js                    nuevo
test/test_whatsapp_human_control.js                       nuevo
test/test_whatsapp_alert_dispatcher.js                    nuevo
test/test_admin_agent_chats.js                           nuevo
test/test_whatsapp_control_emulator.js                    nuevo
docs/VERIFICACION-agente-7B.md                            nuevo
src/services/whatsapp-agent.service.js
src/services/whatsapp-agent.bootstrap.js
src/services/whatsapp-transport.service.js
src/services/cart.repository.js
src/services/order-confirmation.repository.js
src/agents/consultation/checkpoint-store.js
src/agents/consultation/production-adapter.js
src/config/whatsapp.js
src/controllers/admin.chat.controller.js
src/app.js
scripts/dev-agent-whatsapp.js
scripts/test-catalog-emulator.js
test/helpers/whatsapp-fixtures.js
test/run-unit.js
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-7A.md
```
