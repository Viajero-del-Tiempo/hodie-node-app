# Correcciones de 5C: lista del servidor y retención de comprobantes

Implementación escrita; tests y evaluación pendientes de Arnaldo. Esta guía no
contiene resultados. No se modifican YAML, checks, umbrales, pensamiento ni plazos
del agente. No se conecta WhatsApp ni se despliega la rama.

## Lista del servidor

Con productosMostrados, texto es solo una introducción breve; cierre es opcional.
El modelo no lista productos ni precios en esos campos. El servidor respeta el
orden de IDs: introducción, una foto por producto con Nombre — precio, cierre.
Precio menor de variantes activas, con Desde si varía; no sale del modelo.
Sin foto, foto ya vista en sesión o envío fallido: línea textual del servidor
en su lugar. Así la lista sigue completa sin reenviar una foto en esa sesión.
productImages.textOnly informa esas líneas junto a sent/skipped/failed.

El esquema conserva máximo tres IDs distintos y el máximo combinado de tres
productos/empaques. Rechaza más de tres antes de enviar. Cierre solo corresponde
a listas; cotizaciones, pedidos/pagos, acuses, políticas y estados inhiben fotos,
líneas adicionales y cierre de lista. Los mensajes de pago siguen exclusivos del
servidor. El runner/juez ya registran los mensajes y las fotos en ese orden.

## Retención decidida

- Pago verificado: 30 días desde orders.paymentVerifiedAt.
- Nunca verificado (pendiente/abandonado o cancelado): 30 días desde la subida.
- Sin asignar: las seis horas vigentes, con su barrido corto actual.

La primera transición manual de sin pago confirmado a un estado con pago
confirmado escribe paymentVerifiedAt en la misma transacción de estado/stock.
Lo conserva en transiciones posteriores y ante cancelación. Un fallo de stock
revierte también esa fecha. No se cambia el cálculo de precios, sus mensajes ni
cuándo se descuenta stock.

El barrido diario inicia con el proceso y luego cada 24 h. Pagina candidatos por
status/createdAt y relee el pedido en la transacción que marca deleting. Si el
pago se verificó entre selección y reclamo, respeta su nuevo plazo. El archivo se
borra fuera de la transacción; después queda status:deleted y deletedAt. Conserva
asociación, metadatos y alerta histórica. El endpoint de descarga rechaza deleted.

Reiniciar antes de borrar recupera deleting; caer después del borrado y antes de
guardar deleted vuelve a intentar un borrado idempotente. El barrido corto también
recupera esos trabajos. Dos workers pueden repetir el borrado sin cambiar el
pedido ni la historia. Un reenvío del mismo archivo eliminado crea una generación
nueva, con ID/archivo distintos, conservando el registro anterior. Las pruebas
anteriores de seis horas se ajustan a ese registro histórico y refuerzan que un
borrado atrasado no afecte al archivo nuevo.

Configuración validada:

| Variable | Por defecto | Rango |
| --- | --- | --- |
| AGENT_RECEIPT_UNASSIGNED_TTL_MS | 6 h | 1 min..7 días |
| AGENT_RECEIPT_ASSOCIATED_RETENTION_MS | 30 días | 1..365 días |
| AGENT_RECEIPT_RETENTION_CLEANUP_INTERVAL_MS | 24 h | 1 min..7 días |

La eliminación física puede esperar el próximo barrido o una recuperación del
proveedor. Los históricos pagados sin paymentVerifiedAt fiable se conservan con
RETENTION_VERIFICATION_DATE_MISSING; no se toma updatedAt como fecha de pago.
Se requiere completar esa fecha con evidencia. Un pedido asociado desaparecido
o un estado desconocido también bloquea el borrado con diagnóstico.

No habilitar TTL de Firestore sobre payment_receipts: eliminaría metadatos antes
de borrar archivos y perdería la historia. Desplegar el índice nuevo de
firestore.indexes.json (payment_receipts: status/createdAt) en la puesta en marcha
conjunta. La comprobación de acceso privado de Cloudinary sigue pendiente.

## Comandos para Arnaldo

Desde /home/arnaldoguerrero/Hodie/hodie-node-app:

```bash
node --test test/test_agent_product_images.js test/test_agent_product_images_runner.js test/test_agent_packaging_images.js test/test_agent_packaging_images_runner.js
node --test test/test_receipt_retention.js test/test_agent_receipts.js test/test_receipt_media_storage.js test/test_receipt_runner.js test/test_order_variant_stock.js
npm run test:agent:unit
npm run test:agent:purchase:unit
npm run test:eval:unit
```

Emulador, en otra terminal:

```bash
npm run catalog:local
```

Con el emulador levantado:

```bash
node scripts/test-catalog-emulator.js --agent-receipts-only
npm run test:integration:emulator
```

Las pruebas de retención del emulador operan por ID sobre sus propios registros;
no ejecutan un barrido con reloj adelantado sobre los demás datos del emulador.
Cubren pago/conservación/borrado/descarga denegada, carrera y rollback reales.

Evaluación objetivo y regresión:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-04,P-08,O-02
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

## Archivos de esta corrección

```text
src/agents/consultation/product-images.js
src/agents/consultation/terminal.js
src/agents/consultation/tool-registry.js
src/agents/prompts/agente.md
src/services/payment-receipt.config.js
src/services/payment-receipt.retention.js
src/services/payment-receipt.repository.js
src/services/payment-receipt.service.js
src/services/order-stock.service.js
firestore.indexes.json
test/helpers/receipt-memory.js
test/test_receipt_retention.js
test/test_agent_receipts.js
test/test_receipt_transactions.js
test/test_order_variant_stock.js
test/test_agent_product_images.js
test/test_agent_product_images_runner.js
test/run-unit.js
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-5B.md
docs/VERIFICACION-agente-5C.md
docs/VERIFICACION-pendientes-5C.md
```
