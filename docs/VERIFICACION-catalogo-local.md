# Catálogo local — entregas 5a y 4b-1

Este entorno usa exclusivamente el proyecto ficticio `demo-hodie-catalogo`.
Los datos de `test/fixtures/catalog-emulator.json` son ejemplos inventados:
no representan productos, precios ni políticas del negocio.

## Requisitos y arranque

Necesitás las dependencias de ambos repositorios, Firebase CLI en PATH y
Java 21 o posterior en PATH. El script comprueba esos requisitos y que los
puertos 3000, 4000, 4400 y 8080 estén libres.

Terminal 1:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run catalog:local
```

El script levanta Firestore Emulator, carga las fixtures y arranca una API
local. Genera un secreto JWT nuevo en cada ejecución y se niega a arrancar
si coincide con `JWT_SECRET` de `.env` o del entorno heredado. No imprime
el secreto. La aplicación Firebase local no lee certificados de servicio.
Los imports usan `scripts/emulator.env`, sin cargar la configuración real.

También genera `hodie-tienda/src/environments/environment.emulator.ts`
desde la plantilla versionada `hodie-tienda/dev/environment.emulator.ts`.
No modifica `environment.ts` ni `environment.development.ts`.

Terminal 2:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-tienda
npm start -- --configuration emulator
```

- Tienda: http://localhost:4200
- API: http://localhost:3000
- Interfaz de Firestore: http://localhost:4000
- Detalle de ejemplo: http://localhost:4200/store/test-local-product-alpha

El backend usa `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` y
`GCLOUD_PROJECT=demo-hodie-catalogo`. Angular apunta su API al puerto
3000 y conecta su SDK al mismo emulador/proyecto.

Ctrl+C en la terminal 1 detiene los procesos locales. El emulador es
efímero: un nuevo arranque comienza otra vez con las fixtures. La carga
inicial no sobrescribe documentos que ya existan dentro de una sesión.
Las imágenes subidas se guardan en una carpeta temporal de esa ejecución
y se eliminan al cerrar la API.

## Sesión y alcance de esta API

Podés usar el login habitual de la tienda con el número ficticio
`0900000001`: el código OTP aparece en la terminal 1, sin enviar WhatsApp.
El script también imprime un JWT del administrador ficticio válido por
una hora, útil para llamadas HTTP manuales. Se verifica la firma y se
consulta el rol real de ese usuario en el Firestore del emulador.

La API local monta las rutas reales de catálogo, productos, categorías,
políticas, imágenes, sesión y perfil. No inicia WhatsApp ni el grafo.
Desde 4b-1 también monta checkout, pedidos propios y lectura administrativa
de pedidos. Las pantallas nuevas de perfil/checkout corresponden a 4b-2;
el contrato backend y sus comandos están en `VERIFICACION-perfil-backend.md`.
El editor nuevo
de Angular y el uso del endpoint de imágenes corresponden a la entrega 5b;
el panel viejo todavía envía un formato que el CRUD nuevo rechaza.

## Contrato del CRUD de productos

`GET /admin/products` lista documentos de versión 2, activos e inactivos,
con todas sus variantes. `GET /admin/products/:id` devuelve el documento
completo y un campo de transporte `version`. Este campo no se guarda en
Firestore ni debe interpretarlo el frontend.

- POST crea un producto completo del esquema nuevo; el servidor asigna
  IDs. No se mandan IDs para las variantes nuevas.
- PUT reemplaza los campos editables del producto completo. PATCH combina
  campos de primer nivel; un arreglo enviado reemplaza ese arreglo.
- PUT/PATCH exige `version` y conserva todos los IDs de variantes existentes.
- DELETE desactiva el producto y exige body `{ "version": "..." }`.
- PATCH `/admin/products/:id/reactivate` lo reactiva, con el mismo body.
- `?force=true` se rechaza; no existe borrado físico de productos.

Los campos derivados `skus` y `priceFrom`, ID de producto y timestamps
son responsabilidad del servidor. SKU y slug se comprueban directamente
en la misma transacción que guarda producto y `counters/catalogWrites`.
El SKU de una variante inactiva y el slug de un producto inactivo siguen
ocupados. Los documentos viejos no se convierten desde esta API.

Un formulario desactualizado recibe 409 con:

```json
{
  "field": "version",
  "code": "CATALOG_VERSION_CONFLICT",
  "error": "Descripción de los campos que cambiaron; el borrador no se guardó.",
  "changes": [
    { "field": "variants[0].stock", "variantId": "...", "sku": "...", "previous": 8, "current": 6 }
  ]
}
```

El mensaje identifica stock anterior/actual o cambios en nombre, precio,
opciones, personalización y otros grupos. No atribuye una causa que no
conste en el documento. El servidor no escribe nada ante ese conflicto;
en 5b el editor conserva su borrador y ofrece revisar la versión actual.

## Imágenes

`POST /admin/images` requiere JWT y usuario administrador. Recibe JSON:
`{ "base64": "...", "mimetype": "image/png" }` y responde 201 con
`{ "success": true, "imageUrl": "..." }`.

Admite JPG, PNG y WEBP, comprueba base64, firma del formato y máximo de
10 MB. Los errores indican `field`. En el entorno local guarda el archivo
temporalmente; en producción el backend firma y realiza la subida a
Cloudinary. No devuelve el secreto ni utiliza un preset sin firma.

Variables del backend para producción: `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` y opcionalmente
`CLOUDINARY_CATALOG_FOLDER`. La carpeta y el contrato de subida de
personalización se conservan.

## Verificación manual de la 5a

1. Abrí el catálogo y los detalles de ambas fixtures: precios, opciones,
   variante agotada deshabilitada y empaques propios.
2. Usá el JWT local en un cliente HTTP para crear/editar un producto con
   las APIs anteriores. Revisá el documento en la interfaz del emulador.
3. Duplicá SKU o slug: debe devolver 400 con el campo correspondiente.
   Repetí contra una variante/producto inactivo.
4. Guardá un GET, editá ese producto mediante otro GET/PUT y después
   mandá el primer documento: debe responder 409 indicando qué cambió.
5. Para simular un descuento, modificá únicamente el stock de una
   variante desde la interfaz del emulador y enviá el borrador anterior:
   debe indicar las unidades anteriores y actuales, sin restaurarlas.
6. Intentá retirar una variante guardada: debe rechazarse. Desactivala
   y comprobá que conserva ID y SKU.
7. Probá una subida válida e inválida a `/admin/images`. La válida devuelve
   una URL local; las inválidas no generan archivo.
8. Quitá el rol admin del usuario ficticio desde el emulador: el mismo
   token debe dejar de tener acceso administrativo.

## Tests y build a cargo del dueño

Pruebas nuevas en memoria, sin Firestore ni WhatsApp:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run test:catalog:unit
```

Integración con el emulador de la terminal 1 todavía encendido:

```bash
npm run test:integration:emulator
```

Este comando fija el proyecto demo y ejecuta las suites con sus propios
IDs `test-`, incluidos sus controles transaccionales. Limpian solo sus
documentos en `finally`; no borran las fixtures manuales. No necesita
`ALLOW_PROD_FIRESTORE_TESTS`.

Frontend:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-tienda
npm test -- --watch=false --browsers=ChromeHeadless
npm run build -- --configuration emulator
```

La suite habitual `test:unit` del backend también incluye las pruebas
nuevas y conserva las suites anteriores, algunas con acceso a Firestore.
`test:integration` conserva su opt-in de producción; para esta verificación
local usá `test:integration:emulator`.

El emulador tiene diferencias respecto de producción en concurrencia,
índices y límites. La comprobación final de puesta en marcha sigue
pendiente para la entrega 6. Nada de esta rama se deploya todavía.
