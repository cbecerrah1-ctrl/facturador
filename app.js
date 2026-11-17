/* Facturador Versión 2.0 — funciona 100 % en el navegador (PC o celular). */
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pesos = PDF.pesos;
/* Entiende 180000, 180.000, $ 180.000 y 2,5 */
const numero = v => {
  let t = String(v ?? "").replace(/[$\s]/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(",", ".");
  const n = parseFloat(t); return isNaN(n) ? 0 : n;
};
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const NOMBRES = { COTIZACION: "Cotización", FACTURA: "Factura", CUENTA_COBRO: "Cuenta de cobro" };
const PREFIJO = { COTIZACION: "COT", FACTURA: "FV", CUENTA_COBRO: "CC" };

function aviso(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("ver"), 5500);
}

/* Ventana propia para preguntar o confirmar: letra grande y botones claros */
const Modal = (() => {
  let cerrarActual = null, foco = null;
  function abrir({ titulo, texto = "", cuerpo = "", botones }) {
    return new Promise(res => {
      foco = document.activeElement;
      $("#m-titulo").textContent = titulo; $("#m-texto").textContent = texto; $("#m-texto").hidden = !texto;
      $("#m-cuerpo").innerHTML = cuerpo; $("#m-cuerpo").hidden = !cuerpo;
      $("#m-acciones").innerHTML = botones.map((b, i) => `<button class="btn ${b.clase || ""}" data-r="${i}">${esc(b.texto)}</button>`).join("");
      const m = $("#modal"); m.hidden = false;
      cerrarActual = valor => { m.hidden = true; cerrarActual = null; if (foco && foco.focus) foco.focus(); res(valor); };
      $("#m-acciones").onclick = e => { const b = e.target.closest("[data-r]"); if (b) cerrarActual(botones[+b.dataset.r].valor); };
      setTimeout(() => (m.querySelector(".btn.primario, .btn.verde") || m.querySelector("button")).focus(), 30);
    });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && cerrarActual) cerrarActual(false); });
  $("#modal").addEventListener("click", e => { if (e.target.id === "modal" && cerrarActual) cerrarActual(false); });
  return { abrir };
})();
const confirmar = (titulo, texto, si = "Sí, continuar", no = "No, volver") =>
  Modal.abrir({ titulo, texto, botones: [{ texto: no, valor: false }, { texto: si, valor: true, clase: "primario" }] });

/* Tamaño de la letra: se recuerda en este equipo */
const Preferencia = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
function ponerTamano(t) {
  if (!["normal", "grande", "muy-grande"].includes(t)) t = "normal";
  if (t === "normal") document.documentElement.removeAttribute("data-tam"); else document.documentElement.dataset.tam = t;
  $$(".tamanos button").forEach(b => b.setAttribute("aria-pressed", b.dataset.tam === t));
}
ponerTamano(Preferencia.get("facturador-letra-tamano"));
$$(".tamanos button").forEach(b => b.addEventListener("click", () => {
  ponerTamano(b.dataset.tam); Preferencia.set("facturador-letra-tamano", b.dataset.tam);
  aviso("Tamaño de letra cambiado");
}));

/* ======================= Almacenamiento en el equipo ======================= */
const Almacen = (() => {
  let db = null;
  const memoria = {};
  const abrir = () => new Promise(res => {
    try {
      const r = indexedDB.open("facturador-v2", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("datos");
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => res();
    } catch (e) { res(); }
  });
  const leer = k => new Promise(res => {
    if (!db) return res(memoria[k]);
    const r = db.transaction("datos").objectStore("datos").get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => res(undefined);
  });
  const guardar = (k, v) => new Promise((res, rej) => {
    if (!db) { memoria[k] = v; return res(); }
    const tx = db.transaction("datos", "readwrite");
    tx.objectStore("datos").put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
  return { abrir, leer, guardar };
})();

// Los datos personales (cédula, celular, dirección) NO van en el código, porque el repositorio es público.
// Se llenan en Ajustes o cargando el archivo de datos del negocio en cada equipo.
const CFG_INICIAL = {
  nombre: "VERSIÓN 2.0", eslogan: "Aliado Automotriz", responsable: "",
  identificacion: "", direccion: "", ciudad: "Bogotá D.C.", telefono: "", datosPago: "",
  notaImpuestos: "El valor total es libre de impuestos.",
  notaPie: "Documento interno. No reemplaza la factura electrónica de venta ante la DIAN.", vigencia: 8,
};
const INVENTARIO_INICIAL = [
  { codigo: "TAP-SC", nombre: "Tapizado silla de conductor en vinilo original", unidad: "und", precio: 250000, alias: "silla conductor" },
  { codigo: "TAP-BP", nombre: "Tapizado banca pasajeros en vinilo", unidad: "und", precio: 320000, alias: "banca" },
  { codigo: "FOR-CV", nombre: "Forro camilla en vinilo", unidad: "und", precio: 150000, alias: "camilla" },
  { codigo: "FOR-BC", nombre: "Forro base camilla en vilcuero", unidad: "und", precio: 80000, alias: "base camilla" },
  { codigo: "TPT-FM", nombre: "Tapete piso con base Fomy de alta densidad (ribete plástico y dos taconeras)", unidad: "und", precio: 100000, alias: "tapete" },
  { codigo: "FOR-SL", nombre: "Forro silla en lona", unidad: "und", precio: 90000, alias: "forro silla" },
];

const E = { cfg: {}, inventario: [], clientes: [], documentos: [], equipo: { letra: "A", COT: 1, FV: 1, CC: 1 } };

async function cargarTodo() {
  await Almacen.abrir();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  E.cfg = { ...CFG_INICIAL, ...(await Almacen.leer("cfg") || {}) };
  E.inventario = await Almacen.leer("inventario") || INVENTARIO_INICIAL;
  E.clientes = await Almacen.leer("clientes") || [];
  E.documentos = await Almacen.leer("documentos") || [];
  E.equipo = { ...E.equipo, ...(await Almacen.leer("equipo") || {}) };
}
const guardar = k => Almacen.guardar(k, E[k]);

/* El siguiente número nunca repite uno que ya exista con esa letra */
const mayorExistente = (p, letra) => {
  const patron = new RegExp(`^${p}-${letra}(\\d+)$`);
  return E.documentos.reduce((m, d) => { const x = patron.exec(d.numero); return x ? Math.max(m, +x[1]) : m; }, 0);
};
function siguienteNumero(tipo) {
  const p = PREFIJO[tipo], letra = (E.equipo.letra || "").toUpperCase();
  const n = Math.max(E.equipo[p] || 1, mayorExistente(p, letra) + 1);
  E.equipo[p] = n + 1;
  return `${p}-${letra}${String(n).padStart(4, "0")}`;
}

/* ======================= Navegación ======================= */
let invCambios = false;
$$("nav button[data-vista]").forEach(b => b.addEventListener("click", () => irA(b.dataset.vista)));
async function irA(vista) {
  if ($("#v-" + vista).classList.contains("activa")) return;
  if (vista !== "inventario" && invCambios && !(await confirmar("¿Salir sin guardar?", "Cambió trabajos o precios y todavía no los ha guardado.", "Salir sin guardar", "Quedarme"))) return;
  if (vista !== "inventario") invCambios = false;
  $$("nav button[data-vista]").forEach(b => b.dataset.vista === vista ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $$(".vista").forEach(v => v.classList.toggle("activa", v.id === "v-" + vista));
  if (vista === "nuevo") pintarCatalogo();
  if (vista === "historial") pintarHistorial();
  if (vista === "inventario") { inv = E.inventario.map(p => ({ ...p })); pintarInventario(); }
  if (vista === "ajustes") pintarAjustes();
  window.scrollTo(0, 0);
}

/* ======================= Nuevo documento ======================= */
let tipo = "COTIZACION", items = [], ultimo = null;

$$(".tipos button").forEach(b => b.addEventListener("click", () => {
  tipo = b.dataset.tipo;
  $$(".tipos button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("#panel-cobro").hidden = tipo !== "CUENTA_COBRO";
  ocultarListo(); pintarRecibo();
}));

const precioTexto = n => n ? Math.round(n).toLocaleString("es-CO") : "";
function pintarItems() {
  $("#items").innerHTML = items.map((it, i) => `
    <div class="item">
      <label class="campo-desc">Trabajo
        <input class="desc" value="${esc(it.descripcion)}" data-i="${i}" data-campo="descripcion" placeholder="Escriba qué trabajo es">
      </label>
      <div class="campo-cant"><label for="cant-${i}">Cantidad</label>
        <div class="contador">
          <button type="button" data-menos="${i}" aria-label="Quitar uno">−</button>
          <input class="cant" id="cant-${i}" value="${String(it.cantidad).replace(".", ",")}" data-i="${i}" data-campo="cantidad" inputmode="decimal">
          <button type="button" data-mas="${i}" aria-label="Sumar uno">+</button>
        </div>
      </div>
      <label class="campo-precio">Precio de cada uno
        <input class="precio" value="${precioTexto(it.precio)}" data-i="${i}" data-campo="precio" inputmode="numeric" placeholder="0">
      </label>
      <div class="subtotal"><small>Total</small><b id="tot-${i}">${pesos(it.cantidad * it.precio)}</b></div>
      <button class="btn quitar" data-quitar="${i}">Quitar</button>
    </div>`).join("");
  pintarRecibo(); pintarCatalogo();
}
$("#items").addEventListener("input", e => {
  const el = e.target; if (!el.dataset.campo) return;
  const it = items[el.dataset.i];
  it[el.dataset.campo] = ["cantidad", "precio"].includes(el.dataset.campo) ? numero(el.value) : el.value;
  $("#tot-" + el.dataset.i).textContent = pesos(it.cantidad * it.precio);
  ocultarListo(); pintarRecibo(); if (el.dataset.campo !== "precio") pintarCatalogo();
});
$("#items").addEventListener("click", e => {
  const b = e.target.closest("[data-quitar],[data-mas],[data-menos]"); if (!b) return;
  if (b.dataset.quitar !== undefined) items.splice(+b.dataset.quitar, 1);
  else {
    const it = items[+(b.dataset.mas ?? b.dataset.menos)];
    it.cantidad = Math.max(1, Math.round((it.cantidad + (b.dataset.mas !== undefined ? 1 : -1)) * 100) / 100);
  }
  ocultarListo(); pintarItems();
});
$("#agregar-libre").addEventListener("click", () => {
  items.push({ ref: "SERVICIO", descripcion: "", cantidad: 1, precio: 0, unidad: "und" });  // trabajo escrito a mano
  pintarItems(); $$("#items .desc").at(-1).focus();
});

function cliente() {
  const v = id => $("#c-" + id).value.trim();
  return { nombre: v("nombre"), documento: v("documento"), telefono: v("telefono"), direccion: v("direccion"),
           correo: v("correo"), ciudad: v("ciudad"), vehiculo: v("vehiculo"), placa: v("placa").toUpperCase() };
}
$$("#v-nuevo .panel input").forEach(i => i.addEventListener("input", () => { ocultarListo(); pintarRecibo(); }));

const itemsValidos = () => items.filter(it => it.descripcion.trim() && it.cantidad > 0);
function totalActual() {
  const suma = itemsValidos().reduce((s, it) => s + Math.round(it.cantidad * it.precio), 0);
  return suma || (tipo === "CUENTA_COBRO" ? Math.round(numero($("#valor").value)) : 0);
}
function pintarRecibo() {
  const c = cliente(), total = totalActual();
  $("#r-tipo").textContent = NOMBRES[tipo];
  $("#generar").textContent = "Crear la " + NOMBRES[tipo].toLowerCase();
  $("#r-fecha").textContent = new Date().toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });
  $("#r-cliente").textContent = c.nombre || (tipo === "CUENTA_COBRO" ? "Falta el nombre del cliente" : "Consumidor final");
  $("#r-cliente2").textContent = [c.documento && "C.C./NIT " + c.documento, c.vehiculo, c.placa].filter(Boolean).join(", ");
  const vis = itemsValidos();
  $("#r-items").innerHTML = vis.length
    ? vis.map(it => `<li><span>${String(it.cantidad).replace(".", ",")} × ${esc(it.descripcion)}</span><span>${pesos(it.cantidad * it.precio)}</span></li>`).join("")
    : (tipo === "CUENTA_COBRO" && $("#concepto").value.trim()
        ? `<li><span>${esc($("#concepto").value)}</span><span></span></li>`
        : `<li class="vacio"><span>Todavía no hay trabajos</span><span></span></li>`);
  $("#r-total").textContent = pesos(total);
  $("#r-letras").textContent = total ? Letras.pesos(total) : "";
}

/* ---------- autocompletar ---------- */
function autocompletar(input, caja, buscar, pintar, elegir) {
  let lista = [], sel = 0;
  const cerrar = () => caja.classList.remove("abierta");
  const mostrar = () => {
    caja.innerHTML = lista.map((x, i) => `<div role="option" data-i="${i}" aria-selected="${i === sel}">${pintar(x)}</div>`).join("");
    caja.classList.toggle("abierta", lista.length > 0);
  };
  input.addEventListener("input", () => { lista = buscar(input.value); sel = 0; mostrar(); });
  input.addEventListener("keydown", e => {
    if (!caja.classList.contains("abierta")) return;
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, lista.length - 1); mostrar(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); mostrar(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); if (lista[sel]) { elegir(lista[sel]); cerrar(); } }
    else if (e.key === "Escape") cerrar();
  });
  caja.addEventListener("pointerdown", e => { const d = e.target.closest("[data-i]"); if (d) { e.preventDefault(); elegir(lista[d.dataset.i]); cerrar(); } });
  input.addEventListener("blur", () => setTimeout(cerrar, 150));
}

function filtrarCatalogo(q) {
  const t = norm(q).split(/\s+/).filter(Boolean);
  return E.inventario.filter(p => { const h = norm(`${p.codigo} ${p.nombre} ${p.alias}`); return t.every(x => h.includes(x)); });
}
function pintarCatalogo() {
  const lista = filtrarCatalogo($("#buscar-prod").value);
  $("#catalogo").innerHTML = lista.length ? lista.map((p, i) => {
    const ya = items.find(it => it.ref === p.codigo && it.descripcion === p.nombre);
    return `<button role="listitem" data-cat="${E.inventario.indexOf(p)}">
      <span class="nombre">${esc(p.nombre)}</span>
      <span class="precio">${pesos(p.precio)}</span>
      ${ya ? `<span class="ya">✓ Agregado (${String(ya.cantidad).replace(".", ",")})</span>` : `<span class="agregar">Toque para agregar</span>`}
    </button>`;
  }).join("") : `<p class="sin">${E.inventario.length ? "No hay trabajos con esa palabra. Pruebe con otra, o escriba el trabajo con el botón de abajo." : "Todavía no hay trabajos guardados. Agréguelos en «Mis trabajos y precios»."}</p>`;
}
function agregarDelCatalogo(p) {
  const ya = items.find(it => it.ref === p.codigo && it.descripcion === p.nombre);
  if (ya) ya.cantidad += 1;
  else items.push({ ref: p.codigo || "SERVICIO", descripcion: p.nombre, cantidad: 1, precio: p.precio, unidad: p.unidad || "und" });
  ocultarListo(); pintarItems();
  aviso(ya ? `Ahora son ${String(ya.cantidad).replace(".", ",")}: ${p.nombre}` : `Agregado: ${p.nombre}`);
}
$("#catalogo").addEventListener("click", e => { const b = e.target.closest("[data-cat]"); if (b) agregarDelCatalogo(E.inventario[+b.dataset.cat]); });
$("#buscar-prod").addEventListener("input", pintarCatalogo);
$("#buscar-prod").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const lista = filtrarCatalogo($("#buscar-prod").value);
  if (lista.length && $("#buscar-prod").value.trim()) { agregarDelCatalogo(lista[0]); $("#buscar-prod").value = ""; pintarCatalogo(); }
});

autocompletar($("#c-nombre"), $("#sug-clientes"),
  q => { const t = norm(q).trim(); if (t.length < 2) return [];
    return E.clientes.filter(c => norm(`${c.nombre} ${c.documento} ${c.telefono}`).includes(t)).slice(0, 8); },
  c => `<span>${esc(c.nombre)} <small>${esc(c.documento || "")}</small></span><small>${esc(c.telefono || "")}</small>`,
  c => {
    ["nombre", "documento", "telefono", "direccion", "correo", "ciudad"].forEach(k => { $("#c-" + k).value = c[k] || ""; });
    $("#mas-datos").open = !!(c.direccion || c.correo || c.ciudad);
    pintarRecibo();
  });

/* ---------- generar ---------- */
$("#generar").addEventListener("click", async () => {
  $("#aviso").textContent = "";
  const c = cliente(), its = itemsValidos(), total = totalActual();
  const falta = (msg, campo) => { $("#aviso").textContent = msg; if (campo) { campo.scrollIntoView({ behavior: "smooth", block: "center" }); campo.focus({ preventScroll: true }); } };
  if (tipo === "CUENTA_COBRO" && !c.nombre) return falta("Falta el nombre del cliente (paso 2).", $("#c-nombre"));
  if (!its.length && !(tipo === "CUENTA_COBRO" && total > 0)) return falta("Falta agregar al menos un trabajo (paso 3).", $("#buscar-prod"));
  if (its.some(it => it.precio < 0)) return falta("Hay un precio con signo menos. Corrija el precio (paso 3).", $("#items .precio"));
  if (total <= 0) return falta("El total está en $0. Escriba el precio de los trabajos (paso 3).", $("#items .precio"));
  if (tipo === "CUENTA_COBRO" && !its.length && !$("#concepto").value.trim()) return falta("Escriba por qué se cobra (paso 3).", $("#concepto"));
  if (!c.nombre) c.nombre = "Consumidor final";   // la C.C. o NIT es opcional en todos los documentos

  const b = $("#generar"); b.disabled = true; b.textContent = "Creando el documento…";
  let creado = null, listo = false;
  try {
    const ahora = new Date();
    const doc = creado = {
      numero: siguienteNumero(tipo), tipo, fecha: ahora.toISOString(), cliente: c,
      items: its.map(it => ({ ref: String(it.ref || "").trim() || "SERVICIO", descripcion: it.descripcion.trim(), cantidad: it.cantidad,
                              unidad: it.unidad || "und", precio: Math.round(it.precio), total: Math.round(it.cantidad * it.precio) })),
      total, concepto: $("#concepto").value.trim() || null,
      estado: tipo === "COTIZACION" ? "pendiente" : "emitida",
      vence: tipo === "COTIZACION" ? new Date(ahora.getTime() + (+E.cfg.vigencia || 8) * 864e5).toISOString() : null,
    };
    const blob = await PDF.crear(doc, E.cfg);   // si falla, no se guarda nada ni se gasta el número
    E.documentos.unshift(doc);
    recordarCliente(c);
    await Promise.all([guardar("documentos"), guardar("equipo"), guardar("clientes")]);
    ultimo = { doc, blob };
    $("#listo-texto").textContent = `Listo: ${NOMBRES[tipo].toLowerCase()} ${doc.numero} por ${pesos(total)}. ¿Qué quiere hacer ahora?`;
    $("#listo").classList.add("visible");
    $("#listo").scrollIntoView({ behavior: "smooth", block: "center" }); $("#listo").focus({ preventScroll: true });
    listo = true;
  } catch (e) {
    E.equipo[PREFIJO[tipo]]--;  // devolvemos el número
    if (creado) E.documentos = E.documentos.filter(d => d !== creado);
    $("#aviso").textContent = "No se pudo crear el documento. Inténtelo otra vez. (" + (e.message || "error al guardar") + ")";
  }
  pintarRecibo();
  // Mientras el documento recién creado está en pantalla, el botón queda bloqueado para no duplicarlo.
  // Cualquier cambio en el formulario lo vuelve a habilitar.
  b.disabled = listo;
  if (listo) b.textContent = "✓ Ya está creado";
});
function recordarCliente(c) {
  if (!c.nombre || c.nombre === "Consumidor final") return;
  const i = E.clientes.findIndex(x => (c.documento && x.documento === c.documento) || norm(x.nombre) === norm(c.nombre));
  const datos = { nombre: c.nombre, documento: c.documento, telefono: c.telefono, direccion: c.direccion, correo: c.correo, ciudad: c.ciudad };
  if (i >= 0) E.clientes.splice(i, 1);
  E.clientes.unshift(datos);
  E.clientes = E.clientes.slice(0, 500);
}
function ocultarListo() {
  if (!$("#listo").classList.contains("visible")) return;
  $("#listo").classList.remove("visible");
  $("#generar").disabled = false; pintarRecibo();
}

$("#l-compartir").addEventListener("click", () => compartir(ultimo.doc, ultimo.blob));
$("#l-ver").addEventListener("click", () => verPDF(ultimo.blob));
$("#l-descargar").addEventListener("click", () => descargar(ultimo.blob, ultimo.doc.numero + ".pdf"));
$("#l-nuevo").addEventListener("click", () => {
  items = []; $$("#v-nuevo input").forEach(i => i.value = ""); $("#mas-datos").open = false; ultimo = null; ocultarListo(); pintarItems();
  window.scrollTo({ top: 0, behavior: "smooth" }); $("#c-nombre").focus({ preventScroll: true });
});

/* ======================= Compartir / ver / descargar ======================= */
function telefonoWA(t) {
  let n = String(t || "").replace(/\D/g, "");
  if (n.length === 10 && n.startsWith("3")) n = "57" + n;
  return n.length >= 11 ? n : "";
}
function mensaje(doc) {
  const nombre = doc.cliente.nombre && doc.cliente.nombre !== "Consumidor final" ? " " + doc.cliente.nombre : "";
  let t = `Hola${nombre}, te envío la ${NOMBRES[doc.tipo].toLowerCase()} ${doc.numero} de ${E.cfg.nombre} por ${pesos(doc.total)}.`;
  if (doc.tipo === "COTIZACION") t += " Si estás de acuerdo, respóndeme con el número para aprobarla.";
  return t;
}
/* ¿Es un celular o tableta? Ahí sí se usa el menú de compartir del sistema */
/* Celulares y tabletas: Android, iPhone/iPad, o pantalla táctil que no sea Windows
   (las tabletas Samsung y los iPad muchas veces se presentan como "computador") */
const esCelular = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || !!(navigator.userAgentData && navigator.userAgentData.mobile)
  || (navigator.maxTouchPoints > 1 && !/Windows/i.test(navigator.userAgent));

async function compartir(doc, blob) {
  blob = blob || await PDF.crear(doc, E.cfg);
  const archivo = new File([blob], `${doc.numero}.pdf`, { type: "application/pdf" });
  const puede = !window.facturadorPC && !!(navigator.canShare && navigator.canShare({ files: [archivo] }));
  let motivo = puede ? "" : "este navegador no deja adjuntar archivos";
  // 1) En celular o tableta: menú de compartir del sistema (se elige WhatsApp y el contacto, y el PDF va adjunto)
  if (puede && esCelular()) {
    try { await navigator.share({ files: [archivo], text: mensaje(doc) }); return; }
    catch (e) { if (e.name === "AbortError") return; motivo = e.name || "error"; }
  }
  // 2) Si no se pudo (o es un computador): ventana con botones grandes
  return envioEnDosPasos(doc, blob, archivo, puede, motivo);
}
function envioEnDosPasos(doc, blob, archivo, puede, motivo) {
  const tel = telefonoWA(doc.cliente.telefono);
  const enlace = `https://wa.me/${tel}?text=${encodeURIComponent(mensaje(doc))}`;
  const quien = tel ? `el chat de ${esc(doc.cliente.nombre)}` : "WhatsApp (ahí elige a quién enviarlo)";
  const directo = puede ? `<div class="paso-m"><span class="num">★</span><div><b>Lo más fácil:</b> toque este botón, elija <b>WhatsApp</b> y el contacto. El PDF va pegado.
        <button class="btn verde" id="m-directo">Enviar el PDF por WhatsApp</button></div></div>
      <p class="ayuda">Si eso no funciona, hágalo en dos pasos:</p>` : "";
  const cuerpo = `<div class="pasos">${directo}
      <div class="paso-m"><span class="num">1</span><div>Guarde el PDF en este equipo.
        <button class="btn ${puede ? "" : "primario"}" id="m-guardar">Guardar ${esc(doc.numero)}.pdf</button></div></div>
      <div class="paso-m"><span class="num">2</span><div>Abra ${quien} con el mensaje ya escrito. En el chat toque el clip 📎 y elija el PDF${esCelular() ? "" : " (queda en la carpeta Descargas)"}.
        <a class="btn ${puede ? "" : "verde"}" id="m-whatsapp" href="${enlace}" target="_blank" rel="noopener">Abrir WhatsApp</a></div></div>
      ${motivo && esCelular() ? `<p class="ayuda nota-tec">Nota: ${esc(motivo)}.</p>` : ""}
    </div>`;
  const abierto = Modal.abrir({ titulo: `Enviar ${NOMBRES[doc.tipo].toLowerCase()} ${doc.numero}`, texto: puede ? "" : "Son dos pasos:", cuerpo,
    botones: [{ texto: "Cerrar", valor: true }] });
  if (puede) $("#m-directo").addEventListener("click", async () => {
    try { await navigator.share({ files: [archivo], text: mensaje(doc) }); $("#m-acciones button").click(); }
    catch (e) { if (e.name !== "AbortError") aviso("No se pudo así. Use los pasos 1 y 2 de abajo."); }
  });
  $("#m-guardar").addEventListener("click", () => { descargar(blob, `${doc.numero}.pdf`); aviso("PDF guardado. Ahora toque «Abrir WhatsApp»."); });
  // En el programa de escritorio el enlace se abre por su puente (WhatsApp Web o la app de WhatsApp)
  $("#m-whatsapp").addEventListener("click", e => { if (window.facturadorPC) { e.preventDefault(); abrirEnlace(enlace); } });
  return abierto;
}
/* En el programa de escritorio los enlaces se abren por su puente; en el navegador, en una pestaña nueva */
function abrirEnlace(url) {
  if (window.facturadorPC && window.facturadorPC.abrirEnlace) window.facturadorPC.abrirEnlace(url);
  else window.open(url, "_blank");
}
function descargar(blob, nombre) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function verPDF(blob) {
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (!w) descargar(blob, "documento.pdf");
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

/* ======================= Historial ======================= */
$("#h-buscar").addEventListener("input", pintarHistorial);
$("#h-tipo").addEventListener("change", pintarHistorial);
function pintarHistorial() {
  const q = norm($("#h-buscar").value).trim(), t = $("#h-tipo").value, hoy = new Date();
  const docs = E.documentos.filter(d => (!t || d.tipo === t) &&
    (!q || norm(`${d.numero} ${d.cliente.nombre} ${d.cliente.documento} ${d.cliente.placa}`).includes(q)));
  $("#h-lista").innerHTML = docs.length ? docs.slice(0, 300).map(d => {
    let estado = { pendiente: "Esperando respuesta", facturada: "Ya se facturó", emitida: "Hecha" }[d.estado] || d.estado, clase = d.estado;
    if (d.estado === "pendiente" && d.vence && new Date(d.vence) < hoy) { estado = "Vencida"; clase = "vencida"; }
    const fecha = new Date(d.fecha).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
    return `<div class="doc">
      <div>
        <div class="que">${NOMBRES[d.tipo]} ${esc(d.numero)}<small>${fecha}${d.origen ? ", sale de la " + esc(d.origen) : ""}</small></div>
        <div class="quien">${esc(d.cliente.nombre)}<small>${esc([d.cliente.vehiculo, d.cliente.placa, d.cliente.documento].filter(Boolean).join(" · "))}</small></div>
      </div>
      <div class="lado"><div class="monto">${pesos(d.total)}</div><span class="estado ${clase}">${estado}</span></div>
      <div class="fila-acciones">
        <button class="btn" data-ver="${esc(d.numero)}">Ver el PDF</button>
        <button class="btn verde" data-compartir="${esc(d.numero)}">Enviar por WhatsApp</button>
        ${d.tipo === "COTIZACION" && d.estado === "pendiente" ? `<button class="btn primario" data-facturar="${esc(d.numero)}">Pasar a factura</button>` : ""}
      </div></div>`;
  }).join("") : `<div class="vacio">${E.documentos.length ? "No hay documentos con esa búsqueda." : "Todavía no hay documentos. Haga el primero en «Hacer documento»."}</div>`;
}
$("#h-lista").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const buscar = n => E.documentos.find(d => d.numero === n);
  try {
    if (b.dataset.ver) verPDF(await PDF.crear(buscar(b.dataset.ver), E.cfg));
    if (b.dataset.compartir) await compartir(buscar(b.dataset.compartir));
    if (b.dataset.facturar) {
      const cot = buscar(b.dataset.facturar);
      if (!(await confirmar(`¿Pasar la ${cot.numero} a factura?`, `Se crea una factura con los mismos datos y trabajos, por ${pesos(cot.total)}.`, "Sí, crear la factura"))) return;
      const fac = { ...JSON.parse(JSON.stringify(cot)), numero: siguienteNumero("FACTURA"), tipo: "FACTURA",
                    fecha: new Date().toISOString(), estado: "emitida", vence: null, origen: cot.numero };
      const blob = await PDF.crear(fac, E.cfg);
      cot.estado = "facturada"; E.documentos.unshift(fac);
      await Promise.all([guardar("documentos"), guardar("equipo")]);
      pintarHistorial();
      aviso(`Factura ${fac.numero} creada`);
      if (await confirmar(`Factura ${fac.numero} creada`, "¿Quiere enviarla ahora por WhatsApp?", "Sí, enviar", "Ahora no")) compartir(fac, blob);
    }
  } catch (err) { aviso("No se pudo hacer: " + err.message); }
});

/* ======================= Inventario ======================= */
let inv = [];
function pintarInventario() {
  $("#i-cambios").textContent = invCambios ? "Tiene cambios sin guardar" : "";
  $("#i-lista").innerHTML = inv.length ? inv.map((p, i) => `<div class="inv">
    <label class="nom">Nombre del trabajo<input value="${esc(p.nombre)}" data-i="${i}" data-c="nombre" placeholder="Ejemplo: Forro silla en lona"></label>
    <label class="precio">Precio<input value="${precioTexto(p.precio)}" data-i="${i}" data-c="precio" inputmode="numeric" placeholder="0"></label>
    <label class="cod">Código <small>(opcional)</small><input class="mayus" value="${esc(p.codigo)}" data-i="${i}" data-c="codigo"></label>
    <button class="btn quitar" data-borrar="${i}">Quitar</button></div>`).join("")
    : `<div class="lista"><div class="vacio">Todavía no hay trabajos. Toque «Agregar un trabajo nuevo».</div></div>`;
}
$("#i-lista").addEventListener("input", e => {
  const el = e.target; if (!el.dataset.c) return;
  inv[el.dataset.i][el.dataset.c] = el.dataset.c === "precio" ? numero(el.value) : el.value;
  invCambios = true; $("#i-cambios").textContent = "Tiene cambios sin guardar";
});
$("#i-lista").addEventListener("click", async e => {
  const b = e.target.closest("[data-borrar]"); if (!b) return;
  const p = inv[b.dataset.borrar];
  if (p.nombre && !(await confirmar("¿Quitar este trabajo de la lista?", p.nombre, "Sí, quitarlo"))) return;
  inv.splice(+b.dataset.borrar, 1); invCambios = true; pintarInventario();
});
$("#i-agregar").addEventListener("click", () => {
  inv.unshift({ codigo: "", nombre: "", unidad: "und", precio: 0, alias: "" });
  invCambios = true; pintarInventario(); $("#i-lista .nom input").focus();
});
$("#i-guardar").addEventListener("click", async () => {
  const limpio = inv.filter(p => p.nombre.trim()).map(p => ({ ...p, codigo: p.codigo.trim().toUpperCase(), nombre: p.nombre.trim() }));
  const cods = limpio.map(p => p.codigo).filter(Boolean);
  const rep = [...new Set(cods.filter((c, i) => cods.indexOf(c) !== i))];
  if (rep.length) return aviso("Hay dos trabajos con el mismo código: " + rep.join(", ") + ". Cambie uno.");
  E.inventario = limpio; await guardar("inventario");
  inv = E.inventario.map(p => ({ ...p })); invCambios = false; pintarInventario();
  aviso(`Guardado: ${limpio.length} trabajos con sus precios`);
});
window.addEventListener("beforeunload", e => { if (invCambios) { e.preventDefault(); e.returnValue = ""; } });

/* ======================= Ajustes ======================= */
/* ======================= Firma ======================= */
/* Convierte cualquier imagen de firma en un PNG pequeño con fondo transparente:
   lo claro (el papel) se vuelve transparente y lo oscuro (la tinta) queda en azul oscuro. */
function limpiarFirma(fuente) {
  const W = fuente.naturalWidth || fuente.width, H = fuente.naturalHeight || fuente.height;
  const esc1 = Math.min(1, 1400 / Math.max(W, H));
  const c = document.createElement("canvas"); c.width = Math.round(W * esc1); c.height = Math.round(H * esc1);
  const x = c.getContext("2d"); x.drawImage(fuente, 0, 0, c.width, c.height);
  const img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  // umbral automático: promedio del papel menos un margen
  let suma = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { if (d[i + 3] > 0) { suma += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; } }
  const papel = n ? suma / n : 255, corte = Math.max(60, papel - 45);
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    const lum = d[i + 3] === 0 ? 255 : (d[i] + d[i + 1] + d[i + 2]) / 3;
    const a = lum >= corte ? 0 : Math.min(255, Math.round((corte - lum) / corte * 255 * 2.2));
    d[i] = 27; d[i + 1] = 42; d[i + 2] = 107; d[i + 3] = a;
    if (a > 40) { const px = p % c.width, py = (p / c.width) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
  }
  if (x1 < 0) throw new Error("no se encontró la firma en la imagen. Usa una foto con buena luz sobre papel blanco");
  x.putImageData(img, 0, 0);
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(c.width - 1, x1 + m); y1 = Math.min(c.height - 1, y1 + m);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, esc2 = Math.min(1, 600 / w, 200 / h);
  const out = document.createElement("canvas"); out.width = Math.max(1, Math.round(w * esc2)); out.height = Math.max(1, Math.round(h * esc2));
  out.getContext("2d").drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
async function guardarFirma(dataUrl) {
  E.cfg.firma = dataUrl || "";
  try { await guardar("cfg"); } catch (e) { return; }
  pintarFirma(); aviso(dataUrl ? "Firma guardada. Saldrá en los próximos documentos." : "Firma quitada");
}
function pintarFirma() {
  const f = E.cfg.firma;
  $("#firma-img").hidden = !f; $("#firma-vacia").hidden = !!f; $("#firma-quitar").hidden = !f;
  if (f) $("#firma-img").src = f; else $("#firma-img").removeAttribute("src");
}
$("#firma-subir").addEventListener("click", () => $("#firma-archivo").click());
$("#firma-archivo").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const url = URL.createObjectURL(f);
  try {
    const im = new Image();
    await new Promise((ok, mal) => { im.onload = ok; im.onerror = () => mal(new Error("ese archivo no es una imagen")); im.src = url; });
    await guardarFirma(limpiarFirma(im));
  } catch (err) { aviso("No se pudo usar la imagen: " + err.message + "."); }
  URL.revokeObjectURL(url);
});
$("#firma-quitar").addEventListener("click", () => guardarFirma(""));

/* dibujar con el dedo o el mouse */
const Lienzo = (() => {
  const cv = $("#firma-lienzo"), cx = cv.getContext("2d");
  let trazando = false, ultimo = null, hayTrazo = false;
  const punto = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  const limpiar = () => { cx.clearRect(0, 0, cv.width, cv.height); hayTrazo = false; };
  cx.lineCap = "round"; cx.lineJoin = "round"; cx.strokeStyle = "#1B2A6B"; cx.lineWidth = 5;
  cv.addEventListener("pointerdown", e => { trazando = true; ultimo = punto(e); cv.setPointerCapture(e.pointerId); e.preventDefault(); });
  cv.addEventListener("pointermove", e => {
    if (!trazando) return; const p = punto(e);
    cx.beginPath(); cx.moveTo(...ultimo); cx.lineTo(...p); cx.stroke(); ultimo = p; hayTrazo = true; e.preventDefault();
  });
  const fin = () => { trazando = false; };
  cv.addEventListener("pointerup", fin); cv.addEventListener("pointercancel", fin);
  return { limpiar, hayTrazo: () => hayTrazo, lienzo: cv };
})();
$("#firma-dibujar").addEventListener("click", () => { Lienzo.limpiar(); $("#firma-pad").hidden = false; });
$("#firma-borrar").addEventListener("click", () => Lienzo.limpiar());
$("#firma-cancelar").addEventListener("click", () => { $("#firma-pad").hidden = true; });
$("#firma-guardar").addEventListener("click", async () => {
  if (!Lienzo.hayTrazo()) return aviso("Dibuja la firma antes de guardarla.");
  try { await guardarFirma(limpiarFirma(Lienzo.lienzo)); $("#firma-pad").hidden = true; }
  catch (err) { aviso("No se pudo usar el dibujo: " + err.message + "."); }
});

/* Recuadro que pide llenar los datos del negocio mientras falten */
function revisarNegocio() { $("#falta-negocio").hidden = !!(E.cfg.responsable || "").trim(); }
$("#ir-ajustes").addEventListener("click", () => irA("ajustes"));

function pintarAjustes() {
  pintarFirma();
  $$("[data-cfg]").forEach(i => i.value = E.cfg[i.dataset.cfg] ?? "");
  $("#equipo").value = E.equipo.letra || "";
  ["COT", "FV", "CC"].forEach(p => $("#sig-" + p).value = E.equipo[p]);
}
$("#guardar-cfg").addEventListener("click", async () => {
  $$("[data-cfg]").forEach(i => E.cfg[i.dataset.cfg] = i.value.trim());
  E.cfg.vigencia = Math.max(1, parseInt(E.cfg.vigencia) || 8);
  await guardar("cfg"); revisarNegocio(); aviso("Datos del negocio guardados");
});
$("#guardar-equipo").addEventListener("click", async () => {
  const anterior = E.equipo.letra || "";
  E.equipo.letra = $("#equipo").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (E.equipo.letra !== anterior) {
    // Letra nueva: cada tipo arranca después del último número que exista con esa letra
    ["COT", "FV", "CC"].forEach(p => E.equipo[p] = mayorExistente(p, E.equipo.letra) + 1);
  } else {
    ["COT", "FV", "CC"].forEach(p => E.equipo[p] = Math.max(1, parseInt($("#sig-" + p).value) || 1));
  }
  await guardar("equipo"); pintarAjustes();
  aviso(E.equipo.letra !== anterior ? `Numeración con la letra ${E.equipo.letra || "(sin letra)"} guardada` : "Numeración guardada");
});

/* copia de seguridad */
$("#exportar").addEventListener("click", () => {
  const copia = { app: "facturador-v2", version: 1, fecha: new Date().toISOString(),
                  cfg: E.cfg, inventario: E.inventario, clientes: E.clientes, documentos: E.documentos, equipo: E.equipo };
  const hoy = new Date().toISOString().slice(0, 10);
  descargar(new Blob([JSON.stringify(copia, null, 1)], { type: "application/json" }), `copia-facturador-${hoy}.json`);
});
let modoImportar = "";
$("#importar-inv").addEventListener("click", () => { modoImportar = "inventario"; $("#archivo-copia").click(); });
$("#importar-todo").addEventListener("click", () => { modoImportar = "todo"; $("#archivo-copia").click(); });
$("#archivo-copia").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const copia = JSON.parse(await f.text());
    if (!copia || copia.app !== "facturador-v2") throw new Error("ese archivo no es una copia del facturador");
    const lista = x => Array.isArray(x) ? x : [];
    copia.inventario = lista(copia.inventario).filter(p => p && typeof p.nombre === "string" && p.nombre.trim())
      .map(p => ({ codigo: String(p.codigo || "").toUpperCase(), nombre: p.nombre.trim(), unidad: p.unidad || "und", precio: Math.max(0, numero(p.precio)), alias: String(p.alias || "") }));
    copia.clientes = lista(copia.clientes).filter(c => c && c.nombre);
    copia.documentos = lista(copia.documentos).filter(d => d && d.numero && d.tipo in PREFIJO && d.cliente && Array.isArray(d.items));
    if (modoImportar === "inventario" && !copia.inventario.length) throw new Error("la copia no trae productos en el inventario");
    if (modoImportar === "inventario") {
      E.inventario = copia.inventario || []; await guardar("inventario");
      aviso(`Se cargaron ${E.inventario.length} trabajos con sus precios`);
    } else {
      if (!(await confirmar("¿Cargar la copia completa?", "Se cambian los datos del negocio, los trabajos y los clientes por los de la copia.", "Sí, cargarla"))) return;
      // La numeración de este equipo no se reemplaza, para que no choque con la del otro equipo
      Object.assign(E, { cfg: { ...CFG_INICIAL, ...copia.cfg }, inventario: copia.inventario || [], clientes: copia.clientes || [], documentos: copia.documentos || [] });
      await Promise.all(["cfg", "inventario", "clientes", "documentos"].map(guardar));
      pintarAjustes(); revisarNegocio(); aviso("Copia cargada");
    }
  } catch (err) { aviso("No se pudo cargar la copia: " + err.message + "."); }
});

/* ======================= Instalar como app ======================= */
let pedirInstalar = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); pedirInstalar = e; $("#instalar").hidden = false; });
$("#instalar").addEventListener("click", async () => {
  if (!pedirInstalar) return;
  pedirInstalar.prompt(); await pedirInstalar.userChoice; pedirInstalar = null; $("#instalar").hidden = true;
});
window.addEventListener("appinstalled", () => { $("#instalar").hidden = true; aviso("App instalada"); });
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ======================= Pantalla de carga animada ======================= */
const Splash = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const CX = 150, CY = 138, R_ARCO = 80, A0 = -158, A1 = -22, SEG = 10;
  const COLORES = ["#3A167A", "#45208A", "#502C98", "#5A3AA6", "#5B4FB3", "#5367BE", "#4D82C6", "#5A9ECD", "#78B8D1", "#9CCFD3"];
  const rad = g => g * Math.PI / 180;
  const punto = (r, g) => [CX + r * Math.cos(rad(g)), CY + r * Math.sin(rad(g))];
  const el = (tag, at, padre) => { const n = document.createElementNS(NS, tag); for (const k in at) n.setAttribute(k, at[k]); padre && padre.appendChild(n); return n; };

  function dibujar(svg) {
    // volante: aro y radios inferiores
    el("circle", { cx: CX, cy: CY, r: 112, fill: "none", stroke: "#3A167A", "stroke-width": 24 }, svg);
    [[34, 0], [146, 0], [90, 0]].forEach(([g]) => {
      const [x1, y1] = punto(36, g), [x2, y2] = punto(104, g);
      el("line", { x1, y1, x2, y2, stroke: "#3A167A", "stroke-width": g === 90 ? 20 : 24, "stroke-linecap": "round" }, svg);
    });
    // escala del velocímetro (segmentos que se encienden)
    const paso = (A1 - A0) / SEG, segs = [];
    for (let i = 0; i < SEG; i++) {
      const a = A0 + i * paso + 1.4, b = A0 + (i + 1) * paso - 1.4;
      const [x1, y1] = punto(R_ARCO, a), [x2, y2] = punto(R_ARCO, b);
      segs.push(el("path", { d: `M${x1} ${y1} A${R_ARCO} ${R_ARCO} 0 0 1 ${x2} ${y2}`, fill: "none", stroke: COLORES[i],
                             "stroke-width": 15, opacity: .13, class: "v-segmento" }, svg));
    }
    // marcas 0 y 2.0
    const [lx0, ly0] = punto(R_ARCO + 2, A0 - 13), [lx1, ly1] = punto(R_ARCO + 4, A1 + 14);
    el("text", { x: lx0, y: ly0 + 4, "text-anchor": "middle", "font-family": "Barlow Semi Condensed, Arial", "font-weight": 600, "font-size": 13, fill: "#8A86A0" }, svg).textContent = "0";
    const maximo = el("text", { x: lx1, y: ly1 + 4, "text-anchor": "middle", "font-family": "Barlow Semi Condensed, Arial", "font-weight": 700, "font-size": 15, fill: "#C8282E", class: "v-maximo" }, svg);
    maximo.textContent = "2.0";
    // aguja roja
    const aguja = el("g", {}, svg);
    el("path", { d: `M${CX - 6.5} ${CY} L${CX - 1.2} ${CY - 84} L${CX + 1.2} ${CY - 84} L${CX + 6.5} ${CY} Z`, fill: "#C8282E" }, aguja);
    // centro con lectura digital
    el("circle", { cx: CX, cy: CY, r: 38, fill: "#fff", stroke: "#3A167A", "stroke-width": 7 }, svg);
    const lectura = el("text", { x: CX, y: CY + 11, "text-anchor": "middle", "font-family": "Barlow Semi Condensed, Arial",
                                 "font-weight": 700, "font-style": "italic", "font-size": 31, fill: "#3A167A" }, svg);
    lectura.textContent = "0.0";
    // nombre
    const g = el("g", { class: "v-palabra" }, svg);
    el("text", { x: CX, y: 300, "text-anchor": "middle", "font-family": "Barlow Semi Condensed, Arial", "font-weight": 700, "font-size": 38, "letter-spacing": 2, fill: "#3A167A" }, g).textContent = "VERSIÓN 2.0";
    el("text", { x: CX, y: 326, "text-anchor": "middle", "font-family": "Barlow Semi Condensed, Arial", "font-weight": 600, "font-size": 15.5, "letter-spacing": 4.2, fill: "#C8282E" }, g).textContent = "ALIADO AUTOMOTRIZ";
    return { segs, aguja, lectura };
  }

  function iniciar() {
    const caja = $("#splash"), svg = $("#velocimetro");
    const { segs, aguja, lectura } = dibujar(svg);
    const poner = (g) => {   // g: ángulo de la aguja
      aguja.setAttribute("transform", `rotate(${g + 90} ${CX} ${CY})`);
      const f = Math.max(0, Math.min(1, (g - A0) / (A1 - A0)));
      lectura.textContent = (f * 2).toFixed(1);
      segs.forEach((s, i) => s.setAttribute("opacity", f >= (i + .5) / SEG ? 1 : .13));
    };
    let terminado = false;
    const cerrar = () => {
      if (terminado) return; terminado = true;
      caja.classList.add("fuera"); setTimeout(() => caja.remove(), 500);
    };
    caja.addEventListener("click", cerrar);
    const reducido = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducido) { poner(A1); caja.classList.add("marca", "listo"); setTimeout(cerrar, 900); return; }

    poner(A0);
    const DUR = 1500, inicio = performance.now() + 250;
    // Acelera como un motor que revoluciona, pasa un poco del máximo y se asienta en 2.0
    const curva = t => { const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    const cuadro = ahora => {
      if (terminado) return;
      const t = Math.min(1, Math.max(0, (ahora - inicio) / DUR));
      poner(A0 + (A1 - A0) * curva(t));
      if (t < 1) requestAnimationFrame(cuadro);
      else {
        lectura.textContent = "2.0";
        caja.classList.add("marca", "listo");
        setTimeout(cerrar, 950);
      }
    };
    requestAnimationFrame(cuadro);
  }
  return { iniciar };
})();

/* ======================= Inicio ======================= */
(async () => {
  Splash.iniciar();
  await cargarTodo();
  pintarItems();
  pintarCatalogo(); revisarNegocio();
  if (!matchMedia("(max-width:720px)").matches) $("#c-nombre").focus({ preventScroll: true });
})();
