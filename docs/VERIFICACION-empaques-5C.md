# Fotos de empaques: agregado a 5C

Código y pruebas escritos; verificación por Arnaldo pendiente. No se ejecutaron
tests, builds ni evaluaciones. Backend en feature/agente; Angular en
feature/catalogo-variantes. No se conecta WhatsApp ni se despliega la rama.

## Qué se encontró

La tienda anterior tomaba las fotos del catálogo, por posición de imageUrls.
En el commit 0a0da0f de hodie-tienda, product-detail-page.ts asignaba [0] al
producto solo y [1]/[2]/[3] a la lista de empaques fija. onRadioChange cambiaba
la principal con imageUrl de la opción seleccionada. No construía nombres ni
URLs de Cloudinary. Se puede comprobar con:

```bash
git show 0a0da0f:src/app/pages/store/product-detail-page/product-detail-page.ts
git show 0a0da0f:src/app/core/models/packaging.model.ts
```

V2 conserva el campo packagingOptions[].imageUrl, las miniaturas y el uploader
firmado del panel (también local en emulador). La regresión era el detalle:
[(selected)] asignaba selectedPackaging sin actualizar selectedImageUrl.
Se corrigió. La foto se obtiene exclusivamente del campo de esa opción.

## Comportamiento

- Web: elegir empaque muestra producto con ese empaque. Cambiar de variante
  conserva esa foto compartida por producto; quitar empaque/elegir uno sin foto
  vuelve a la variante actual. El alt también identifica el empaque.
- Panel: sube, reemplaza, edita y quita la foto con el uploader existente. Bloquea
  guardado mientras sube. Errores y 409 conservan borrador; URL rechazada queda
  junto a packagingOptions[n].imageUrl. No cambian presupuestos de estilos.
- Validación: imagen opcional, vacía/ausente significa sin foto. URLs HTTP/HTTPS
  sin credenciales o rutas desde / del mismo origen; sin espacios internos,
  controles o barras invertidas. Rechaza data:, javascript:, file:, //host y
  valores de otro tipo. La subida sigue validando firma de archivo, MIME y 10 MB.
- Fixture Angular: su foto de empaque era un data: SVG que no representa una
  subida de imagen admitida. Ahora usa ruta ficticia válida; se conservan los
  controles de nombres/precios y se agregan pruebas de selección/subida/rechazo.
- Bot: responder.empaquesMostrados acepta objetos productId, packagingType y
  variantId opcional; nunca URLs, nombres ni precios. Límite conjunto de tres
  presentaciones con productosMostrados y sin repetir producto/tipo. Para mostrar
  otros empaques se ofrece continuar en otro mensaje/turno.
- Decisión confirmada de Arnaldo: pie con total por unidad del producto con ese
  empaque. Variante elegida + costo adicional, o menor precio activo + empaque
  con Desde si varían. Información del catálogo, sin cotizar/reservar/descontar
  stock. Cotización y pedido conservan su pricing, mensajes y validaciones.
- Texto principal primero; una línea textual del servidor para cada opción sin
  foto (agrupadas en un mensaje adicional); después las fotos. packagingImages
  informa sent/skipped/failed/textOnly. Fallos de imagen no suman racha técnica.
- enviar_imagenes puede pedir packagingType concreto; sin filtro, incluye
  empaques después de las fotos de variantes, hasta tres nuevas. Deduplicación
  por URL y sesión compartida con 5C. packagingPhotosSent distingue entregas del
  producto solo en el contexto del modelo. No hay fotos/líneas adicionales en
  cotizaciones, pedido/pago, acuses, estados ni políticas.
- Runner conserva imageUrl de cada opción y diagnostica valores inválidos con
  campo/línea. El juez recibe producto/empaque/pie de la foto, sin bytes. El dueño
  actualiza el YAML; ni ese archivo ni su parche-fotos.py se modifican aquí.

## Comandos para Arnaldo

Backend, desde /home/arnaldoguerrero/Hodie/hodie-node-app:

```bash
node --test test/test_catalog_packaging_images.js test/test_catalog_validation.js test/test_catalog_service.js test/test_catalog_public_api.js test/test_catalog_images.js
node --test test/test_agent_packaging_images.js test/test_agent_packaging_images_runner.js test/test_agent_product_images.js test/test_agent_product_images_runner.js
npm run test:eval:unit
npm run test:agent:unit
npm run test:agent:purchase:unit
npm run test:guardian:unit
```

Emulador, en otra terminal:

```bash
npm run catalog:local
```

Con él levantado:

```bash
npm run test:integration:emulator
```

Ese script incluye test_catalog_products_api.js con creación, publicación,
reemplazo, borrado de foto y rechazo sin alterar el producto. Reutiliza el
emulador y sus protecciones de proyecto/host; no ejecutar esa suite contra producción.

Angular, desde /home/arnaldoguerrero/Hodie/hodie-tienda:

```bash
npm test -- --watch=false --browsers=ChromeHeadless
npm run build
npm run build:prod
npm start -- --configuration emulator
```

Regresión del agente tras el parche de fixtures del dueño:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json
```

A mano: editar el producto ficticio en el panel local, subir/reemplazar foto de
una opción y guardar. En /store/<slug> elegirla: cambia principal y precio. Cambiar
variante, quitar empaque y probar opción sin foto. Reabrir panel: conserva la URL.
Probar URL inválida, error de subida y conflicto de edición: conserva borrador y
marca campo. Para el bot revisar trace/report: máximo tres fotos, tipo de empaque
y total del pie, texto sin foto, omisiones de sesión y ausencia de cambios de stock.

## Archivos del agregado

Backend:

```text
src/validators/catalog.validator.js
src/agents/consultation/product-images.js
src/agents/consultation/read-tools.js
src/agents/consultation/tool-registry.js
src/agents/consultation/terminal.js
src/agents/consultation/server-context.js
src/agents/prompts/agente.md
test/eval/load-cases.js
test/eval/fake-whatsapp.js
test/eval/run-eval.js
test/eval/judge.js
test/helpers/packaging-images-fixtures.js
test/test_catalog_packaging_images.js
test/test_catalog_public_api.js
test/test_catalog_products_api.js
test/test_agent_packaging_images.js
test/test_agent_packaging_images_runner.js
test/test_eval_loader.js
test/test_eval_judge.js
test/run-unit.js
docs/SPEC-catalogo.md
docs/SPEC-agente.md
docs/CONTEXT.md
docs/VERIFICACION-agente-5C.md
docs/VERIFICACION-empaques-5C.md
```

Angular:

```text
src/app/pages/store/product-detail-page/product-detail-page.ts
src/app/pages/store/product-detail-page/product-detail-page.html
src/app/core/models/catalog.model.ts
src/app/admin/catalog-editor.util.ts
src/app/admin/product-editor-form.util.ts
src/app/admin/pages/products/product-editor.component.html
test/helpers/catalog-fixtures.ts
test/packaging-images.spec.ts
test/admin-product-editor.spec.ts
```
