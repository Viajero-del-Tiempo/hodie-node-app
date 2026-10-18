# Tests y Firestore: inventario y aislamiento

Inventario estático del código, incluidos servicios invocados y limpieza.
No se consultó producción ni se ejecutaron estas suites para elaborar el informe.
Los números de pedido reportados por Arnaldo no se comprobaron en la base.

## Causa

`test/run-unit.js` añadía `ALLOW_PROD_FIRESTORE_TESTS=1` a ocho procesos. Sus
imports ESM llegaban a `src/config/firebase.js` antes de ejecutar la guarda del
cuerpo de cada archivo. Sin emulador, ese inicializador leía serviceAccountKey.json
o ADC. La bandera autorizaba el riesgo y tampoco protegía el orden de imports.
El helper de integración tenía además un fallback explícito a producción.

## Los ocho archivos

Colecciones indicadas por su nombre real. `langgraph_checkpoints` incluye la
subcolección `checkpoints`; `langgraph_checkpoint_writes` es una colección raíz.
Crear una referencia `.doc()` no equivale a leerla o escribirla.

| Test | Lecturas | Escrituras, incluidas eliminaciones | Limpieza anterior y residuos posibles |
|---|---|---|---|
| `test_budget_agent_v2.js` | Simula `products`, `orders` y transacciones de `counters`. Conservaba un fallback al DB real para colecciones no simuladas. | Las operaciones ejercidas sobre `orders`/`counters` están simuladas; no se prevén escrituras reales en esos casos. Sí inicializaba el singleton productivo. | Restaura mocks en finally; los pedidos simulados viven en un Map. No es una suite que deba inicializar producción aunque use mocks. |
| `test_handoff_alert_transition.js` | `users` para autorización; `handoff_threads`, checkpoints y writes para receptor/reactivación. Desde 7B, `agent_chat_controls` para determinar el motor al reactivar. | `users`, `handoff_threads`, `langgraph_checkpoints/*/checkpoints`, `langgraph_checkpoint_writes`. | Borra el admin temporal `admin-<timestamp>` y el índice. **No borra los checkpoints ni sus writes**. Los fallos de limpieza se silencian. |
| `test_lid_resolution.js` | `lid_phone_map`, `products`, `orders`, `counters/orderNumber`, checkpoints y writes. La selección de producto usa el catálogo existente. | `lid_phone_map`, `orders`, `counters/orderNumber`, checkpoints y writes; borra también documentos de `handoff_threads` en la limpieza. | Borra pedidos cuyos IDs alcanzó a registrar y recorre hilos/checkpoints/writes. El mapa LID se elimina en el cuerpo de algunos casos, no en el finally general: una excepción puede dejarlo. **No restaura el contador**. Si creó un pedido y no llegó a registrar su ID, puede quedar. |
| `test_order_pdf_decoupling.js` | `products`, `users`, `orders`, `counters/orderNumber`; precios del backend y autenticación. | Crea/modifica `products`, `users`, `orders`; incrementa `counters/orderNumber`, también desde la confirmación de BudgetAgent. | Borra IDs registrados y hacía un barrido global de pedidos con prefijo test-, userId test- o producto test-. **Ese barrido podía borrar datos de otras suites**. No restaura el contador. Los errores se capturan como advertencias. |
| `test_order_security.js` | `products`, `users`, `orders`, `counters/orderNumber`. | Crea `products`, `users`, `orders`; la compra web y la del BudgetAgent incrementan `counters/orderNumber`. | Igual riesgo de barrido global por test- y limpieza best effort. El contador queda avanzado aunque quite los pedidos. |
| `test_whatsapp_chat_id.js` | `products`, `orders`, `counters/orderNumber`; `lid_phone_map` al resolver evidencia de identidad de pedidos LID. | `products`, `orders`, `counters/orderNumber`. Los cambios de estado descuentan/restauran variantes de su producto propio. | Borra pedidos registrados y sus dos productos en finally; restaura mocks. **No restaura el contador**. No elimina un pedido cuyo ID no haya llegado a registrar. |
| `test_multi_agent_graph.js` | `products`, `orders`, checkpoints y writes, `handoff_threads` desde el receptor. | Crea los dos pedidos de comparación de fecha; escribe checkpoints/writes e índice de handoff. El LLM está simulado, la persistencia no. | Recorre IDs de pedidos e hilos registrados, subcolecciones, writes e índice. Limpieza best effort; una interrupción forzada puede dejar datos. No hay rollback global. |
| `test_bot_resume_and_filters.js` | `users`, `products`, `orders`, checkpoints/writes e índice. Desde 7B, `agent_chat_controls` al discriminar motor. | `users`, checkpoints/writes, `handoff_threads`. | Borra usuarios e hilos registrados, subcolecciones, writes e índice en finally. Las advertencias no convierten por sí solas la limpieza en fallo; una caída antes/durante finally deja residuos. |

Los servicios de pricing pueden consultar `categories` si se les pasa un producto
v2. Esto es condicional al catálogo seleccionado; las fixtures propias antiguas
son v1. No son escrituras de categorías. Los mocks de sendMessage de estas suites
sustituyen el envoltorio global, por lo que no se presupone que generen registros
en agent_whatsapp_own_messages. Estas observaciones no reemplazan una traza de
ejecución, que no se tiene para este inventario.

Eliminar el pedido no deshace la transacción previa de numeración. Tampoco se
debe retroceder ahora el contador real: podría haber compras legítimas posteriores.
Los huecos por sí solos no permiten atribuir un pedido o avance a un test.

## Guarda única y clasificación nueva

- La regla está en `src/config/firebase-test-environment.js`. Sin
  FIRESTORE_EMULATOR_HOST, toda inicialización Firebase de tests falla antes
  de credenciales. Host loopback con puerto válido; proyecto coherente demo-*.
  ALLOW_PROD_FIRESTORE_TESTS ya no habilita nada.
- `test/firebase-bootstrap.js` se carga con --import antes de los imports ESM.
  Vigila SDK/configuración y bloquea cert(), ADC y opciones con credential o
  projectId real. Los ocho archivos también importan este punto común para
  ejecuciones directas. No se copian guardas por archivo.
- `src/config/firebase.js` comprueba también contexto/ruta de tests antes de
  buscar credenciales, protegiendo el acceso directo al singleton. El helper
  catalog-firestore usa la misma regla y ya no tiene fallback a producción.
- Las suites puras de `test:unit` siguen sin necesitar emulador: no inicializan
  Firebase. Una dependencia nueva que intente hacerlo falla antes del SDK.
- Los dos tests con fixtures propias de pedidos, `test_order_security.js` y
  `test_whatsapp_chat_id.js`, pasan a integración con emulador. Se conservan
  sus aserciones. El barrido de seguridad solo reconoce IDs/usuarios/productos
  creados por esa misma ejecución, no cualquier prefijo test-.
- Los otros seis pasan a `test:legacy`: importan el grafo/nodos viejos y varios
  dependen de catálogo v1, diálogos legacy y Gemini. No se reescriben para el
  agente nuevo. Se conservan todas las comprobaciones y se suministra un catálogo
  v1 ficticio en test/fixtures/legacy-products.json. Algunos usan Gemini real.
- Cada suite antigua tiene un proyecto demo-hodie-test-<aleatorio> distinto.
  El runner limpia **solo ese proyecto del emulador** en finally; nunca limpia
  el demo compartido de la tienda ni producción. El contador de cada proyecto
  aislado desaparece con él. Se usan JWT y datos bancarios ficticios.
- Todos los scripts npm de tests usan el preload o un runner que lo instala.
  También se quitaron las autorizaciones antiguas del smoke LLM y de los dos
  evaluadores legacy JS. conversations.yaml y el código del agente no cambian.

## Inventario productivo de solo lectura

`scripts/list-test-orders.js` es una herramienta administrativa independiente,
no un test. No se ejecutó. Usa la credencial explícita y verifica que su proyecto
coincida con --project (por defecto hodie-tienda-de-regalos). Se niega a arrancar
con contexto de test o FIRESTORE_EMULATOR_HOST.

Solo expone get/where/orderBy/limit y referencias sin métodos de escritura al
lector. No hay set, create, update, delete, batch ni transacciones en su interfaz.
No descarga medios ni carga agentes/WhatsApp. Su salida JSONL contiene rutas,
número/estado/fechas, userId y motivos de coincidencia; no imprime documentos
completos, claves privadas, direcciones, textos de chats ni datos bancarios.

Sin argumentos busca el teléfono de prueba 595981646055, con formatos históricos
compatibles, y sigue referencias a chats, usuarios y productos. Consulta también
los checkpoints aunque su documento padre no exista. --marker agrega barridos
por prefijo en IDs/campos; --from/--to agrega candidatos por fechas de creación,
actualización, guardado o recepción. Los selectores se combinan por OR y las
fechas usan [from,to), con zona horaria explícita. Un documento legítimo dentro
del rango es un candidato para revisar, no prueba de que sea un test.

Los barridos, consultas y referencias están limitados (1000 por defecto,
--limit hasta 10000). Si alcanzan el límite, summary.complete=false, se informa
qué consultas quedaron truncadas y el proceso termina con código 2. También
informa las consultas fallidas (por permisos o índices, por ejemplo), conserva
el listado parcial y lo marca incompleto. Los checkpoints de chats conocidos
se leen por su ruta de subcolección, sin exigir índices de grupo adicionales. Incluso
sin truncamiento, no es posible recuperar documentos ya borrados ni resolver
todo historial solo por teléfono si no hay referencias consultables; usar
marcas/fechas para ampliar el inventario. El contador se muestra sin modificar
ni atribuir sus avances a pruebas.

## Comandos para Arnaldo

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run test:unit
```

En otra terminal levantar el entorno existente:

```bash
npm run catalog:local
```

Integración, incluidos los dos archivos de pedidos trasladados:

```bash
npm run test:integration
# Solo esos dos, siempre aislados en el emulador:
npm run test:integration -- --legacy-orders-only
```

Los seis restantes, con el emulador levantado (los que llaman Gemini requieren
su clave; el launcher solo toma claves/modelo Gemini de .env):

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-hodie-catalogo npm run test:legacy
```

Para correr solo las nuevas pruebas de aislamiento/inventario:

```bash
node --import ./test/firebase-bootstrap.js --test test/test_firestore_safety.js
```

Estas pruebas arrancan procesos **sin emulador** para comprobar el rechazo, y
con un host local inválido para comprobar el rechazo de cert/ADC antes de crear
apps. No hacen lecturas productivas ni necesitan el archivo de credenciales.

Inventario real, a ejecutar por Arnaldo, sin iniciar tests. Eliminar las variables
de emulador solo para este comando, no de la configuración de las suites:

```bash
env -u FIRESTORE_EMULATOR_HOST -u HODIE_TEST_MODE node scripts/list-test-orders.js --phone 595981646055
env -u FIRESTORE_EMULATOR_HOST -u HODIE_TEST_MODE node scripts/list-test-orders.js --marker test- --limit 1000
env -u FIRESTORE_EMULATOR_HOST -u HODIE_TEST_MODE node scripts/list-test-orders.js --from 2026-10-18T00:00:00-03:00 --to 2026-10-19T00:00:00-03:00 --limit 1000
```

Las fechas son un ejemplo a ajustar a la corrida investigada. Se puede acotar
con --collection orders o indicar --service-account /ruta/credencial.json.
No hay comando de borrado productivo ni modo que escriba cambios.

## Archivos

```text
src/config/firebase-test-environment.js         nuevo, regla común
test/firebase-bootstrap.js                     nuevo, preload
test/emulator-suite.js                         nuevo, aislamiento por proyecto
test/run-legacy.js                             nuevo, seis suites
test/legacy-bootstrap.js                       nuevo, catálogo v1 ficticio
test/fixtures/legacy-products.json              nuevo
test/test_firestore_safety.js                   nuevo, guardas y solo lectura
scripts/list-test-orders.js                    nuevo, CLI productiva solo lectura
scripts/lib/test-order-inventory.js             nuevo, consultas e interfaz limitada
docs/AUDITORIA-tests-firestore.md               nuevo, este inventario
src/config/firebase.js                         guarda de inicialización
test/helpers/catalog-firestore.js              sin fallback productivo
test/run-unit.js                               solo memoria, continúa todas las suites
scripts/test-catalog-emulator.js                integración aislada
package.json                                   scripts sin autorización productiva
test/test_budget_agent_v2.js                    import común
test/test_handoff_alert_transition.js           import común
test/test_lid_resolution.js                     import común
test/test_order_pdf_decoupling.js               import común, limpieza acotada
test/test_order_security.js                     import común, limpieza acotada
test/test_whatsapp_chat_id.js                   import común
test/test_multi_agent_graph.js                  import común
test/test_bot_resume_and_filters.js             import común
test/test_llm_smoke.js                          import común
test/eval_conversations.js                      import común
test/eval_hard_cases.js                         import común
docs/CONTEXT.md                                política nueva
docs/SPEC-catalogo.md                          elimina permiso histórico productivo
docs/VERIFICACION-agente-7A.md                  corrige instrucción de suites históricas
```

No se ejecutaron tests, inventario productivo, limpieza productiva, evaluaciones
ni deploy. La revisión de sintaxis no sustituye las suites del dueño.
