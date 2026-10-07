# Especificación: catálogo con variantes (HoDie)

Oct 1, 2026 · @Arnaldo

## Objetivo y regla de oro

Esta fase reemplaza el catálogo actual (un documento por color) por un modelo de productos con variantes, categorías y datos estructurados. Los productos actuales no se migran: el dueño los vuelve a cargar desde el panel admin con el modelo nuevo. Es la base del agente conversacional nuevo, que tendrá su propia especificación y saldrá a producción junto con este catálogo.

**Regla de oro:** agregar un producto desde el panel admin tiene que alcanzar para que la tienda web y el bot lo conozcan, sin tocar código ni prompts. Ningún nombre de producto, categoría, color o tipo de empaque puede estar escrito en el código productivo (`src/`). Los tests pueden usar nombres y datos ficticios, independientes de los documentos del proyecto y del catálogo real.

Alcance: modelo de datos en Firestore, puesta en marcha sin migración, backend (precios, stock, panel admin, servicio de catálogo con búsqueda) y frontend (tienda, carrito, checkout y panel admin).

## Modelo de datos

El catálogo pasa a tener tres colecciones: `categories`, `products` (con variantes embebidas) y `policies`. Cada variante tiene su propio precio y stock; el producto no tiene precio propio.

### categories

```js
{
  id: "termos",              // slug estable, nunca cambia
  name: "Termos",
  description: "Termos de acero inoxidable personalizables",
  active: true,
  order: 1                   // orden de aparición en la tienda
}
```

### products

```js
{
  id: "<id automático>",
  schemaVersion: 2,
  name: "Termo 650 ml",
  slug: "termo-650-ml",
  description: "Texto libre para la tienda",
  categoryId: "termos",
  tags: ["mate", "tereré", "regalo para papá"],  // ayudan a la búsqueda
  active: true,
  attributes: {                // datos que el bot puede afirmar
    material: "Acero inoxidable",
    medidas: "23 x 7 cm",
    capacidad: "650 ml"
  },
  optionNames: ["color"],      // ejes de variante; ver la regla de variantes
  variants: [
    {
      id: "<id estable>",
      sku: "HOD-TER650-NEG",
      options: { color: "Negro" },
      price: 67000,            // guaraníes, entero
      stock: 5,
      active: true,
      imageUrls: ["..."]
    }
  ],
  skus: ["HOD-TER650-NEG"],     // calculado por el servidor: SKU de todas las variantes
  priceFrom: 67000,            // calculado por el servidor: menor precio de variantes activas
  customization: {
    allowed: true,
    allowsText: true,
    maxChars: 20,
    allowsImage: true,
    notes: "Grabado en una cara"
  },
  packagingOptions: [          // propios del producto: el precio depende de su tamaño
    { type: "caja", name: "Caja de regalo", price: 25000, imageUrl: "..." }
  ],
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

- **Regla de variantes:** las variantes de un producto solo difieren en atributos que no cambian su tamaño ni su modelo (color, diseño). Lo que cambia el tamaño o el modelo es otro producto: el termo de 650 ml y el de 1200 ml son dos productos, igual que la billetera femenina y la masculina.
- **Cada variante tiene su propio precio**, aunque hoy todas valgan lo mismo, para poder cambiarlo más adelante sin tocar el modelo.
- **Los atributos comunes a todas las variantes** (material, medidas, capacidad) van en `attributes`; lo que distingue a cada variante va en `options`.
- **Los empaques son propios de cada producto**, porque su precio depende del tamaño del producto. `packagingOptions` es una lista libre: desaparece la lista fija `caja / bolsa / envoltorio` del código. El empaque estándar sin costo no se guarda: se ofrece siempre.
- **`priceFrom` lo calcula siempre el servidor** al guardar; el cliente nunca lo envía.
- **`skus` lo calcula siempre el servidor** al guardar, a partir de todas las variantes, incluidas las inactivas. Si viene en el body se ignora. Permite comprobar unicidad con consultas indexadas `array-contains`, sin leer todos los productos. La comparación de SKU es exacta, después de quitar espacios de los extremos.

### policies

```js
{ id: "envios", title: "Envíos", text: "Envío gratis en Minga Guazú; resto del país por transportadora con flete contra entrega.", updatedAt }
```

Un documento por tema (`envios`, `pagos`, `tiempos-de-entrega`, `personalizacion`, `devoluciones`). Los usa el agente en fases posteriores; en esta fase solo se crean y se editan desde el panel.

### Ítem de pedido

Cada ítem de `orders` guarda una foto de la variante al momento de la compra, para que un cambio de precio posterior no altere pedidos existentes:

```js
{
  productId, variantId,
  productName: "Termo",
  variantLabel: "Negro · 650 ml",
  sku, price, quantity,
  selectedPackaging: { type, name, price } | null,
  customization, customizationImageUrl, customizationPending
}
```

## Reglas de validación

El backend valida todo al guardar un producto desde el panel; un producto inválido se rechaza con un error 400 que dice qué campo falló.

| Campo                    | Regla                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `name`                   | Obligatorio, 2 a 80 caracteres                                                         |
| `categoryId`             | Tiene que existir en `categories` y estar activa                                       |
| `variants`               | Al menos una variante                                                                  |
| `variants[].options`     | Mismas claves que `optionNames`, en todas las variantes; ninguna combinación repetida  |
| `variants[].price`       | Entero mayor a 0 (guaraníes)                                                           |
| `variants[].stock`       | Entero mayor o igual a 0                                                               |
| `variants[].sku`         | Obligatorio y único en todo el catálogo                                                |
| `slug`                  | Slug en minúsculas, único en todo el catálogo; la edición excluye el propio producto   |
| `variants[].id`          | Asignado por el servidor, estable y obligatorio al editar una variante existente; una variante creada nunca se elimina |
| `packagingOptions[]`     | `type` único dentro del producto, `name` obligatorio, `price` entero mayor o igual a 0 |
| `customization.maxChars` | Entero entre 1 y 500, solo si `allowsText` es true                                     |
| `tags`                   | Hasta 20, cada una de 2 a 30 caracteres, guardadas en minúsculas                       |
| `priceFrom`              | Lo calcula el servidor; si viene en el body se ignora                                  |
| `skus`                   | Arreglo derivado por el servidor de los SKU de todas las variantes; si viene en el body se ignora |

Dos reglas de negocio más:

- **Una variante, una vez creada, nunca se elimina:** solo se desactiva (`active: false`), independientemente de que tenga pedidos que la referencien. En una edición deben conservarse todos sus IDs, incluso los de variantes inactivas. No se consultan pedidos para decidirlo.
- **Un producto sin variantes activas** no se muestra en la tienda ni aparece en la búsqueda, aunque el producto esté activo.
- Si no hay variantes activas, `priceFrom` es `null`. El stock cero no desactiva una variante ni la excluye por sí solo de la búsqueda.

## Cómo recargar los productos actuales

Los productos actuales no se migran: se borran y el dueño los vuelve a cargar desde el panel admin cuando el modelo nuevo esté funcionando. Siguiendo la regla de variantes, los 19 productos visibles hoy quedan en 7:

| Producto nuevo              | Categoría    | Opciones | Variantes (de los productos actuales)               | Precio por variante |
| --------------------------- | ------------ | -------- | --------------------------------------------------- | ------------------- |
| Kit para mate               | Kits de mate | color    | Verde, Rosa claro, Blanco, Rosa oscuro, Azul, Negro | 140.000 Gs.         |
| Termo 650 ml                | Termos       | color    | Rosa, Naranja, Gris, Verde, Azul, Negro             | 67.000 Gs.          |
| Billetera femenina Chenson  | Billeteras   | color    | Marrón claro, Marrón, Negro                         | 55.000 Gs.          |
| Billetera masculina Chenson | Billeteras   | color    | Negro                                               | 59.000 Gs.          |
| Vaso con abridor            | Vasos        | color    | Negro                                               | 35.000 Gs.          |
| Joyero cuadrado             | Joyería      | color    | Negro                                               | 47.000 Gs.          |
| Neceser de cuero sintético  | Neceseres    | color    | Negro                                               | 35.000 Gs.          |

Los productos de una sola variante igual se modelan con variante: así, el día que llegue el vaso en otro color, se agrega una variante sin cambiar nada más.

### Datos a definir antes de cargarlos

- [ ] Nombres definitivos de las categorías y su orden en la tienda.
- [ ] Personalización por producto: si admite texto, cantidad máxima de caracteres, si admite logo o imagen, y en qué parte del producto va.
- [ ] Atributos por producto (material, medidas, capacidad, marca).
- [ ] Empaques de cada producto y su precio, según su tamaño.
- [ ] Etiquetas de búsqueda por producto (por ejemplo, "regalo para papá", "tereré", "corporativo").

## Puesta en marcha

No hay migración de productos: se respalda todo, se borran los productos viejos y se cargan los nuevos a mano. La tienda completa está en mantenimiento. La entrega 6 se realiza cuando estén listos el catálogo y el agente conversacional nuevo, con su propia especificación: backend, frontend y agente salen a producción juntos. Hasta entonces, nada de esta rama se deploya.

1. **Condición previa:** ningún pedido abierto. Todos los pedidos existentes tienen que estar entregados o cancelados (ver Pedidos existentes).
2. **Backup completo:** exportar Firestore con `gcloud firestore export` a un bucket de Cloud Storage.
3. **Mantenimiento:** la tienda sigue en mantenimiento y se detiene el bot con `pm2 stop hodie-backend`.
4. **Borrado:** un script con dry-run por defecto lista y borra los documentos de `products`. Nada más.
5. **Deploy conjunto:** backend, frontend y agente conversacional nuevos, y `pm2 start`. Antes del deploy se elimina la compatibilidad temporal con productos del modelo viejo en pricing y en la consulta de SKU raíz. El manejo de pedidos históricos sin `variantId` permanece, con aviso y sin movimientos de stock.
6. **Carga manual:** el dueño crea las categorías y los productos desde el panel admin.
7. **Verificación** con los criterios de aceptación, antes de sacar la tienda de mantenimiento.

**Rollback:** restaurar `products` desde el export y volver a deployar el commit anterior. Los pedidos no se tocan en ningún paso.

## Cambios en el backend

Todo acceso al catálogo pasa por un único servicio, y precios y stock se calculan siempre sobre la variante.

### Servicio de catálogo (`src/services/catalog.service.js`, nuevo)

- `getCategories()`: categorías activas, en orden.
- `getProduct(productId)`: producto completo con sus variantes activas.
- `searchProducts({ query, categoryId, options, onlyAvailable, limit })`: busca en nombre, etiquetas, nombre de categoría, valores de opciones y valores de atributos. Normaliza tildes, diéresis, mayúsculas y plurales regulares, preservando `ñ`. Elimina palabras vacías del castellano, incluidos artículos, preposiciones y verbos de consulta. No usa vocabulario del negocio ni busca en descripción, políticas o empaques.
- Admite coincidencias parciales: ordena primero por cantidad de términos encontrados, y luego por coincidencias en nombre, etiquetas, categoría, opciones y atributos, en ese orden. Dentro de cada campo prioriza coincidencias exactas sobre equivalencias de plural. Desempata por nombre completo coincidente, orden de categoría, nombre normalizado e ID. Cada resultado incluye `matchedTerms`, un arreglo de términos normalizados de la consulta, sin palabras vacías ni duplicados.
- `onlyAvailable` es `false` por defecto: las variantes activas agotadas siguen visibles. Cada variante devuelta incluye `available: true/false`, calculado como `stock > 0`. Con `onlyAvailable: true` solo se incluyen variantes con stock. El resultado es uno por producto, con categoría, `priceFrom`, variantes que satisfacen los filtros, sus precios y un resumen de personalización; el límite es 5 por defecto y debe ser un entero positivo.
- Los filtros de opciones se satisfacen sobre una misma variante. La cantidad de términos encontrados se calcula también sobre una sola variante y los campos comunes, sin sumar opciones de variantes incompatibles. El producto puede devolver otras variantes activas que satisfagan los filtros explícitos.
- Las categorías y productos inactivos quedan excluidos. `getProduct` conserva la información completa del producto y solo sus variantes activas, incluidas las agotadas; devuelve `null` si no existe, es del esquema viejo, está inactivo, su categoría no está activa o no tiene variantes activas. `priceFrom` se deriva de todas las variantes activas, incluso cuando un filtro devuelve solo parte de ellas.
- Una consulta vacía o formada solo por palabras vacías devuelve el catálogo filtrado en orden de categoría, nombre e ID, con `matchedTerms: []`. Los plurales usan reglas generales de sufijos `s`, `es` y `ces`/`z`, conservando la forma original: pueden tener falsos positivos en terminaciones ambiguas y no resuelven todos los plurales irregulares. Una etiqueta compuesta solo de palabras vacías no aporta términos a la consulta.
- Caché en memoria de 5 minutos, que se invalida cuando el panel admin guarda un producto, una categoría o una política.
- La caché es por proceso. Una invalidación durante una carga descarta esa carga y vuelve a leer; una escritura fallida no invalida. Las comprobaciones de categoría activa y unicidad de SKU no utilizan la caché.
- Este servicio es la única fuente que usarán la tienda, el panel y el agente. No contiene ningún nombre de producto ni de categoría.

#### Validaciones preparadas en la entrega 1

`validateProductModel` recibe un documento completo, asigna IDs a variantes nuevas sin ID, rechaza IDs nuevos enviados por el cliente y conserva todos los IDs de variantes existentes. Deriva `priceFrom` y `skus` y devuelve únicamente los campos del modelo; el futuro guardado agrega ID y timestamps del producto.

`validateProductForSave`/`catalogService.validateProduct` comprueba la categoría directamente y consulta `products` con `where('skus', 'array-contains', sku).limit(2)` por SKU, excluyendo el propio producto al editar. Una consulta adicional `where('sku', '==', sku).limit(2)` cubre los documentos del esquema viejo sin migrarlos. Los SKU de variantes inactivas siguen ocupados. No hay lectura completa del catálogo para esta validación.

El slug también se comprueba directamente con `where('slug', '==', slug).limit(2)`, excluyendo el propio producto al editar. Productos desactivados siguen ocupando sus SKU y su slug. No se lee todo el catálogo para comprobar unicidad.

**Concurrencia:** esta validación detecta conflictos, pero no reserva SKU ni slug ni constituye por sí sola una garantía frente a dos guardados simultáneos. El CRUD nuevo de productos de la entrega 5a serializa su comprobación y escritura en una transacción que también escribe el documento de control compartido `counters/catalogWrites`. La unicidad no debe basarse solo en una consulta previa o en la caché. Todos los productos del modelo nuevo deben guardar `skus` derivado; no se hace ningún backfill en esta entrega.

El CRUD viejo de productos mantiene su comportamiento en la entrega 1 y solo incorpora invalidación de caché tras una escritura exitosa. La validación del modelo nuevo todavía no se conecta a ese CRUD; se integrará al reemplazarlo. No se implementan precios de pedidos, stock por variante ni adaptador del bot en esta entrega.

### Precios (`calculateOrderPricing`)

- Cada ítem recibido trae `productId`, `variantId`, `quantity`, `packagingType` y personalización. Cualquier precio que venga del cliente se ignora, como hoy.
- El precio sale de la variante; el del empaque, de `packagingOptions` del producto. Si el `type` no existe en ese producto, error 400.
- Rechaza variantes o productos inactivos, y cantidades fuera de 1 a 100.
- Comprueba el stock actual de la variante con una lectura directa, sin caché: suma las líneas repetidas de la misma pareja `productId`/`variantId` y devuelve 400 si el total solicitado supera el stock. El mensaje identifica la variante y cuántas unidades hay disponibles. No reserva ni descuenta unidades al crear el pedido; vuelve a comprobarlas al confirmar el pago.
- Arma la foto del ítem (`productName`, `variantLabel`, `sku`, `price`) descrita en el modelo de datos.
- Reprocesar un ID ya persistido conserva esa foto, sus totales, estado, número y fecha originales, sin volver a cotizar. La creación usa `create`, sin sobrescribir un documento existente. Los errores de persistencia impiden emitir un comprobante de un pedido que no se guardó; los errores de PDF posteriores no revierten el pedido.
- La misma función la usan el checkout web y el bot.

**Compatibilidad temporal hasta la entrega 6:** el CRUD de productos continúa guardando el modelo viejo hasta su reemplazo en la entrega 5. Para esos documentos (sin `schemaVersion` o con versión 1), el pricing acepta ítems sin `variantId`, lee precio/SKU raíz y empaques de `packagingPrices`/`packagingImages`. Los tipos salen de las claves reales del documento; no hay lista ni nombres de empaques fijos. Si el cliente envía solo un nombre descriptivo, se acepta únicamente si identifica sin ambigüedad una clave mediante sus palabras; nombres que no contienen esa clave se rechazan. El nombre guardado es la clave, porque el modelo viejo no guarda un nombre comercial. Esta compatibilidad y la consulta de SKU raíz se eliminan en la entrega 6, antes del deploy conjunto. Un producto de versión 2 siempre exige `variantId`: no se adapta ni se elige una variante automáticamente. La advertencia para pedidos históricos sin `variantId` permanece después de ese retiro.

### Stock

- `deductStockInTransaction` y `restoreStockInTransaction` operan sobre la variante: leen el producto en la transacción, modifican el stock de esa variante dentro del arreglo `variants` y lo guardan.
- Los ítems sin `variantId` (pedidos anteriores al cambio) no tocan stock: el cambio de estado se guarda y el panel muestra un aviso.
- La máquina de estados de pedidos del panel no cambia: descuenta al pasar a pagado y restituye al cancelar.
- El estado del pedido y los stocks se escriben en la misma transacción. Se lee el pedido dentro de ella, se agrupan cantidades por producto/variante y se leen todos los productos antes de escribir. Cada producto se actualiza una vez, preservando las demás variantes y el stock raíz. Un faltante o referencia inválida revierte toda la transición. Firestore reintenta ante conflictos: dos pedidos no pueden gastar la misma última unidad y repetir pago/cancelación no mueve stock dos veces.
- Se mantienen los estados comprometidos actuales (`paid`, `preparing`, `shipped`, `delivered`), la restitución al volver a `pending` y el bloqueo de reactivar un cancelado. Restaurar permite variantes o productos desactivados; una referencia de variante inexistente falla sin usar el stock raíz.
- La API agrega `stockWarnings` al listado, detalle y respuesta de estado. El mensaje de respuesta incluye el aviso que ya muestra el panel. Un ítem histórico se omite sin leer su producto; en pedidos mixtos se procesan solo las variantes identificadas. La caché se invalida y WhatsApp se notifica después del commit; repetir el mismo estado no vuelve a notificar.

### Panel admin (API)

- CRUD de productos con el esquema nuevo. Los `variantId` los genera el servidor y no cambian al editar. En la entrega 5a reemplaza el CRUD viejo; el panel Angular se reemplaza en 5b.
- Las lecturas administrativas de productos son frescas e incluyen variantes inactivas. Devuelven `version`, un token de transporte basado en `updateTime` de Firestore, que nunca se persiste. PUT/PATCH y desactivación/reactivación lo exigen. Un documento modificado desde su lectura devuelve 409 con `field: "version"`, `code: "CATALOG_VERSION_CONFLICT"`, mensaje que identifica los cambios y un arreglo `changes`. No sobrescribe el documento; el panel de 5b conserva el borrador.
- GET/POST/PUT/PATCH de productos trabajan únicamente con `schemaVersion: 2`; los documentos viejos no se convierten. DELETE siempre desactiva y `force=true` se rechaza.
- `POST /admin/images` recibe base64 y MIME, requiere autenticación y rol admin consultado en Firestore, admite JPG/PNG/WEBP hasta 10 MB y devuelve `imageUrl`. La subida a Cloudinary la firma y realiza el backend, sin preset sin firma del frontend. El panel lo utiliza en 5b.
- Desactivar (no borrar) variantes y productos.
- CRUD de `categories` y de `policies`. No se puede desactivar una categoría que tenga productos activos.
- En la entrega 1, ambas APIs ofrecen GET de colección y documento, POST, PUT, PATCH y DELETE. PUT/PATCH de categorías y políticas validan el documento combinado con el existente, preservando el ID. Los IDs son slugs libres, sin temas ni categorías predefinidos. `DELETE /admin/categories/:id` desactiva la categoría; consulta sus productos directamente en una transacción y rechaza con 409 si alguno está activo. Las lecturas administrativas incluyen categorías inactivas. `DELETE /admin/policies/:id` elimina solo ese documento; `updatedAt` siempre lo genera el servidor. Campos inválidos devuelven 400 con `field`, documentos inexistentes 404 y duplicados o referencias que impiden desactivar 409.
- Todas las rutas con `requireAuth` + `requireAdmin`, igual que las actuales.

### Reglas de Firestore

- `categories`: lectura pública, escritura solo desde el backend.
- `products`: igual que hoy (lectura pública, escritura solo desde el backend).
- `policies`: lectura pública, escritura solo desde el backend.

### El bot actual y su reemplazo

El BudgetAgent actual no se modifica: `budget.node.js` queda fuera del alcance de esta fase y se elimina cuando se reemplace por el agente nuevo. No se implementa un adaptador para el modelo nuevo. El agente nuevo tendrá su propia especificación y su puesta en producción se coordina con la entrega 6 del catálogo; no hay deploys intermedios de esta rama.

## Cambios en el frontend

La tienda muestra un producto por modelo con un selector de variantes, y el carrito y el checkout trabajan con variantes.

### Tienda

- **Listado:** una tarjeta por producto, con "desde" + `priceFrom` y las muestras de color disponibles. Filtro por categoría, generado desde `categories`.
- **Detalle:** ruta `/store/<slug>`, con slug único. Si no existe, está inactivo, su categoría está inactiva o no tiene variantes activas, muestra "Este producto ya no está disponible" y un acceso al catálogo. Los enlaces viejos no se convierten de ID a slug. Un selector por cada eje de `optionNames`, en ese orden: las opciones dependen de los ejes anteriores y cambiar un eje limpia los posteriores. Al elegir, se actualizan precio, stock e imágenes de esa variante. Las combinaciones sin stock se muestran deshabilitadas.
- **Empaques:** se listan los de `packagingOptions` del producto más el estándar sin costo. Ningún empaque escrito en el código.
- **Personalización:** se carga en el detalle antes de agregar al carrito. El campo "¿Qué querés que diga?" respeta `customization.maxChars` contando caracteres Unicode como el servidor y solo aparece si el producto admite texto. El texto vacío queda con `customizationPending` si admite texto. Las indicaciones para enviar imágenes por WhatsApp solo aparecen si admite imágenes.

### Carrito y checkout

- Cada ítem del carrito guarda `productId` + `variantId`. Su identidad es producto + variante + empaque + texto (sin espacios extremos): dos textos diferentes son dos líneas; el mismo texto y las mismas opciones suman cantidad. El mismo producto con dos variantes distintas son dos ítems.
- Cada línea muestra su texto y permite editarlo o quitarlo. Editar puede fusionar líneas coincidentes, respetando el límite de cantidad por línea y el stock acumulado de la variante entre todos los textos y empaques. Quitar el texto vuelve a dejarlo pendiente si el producto admite texto.
- El checkout muestra la personalización ya guardada y no vuelve a pedirla. Revisa el catálogo antes de confirmar: si actualiza precios pide revisar el resumen y confirmar nuevamente. Esta lectura pública usa la caché del catálogo y es informativa; el servidor vuelve a validar stock fresco sin reservar al crear el pedido. Los errores 400 conservan el carrito y los textos para corregirlos.
- El payload del checkout envía `productId`, `variantId`, `quantity`, `packagingType` y personalización. El total que muestra el frontend es solo informativo; el que vale es el que calcula el servidor.
- El carrito guardado usa `schemaVersion: 2`. Los carritos del formato viejo (sin versión o sin `variantId`) y los JSON inválidos se descartan completos con un aviso al cliente, sin intentar deducir variantes. Los totales y las identidades se recalculan al cargar.

### API pública de tienda (entrega 4)

- `GET /catalog/categories`: categorías activas en orden.
- `GET /catalog/products`: `query`, `categoryId`, `onlyAvailable` (false por defecto), `sort`, `page` y `pageSize`; devuelve productos, total y paginación. `pageSize` es 12 por defecto, máximo 100. El controlador usa todos los resultados de `searchProducts` antes de ordenar y paginar: no limita la tienda a los 5 resultados por defecto. `relevance` conserva el orden del servicio; también admite precio ascendente/descendente y nombre ascendente.
- `GET /catalog/products/by-slug/:slug`: detalle público por slug; 404 para enlaces inexistentes, inválidos, ambiguos o productos no disponibles.
- `GET /catalog/products/:id`: detalle por referencia interna para revisar las líneas del carrito. Las URLs de la tienda usan exclusivamente slug.
- Las lecturas pasan por el servicio central y su caché. Estas rutas son públicas y solo de lectura; las escrituras y el checkout mantienen sus protecciones actuales.

### Panel admin

- **Productos:** editor con datos generales, categoría, etiquetas, atributos, ejes de opciones, tabla de variantes (opciones, SKU, precio, stock, activa, imágenes), personalización y empaques.
- **Categorías:** alta, edición, orden y activación.
- **Políticas:** editor de texto por tema.
- **Pedidos:** el detalle muestra `variantLabel` de cada ítem; los pedidos viejos se ven como hoy.

## Pedidos existentes

Los pedidos existentes no se modifican y siguen visibles, pero quedan desvinculados del catálogo: sus productos ya no existen.

- **Antes de borrar los productos,** todo pedido abierto (pendiente, pagado, en preparación, enviado) se entrega o se cancela con el sistema actual, para que el stock quede bien.
- **Mostrar un pedido viejo** usa los datos guardados en el propio pedido (`productName`, `price`), como hoy.
- **Cambiar el estado de un pedido viejo** se permite, pero no toca stock y el panel lo avisa.

El bot, al consultar el estado de un pedido, lo muestra con sus datos guardados, sin consultar el catálogo.

## Criterios de aceptación y pruebas

La fase está terminada cuando todos estos puntos se verifican con salidas que corre el dueño, no con informes del asistente de código.

### Regla de oro

- [ ] Crear desde el panel una categoría nueva y un producto nuevo con dos variantes. Sin tocar código, aparece en la tienda y `searchProducts` lo encuentra por nombre, etiqueta y color.
- [ ] `grep -rniE "termo|billetera|vaso|mate|joyero|neceser|caja|bolsa|envoltorio" src/` no encuentra nombres de productos ni de empaques fuera de comentarios.

### Puesta en marcha

- [ ] No quedan pedidos abiertos antes del borrado.
- [ ] El export de Firestore existe en el bucket y se probó restaurarlo sobre un proyecto de prueba.
- [ ] El script de borrado, en dry-run, lista solo documentos de `products`.

### Pedidos y stock

- [ ] Un pedido nuevo guarda `variantId` y la foto de la variante; cambiar después el precio de la variante no altera el pedido.
- [ ] Pasar un pedido nuevo a pagado descuenta el stock de su variante, y cancelarlo lo restituye.
- [ ] Cambiar el estado de un pedido viejo no toca stock y muestra el aviso.
- [ ] El checkout ignora precios manipulados en el body y rechaza variantes inactivas y empaques que el producto no tiene.
- [ ] Crear un pedido con líneas repetidas que superan el stock devuelve 400 indicando variante y unidades disponibles, sin guardar pedido ni reservar stock.
- [ ] Dos pagos simultáneos por la última unidad dejan un pedido pagado y el otro pendiente; repetir el pago o la cancelación de un mismo pedido mueve stock una sola vez.

### Tienda, panel y bot

- [ ] La tienda muestra un producto por modelo con selector de color, y deshabilita las variantes sin stock.
- [ ] Cada producto ofrece solo sus propios empaques, con sus precios.
- [ ] Un carrito guardado con el formato viejo se descarta con aviso.
- [ ] Dos textos diferentes del mismo producto/variante/empaque crean dos líneas; textos iguales suman cantidad. Editar o quitar texto en carrito conserva el stock acumulado y las banderas pendientes.
- [ ] El checkout muestra los textos de cada línea y crea el pedido con ambos IDs. Un 400 conserva el carrito y su personalización.
- [ ] Los enlaces usan slug único; uno inexistente o inactivo muestra el aviso y el acceso al catálogo.

### Cómo se prueban

- Los tests nuevos van en `test/`, con sus propios datos (prefijo `test-`), limpieza en `finally` y la protección `ALLOW_PROD_FIRESTORE_TESTS`.
- En la entrega 1, búsqueda, validación y caché se prueban en memoria sin cargar Firebase. Los tests de CRUD y API usan el emulador si está configurado; sin emulador requieren `ALLOW_PROD_FIRESTORE_TESTS=1` antes de importar el SDK o la configuración. Registran únicamente IDs de su propia ejecución y limpian en `finally`, sin barridos generales. El caso de consulta parcial usa datos ficticios en `test/`, sin leer esta especificación en tiempo de ejecución.
- Los tres tests de catálogo en memoria están incluidos en `npm run test:unit`, junto con los tests preexistentes de ese script. Los de CRUD y API se ejecutan con `npm run test:integration`, que establece `ALLOW_PROD_FIRESTORE_TESTS=1`. Los tests preexistentes de `test:unit` conservan sus protecciones y pueden acceder a Firestore.
- Entrega 2: `test_order_variant_pricing.js` y `test_order_variant_stock.js` se agregan a `test:unit` y usan memoria, sin Firebase. `test_order_variant_orders.js` y `test_order_variant_transactions.js` se agregan a `test:integration`: guardia antes de cargar Firebase, datos ficticios `test-` por ejecución y limpieza en `finally`. Prueban persistencia/API, snapshots y concurrencia real de Firestore; no envían WhatsApp, no invocan LLM ni modifican `counters/orderNumber`. La API usa los middlewares y el controlador reales, con IDs/números de test asignados por un doble del servidor y entrega PDF simulada.
- Los scripts de migración se prueban primero contra un proyecto de Firebase de prueba o el emulador, nunca directo en producción.

## Fuera de alcance

Esta fase no toca el comportamiento conversacional del bot. Quedan para fases siguientes:

- El agente conversacional nuevo, sus herramientas y su prompt.
- La búsqueda semántica con embeddings (se agrega cuando el catálogo pase de unos cientos de productos, sin cambiar la firma de `searchProducts`).
- Descuentos, cupones y precios por cantidad.
- Reemplazar y eliminar el BudgetAgent actual, dentro de la especificación del agente nuevo y antes de la puesta en producción conjunta.

## Reglas de trabajo para la implementación

La fase se implementa en entregas chicas, una por vez, y cada una se aprueba antes de empezar la siguiente.

Se conservan los números de las entregas restantes para mantener las referencias existentes.

- **Entrega 1:** servicio de catálogo, validaciones del modelo y CRUD de `categories` y `policies`.
- **Entrega 2:** precios y stock por variante.
- **Entrega 4:** tienda: listado, detalle, carrito y checkout.
- **Entrega 4b-1:** backend de perfil, direcciones y registros fiscales con
  predeterminados; pedidos propios con procedencia de teléfono; modalidad de
  envío, cédula condicional, RUC SET y confirmaciones; fotos de envío/facturación
  en pedidos y PDF; fixtures y tests en emulador. Los históricos sin origen
  explícito se excluyen, incluidos los web, hasta una revisión posterior.
- **Entrega 4b-2:** pantallas Angular de checkout, Mi perfil y pedidos propios;
  aviso fiscal/copiar razón social y RUC en el detalle administrativo. Guardar
  dirección viene marcado si no hay ninguna guardada y desmarcado si ya hay.
- **Entrega 5a:** entorno local con Firestore Emulator, fixtures ficticias, sesión local con secreto JWT propio y configuración Angular `emulator`; CRUD nuevo de productos en backend, unicidad de SKU/slug transaccional y endpoint de imágenes con subida firmada. Tests de regresión de `/auth/request`, `/auth/verify`, `/auth/session` y `/auth/logout`.
- **Entrega 5b:** panel Angular: productos, categorías y políticas; conservación del borrador ante 409 y uso del endpoint de imágenes del backend. Eliminar servicios y modelos viejos que queden sin consumidores.
- **Entrega 6:** puesta en marcha junto con el agente conversacional nuevo, que tiene su propia especificación: backup, borrado de productos viejos, deploy conjunto de backend/frontend/agente, carga manual y verificación.
  - Hasta entonces, nada de esta rama se deploya. El BudgetAgent actual no se modifica y se elimina cuando se reemplace.
  - Eliminar la compatibilidad temporal con productos del modelo viejo en pricing y en la consulta de SKU raíz antes del deploy conjunto. Mantener el manejo de pedidos históricos sin `variantId`, con aviso y sin movimientos de stock.
  - Configurar el índice de pedidos propios descrito en `firestore.indexes.json`.

En cada entrega:

- **Primero un plan, después el código.** El asistente presenta qué archivos toca y espera aprobación.
- **Nada fuera del alcance de la entrega.**
- **Los resultados los corre el dueño:** tests, `git diff --stat` y las verificaciones de cada criterio. Si el asistente no tiene una salida textual de la consola, dice "no tengo la salida" en lugar de reconstruirla.
- **Nada de datos del negocio inventados:** productos, precios, empaques y políticas salen de Firestore o de este documento.
- **`docs/CONTEXT.md` se actualiza** con cada decisión de arquitectura, en la misma entrega.
