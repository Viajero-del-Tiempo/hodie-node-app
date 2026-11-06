# Backend de perfil, checkout y facturación — entrega 4b-1

Esta guía describe el backend 4b-1. Las pantallas Angular se conectan al contrato
en 4b-2; su guía está en hodie-tienda/docs/VERIFICACION-perfil-tienda.md.
También se puede verificar el backend mediante HTTP y sus tests, contra el emulador.
Nada se deploya antes de la entrega 6 conjunta con el agente nuevo.

## Arranque y clientes locales

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run catalog:local
```

API `http://localhost:3000`, Firestore UI `http://localhost:4000`.
Se conservan las guardas del proyecto demo y el secreto JWT propio por ejecución.
La API no inicia WhatsApp ni el grafo: genera PDFs reales con entrega local.

- `0900000001`: administrador ficticio existente.
- `0900000002`: dos direcciones, dos registros fiscales, dos pedidos visibles
  (web verificado y web histórico con origen explícito) y dos ocultos (teléfono
  manual del bot e histórico sin origen).
- `0900000003`: sin direcciones, facturación ni pedidos. Su profile_status es
  complete a propósito: la falta de direcciones debe habilitar el formulario.

OTP en esta terminal; cada cliente inicia sesión con `/auth/request` y
`/auth/verify` (campos `phone`, `code`). Podés obtener la sesión con el login
actual de Angular contra `emulator`, o usando un cliente HTTP. El token se
envía como `Authorization: Bearer <token>`. No pegues el secreto de producción.

## Endpoints y contratos

Todas las rutas de cliente requieren sesión válida y usuario activo.

| Método y ruta | Contrato |
| --- | --- |
| GET `/users/me` | `user`, con direcciones/facturación, predeterminados y `version` |
| PUT `/users/me` | `version` + campos editables; responde perfil actualizado |
| POST `/users/me/ruc/validate` | `{ "ruc": "1234567" }`: propuesta, estado y confirmación necesaria; no guarda |
| GET `/orders/shipping-options?city=...` | modalidad, etiqueta, shippingCost=0, requiresRecipientDocument |
| POST `/orders/order/send` | ítems por variante, shippingAddress, billing y flags de guardado |
| GET `/users/me/orders?limit=20&cursor=...` | `orders` resumidos, fechas ISO, `nextCursor` |
| GET `/users/me/orders/:id` | foto pública propia y habilitada; 404 si ajena u oculta |
| GET `/users/me/orders/:id/pdf` | descarga autenticada, mismo filtro y limpieza temporal |

Perfil: campos editables `displayName`, `addresses`, `defaultAddressId`,
`billingProfiles`, `defaultBillingProfileId`. Los demás campos del body se
ignoran. `billingAddress` sigue siendo postal antiguo y no se usa como RUC.
Arreglos enviados reemplazan su propia lista; los omitidos se conservan.
Cada lista admite 30 registros; textos hasta 200 caracteres.

Una dirección nueva va sin `id`; una existente conserva el `id` recibido.
Incluye alias opcional, recipientName (nombre y apellido), street, city,
department y recipientDocument obligatorio solo para transportadora.
Al eliminar la predeterminada se elige la primera restante; sin registros el
predeterminado es null. Para elegir otra, enviá su ID recibido del servidor.
Un registro fiscal nuevo va sin ID, con alias opcional, legalName y ruc.

PUT requiere la `version` del GET. Ante 409, `field=version`,
`code=PROFILE_VERSION_CONFLICT` y `changes` identifican qué cambió. El servidor
no guarda ni modifica el borrador; la UI 4b-2 deberá conservarlo al recargar.

Checkout de ejemplo (tomá productId/variantId y packagingType del catálogo
local: GET `/catalog/products/by-slug/test-local-product-alpha`):

```json
{
  "items": [
    { "productId": "<id del catálogo>", "variantId": "<variante activa con stock>",
      "quantity": 1, "packagingType": null, "customization": "Nombre de prueba" }
  ],
  "shippingAddress": {
    "recipientName": "Destinatario de prueba", "city": "Ciudad Alfa",
    "department": "Departamento Alfa", "street": "Referencia ficticia",
    "recipientDocument": "1234567"
  },
  "billing": { "invoiceRequested": true, "legalName": "Persona de prueba", "ruc": "1234567-9" },
  "saveShippingAddress": true,
  "saveBillingProfile": false
}
```

Sin billing (o invoiceRequested=false): consumidor final y sin datos fiscales.
saveShippingAddress omitido: true sin direcciones; false si hay alguna.
saveBillingProfile omitido: false. No guarda la dirección si se envía false.
Los datos opcionales se agregan al perfil tras guardar el pedido, sin reemplazar
los demás. Si fallan, respuesta de compra exitosa con profileSaved=false y
profileWarning: el pedido existe, no se debe repetir. Guardarlos desde perfil.

### RUC y confirmaciones

Cadena numérica, guion y un DV; distintas longitudes, sin prefijo empresarial
obligatorio. El algoritmo SET publicado por DNIT es módulo 11 con pesos 2..11
desde la derecha y reinicio en 2. Restos 0/1 dan 0; otros dan 11-resto.
[Fuente oficial](https://www.dnit.gov.py/documents/20123/224893/D%C3%ADgito%2BVerificador.pdf/fb9f86c8-245d-9dad-2dc1-ac3b3dc307a7).
No verifica inscripción ni vigencia en un registro fiscal.

- Base `1234567`: propuesta `1234567-9`. Guardar sin confirmación devuelve 400
  RUC_COMPLETION_REQUIRED con suggestedRuc. Después de preguntarle al cliente,
  reenviá el RUC completo aceptado, o mantené la base y agregá
  `confirmedRuc: "1234567-9"`. Una confirmación distinta no sirve.
- `1234567-8`: 400 RUC_DV_MISMATCH. Permite corregir o enviar
  `acknowledgeRucMismatch: true` tras aceptación explícita; guarda el RUC
  ingresado y rucValidation.status=mismatch_confirmed. Nunca cambia el DV.
- Campos fiscales incompletos/formato inválido: 400 con ruta del campo.

El pedido guarda fotos de envío/facturación. Modificar/borrar registros del
perfil no cambia pedidos. El PDF muestra destinatario, cédula si corresponde,
solicitud fiscal/RUC y aviso de discrepancia; aclara que no es una factura.
Históricos sin billing se muestran como datos no registrados.

### Visibilidad de pedidos

El body web no puede elegir origen, teléfono, UID ni verificación. El servidor
guarda origin=web y phoneVerification={verified:true,source:web_session}.
El agente nuevo pasará la evidencia del transporte como opción identity,
fuera de argumentos del LLM. El bot actual sigue intacto: PN/mapa LID permiten
verificar un teléfono coincidente; un teléfono escrito sin evidencia queda
customer_supplied y no habilita la lectura del cliente.

Se muestran pedidos del teléfono autenticado con evidencia verificada y
coherente, o históricos con origin=web explícito y sin phoneVerification.
Por decisión del dueño TODOS los históricos sin origen se excluyen, también
los web. Un histórico del bot sin verificación tampoco se muestra. No hay
inferencia por ID, UID o perfil, ni backfill. La revisión de históricos para
habilitar los que correspondan queda para otra ronda.

Páginas hasta 50 resultados, máximo 500 documentos propios leídos por petición.
Si un bloque contiene solo históricos ocultos puede devolver orders=[] con
nextCursor; seguir el cursor hasta null. Cursor cifrado y ligado al usuario.
No se devuelven chat, evidencia interna ni controles de stock. No hay edición
ni cambio de estado en estas rutas. El índice está en firestore.indexes.json;
se configura en producción en entrega 6, no en esta ronda.

## Tests nuevos a cargo del dueño

Memoria y PDF, sin Firestore, WhatsApp ni LLM:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run test:customer:unit
```

Con `npm run catalog:local` todavía encendido, en otra terminal:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run test:customer:integration
```

Ese comando ejecuta solo las tres integraciones nuevas. Exige proyecto demo y
guardas locales antes del SDK, aunque ALLOW_PROD_FIRESTORE_TESTS=1. Documentos
test- de cada ejecución, limpieza en finally y números de pedido propios; no
usa counters/orderNumber ni borra fixtures manuales.

Para correr toda la integración local, incluyendo catálogo y variantes:

```bash
npm run test:integration:emulator
```

Las cuatro suites nuevas de memoria están también en test:unit; ese script
conserva suites antiguas que pueden acceder a producción. Para revisar solo
esta entrega usá los comandos customer anteriores.

Casos cubiertos: RUC públicos ANDE/COPACO y números ficticios de distintas
longitudes; base confirmada/DV aceptado; dirección/cédula por envío; IDs y
predeterminados; perfil concurrente 200/409; aislamiento y paginación; historial
oculto; checkout completo con ambos IDs y personalización por línea; fotos
inmutables; generación de PDF real y descarga protegida.
