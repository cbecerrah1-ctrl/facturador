# VETEX · Servidor de licencias

Servidor en Azure Static Web Apps que controla las licencias de VETEX.

- **`panel/`**: el panel web donde tú creas, renuevas y bloqueas licencias. Solo entra quien tenga el rol `admin`.
- **`api/`**: las funciones de Azure.
  - `POST /api/licencia`: la llama VETEX para activar o revisar su licencia. Es pública.
  - `POST /api/respaldo`: copias de seguridad cifradas de cada VETEX (subir, listar, bajar). Solo responde a computadores activados con la licencia.
  - `POST /api/dueno`: resumen cifrado para el celular del dueño (VETEX lo sube; el celular lo lee con el código del QR).
  - `/api/gestion/*`: la usa el panel. Solo funciona con el rol `admin`.
- **`panel/dueno/`**: la app del dueño para el celular (se instala como app desde el navegador). Es pública, pero sin el código del QR no muestra nada.
- **`herramientas/generar-llaves.html`**: genera la llave privada (va en Azure) y la llave pública (va dentro de VETEX). Se usa una sola vez.

## Variables de entorno (en la Static Web App)

| Nombre | Valor |
|---|---|
| `VETEX_STORAGE` | Cadena de conexión de la cuenta de almacenamiento (Claves de acceso → key1 → Cadena de conexión) |
| `VETEX_LLAVE_PRIVADA` | La llave privada que da `generar-llaves.html` |

## Datos

Se guardan en Azure Table Storage. Las tablas se crean solas.

- **`licencias`**: una fila por cliente, con negocio, NIT, vencimiento, estado, computadores y última conexión.
- **`eventos`**: historial de activaciones, rechazos y cambios.

Las copias de seguridad van en Blob Storage, en el contenedor privado **`respaldos`** (se crea solo). Se guardan las últimas 30 por licencia.

## Configuración de la Static Web App

| Campo | Valor |
|---|---|
| App location | `/panel` |
| Api location | `/api` |
| Output location | (vacío) |
