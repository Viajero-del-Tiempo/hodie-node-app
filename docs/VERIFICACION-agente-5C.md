# Entrega 5C: fotos automáticas

El agregado de fotos de empaques, la regresión web corregida y sus archivos/tests
se documentan en [VERIFICACION-empaques-5C.md](VERIFICACION-empaques-5C.md).
La corrección de listas y retención de comprobantes está en
[VERIFICACION-pendientes-5C.md](VERIFICACION-pendientes-5C.md).

Revisión final del código cerrada; ejecución de tests y evaluación pendiente de
Arnaldo. Esta guía contiene comandos,
no resultados de tests ni evaluaciones. Describe la 5C original del agente y su
runner; el agregado enlazado arriba incluye la corrección web y la validación
del panel. No conecta WhatsApp ni modifica el flujo productivo.

## Contrato y criterio

responder.productosMostrados es opcional: arreglo de cero a tres IDs distintos
de productos para presentar. Rechaza tipos, IDs y cantidades inválidos antes de
enviar. El modelo aporta solo introducción en texto y cierre opcional en cierre,
sin listar productos/precios. El servidor envía introducción, una foto o línea
por cada ID con nombre/precio reales, y cierre. Devuelve productImages con
sent/skipped/failed/textOnly; una ausencia/error de foto no invalida la lista.

Principal: primera imagen de la primera variante activa que tenga fotos, en el
orden guardado. Puede representar una variante activa agotada. El pie usa el
menor precio de las variantes activas y Desde si varían. No se inventa un precio
ni se toma información de los argumentos del modelo. Sin imágenes en variantes
activas: SIN_IMAGENES y línea textual con nombre/precio del servidor. Una foto
ya enviada o fallida también se reemplaza por esa línea. No se agregan fotos a cotizaciones,
mensajes de pedido/pago, acuses de comprobantes, políticas ni estados de pedido.

La deduplicación por URL exacta persiste en sentProductImages y se comparte con
enviar_imagenes. La reserva anterior al envío evita repetir entregas inciertas
tras una caída; un fallo explícito la libera para una petición posterior. Una
sesión nueva limpia el registro. El contexto anuncia solamente IDs de productos
de fotos entregadas, y el resultado del cierre informa cuáles se enviaron.

buscar_productos conserva sus cinco resultados posibles; el prompt presenta
como máximo tres y ofrece más cuando corresponde. enviar_imagenes sigue enviando
hasta tres fotos nuevas solicitadas, sin gastar ese cupo en una principal ya vista.

El transporte falso no descarga URLs ficticias: registra tipo image, productId y
caption. El juez recibe esa evidencia pública por evento, sin bytes. El loader
conserva imageUrls opcional en variantes y diagnostica listas/URLs mal formadas.
No se editan YAML, checks, umbrales, pensamiento ni tiempos.

La cobertura incluye cotización completa, incompleta e informativa; un turno de
política/estado inhibe fotos en ese turno, pero permite recomendaciones en el
siguiente. Incluye cancelación durante un envío: no acepta la respuesta tardía,
no inicia otra foto ni escribe después del cierre.

## Comandos

Desde /home/arnaldoguerrero/Hodie/hodie-node-app:

```bash
node --test test/test_agent_product_images.js test/test_agent_product_images_runner.js
node --test test/test_eval_loader.js test/test_eval_transport.js test/test_eval_judge.js test/test_guardian_sessions.js
npm run test:agent:unit
npm run test:agent:purchase:unit
npm run test:agent:support:unit
npm run test:guardian:unit
npm run test:eval:unit
node --test test/test_agent_receipts.js test/test_receipt_media_storage.js test/test_receipt_runner.js
```

Las dos suites nuevas también están en test/run-unit.js. package.json no cambia.
La 5C original no requiere emulador ni build Angular; el agregado de empaques
sí incluye ambos y sus comandos están en la guía enlazada arriba.

Tras aplicar el parche del dueño a las fixtures y a C-04/P-08:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-04,P-08
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

Revisar en report.json/trace.jsonl: texto antes de hasta tres imágenes, productId
y caption de cada imagen, pies de precios vigentes, ausencia de fotos para un
producto sin imágenes, omisiones YA_ENVIADA dentro de sesión y entrega al comenzar
otra sesión. PRODUCT_IMAGE_SEND_FAILED queda en log/resultado sin error técnico
del turno. No se afirma entrega solo porque el modelo lo diga.

## Archivos tocados

Rutas relativas a hodie-node-app:

```text
src/agents/consultation/product-images.js
src/agents/consultation/read-tools.js
src/agents/consultation/terminal.js
src/agents/consultation/tool-registry.js
src/agents/consultation/purchase-tools.js
src/agents/consultation/eval-adapter.js
src/agents/consultation/server-context.js
src/agents/guardian/session.js
src/agents/prompts/agente.md
test/eval/fake-whatsapp.js
test/eval/load-cases.js
test/eval/run-eval.js
test/eval/judge.js
test/helpers/product-images-fixtures.js
test/test_agent_product_images.js
test/test_agent_product_images_runner.js
test/test_eval_loader.js
test/test_eval_transport.js
test/test_eval_judge.js
test/test_guardian_sessions.js
test/run-unit.js
docs/CONTEXT.md
docs/SPEC-agente.md
docs/VERIFICACION-agente-5C.md
```
