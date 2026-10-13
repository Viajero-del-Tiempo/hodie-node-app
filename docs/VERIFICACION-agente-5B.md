# Entrega 5B: comprobantes privados

Esta guía contiene comandos para Arnaldo; no registra resultados. El agente
nuevo sigue desconectado de WhatsApp y del router productivo. No desplegar esta
rama antes de la puesta en marcha conjunta con el catálogo.

## Contratos

- registrar_comprobante recibe attachmentId O comprobanteId, orderNumber opcional.
  Nunca acepta importes, precios, teléfonos ni identidad verificada del modelo.
  El primer adjunto se guarda con nombre saneado, extensión según MIME y firma
  validada. El ID es estable por chat/contenido. Una intención durable precede a
  la subida; archivos de una subida interrumpida también pueden limpiarse.
- Cero pendientes: PEDIDO_NO_DISPONIBLE; varios: PEDIDO_AMBIGUO con números
  propios. El resultado conserva comprobanteId para elegir después; el contexto
  pendingReceipts contiene únicamente identificador, tipo y nombre del archivo.
  Un número explícito siempre verifica dueño y estado pendiente. Pertenencia:
  mismo chat o teléfono verificado y normalizado, nunca un teléfono del modelo.
- La transacción relee comprobante, pedido y alerta, asocia y solicita alerta
  juntos. No escribe el pedido ni descuenta stock. La misma asociación es
  idempotente mientras el pedido siga pendiente; no permite reasignar el archivo.
  La alerta usa ID estable por comprobante. Su contexto humano tiene número y
  nombre de archivo; IDs de relación quedan en metadatos, sin URLs ni bytes.
- responder entrega el acuse literal del servidor en lugar del texto del modelo.
  La relación guarda entrega pendiente para recuperación después de commit/reinicio.
  El mensaje de compra/pago recién creado conserva la prioridad. Una falla
  técnica recuperada sigue siendo error técnico en el runner, con sus métricas.
- GET /admin/orders/:id/receipts devuelve solo metadatos de archivos asociados.
  GET /admin/orders/:id/receipts/:receiptId/download exige JWT y administrador
  activo verificado en users, y comprueba relación con ese pedido. Devuelve bytes
  con attachment, no-store, nosniff y CSP sandbox. No devuelve URLs/firmas ni
  redirige a Cloudinary. El panel usa HttpClient + JWT y un Blob local que libera.
- PDF: límite configurable reducible de 5 MB, MIME application/pdf y firma/cierre
  comprobados; cuenta dentro de los 10 MB vigentes por turno. No se extrae texto
  ni se pasa contenido PDF al modelo. Las imágenes se validan al registrarlas.
- Sin asignar: seis horas desde recepción, AGENT_RECEIPT_UNASSIGNED_TTL_MS permite
  1 minuto..7 días. Vencido no se puede seleccionar. Barrido independiente cada
  minuto, sin esperas en tests: reclama estado deleting, borra archivo privado y
  después documento; recupera interrumpidos y reintenta errores del proveedor.
  El borrado físico puede esperar una pasada o una recuperación del proveedor.
  No habilitar TTL de Firestore sobre estos documentos antes de borrar archivos.
- Asociados: propuesta pendiente de Arnaldo, 90 días tras verificación manual.
  No se activa borrado automático de asociados hasta acordar esa política.

## Cloudinary: comprobar antes de puesta en marcha

Se usa raw + type:authenticated y subida firmada con el secreto del backend,
overwrite:false y backup:false, sin conversiones/eager transforms. El descriptor
permanece en Firestore privado. La descarga temporal firmada se obtiene solo en
el backend, mediante el endpoint raw/download; no se entrega esa dirección al
cliente. Se rechaza una respuesta de subida que no confirme raw/authenticated.

`authenticated` protege original y derivados; `private` protege el original pero
puede dejar derivados accesibles. Por eso se eligió authenticated. Ver
[control de acceso](https://cloudinary.com/documentation/control_access_to_media)
y [parámetros de subida](https://cloudinary.com/documentation/upload_parameters).
La API documenta la descarga privada y el borrado con invalidate; ver
[Upload API](https://cloudinary.com/documentation/image_upload_api_reference).

Pendiente: comprobar permisos reales de la cuenta para raw/authenticated y
descarga de PNG/JPG/PDF con la firma del servidor; probar que una URL sin firma
no obtiene archivo, tampoco derivados; verificar eliminación y exclusión de
backups. Algunas cuentas requieren habilitar entrega PDF/ZIP en Security:
[documentación de PDF](https://support.cloudinary.com/hc/en-us/articles/20970529312146-How-to-Upload-Manage-and-Deliver-PDF-Files).
No usar un preset sin firma ni resolver un fallo cambiando el tipo a upload.
No se accedió ni se modificó la cuenta real durante esta implementación.

Configurar CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET existentes y, opcionalmente,
CLOUDINARY_RECEIPTS_FOLDER (solo letras, números, /, _ y -). Desplegar los índices
payment_receipts de firestore.indexes.json en la puesta en marcha. Reglas de
Firestore cerradas: estas rutas usan Admin SDK después del control de acceso.
Conectar el puerto de repositorio/almacenamiento al agente real junto con el
checkpointer y el despacho exclusivo de alertas en whatsapp.js.

## Comandos

Desde hodie-node-app:

```bash
node --test test/test_agent_receipts.js test/test_receipt_media_storage.js test/test_receipt_runner.js
npm run test:agent:unit
npm run test:agent:support:unit
npm run test:agent:purchase:unit
npm run test:guardian:unit
npm run test:eval:unit
```

En una terminal levantar el entorno local:

```bash
npm run catalog:local
```

En otra terminal del backend:

```bash
node scripts/test-catalog-emulator.js --agent-receipts-only
npm run test:integration:emulator
```

Los tests de emulador comprueban concurrencia, cambio de estado antes de la
lectura transaccional, rollback, protección real de lista/descarga y admin
inactivo. Usan IDs test-, secretos locales y limpieza en finally. Nunca admiten
Firestore de producción, incluso si existe ALLOW_PROD_FIRESTORE_TESTS.

Evaluación O-02 y regresión completa con juez real, sin cambios a umbrales:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases O-02
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

Desde hodie-tienda:

```bash
npm test -- --watch=false --browsers=ChromeHeadless
npm run build
npm run build:prod
npm start -- --configuration emulator
```

Con administrador ficticio, abrir el pedido pendiente sembrado desde las fixtures:
ver comprobante sintético, descargarlo, comprobar que no aparece URL del proveedor
y que el pedido continúa pendiente. Refrescar/reiniciar conserva el archivo privado
en dev/receipts. Probar sin sesión y con cliente: descarga denegada. No se agrega
un botón de aprobación al componente; la actualización manual del pedido conserva
el endpoint y comportamiento existentes. El mock Angular también lo comprueba.

El runner usa almacenamiento privado en memoria. o02-receipt.png es una imagen
sintética rotulada ficticia, sin cuentas ni datos personales; el YAML permanece
intacto. Los PDF unitarios son generados con contenido ficticio. El stub continúa
sin evaluar criterios de calidad.

## Archivos tocados

Backend (rutas relativas a hodie-node-app):

```text
.gitignore
server.js
firestore.indexes.json
scripts/local-catalog-server.js
scripts/test-catalog-emulator.js
src/app.js
src/agents/consultation/agent.js
src/agents/consultation/eval-adapter.js
src/agents/consultation/receipt-tools.js
src/agents/consultation/server-context.js
src/agents/consultation/terminal.js
src/agents/consultation/tool-registry.js
src/agents/guardian/attachments.js
src/agents/guardian/config.js
src/agents/guardian/media.js
src/agents/guardian/runtime.js
src/agents/prompts/agente.md
src/routes/admin.receipt.routes.js
src/services/payment-receipt.config.js
src/services/payment-receipt.infrastructure.js
src/services/payment-receipt.local-storage.js
src/services/payment-receipt.repository.js
src/services/payment-receipt.service.js
src/services/payment-receipt.storage.js
src/validators/payment-receipt.validator.js
test/eval/fake-whatsapp.js
test/eval/memory-world.js
test/eval/run-eval.js
test/eval/media/guardian-manifest.json
test/eval/media/o02-receipt.png
test/helpers/consultation-fixtures.js
test/helpers/customer-firestore.js
test/helpers/receipt-fixtures.js
test/helpers/receipt-memory.js
test/run-unit.js
test/test_agent_receipts.js
test/test_receipt_media_storage.js
test/test_receipt_runner.js
test/test_receipt_transactions.js
test/test_consultation_agent.js
test/test_consultation_tools.js
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-5B.md
```

Frontend (rutas relativas a hodie-tienda):

```text
src/app/core/models/payment-receipt.model.ts
src/app/core/services/payment-receipt.service.ts
src/app/admin/pages/orders/order-detail/receipts/order-receipts.component.ts
src/app/admin/pages/orders/order-detail/receipts/order-receipts.component.html
src/app/admin/pages/orders/order-detail/receipts/order-receipts.component.scss
src/app/admin/pages/orders/order-detail/order-detail-component/order-detail-component.ts
src/app/admin/pages/orders/order-detail/order-detail-component/order-detail-component.html
test/admin-receipts.spec.ts
```
