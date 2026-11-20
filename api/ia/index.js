/* /api/ia/{accion} — funciones de inteligencia artificial de VETEX (plan Pro).
   La llave de la IA vive solo aquí (variable VETEX_IA_LLAVE); VETEX nunca la ve.
   POST factura  { clave, equipo, imagen (base64), tipo, catalogo:[{i,n,s,c,p:[[j,nombre,factor]]}], proveedores:[nombre] }
   POST pregunta { clave, equipo, pregunta, datos }  (datos = resumen del negocio, sin cédulas ni teléfonos)
   Variables: VETEX_IA_LLAVE, VETEX_IA_MODELO (por defecto claude-haiku-5-5), VETEX_IA_LIMITE (consultas por mes y licencia, 200) */
const L = require('../shared/lib');

const MODELO = () => process.env.VETEX_IA_MODELO || 'claude-haiku-5-5';
const LIMITE = () => Math.max(1, Number(process.env.VETEX_IA_LIMITE) || 200);
const LIMITE_PRUEBA = () => Math.max(1, Number(process.env.VETEX_IA_LIMITE_PRUEBA) || 20);   /* consultas en toda la prueba gratis */
const TOPE_DIA = () => Math.max(1, Number(process.env.VETEX_IA_TOPE_DIA) || 300);      /* entre TODOS los clientes */
const POR_MINUTO = () => Math.max(1, Number(process.env.VETEX_IA_POR_MINUTO) || 6);   /* por licencia */
/* Suma 1 a un contador sin que dos consultas al mismo tiempo se pisen (etag). Devuelve el nuevo valor o null si pasaría el tope. */
async function reservar(t, pk, rk, campo, periodo, tope) {
  for (let i = 0; i < 5; i++) {
    let e = null;
    try { e = await t.lic.getEntity(pk, rk); } catch (x) { if (x.statusCode !== 404) throw x; }
    const n = e && e[campo + 'P'] === periodo ? Number(e[campo]) || 0 : 0;
    if (n >= tope) return null;
    const nuevo = { partitionKey: pk, rowKey: rk, [campo]: n + 1, [campo + 'P']: periodo };
    try {
      if (!e) await t.lic.createEntity(nuevo); else await t.lic.updateEntity(nuevo, 'Merge', { etag: e.etag });
      return n + 1;
    } catch (x) { if (x.statusCode === 409 || x.statusCode === 412) continue; throw x; }
  }
  return null;
}
async function devolver(t, pk, rk, campo, periodo) {
  try { const e = await t.lic.getEntity(pk, rk); if (e[campo + 'P'] === periodo && Number(e[campo]) > 0) await t.lic.updateEntity({ partitionKey: pk, rowKey: rk, [campo]: Number(e[campo]) - 1 }, 'Merge', { etag: e.etag }); } catch { }
}
const mesActual = () => L.hoy().slice(0, 7);

async function claude(system, content, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.VETEX_IA_LLAVE, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO(), max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('IA respondió ' + r.status)); e.ia = r.status; throw e; }
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
function sacarJSON(t) {
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('La IA no devolvió datos legibles.');
  return JSON.parse(t.slice(a, b + 1));
}

const SYS_FACTURA = `Eres el asistente de compras de VETEX, un programa de punto de venta en Colombia.
Lees la foto o el PDF de una factura de un PROVEEDOR y devuelves SOLO un objeto JSON, sin texto antes ni después, con esta forma:
{"proveedor":"nombre del proveedor o null","numero":"número de factura o null","fecha":"AAAA-MM-DD o null","items":[{"desc":"texto del producto tal como aparece","cant":número,"costo":número,"total":número,"i":"id del producto del catálogo o null","pres":número,"seguro":true|false}],"subtotal":número o null,"iva":número o null,"total":número o null,"notas":"advertencias cortas o null"}
Reglas:
- Pesos colombianos: el punto separa miles y la coma decimales ("1.250,50" = 1250.5). Devuelve números sin símbolos.
- "costo" es el costo de UNA unidad de lo que dice "cant" en la factura, ANTES de IVA si la factura separa el IVA por línea; si solo hay valores con IVA, úsalos y dilo en "notas".
- Empareja cada línea con el catálogo (campo "i" = id). Usa nombre, código (s) y costo anterior (c) como pistas. Si no hay uno claramente igual, i = null. No inventes.
- Si la factura vende por paquete/caja y el producto del catálogo tiene esa presentación (lista p: [índice, nombre, unidades]), pon "pres" = ese índice y "cant" = cantidad de paquetes; si no, "pres" = -1 y "cant" en unidades.
- "seguro" = false si dudas del emparejamiento o de los números (letra borrosa, cortada).
- No incluyas fletes, descuentos globales ni totales como items; menciónalos en "notas".`;

const SYS_PREGUNTA = `Eres "VETEX", el asistente del dueño de un negocio en Colombia que usa el programa de punto de venta VETEX.
Respondes en español sencillo, cálido y breve (máximo 6 líneas, o una lista corta si ayuda), usando SOLO los datos del negocio que te entregan en JSON.
- Dinero en pesos colombianos con punto de miles: $1.250.000. Fechas en palabras ("martes 10 de noviembre").
- Si los datos no alcanzan para responder, dilo y sugiere dónde mirarlo en VETEX (Reportes, Ventas, Inventario, Clientes, Compras, Caja).
- No inventes cifras ni productos. Si haces un cálculo, que sea con los datos dados.
- Cuando sirva, termina con una recomendación práctica de una línea.
- No des asesoría legal ni tributaria; para eso, sugiere a su contador.`;

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const accion = String((context.bindingData && context.bindingData.accion) || '').toLowerCase();
  const b = L.cuerpoJSON(req);
  const clave = L.normClave(b.clave), equipo = String(b.equipo || '').toLowerCase();
  if (!process.env.VETEX_IA_LLAVE) { context.res = L.resp(200, { ok: false, motivo: 'sin_ia', mensaje: 'La inteligencia artificial aún no está activada en el servidor.' }); return; }
  if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clave) || !/^[a-f0-9]{64}$/.test(equipo)) { context.res = L.resp(200, { ok: false, mensaje: 'Licencia no válida.' }); return; }

  let t, lic;
  try { t = L.tablas(); await L.asegurarTablas(t); lic = await t.lic.getEntity('lic', clave); }
  catch (e) { context.res = L.resp(200, { ok: false, mensaje: e.statusCode === 404 ? 'Licencia no válida.' : 'El servidor no está disponible.' }); return; }
  if (!L.parseEquipos(lic).some(x => x.id === equipo)) { context.res = L.resp(200, { ok: false, mensaje: 'Este computador no está activado con esa licencia.' }); return; }
  if (lic.estado === 'bloqueada' || !L.esFecha(lic.vence) || lic.vence < L.hoy()) { context.res = L.resp(200, { ok: false, mensaje: 'La licencia no está al día.' }); return; }
  if (!lic.ia) { context.res = L.resp(200, { ok: false, motivo: 'sin_plan', mensaje: 'Las funciones de inteligencia artificial son del plan VETEX Pro. Pídeselas a tu proveedor de VETEX.' }); return; }

  /* Frenos de gasto: por minuto (por licencia), por mes (por licencia) y por día (todo el servidor). Se reservan ANTES de llamar a la IA. */
  const mes = mesActual(), dia = L.hoy(), minuto = new Date().toISOString().slice(0, 16);
  /* En la prueba gratis hay un cupo total (no mensual) en un contador aparte */
  const enPrueba = !!lic.prueba, CAMPO = enPrueba ? 'iaPru' : 'iaUso', PER = enPrueba ? 'prueba' : mes, TOPE = enPrueba ? LIMITE_PRUEBA() : LIMITE();
  const msgLim = enPrueba ? `Usaste las ${TOPE} consultas de IA de la prueba gratis. Con el plan Pro tienes ${LIMITE()} al mes.` : `Ya usaste las ${TOPE} consultas de IA de este mes. Se renuevan el día 1.`;
  const usoAntes = lic[CAMPO + 'P'] === PER ? Number(lic[CAMPO]) || 0 : 0;
  if (usoAntes >= TOPE) { context.res = L.resp(200, { ok: false, motivo: 'limite', mensaje: msgLim }); return; }
  if (!(await reservar(t, 'sys', 'ia-min-' + clave, 'n', minuto, POR_MINUTO()))) { context.res = L.resp(200, { ok: false, motivo: 'rapido', mensaje: 'Vas muy rápido. Espera un minuto y vuelve a intentar.' }); return; }
  if (!(await reservar(t, 'sys', 'ia-dia', 'n', dia, TOPE_DIA()))) { await L.evento(t, 'general', 'ia_tope_dia', 'Se alcanzó el tope diario de IA (' + TOPE_DIA() + ')'); context.res = L.resp(200, { ok: false, motivo: 'tope', mensaje: 'La IA está ocupada por hoy. Intenta de nuevo mañana.' }); return; }
  const uso = await reservar(t, 'lic', clave, CAMPO, PER, TOPE);
  if (!uso) { await devolver(t, 'sys', 'ia-dia', 'n', dia); context.res = L.resp(200, { ok: false, motivo: 'limite', mensaje: msgLim }); return; }
  let cobrada = false;
  const contar = async () => { cobrada = true; };

  try {
    if (accion === 'factura') {
      const img = String(b.imagen || ''), tipo = String(b.tipo || 'image/jpeg');
      if (!img || img.length > 9.5e6) { await devolver(t, 'lic', clave, CAMPO, PER); await devolver(t, 'sys', 'ia-dia', 'n', dia); context.res = L.resp(200, { ok: false, mensaje: 'La imagen está vacía o es muy grande (máximo unos 7 MB).' }); return; }
      if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(tipo)) { await devolver(t, 'lic', clave, CAMPO, PER); await devolver(t, 'sys', 'ia-dia', 'n', dia); context.res = L.resp(200, { ok: false, mensaje: 'Usa una foto (JPG o PNG) o un PDF.' }); return; }
      const cat = (Array.isArray(b.catalogo) ? b.catalogo : []).slice(0, 1500);
      const provs = (Array.isArray(b.proveedores) ? b.proveedores : []).slice(0, 200).map(x => String(x).slice(0, 80));
      const doc = tipo === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: tipo, data: img } }
        : { type: 'image', source: { type: 'base64', media_type: tipo, data: img } };
      const texto = await claude(SYS_FACTURA, [doc, { type: 'text', text: 'Proveedores conocidos: ' + JSON.stringify(provs) + '\nCatálogo del negocio (i=id, n=nombre, s=código, c=costo anterior por unidad, p=presentaciones): ' + JSON.stringify(cat) + '\nLee la factura y devuelve el JSON.' }], 6000);
      const d = sacarJSON(texto);
      const ids = new Set(cat.map(x => String(x.i)));
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 200).map(x => ({
        desc: String(x.desc || '').slice(0, 160), cant: Math.max(0, Number(x.cant) || 0), costo: Math.max(0, Number(x.costo) || 0), total: Math.max(0, Number(x.total) || 0),
        i: x.i != null && ids.has(String(x.i)) ? String(x.i) : null, pres: Number.isInteger(x.pres) ? x.pres : -1, seguro: x.seguro !== false
      }));
      await contar(); await L.evento(t, clave, 'ia_factura', `${items.length} líneas · ${d.proveedor || ''}`.slice(0, 200));
      context.res = L.resp(200, { ok: true, proveedor: d.proveedor || '', numero: d.numero || '', fecha: /^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '') ? d.fecha : '', items, subtotal: Number(d.subtotal) || 0, iva: Number(d.iva) || 0, total: Number(d.total) || 0, notas: d.notas || '', usadas: uso, limite: TOPE, prueba: enPrueba }); return;
    }
    if (accion === 'pregunta') {
      const q = String(b.pregunta || '').trim().slice(0, 500);
      if (!q) { await devolver(t, 'lic', clave, CAMPO, PER); await devolver(t, 'sys', 'ia-dia', 'n', dia); context.res = L.resp(200, { ok: false, mensaje: 'Escribe tu pregunta.' }); return; }
      const datos = JSON.stringify(b.datos || {}).slice(0, 120000);
      const texto = await claude(SYS_PREGUNTA, [{ type: 'text', text: 'Datos del negocio (JSON):\n' + datos + '\n\nPregunta del dueño: ' + q }], 1200);
      await contar();
      context.res = L.resp(200, { ok: true, respuesta: texto, usadas: uso, limite: TOPE, prueba: enPrueba }); return;
    }
    context.res = L.resp(404, { ok: false, mensaje: 'Acción no válida' });
  } catch (e) {
    context.log.error(e);
    if (!cobrada) { await devolver(t, 'lic', clave, CAMPO, PER); await devolver(t, 'sys', 'ia-dia', 'n', dia); }   /* si falló, no cuenta */
    context.res = L.resp(200, { ok: false, mensaje: e.ia ? 'La IA no pudo responder ahora. Intenta en un momento.' : 'No se pudo leer la respuesta de la IA. Intenta con una foto más clara.' });
  }
};
