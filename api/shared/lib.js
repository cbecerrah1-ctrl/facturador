/* Utilidades compartidas del servidor de licencias VETEX */
const crypto = require('crypto');

let _tables = null;
/* Tablas de Azure Storage: "licencias" (una fila por cliente) y "eventos" (historial) */
function tablas() {
  if (_tables) return _tables;
  const cs = process.env.VETEX_STORAGE;
  if (!cs) throw new Error('Falta la variable VETEX_STORAGE (cadena de conexión de la cuenta de almacenamiento)');
  const { TableClient } = require('@azure/data-tables');
  _tables = {
    lic: TableClient.fromConnectionString(cs, 'licencias'),
    ev: TableClient.fromConnectionString(cs, 'eventos'),
    pg: TableClient.fromConnectionString(cs, 'pagos'),
    tr: TableClient.fromConnectionString(cs, 'traslados'),
    listo: null
  };
  return _tables;
}
async function asegurarTablas(t) {
  if (!t.listo) t.listo = Promise.all([t.lic.createTable().catch(ignorarExiste), t.ev.createTable().catch(ignorarExiste), t.pg.createTable().catch(ignorarExiste), t.tr.createTable().catch(ignorarExiste)]);
  return t.listo;
}
function ignorarExiste(e) { if (e && (e.statusCode === 409 || /TableAlreadyExists/i.test(e.code || e.message))) return; throw e; }

/* Firma ECDSA P-256 (SHA-256, formato r||s) — VETEX la verifica con la llave pública */
let _llave = null;
function llavePrivada() {
  if (_llave) return _llave;
  const b64 = (process.env.VETEX_LLAVE_PRIVADA || '').replace(/\s+/g, '');
  if (!b64) throw new Error('Falta la variable VETEX_LLAVE_PRIVADA');
  _llave = crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  return _llave;
}
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function firmar(payload) {
  const datos = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const firma = crypto.sign('sha256', Buffer.from(datos, 'utf8'), { key: llavePrivada(), dsaEncoding: 'ieee-p1363' });
  return datos + '.' + b64url(firma);
}

/* Claves tipo VTX-7K3M-Q9PX-2DWF (sin letras que se confunden: 0/O, 1/I/L) */
const ALFA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function nuevaClave() {
  const b = crypto.randomBytes(12); let s = '';
  for (let i = 0; i < 12; i++) s += ALFA[b[i] % ALFA.length];
  return 'VTX-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
/* Secreto del código técnico (TOTP, como las apps autenticadoras): 20 bytes en base32 */
function nuevoSecreto() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', b = crypto.randomBytes(20); let bits = 0, val = 0, out = '';
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
const normClave = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VTX/, '').replace(/(.{4})(.{4})(.{4}).*/, 'VTX-$1-$2-$3');

const hoy = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); /* fecha de Colombia */
const sumarMeses = (fecha, m) => { const d = new Date(fecha + 'T12:00:00Z'); const dia = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + m); const ult = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(dia, ult)); return d.toISOString().slice(0, 10); };
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/* Respuestas JSON con CORS abierto: VETEX se abre como archivo local (origen "null") */
function resp(status, cuerpo) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(cuerpo)
  };
}
function cuerpoJSON(req) {
  /* Siempre devuelve un objeto: un cuerpo "null", un arreglo o un texto suelto no deben tumbar la función */
  const obj = x => (x && typeof x === 'object' && !Array.isArray(x)) ? x : {};
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return obj(req.body);
  try { return obj(JSON.parse(req.rawBody || (req.body ? String(req.body) : '{}'))); } catch { return {}; }
}

/* Usuario que entró al panel (lo pone Static Web Apps en este encabezado) */
function usuario(req) {
  const h = req.headers && (req.headers['x-ms-client-principal'] || req.headers['X-MS-CLIENT-PRINCIPAL']);
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { return null; }
}
const esAdmin = u => !!(u && Array.isArray(u.userRoles) && u.userRoles.includes('admin'));

async function evento(t, clave, tipo, detalle) {
  try {
    const ts = Date.now();
    await t.ev.createEntity({ partitionKey: clave || 'general', rowKey: String(9999999999999 - ts) + '-' + crypto.randomBytes(3).toString('hex'), tipo, detalle: String(detalle || '').slice(0, 900), fecha: new Date(ts).toISOString() });
  } catch { /* el historial nunca debe tumbar la respuesta */ }
}

const parseEquipos = e => { try { const a = JSON.parse(e.equipos || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/* ---------- Pagos en línea con Wompi ----------
   Variables: WOMPI_PUBLICA (pub_test_… o pub_prod_…), WOMPI_INTEGRIDAD, WOMPI_EVENTOS.
   Precios por defecto (COP); se pueden cambiar con VETEX_PRECIOS = {"mensual":49900,"anual":499000,"extraMensual":16900,"extraAnual":169000} */
function precios() {
  const d = { mensual: 49900, anual: 499000, extraMensual: 16900, extraAnual: 169000, proMensual: 17900, proAnual: 179000 };
  try { return { ...d, ...JSON.parse(process.env.VETEX_PRECIOS || '{}') }; } catch { return d; }
}
/* Los 4 planes (Básico o Pro, por mes o por año) con su desglose. Pagar un plan Pro activa la IA y el diseño Ejecutivo. */
const diasPrueba = () => Math.max(3, Math.min(60, Number(process.env.VETEX_DIAS_PRUEBA) || 15));
const normNit = s => String(s || '').replace(/[^0-9]/g, '').replace(/^(\d{9})\d$/, '$1');   /* sin puntos ni dígito de verificación */
function planes(maxEquipos) {
  const P = precios(), extra = Math.max(0, (Number(maxEquipos) || 1) - 1), r = [];
  for (const pro of [false, true]) for (const anual of [false, true]) {
    const d = { base: anual ? P.anual : P.mensual, extra: extra * (anual ? P.extraAnual : P.extraMensual), cajasExtra: extra, pro: pro ? (anual ? P.proAnual : P.proMensual) : 0 };
    r.push({ k: (anual ? 'anual' : 'mensual') + (pro ? '-pro' : ''), n: (anual ? '1 año' : '1 mes') + (pro ? ' · Pro' : ''), meses: anual ? 12 : 1, pro, monto: d.base + d.extra + d.pro, desglose: d, ...(anual ? { nota: '2 meses gratis' } : {}) });
  }
  return r;
}
const wompi = () => {
  const pub = process.env.WOMPI_PUBLICA || '';
  const prod = pub.startsWith('pub_prod_');
  return { pub, integridad: process.env.WOMPI_INTEGRIDAD || '', eventos: process.env.WOMPI_EVENTOS || '', prod,
    api: prod ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1', checkout: 'https://checkout.wompi.co/p/', listo: !!(pub && process.env.WOMPI_INTEGRIDAD) };
};
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const firmaIntegridad = (ref, centavos, moneda, secreto) => sha256(`${ref}${centavos}${moneda}${secreto}`);
/* Firma de los eventos de Wompi: valores de signature.properties (en orden) + timestamp + secreto de eventos */
function eventoValido(body, secreto, encabezado) {
  try {
    const sg = body.signature || {}, props = Array.isArray(sg.properties) ? sg.properties : [];
    if (!secreto || !props.length || body.timestamp == null) return false;
    const val = props.map(p => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), body.data)).map(v => v == null ? '' : String(v)).join('');
    const calc = sha256(val + String(body.timestamp) + secreto).toUpperCase();
    const dado = String(sg.checksum || encabezado || '').toUpperCase();
    return dado.length === 64 && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(dado));
  } catch { return false; }
}
const pesos = c => '$' + Math.round(c / 100).toLocaleString('es-CO');
/* Aplica una transacción de Wompi (del evento o consultada a su API). Idempotente: un pago solo suma una vez. */
async function aplicarPago(t, tx, via) {
  const ref = String(tx && tx.reference || ''), clave = ref.slice(0, 18);
  if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[AM]-[A-Z0-9]+$/.test(ref)) return { ok: false, estado: 'desconocido' };
  let pg; try { pg = await t.pg.getEntity(clave, ref); } catch (e) { if (e.statusCode === 404) { await evento(t, clave, 'pago_desconocido', ref + ' · ' + (tx.status || '')); return { ok: false, estado: 'desconocido' }; } throw e; }
  if (pg.estado === 'aprobado') { const l = await t.lic.getEntity('lic', clave); return { ok: true, estado: 'aprobado', vence: l.vence, negocio: l.negocio || '', yaAplicado: true }; }
  const st = String(tx.status || '').toUpperCase();
  if (st !== 'APPROVED') {
    if (['DECLINED', 'VOIDED', 'ERROR'].includes(st) && pg.estado !== st.toLowerCase()) { await t.pg.updateEntity({ partitionKey: clave, rowKey: ref, estado: st.toLowerCase(), txId: String(tx.id || ''), actualizado: new Date().toISOString() }, 'Merge'); await evento(t, clave, 'pago_rechazado', `${pesos(pg.monto)} · ${st} · ${tx.payment_method_type || ''}`); }
    return { ok: false, estado: st ? st.toLowerCase() : 'pendiente' };
  }
  if (Number(tx.amount_in_cents) !== Number(pg.monto) || (tx.currency && tx.currency !== 'COP')) {
    await evento(t, clave, 'pago_monto_distinto', `${ref} · esperado ${pesos(pg.monto)} · llegó ${pesos(tx.amount_in_cents)}`);
    return { ok: false, estado: 'revisar' };
  }
  /* Marca el pago como aprobado solo si nadie lo marcó antes (etag): así el evento y la confirmación no suman dos veces */
  try { await t.pg.updateEntity({ partitionKey: clave, rowKey: ref, estado: 'aprobado', txId: String(tx.id || ''), metodo: String(tx.payment_method_type || ''), aprobado: new Date().toISOString(), via }, 'Merge', { etag: pg.etag }); }
  catch (e) { if (e.statusCode === 412) { const l = await t.lic.getEntity('lic', clave); return { ok: true, estado: 'aprobado', vence: l.vence, negocio: l.negocio || '', yaAplicado: true }; } throw e; }
  const lic = await t.lic.getEntity('lic', clave);
  const base = esFecha(lic.vence) && lic.vence > hoy() ? lic.vence : hoy();
  const vence = sumarMeses(base, Number(pg.meses) || 1);
  const cambioPlan = typeof pg.pro === 'boolean' && pg.pro !== !!lic.ia;
  await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, vence, ultimoPago: new Date().toISOString(), ultimoPagoMonto: Number(pg.monto) / 100, ultimoPagoPlan: pg.plan || '', ...(typeof pg.pro === 'boolean' ? { ia: pg.pro } : {}), ...(lic.prueba ? { prueba: false, convertida: new Date().toISOString() } : {}) }, 'Merge');
  await evento(t, clave, 'pago', `${pesos(pg.monto)} · ${String(pg.plan || '').startsWith('anual') ? '1 año' : '1 mes'}${pg.pro ? ' · Pro' : ''} · ${tx.payment_method_type || ''} · vence ${vence}${cambioPlan ? (pg.pro ? ' · pasó a Pro' : ' · pasó a Básico') : ''}${lic.prueba ? ' · 🎉 prueba convertida en cliente' : ''}`);
  return { ok: true, estado: 'aprobado', vence, negocio: lic.negocio || '' };
}

module.exports = { diasPrueba, normNit, precios, planes, wompi, sha256, firmaIntegridad, eventoValido, aplicarPago, pesos, nuevoSecreto, tablas, asegurarTablas, firmar, nuevaClave, normClave, hoy, sumarMeses, esFecha, resp, cuerpoJSON, usuario, esAdmin, evento, parseEquipos };
