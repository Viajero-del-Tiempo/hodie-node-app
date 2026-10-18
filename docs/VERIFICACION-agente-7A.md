# Agente 7A: piloto mínimo de WhatsApp

Implementación para revisión. Los tests y las evaluaciones los ejecuta Arnaldo;
esta guía no afirma resultados. No se despliega ni se retira mantenimiento.

## Interruptor y mantenimiento

- `AGENT_ENABLED` ausente o false: receptor, grafo, envíos y alertas legacy
  actuales. No abre el almacenamiento. El modo de mantenimiento se valida
  siempre; las demás variables del piloto no alteran este camino.
- `AGENT_ENABLED=true`, `AGENT_ALLOWLIST` ausente: agente nuevo para todos los
  chats individuales aceptados, incluso si no se pudo verificar el teléfono.
- Lista presente vacía: ninguno usa el agente nuevo.
- Lista presente con teléfonos separados por comas: solo los normalizados de
  esa lista. Se aceptan los formatos del normalizador existente; nunca un LID.
  El texto del cliente no habilita un número. Un LID no resuelto queda fuera.
- Variables inválidas rechazan la configuración; no habilitan el router anterior.
- `AGENT_MAINTENANCE_MODE` acepta exactamente `message` (default) o `silent`.
  Cualquier otro valor rechaza el arranque, incluso con el interruptor apagado.
- `silent` exige `AGENT_ENABLED=true` y `AGENT_ALLOWLIST` definida y no vacía.
  Un chat excluido no recibe nada y deja solo un log `MAINTENANCE_SILENT` con
  chat enmascarado: sin modelo, descarga de medios, registros de IDs, envíos,
  mantenimiento ni checkpoints. La resolución de LID no escribe caché ni emite
  advertencias. Los números habilitados conservan el funcionamiento del agente.
- Fuera de la lista, con el interruptor activo y modo `message`: mantenimiento sin modelo,
  configurable mediante `AGENT_MAINTENANCE_MESSAGE`. Por defecto:
  «¡Hola! Estamos renovando nuestra tienda y volvemos muy pronto. Gracias por escribirnos 🎁».
- Máximo un intento del aviso por chat cada seis horas. Se reserva antes del
  envío; la cuota no se libera ante una caída o entrega incierta. El envío se
  registra como propio, con el ID devuelto por WhatsApp. 7B observará estos IDs.

Con el piloto activo, sus errores nunca vuelven al grafo viejo. Grupos, estados,
difusiones, canales, sistema, tipos no permitidos y mensajes propios se ignoran.

## Durabilidad y transporte

`agent_whatsapp_messages` reclama transaccionalmente chat + ID de WhatsApp antes
del buffer (excepto chats excluidos en `silent`, que se descartan antes).
Receptores concurrentes o un reinicio no lo procesan otra vez dentro
de los siete días. Otro ID, aunque tenga el mismo texto, es un mensaje nuevo.
No se guardan el texto ni los bytes en ese registro. Un mensaje que debe
registrarse y no tiene ID se rechaza.

`expiresAt` es Timestamp, calculado como recibido + siete días. La verificación
lógica también considera vencido el registro aunque el barrido TTL no haya
borrado aún el documento. Un vencimiento ausente/corrupto es error explícito.
Tras siete días ya no se garantiza deduplicación de ese ID, por decisión de
retención. `agent_whatsapp_deliveries` conserva el registro propio y su ID por
el mismo plazo; `agent_whatsapp_maintenance` conserva la próxima hora habilitada.

Los checkpoints usan `agent_checkpoints` y `agent_checkpoint_writes`, con el
thread_id de WhatsApp. El saver común propaga errores de lectura solo cuando se
solicita el modo estricto nuevo. Sus defaults legacy siguen intactos. El estado
no persiste bytes ni attachmentId. El historial se guarda por lote, con el texto
transcripto y los mensajes/fotos efectivamente enviados.

El transporte mantiene FIFO por chat y una pausa de 500 ms, cancelable, entre
envíos. Chats distintos avanzan independientemente. Descarga las imágenes antes
de iniciar su envío, valida MIME/tamaño y conserva el caption del servidor.
Si la descarga falla, el servicio existente puede emitir el reemplazo textual y
continuar. Un rechazo de sendMessage o fallo de registro tras el envío puede ser
incierto: corta las siguientes salidas de ese turno y no reintenta. Un turno
nuevo puede responder sin repetir automáticamente la secuencia anterior.
La foto incierta conserva su reserva de sesión; una foto siguiente cuyo envío
no llegó a intentarse libera la reserva. Se distingue SEND_UNCERTAIN de
SEND_SEQUENCE_STOPPED y se registra PRODUCT_IMAGE_DELIVERY_UNCERTAIN.

Las ráfagas siguen en RAM: 8 s de silencio, máximo 30 s, 60 s desde el cierre,
incluyendo medios y cola. Un apagado ordenado registra lotes descartados; un
reinicio abrupto puede perderlos. Sus IDs reclamados no se vuelven a ejecutar.
No se promete entrega exactamente una vez entre Firestore y WhatsApp.

## Política TTL que se debe habilitar en la puesta en marcha

No ejecutado. Reemplazar PROYECTO por el proyecto autorizado; no usar el demo
para estos comandos de administración de la base real:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=agent_whatsapp_messages --enable-ttl --project=PROYECTO
gcloud firestore fields ttls update expiresAt --collection-group=agent_whatsapp_deliveries --enable-ttl --project=PROYECTO
```

No agregar expiration-offset: los siete días ya están incluidos en expiresAt.
La política TTL es independiente de desplegar índices. Fuente:
[gcloud firestore fields ttls update](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/fields/ttls/update).
La aplicación aplica el vencimiento lógico en las pruebas del emulador; el test
no depende de un barrido asíncrono de TTL.

## Piloto local

Detener antes otro `catalog:local` que ocupe los mismos puertos. Se requieren los
prerrequisitos existentes de ese entorno: Firebase CLI, Java y Chrome/Puppeteer.
No se instalan dependencias nuevas. El launcher verifica proyecto y host antes
de revisar puertos o importar SDKs; rechaza un destino distinto del demo.

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
read -r -p 'Número de prueba habilitado, en formato internacional: ' PILOT_PHONE
AGENT_ENABLED=true AGENT_ALLOWLIST="$PILOT_PHONE" AGENT_MAINTENANCE_MODE=silent node scripts/dev-agent-whatsapp.js
```

El launcher inicia el emulador y API existentes, carga sus fixtures y luego
conecta WhatsApp. GEMINI_API_KEY y GEMINI_MODEL se toman del entorno o .env;
usa el modelo real y consume sus tokens. Conserva el pensamiento/plazos vigentes.
Los datos bancarios son los ficticios de test/fixtures/agent-bank.json.
Antes de iniciar servicios imprime el modo y la cantidad de teléfonos únicos
habilitados, sin mostrar sus números.

Escanear el QR con la cuenta que atenderá el piloto. La sesión se guarda aparte,
en sessions/agent-pilot-local (ignorado por Git); no usa la sesión client-one del backend.
El teléfono habilitado es el del cliente que escribe, no el de la cuenta del QR.
Con el comando anterior, los demás chats individuales de esa cuenta quedan
en silencio. Para probar el aviso de mantenimiento, usar
`AGENT_MAINTENANCE_MODE=message` en lugar de `silent`.

Firestore apunta únicamente a demo-hodie-catalogo en 127.0.0.1:8080. API y fotos
del catálogo en 3000; imágenes de personalización locales en 3001; comprobantes
privados en dev/receipts, compartido con el panel local y fuera de express.static.
El launcher no sube estas imágenes/comprobantes a Cloudinary. El entorno local
mantiene el JWT ficticio independiente y sus comprobaciones existentes.

En otra terminal, la tienda/panel existente:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-tienda
npm start -- --configuration=emulator
```

Ctrl+C detiene los procesos propios y registra los buffers descartados. La sesión
de WhatsApp permanece. El emulador se inicia sin persistencia entre ejecuciones.

Para reiniciar solo el piloto conservando la misma base, levantar primero
`npm run catalog:local` en otra terminal y usar el modo de conexión al entorno
existente. Ctrl+C de este modo deja el emulador/API ajenos en funcionamiento:

```bash
AGENT_ENABLED=true AGENT_ALLOWLIST="$PILOT_PHONE" AGENT_MAINTENANCE_MODE=silent node scripts/dev-agent-whatsapp.js --attach
```

## Tests para Arnaldo

Unitarios nuevos, sin WhatsApp, Firestore ni Gemini reales:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
node --test test/test_whatsapp_agent_routing.js test/test_whatsapp_transport.js test/test_whatsapp_production.js
node --test test/test_agent_product_images.js test/test_agent_packaging_images.js
AGENT_ENABLED=false npm run test:guardian:unit
AGENT_ENABLED=false npm run test:agent:unit
AGENT_ENABLED=false npm run test:agent:purchase:unit
AGENT_ENABLED=false npm run test:agent:support:unit
```

El test de paridad de filtros evalúa ahora el receptor como función async, con
AGENT_ENABLED=false; conserva todos los casos anteriores. La prueba del saver
evalúa la clase real con dependencias falsas, sin inicializar Firebase.
La suite de routing incluye la matriz modo × interruptor × lista, rechazo de
modos inválidos, descarte `silent` sin efectos, deduplicación de habilitados y
resolución LID sin escrituras ni advertencias, conservando el default legacy.

Con el emulador/API levantados por el launcher o por `npm run catalog:local`:

```bash
AGENT_ENABLED=false node scripts/test-catalog-emulator.js --agent-whatsapp-only
```

La suite del emulador rechaza producción incluso con ALLOW_PROD_FIRESTORE_TESTS.
Crea un chat test- propio y limpia sus documentos/subcolecciones en finally.
La batería general existente también incluye las tres suites unitarias nuevas:

```bash
AGENT_ENABLED=false npm run test:unit
```

Esa batería general conserva suites históricas con acceso a Firestore real bajo
su autorización existente; no confundirla con los tres tests nuevos en memoria.

Regresión completa del agente en el runner, independiente del cliente real:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

## Recorrido manual de 7A

1. En `silent`, desde el número fuera de la lista: «Hola», luego un adjunto.
   Ninguna respuesta ni descarga; solo una línea de log enmascarada por evento,
   sin registros de IDs, mantenimiento, envíos ni checkpoints para ese chat.
   En `message`, «Hola» y otro mensaje producen un solo aviso; ningún modelo.
   Reiniciar conservando la base no abre la cuota; tras seis horas se habilita
   otro aviso. Cambiar a `silent` no modifica las reservas previas.
2. Desde el número habilitado: saludo y una ráfaga de consulta por un producto
   de los fixtures, sus medidas y una cantidad. Un lote; herramientas reales,
   datos del catálogo y cotización del servidor.
3. Pedir opciones y empaques: introducción, fotos/líneas con captions y cierre,
   respetando orden y máximo existente. Pedirlas otra vez no repite las fotos.
4. Audio breve e imagen/PDF sintéticos: límites actuales, transcripción como
   cliente, PDF solo como descriptor. Sin datos personales ni cuentas reales.
5. Completar una compra y confirmar: un pedido pendiente, pago ficticio textual,
   trabajo PDF durable pendiente. Enviar comprobante: registro privado y acuse;
   el estado del pedido no cambia. Las alertas permanecen pendientes, sin envío.
6. Pedir una persona: handoff durable y silencio. La reactivación del agente
   nuevo desde el panel queda para 7B; reiniciar el proceso no quita el handoff.
7. Reiniciar durante una ráfaga: el buffer se descarta, no aparece respuesta
   tardía; un mensaje nuevo con otro ID vuelve a ser atendido.
8. Para revisar el legacy, ejecutar el backend habitual con AGENT_ENABLED=false;
   no usar el launcher del piloto, que exige interruptor activo y lista no vacía.

## Límites de esta entrega y próximas rondas

- 7B: message_create, correlación global de envíos propios, toma humana al
  escribir desde la tienda, resume-bot por motor y despacho de agent_alerts y
  order_alerts. El panel listará todos los chats pausados, con motivo y fecha,
  tanto por derivación como por toma manual, y reactivación con un clic.
- 7C: auth_failure/disconnected/message_ack, trabajador PDF conectado al
  transporte, telemetría y cachedContentTokenCount.
- En 7A, escribir desde la tienda todavía no pausa automáticamente el bot.
- No se retira mantenimiento, no se despliega y no se elimina código legacy.
- No se modifican conversations.yaml, checks, umbrales, prompt, pensamiento ni
  tiempos del agente; no se agregan dependencias ni scripts de package.json.

## Archivos de 7A

```text
server.js
src/config/agent-whatsapp.config.js
src/config/whatsapp.js
src/agents/checkpointer/firestore.checkpointer.js
src/agents/consultation/runtime-factory.js
src/agents/consultation/eval-adapter.js
src/agents/consultation/checkpoint-store.js
src/agents/consultation/production-adapter.js
src/agents/consultation/product-images.js
src/agents/guardian/runtime.js
src/services/whatsapp-agent.service.js
src/services/whatsapp-agent.bootstrap.js
src/services/whatsapp-delivery.repository.js
src/services/whatsapp-transport.service.js
scripts/dev-agent-whatsapp.js
scripts/test-catalog-emulator.js
test/helpers/whatsapp-fixtures.js
test/test_whatsapp_agent_routing.js
test/test_whatsapp_transport.js
test/test_whatsapp_production.js
test/test_whatsapp_delivery_emulator.js
test/test_guardian_filters.js
test/run-unit.js
test/eval/README.md
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-7A.md
```
