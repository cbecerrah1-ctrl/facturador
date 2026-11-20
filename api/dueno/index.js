/* POST /api/dueno — resumen del negocio para el celular del dueño.
   Desde VETEX (computador activado): 'subir' el resumen, 'vincular' un celular, 'desvincular' todos.
   Desde el celular: 'leer' con la clave y el código que le dio el QR.
   El resumen llega cifrado desde VETEX; solo el celular (que tiene la clave) lo puede abrir. */
const crypto = require('crypto');
const L = require('../shared/lib');
const MAX_CEL = 5, MAX_BYTES = 2 * 1024 * 1024;

let _cont = null;
async function contenedor() {
  if (_cont) return _cont;
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.VETEX_STORAGE).getContainerClient('resumenes');
  await c.createIfNotExists();
  _cont = c;
  return c;
}
const parseCel = e => { try { const a = JSON.parse(e.duenoTokens || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const b = L.cuerpoJSON(req);
  const accion = String(b.accion || '');
  const clave = L.normClave(b.clave);
  const no = (motivo, mensaje) => { context.res = L.resp(200, { ok: false, motivo, mensaje }); };
  if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clave)) return no('clave_invalida', 'El enlace no es válido.');

  let t, lic;
  try { t = L.tablas(); await L.asegurarTablas(t); lic = await t.lic.getEntity('lic', clave); }
  catch (e) { if (e.statusCode === 404) return no('no_existe', 'Esta conexión ya no existe.'); context.log.error(e); context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'Error del servidor.' }); return; }
  const cels = parseCel(lic);

  try {
    if (accion === 'leer') {
      const token = String(b.token || '');
      if (token.length < 20) return no('token', 'El enlace no es válido.');
      const h = sha(token), i = cels.findIndex(x => x.h === h);
      if (i < 0) return no('desvinculado', 'Este celular fue desconectado. Pide un nuevo código QR en VETEX.');
      const c = await contenedor();
      const blob = c.getBlockBlobClient(clave + '.vxb');
      const buf = await blob.downloadToBuffer().catch(e => { if (e.statusCode === 404) return null; throw e; });
      cels[i].ultimo = new Date().toISOString();
      await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, duenoTokens: JSON.stringify(cels) }, 'Merge').catch(() => {});
      if (!buf) return no('sin_datos', 'VETEX todavía no ha enviado el primer resumen. Abre VETEX en el computador del negocio.');
      context.res = L.resp(200, { ok: true, datos: buf.toString('base64'), fecha: lic.resumenFecha || '' }); return;
    }

    /* Las demás acciones solo las puede hacer un computador activado con la licencia */
    const equipo = String(b.equipo || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(equipo) || !L.parseEquipos(lic).some(x => x.id === equipo)) return no('equipo_no_registrado', 'Este computador no está activado con esa licencia.');

    if (accion === 'subir') {
      const buf = Buffer.from(String(b.datos || ''), 'base64');
      if (buf.length < 32 || buf.slice(0, 4).toString() !== 'VXB1' || buf.length > MAX_BYTES) return no('datos_invalidos', 'Resumen inválido.');
      const c = await contenedor();
      await c.getBlockBlobClient(clave + '.vxb').uploadData(buf, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
      const ahora = new Date().toISOString();
      await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, resumenFecha: ahora }, 'Merge').catch(() => {});
      context.res = L.resp(200, { ok: true, fecha: ahora, celulares: cels.length }); return;
    }
    if (accion === 'vincular') {
      const h = String(b.tokenHash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(h)) return no('token', 'Código inválido.');
      const nombre = String(b.nombre || 'Celular').slice(0, 40);
      const nuevos = [...cels.filter(x => x.h !== h), { h, nombre, fecha: new Date().toISOString(), ultimo: '' }].slice(-MAX_CEL);
      await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, duenoTokens: JSON.stringify(nuevos) }, 'Merge');
      await L.evento(t, clave, 'celular_conectado', nombre);
      context.res = L.resp(200, { ok: true, celulares: nuevos.length }); return;
    }
    if (accion === 'desvincular') {
      await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, duenoTokens: '[]' }, 'Merge');
      await L.evento(t, clave, 'celulares_desconectados', String(cels.length));
      context.res = L.resp(200, { ok: true, celulares: 0 }); return;
    }
    if (accion === 'estado') { context.res = L.resp(200, { ok: true, celulares: cels.map(x => ({ nombre: x.nombre, fecha: x.fecha, ultimo: x.ultimo })) }); return; }
    no('accion_invalida', 'Acción no válida.');
  } catch (e) {
    context.log.error(e);
    context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'Error del servidor. Intenta de nuevo.' });
  }
};
