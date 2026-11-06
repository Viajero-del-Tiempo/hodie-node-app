# HoDie WhatsApp Integration Service 🚀

Este servicio es el backend encargado de la integración entre la plataforma web de **HoDie Tienda de Regalos** y la mensajería de **WhatsApp**. Sus funciones principales son gestionar el inicio de sesión sin contraseña (passwordless) mediante códigos OTP (One-Time Password) y procesar los pedidos de los clientes, enviándoles un comprobante en PDF de alta calidad y actualizando el estado de sus compras directamente a sus chats de WhatsApp.

---

## ✨ Características Principales

1. **Autenticación Passwordless (OTP):** Generación de códigos numéricos de verificación de 6 dígitos que se envían por WhatsApp para validar la identidad del usuario sin requerir contraseñas.
2. **Generación de Comprobantes PDF:** Conversión automática de los detalles de un pedido en un PDF con diseño premium (incorporando logo de la marca, tipografía Poppins, imágenes de productos y detalles bancarios).
3. **Notificaciones de Estado de Pedidos:** Envío de mensajes automáticos que alertan al cliente sobre cambios de estado en su compra (Pendiente, Pagado, En preparación, Enviado, Entregado, Cancelado).
4. **Chatbot de Auto-respuesta:** Menú básico de respuestas automáticas a palabras clave frecuentes enviadas por los usuarios (como "hola", "precios", "ubicacion", "catalogo").

---

## ⚙️ Stack Tecnológico

* **Core:** Node.js (ES Modules)
* **Framework Web:** Express (v5.1.0)
* **Integración WhatsApp:** whatsapp-web.js (v1.34.4)
* **Generación de PDF:** PDFKit (v0.17.2)
* **Navegador Emulado:** Puppeteer (para la ejecución interna de WhatsApp Web)
* **Seguridad:** JSON Web Token (JWT) y políticas de Rate Limit en memoria

---

## 📂 Arquitectura y Estructura del Proyecto

El código está estructurado en una arquitectura limpia de capas:

```text
hodie-wa-app/
├── assets/                  # Recursos estáticos (Logos, imágenes y fuentes del PDF)
│   ├── banco.png            # Infografía con datos bancarios
│   ├── logo.png             # Logo oficial de HoDie
│   └── fonts/               # Tipografía Poppins para el PDF
├── src/
│   ├── app.js               # Configuración de Express, CORS y Middlewares
│   ├── config/              # Configuraciones globales
│   │   ├── auth.js          # Parámetros del ciclo de vida del OTP y límites de peticiones
│   │   ├── jwt.js           # Clave secreta y vigencia del JWT
│   │   └── whatsapp.js      # Inicialización del cliente de WhatsApp y chatbot
│   ├── controllers/         # Controladores (Lógica de negocio de endpoints)
│   │   ├── auth.controller.js
│   │   └── order.controller.js
│   ├── routes/              # Enrutadores
│   │   ├── auth.routes.js
│   │   └── order.routes.js
│   └── services/            # Servicios de soporte técnico e infraestructura
│       ├── image.service.js # Descarga de imágenes externas
│       ├── pdf.service.js   # Renderizado de PDF
│       └── whatsapp.service.js # Funciones de envío de mensajes en WhatsApp
├── server.js                # Inicializador del servidor y WhatsApp Web
└── package.json             # Dependencias y scripts
```

---

## 🔁 Flujos de Trabajo Principales

### 1. Autenticación Passwordless

El flujo describe cómo un usuario solicita el inicio de sesión y recibe un token JWT firmado tras validar el código enviado a su WhatsApp.

```mermaid
sequenceDiagram
    participant WebApp as Aplicación Angular / Web
    participant API as Express API (Backend)
    participant WA as WhatsApp Web API
    participant User as WhatsApp del Usuario

    WebApp->>API: POST /auth/request { phone }
    Note over API: Valida Rate Limit (max 5 peticiones/hora)
    API->>API: Genera código OTP (6 dígitos)
    API->>WA: Envia código OTP por chat
    WA->>User: "Tu código de verificación es: XXXXXX"
    API-->>WebApp: 200 OK (Código Enviado)
    
    Note over WebApp: Usuario introduce el código recibido
    WebApp->>API: POST /auth/verify { phone, code }
    alt Código Válido y No Expirado (menos de 5 min)
        API->>API: Firma JWT Token
        API-->>WebApp: 200 OK { token }
    else Código Inválido / Expirado
        API->>WA: Envia mensaje de error
        WA->>User: "❌ Código inválido o expirado"
        API-->>WebApp: 400 Bad Request
    end
```

### 2. Procesamiento de Pedido y Envío de PDF

El flujo detalla la recepción de una compra, la descarga de imágenes del producto, el renderizado del PDF con PDFKit y su envío final por chat.

```mermaid
sequenceDiagram
    participant WebApp as Aplicación Angular / Web
    participant API as Express API (Backend)
    participant ImageService as Image Service
    participant PDFKit as PDFKit Generator
    participant WA as WhatsApp Web API
    participant User as WhatsApp del Usuario

    WebApp->>API: POST /orders/order/send { orderDetails }
    Note over API: Valida estructura y campos requeridos
    API->>ImageService: Descarga imágenes de productos
    ImageService-->>API: Imagenes en Buffer
    API->>PDFKit: Genera PDF estructurado (Poppins, Logo, Items, Datos Banco)
    PDFKit-->>API: Archivo temp/pedido-XXXX.pdf
    API->>WA: Envia PDF codificado en Base64
    WA->>User: Adjunto de PDF recibido 📄
    API-->>WebApp: 200 OK { success, file }
    Note over API: Ejecuta setTimeout (30s) para borrar PDF del disco
```

---

## 📡 Endpoints del API

### Rutas de Autenticación (`/auth`)

#### 1. Solicitar Código OTP
* **Ruta:** `POST /auth/request`
* **Cuerpo:**
```json
{
  "phone": "595981234567"
}
```
* **Respuesta (Exitosa):**
```json
{
  "success": true,
  "message": "Código enviado por WhatsApp"
}
```

#### 2. Verificar Código OTP
* **Ruta:** `POST /auth/verify`
* **Cuerpo:**
```json
{
  "phone": "595981234567",
  "code": "123456"
}
```
* **Respuesta (Exitosa):**
```json
{
  "success": true,
  "message": "Usuario verificado correctamente",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### 3. Verificar Sesión
* **Ruta:** `POST /auth/session`
* **Cabecera:** `Authorization: Bearer <TOKEN>`
* **Respuesta (Exitosa):**
```json
{
  "success": true,
  "message": "Sesión válida",
  "phone": "595981234567"
}
```

#### 4. Cerrar Sesión
* **Ruta:** `POST /auth/logout`
* **Cabecera:** `Authorization: Bearer <TOKEN>`
* **Respuesta (Exitosa):**
```json
{
  "success": true,
  "message": "Sesión cerrada correctamente"
}
```

---

### Rutas de Pedidos (`/orders`)

#### 1. Procesar y Enviar Pedido
* **Ruta:** `POST /orders/order/send`
* **Cuerpo:**
```json
{
  "id": "ord-abc123xyz",
  "orderNumber": "10024",
  "userId": "usr-987",
  "userDisplayName": "Juan Pérez",
  "userPhoneNumber": "595981234567",
  "items": [
    {
      "productName": "Taza Personalizada",
      "productSku": "TAZ-001",
      "quantity": 2,
      "price": 45000,
      "imageUrl": "https://url-de-la-imagen-del-producto.com/taza.jpg",
      "selectedPackaging": {
        "name": "Caja de Regalo de Lujo",
        "price": 10000,
        "imageUrl": "https://url-de-la-imagen-del-paquete.com/caja.jpg"
      }
    }
  ],
  "shippingAddress": {
    "city": "Minga Guazú",
    "department": "Alto Paraná",
    "street": "Calle Palma 123",
    "instructions": "Entregar en portón negro"
  },
  "subtotal": 110000,
  "total": 110000,
  "createdAt": {
    "seconds": 1718889900
  }
}
```
* **Respuesta (Exitosa):**
```json
{
  "success": true,
  "message": "Pedido 10024 procesado y enviado al cliente.",
  "file": "/ruta/absoluta/a/temp/pedido-10024.pdf"
}
```

#### 2. Actualizar Estado de Pedido
* **Ruta:** `POST /orders/order/status`
* **Cuerpo:**
```json
{
  "phone": "595981234567",
  "status": "preparing",
  "amount": 110000
}
```
* **Estados Permitidos (`status`):**
    * `pending`: Recibido con éxito, a la espera del comprobante de pago.
    * `paid`: Pago confirmado.
    * `preparing`: En proceso de empaque o fabricación.
    * `shipped`: Pedido enviado a través de la transportadora.
    * `delivered`: Compra entregada y finalizada con éxito.
    * `cancelled`: Compra anulada.

---

## 🛠️ Instalación y Configuración Local

### Requisitos Previos

1. **Node.js** (Versión 18 o superior recomendada).
2. **Dependencias del Navegador:** Dado que `whatsapp-web.js` ejecuta Puppeteer, tu sistema operativo debe tener instaladas las bibliotecas nativas necesarias para ejecutar Chromium sin interfaz gráfica.
   * **En Linux (Ubuntu/Debian):**
     ```bash
     sudo apt install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget libgbm-dev
     ```

### Configuración del Entorno

Crea un archivo `.env` en la raíz del proyecto basándote en la siguiente estructura:

```env
PORT=3000
JWT_SECRET=tu_clave_secreta_super_segura
```

### Pasos de Ejecución

1. Instala las dependencias del proyecto:
   ```bash
   npm install
   ```
2. Ejecuta el servidor en modo desarrollo:
   ```bash
   npm run dev
   ```
3. **Escaneo del Código QR:**
   Al arrancar por primera vez, el servidor imprimirá un código QR en la terminal. Escanéalo usando la aplicación móvil de WhatsApp (Sección *Dispositivos Vinculados*).
   Una vez emparejado, se creará la carpeta `./sessions/` para mantener activa la sesión y no requerir el escaneo en futuros reinicios.

---

## 🚀 Despliegue en VM de Producción

[`ecosystem.config.cjs`](ecosystem.config.cjs) declara la aplicación **hodie-backend**,
con `server.js`, directorio de trabajo del repositorio, `kill_timeout: 15000` y
`time: true`. No contiene secretos ni `max_memory_restart`. Las variables siguen
en `.env`, que no se versiona. No se modifica `.env`, `sessions/` ni `.wwebjs_auth/`.

### Primer despliegue con el ecosystem

El proceso existente usa la configuración vieja. **Solo la primera vez**, desde
la VM y con el usuario que administra PM2, eliminar su registro antes del deploy:

```bash
cd ~/hodie-node-app
pm2 delete hodie-backend
bash deploy.sh
```

`pm2 delete` retira el proceso de PM2; no ejecutar `logout`, borrar sesiones ni
eliminar credenciales. Esta migración se prepara para la puesta en marcha
aprobada; agregar los archivos no ejecuta el despliegue.

Para despliegues posteriores:

```bash
cd ~/hodie-node-app
bash deploy.sh
```

[`deploy.sh`](deploy.sh) conserva `npm ci`, la instalación de Chrome con Puppeteer
y la comprobación de `cleanMediaOptions` del parche de whatsapp-web.js. Luego:

```bash
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
pm2 logs hodie-backend --lines 15 --nostream
```

Finalmente espera **hasta 60 segundos** un evento JSON `WHATSAPP_READY` del
proceso actual, posterior al inicio de este deploy. Ese evento incluye PID,
identificador de arranque y modo efectivo del agente: `enabled`,
`maintenanceMode`, `allowlistDefined` y `allowlistCount`, sin teléfonos.
Una lista ausente se informa como `null` (sin restricción); vacía como `0`.
Con el agente apagado, la lista se ignora y se informa `null`.

La verificación consulta metadatos de PM2 sin volcarlos al log y lee el stdout
actual y sus rotaciones recientes sin comprimir. No acepta un `WhatsApp listo`
viejo, de otro PID, sin modo del agente o de un proceso que ya fue reemplazado.
Si no encuentra el evento, termina con código 1: `set -e` propaga el error al
workflow de GitHub. No hace rollback ni borra sesiones; revisar los logs y el
estado de conexión. PM2 debe soportar archivos `ecosystem.config.cjs`.

### Apagado y plazo de PM2

SIGINT y SIGTERM se atienden tanto con agente nuevo como con legacy, incluso
durante el arranque antes de ready. Se detiene la admisión, se cierra el
guardián y se suspenden/cierran trabajadores, limpieza de comprobantes, HTTP
y monitor de memoria. `client.destroy()` se inicia sin esperar a que terminen
los trabajadores, para que un SDK o almacenamiento trabado no lo impida. Si
WhatsApp aún se estaba inicializando, se espera su finalización y se vuelve a
cerrar el cliente. HTTP deja de aceptar conexiones y da margen a las solicitudes
en curso dentro del mismo plazo.

El cierre interno tiene un máximo de **14 segundos**, con un segundo de margen
respecto del `kill_timeout` de 15 segundos de PM2. Si todo termina, registra
`SERVER_SHUTDOWN_COMPLETE` y sale 0; un error sale 1. Si algo no termina a
tiempo, registra `SERVER_SHUTDOWN_TIMEOUT` con los componentes pendientes y
sale 1. No se puede prometer que una operación externa trabada haya finalizado;
los leases y las marcas durables conservan la recuperación/revisión aprobadas.
No se llama a `logout` ni se borran archivos de autenticación. PM2 mantiene el
SIGKILL de respaldo si el event loop no puede atender ni el timeout interno.
Ver la [documentación de señales de PM2](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/).

### Rotación de logs

Instalar una vez con el mismo usuario de PM2; no se agrega como dependencia npm
de la aplicación:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 save
```

Se conservan hasta siete archivos rotados además del actual. La rotación se
comprueba periódicamente; `10M` no es un límite instantáneo exacto. Se mantiene
el modo sin compresión por defecto para verificar también un ready que coincida
con una rotación. Ver [pm2-logrotate](https://github.com/keymetrics/pm2-logrotate).

### Verificación local (la ejecuta Arnaldo)

Pruebas con reloj y componentes falsos, sin PM2, WhatsApp ni Firestore reales:

```bash
node --import ./test/firebase-bootstrap.js --test test/test_server_shutdown.js test/test_deploy_readiness.js
npm run test:unit
```

Comprobar en la VM, cuando se autorice desplegar: `pm2 describe hodie-backend`,
evento `DEPLOY_WHATSAPP_READY` y modo esperado sin teléfonos. Un reinicio debe
mostrar `SERVER_SHUTDOWN_COMPLETE` antes del arranque siguiente; revisar cualquier
`SERVER_SHUTDOWN_TIMEOUT` antes de interpretar un PDF/alerta inciertos como enviados.
