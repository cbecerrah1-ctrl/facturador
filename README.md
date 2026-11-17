# Facturador Versión 2.0

App para hacer **cotizaciones, facturas y cuentas de cobro** en PDF y enviarlas por WhatsApp.
Funciona en **PC y Android desde el navegador**, sin instalar programas, y también sin internet
una vez abierta la primera vez.

## Cómo se usa

- **Nuevo:** eliges el tipo de documento, escribes los datos del cliente (los clientes anteriores
  se autocompletan), buscas los trabajos en el inventario y das *Generar*. Luego *Enviar PDF por
  WhatsApp* abre el menú de compartir del equipo: eliges WhatsApp y el contacto, y el PDF se va
  como archivo.
  - Si el navegador no tiene ese menú, la app descarga el PDF y abre el chat del cliente con el
    mensaje escrito; solo adjuntas el archivo con el clip 📎.
- **Historial:** ver, reenviar o convertir una cotización en factura.
- **Inventario:** agregar, editar o quitar trabajos y precios.
- **Ajustes:** datos del negocio, numeración del equipo y copias de seguridad.

## Primera vez en cada equipo

En **Ajustes → Copia de seguridad → Restaurar copia completa** carga el archivo
`datos-version2.json` (no está en el repositorio, porque tiene la cédula y el celular).
Así quedan los datos del negocio y el inventario. Luego pon la letra del equipo.

## Datos y numeración

Todo se guarda **en el propio equipo** (PC o celular). Por eso:

1. En **Ajustes → Este equipo** pon una letra distinta en cada equipo: **A** en el PC, **B** en el
   celular. Así los números nunca se repiten (FV-A0001, FV-B0001).
2. Para pasar el inventario del PC al celular: en el PC, *Descargar copia*; mándate el archivo
   (por WhatsApp o correo); en el celular, *Cargar solo el inventario*.
3. Descarga una copia de vez en cuando. Si borras los datos del navegador, se pierde lo que no
   esté en una copia.

## Publicarla gratis en GitHub Pages

1. Entra a github.com → **New repository** → nombre `facturador` → **Public** → *Create repository*.
2. En el repositorio: **Add file → Upload files**, arrastra **todo el contenido** de esta carpeta
   (index.html, app.js, la carpeta lib, etc., no la carpeta en sí) → *Commit changes*.
3. **Settings → Pages** → en *Branch* elige `main` y carpeta `/ (root)` → *Save*.
4. En 1 o 2 minutos aparece la dirección: `https://TU-USUARIO.github.io/facturador/`.

> El repositorio es público: cualquiera con el enlace puede abrir la app vacía, pero **no ve tus
> datos**, porque esos viven solo en tus equipos.

## Instalarla como app

- **Android (Chrome):** abre la dirección → menú ⋮ → **Agregar a la pantalla principal / Instalar app**.
- **PC (Chrome o Edge):** abre la dirección → botón **Instalar app** en el menú de la izquierda, o el
  ícono de instalar en la barra de direcciones.

Queda con su ícono y abre en su propia ventana, con la animación del logo.

## Actualizar la app

Sube los archivos cambiados al repositorio y, en `sw.js`, cambia `facturador-v1` por
`facturador-v2` (y así sucesivamente). Los equipos toman la nueva versión al abrir la app con
internet.

## Probarla en tu PC sin publicar

En esta carpeta ejecuta `python -m http.server 8000` y abre `http://localhost:8000`.
(Abrir el `index.html` con doble clic no funciona bien: los navegadores bloquean algunas funciones.)

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html` | Pantallas de la app |
| `app.css` | Diseño (PC y celular) |
| `app.js` | Lógica: inventario, clientes, historial, compartir, animación del logo |
| `pdf.js` | Arma los PDF con el diseño de las plantillas |
| `sw.js` | Permite abrir la app sin internet |
| `manifest.webmanifest`, `iconos/` | Nombre e ícono al instalarla |
| `lib/`, `fuentes/` | Librería de PDF y tipografías, incluidas para que funcione sin internet |

Los PDF dicen al pie que son documentos internos: no reemplazan la factura electrónica ante la DIAN.
