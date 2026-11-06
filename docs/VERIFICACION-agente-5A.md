# Entrega 5A: derivación, escalada y cantidad corporativa

El agente nuevo permanece desconectado de WhatsApp/router productivos. Este
documento describe comandos para el dueño; no registra resultados de pruebas.

## Configuración y pruebas locales

En una terminal, desde hodie-node-app:

```bash
npm run catalog:local
```

Levanta el proyecto demo local, Firestore, API y administrador ficticio con
secreto JWT propio. El umbral ficticio viene de test/fixtures/agent-config.json;
solo se crea la configuración si no existe, sin sobrescribir cambios manuales.
La configuración productiva se carga desde el panel antes de la puesta en marcha.

En otra terminal:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-node-app
npm run test:agent:support:unit
npm run test:agent:unit
npm run test:agent:purchase:unit
npm run test:guardian:unit
npm run test:eval:unit
npm run test:customer:unit
npm run test:catalog:unit
node --test test/test_order_variant_pricing.js test/test_order_variant_stock.js
npm run test:agent:support:emulator
npm run test:integration:emulator
```

Los tests de soporte del emulador incluyen configuración/API, autenticación real,
dos guardados con la misma versión, alertas concurrentes/rollback y las
transacciones de pedidos 4B con lectura del umbral/configuración ausente. Usan
documentos aislados test- y limpieza en finally. No habilitan Firestore productivo.

Angular:

```bash
cd /home/arnaldoguerrero/Hodie/hodie-tienda
npm start -- --configuration emulator
```

Desde otra terminal del frontend:

```bash
npm test -- --watch=false --browsers=ChromeHeadless
npm run build
npm run build:prod
```

Con el administrador ficticio, abrir Políticas. Su formulario de configuración
es independiente del editor de temas/títulos/textos. Recorrer:

- Cargar y guardar un umbral positivo; recargar y comprobar su persistencia.
- Rechazar cero/fracciones/negativos junto al campo, conservando lo escrito.
- Abrir dos pestañas, guardar en una y tratar de guardar el borrador de la otra:
  el 409 explica el valor vigente. Recargar conserva el borrador y permite revisar
  antes de volver a guardar; no reintenta automáticamente.
- Editar una política de texto y comprobar que no modifica la configuración.
- Reiniciar el entorno: la semilla no reemplaza el umbral guardado.

El bot no atiende desde este entorno. Las herramientas y el guardián se recorren
con sus pruebas y el runner, sin un receptor WhatsApp nuevo.

## Runner

Casos habilitados por 5A, tres repeticiones y juez real:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases O-03,O-04,H-01,H-03,CQ-01,CQ-02,CQ-03
```

Regresión de consulta/guardián:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases C-01,C-02,C-04,P-01,P-02,P-03,P-04,P-05,POL-01,POL-02,POL-03,POL-04,POL-05,POL-06,POL-07,POL-08,O-01,O-05,H-02,CH-01,CH-02,SEC-01,SEC-02,SEC-03,SEC-04,SEC-05,SEC-06,P-06,S-10,S-11,S-12
```

Regresión 4A/4B:

```bash
npm run test:eval -- --agent real --judge llm --media test/eval/media/guardian-manifest.json --cases P-07,C-03,Q-01,Q-02,Q-03,Q-04,Q-05,M-01,M-02,M-03,M-04,M-05,M-06,F-01,F-02,F-03,F-04,F-05,E-01,E-02,K-01,K-02,K-03,K-04,K-05
```

O-02 queda para 5B: todavía no hay registrar_comprobante ni soporte PDF en el
guardián. El YAML y los checks/umbrales no cambian. metadata.agentConfigFixture
identifica la configuración auxiliar ficticia. context.umbralCorporativo cambia
solo el umbral del caso antes de instalar herramientas y preparar la cotización;
debe ser un entero positivo. Los snapshots guardan la configuración efectiva,
reglas/alertas
en memoria. El stub sigue siendo diagnóstico y no aprueba calidad.

## Contratos

- GET/PUT /admin/agent-config, protegidos por sesión y rol real. Documento único
  agent_config/conversation. PUT acepta solo corporateQuantityThreshold y version
  (null al crear); revisión/timestamp del servidor. La versión opaca refleja el
  umbral y revisión. 400/409 incluyen field; el frontend conserva el borrador.
- Cantidad corporativa = suma total > umbral. Igualar permite seguir. El pricing
  se ejecuta después del control corporativo, aun cuando no haya stock suficiente.
  sigue limitado a 100 por ítem. Una operación rechazada conserva el carrito y
  guarda pendingCorporateRequest por tres días, sin subir imágenes. Invalidar
  lastQuote impide usar una autorización anterior. Una modificación válida limpia
  esa solicitud. Si el umbral aumenta, SOLICITUD_PENDIENTE obliga a aplicar primero
  las líneas solicitadas; no cotiza silenciosamente el carrito anterior.
- Cotizar consulta reglas frescas; crear_pedido las lee en la misma transacción
  antes de escribir. Una repetición de un quoteId ya creado devuelve su pedido,
  conservando la idempotencia y la recuperación de 4B. La regla faltante bloquea
  operaciones nuevas con CONFIGURACION_INCOMPLETA.
- derivar({motivo,texto}) es cierre, incluida la octava llamada. responder cuenta
  entendido:false O fueraDeAlcance:true (opcional, false por defecto), una vez por
  turno. El cuarto deriva por código y sustituye la repregunta por el texto fijo.
  Un cierre normal reinicia la racha; el contador técnico mantiene su política.
  El contexto expone la racha anterior y el umbral corporativo vigente de la
  configuración. El prompt ofrece una persona en el tercer turno sin encauzar,
  también ofrece ante volumen corporativo aunque se consulte por diseño/logo,
  y pide disculpas ante reclamos antes de derivar.
- Alertas: agent_alerts por episodio de chat; order_alerts para PDF existentes.
  El checkpoint guarda la solicitud antes del repositorio. La recuperación
  reintenta persistencia/índice, sin repetir el mensaje ni reiniciar delivered.
  El ID es estable por chat/tipo/episodio. La reactivación no se deshace al recuperar
  un índice del mismo episodio. Contexto: carrito, solicitud corporativa, pedidos
  propios y mensajes, proyectados en un DTO legible con nombres, cantidades,
  personalización confirmada, empaque, envío, facturación y total mostrado. No
  guarda IDs internos, huellas, borradores ni marcas técnicas en ese contexto.
  Si una lectura falla, contextUnavailable queda en los metadatos de la alerta
  sin inventar datos ni impedir la derivación. Nunca envía alertas al equipo.

En la puesta en marcha conjunta: conectar puertos Firestore/checkpointer del agente
nuevo, reactivación y despacho exclusivo desde whatsapp.js. Desplegar el índice
agent_alerts(delivered,createdAt) de firestore.indexes.json; registrar entrega solo
desde ese transporte. El router/BudgetAgent/SupportAgent actuales siguen activos
hasta su reemplazo. No hay deploy de esta rama antes de esa puesta en marcha.

## Archivos de 5A

Rutas relativas a hodie-node-app:

```text
docs/CONTEXT.md
docs/SPEC-agente.md
docs/SPEC-catalogo.md
docs/VERIFICACION-agente-5A.md
firestore.indexes.json
package.json
scripts/local-catalog-server.js
scripts/seed-catalog.js
scripts/test-catalog-emulator.js
src/agents/consultation/agent.js
src/agents/consultation/cart-tools.js
src/agents/consultation/corporate-quantity.js
src/agents/consultation/eval-adapter.js
src/agents/consultation/purchase-tools.js
src/agents/consultation/server-context.js
src/agents/consultation/support-tools.js
src/agents/consultation/technical-failure.js
src/agents/consultation/terminal.js
src/agents/consultation/tool-registry.js
src/agents/guardian/runtime.js
src/agents/prompts/agente.md
src/app.js
src/controllers/admin.agent-config.controller.js
src/routes/admin.agent-config.routes.js
src/services/agent-alert.repository.js
src/services/agent-alert.service.js
src/services/agent-config.repository.js
src/services/agent-config.service.js
src/services/agent-handoff.service.js
src/services/cart.service.js
src/services/order-confirmation.repository.js
src/services/order-confirmation.service.js
src/services/order-quote.service.js
test/eval/README.md
test/eval/initial-state.js
test/eval/memory-world.js
test/eval/run-eval.js
test/fixtures/agent-config.json
test/helpers/agent-memory-firestore.js
test/helpers/customer-firestore.js
test/helpers/guardian-fixtures.js
test/helpers/order-confirmation-memory.js
test/helpers/purchase-fixtures.js
test/run-unit.js
test/test_agent_alerts.js
test/test_agent_config.js
test/test_agent_corporate_quantity.js
test/test_agent_handoff.js
test/test_agent_order_creation.js
test/test_agent_order_transactions.js
test/test_agent_support_runner.js
test/test_agent_support_transactions.js
test/test_consultation_agent.js
test/test_consultation_tools.js
test/test_eval_context.js
test/test_eval_loader.js
```

Rutas relativas a hodie-tienda:

```text
src/app/admin/pages/orders/order-detail/order-detail-component/order-detail-component.html
src/app/admin/pages/orders/order-detail/order-detail-component/order-detail-component.scss
src/app/admin/pages/policies/agent-config-form.component.html
src/app/admin/pages/policies/agent-config-form.component.ts
src/app/admin/pages/policies/policies-page.html
src/app/admin/pages/policies/policies-page.ts
src/app/core/models/admin-catalog.model.ts
src/app/core/services/admin-catalog.service.ts
test/admin-agent-config.spec.ts
test/admin-catalog-pages.spec.ts
test/admin-catalog-service.spec.ts
```
