/* POST /api/respaldo — copias de seguridad de VETEX en la nube.
   Cuerpo: { accion:'subir'|'listar'|'bajar', clave, equipo, datos?, nombre?, version? }
   Los datos llegan ya cifrados desde VETEX (AES-GCM con una llave derivada de la clave de licencia).
   Solo un computador registrado en la licencia puede subir, listar o bajar sus copias. */
const L = require('../shared/lib');

const MAX_COPIAS = 30;                 /* se guardan las últimas 30 copias por licencia */
const MAX_BYTES = 25 * 1024 * 1024;    /* 25 MB por copia (ya comprimida y cifrada) */

let _cont = null;
async function contenedor() {
  if (_cont) return _cont;
  const { BlobServiceClient } = require('@azure/storage-blob');
  const svc = BlobServiceClient.fromConnectionString(process.env.VETEX_STORAGE);
  const c = svc.getContainerClient('respaldos');
  await c.createIfNotExists(); /* privado: sin acceso público */
  _cont = c;
  return c;
}
async function listar(c, clave) {
  const out = [];
  for await (const b of c.listBlobsFlat({ prefix: clave + '/', includeMetadata: true })) {
    out.push({ nombre: b.name, fecha: (b.properties.createdOn || b.properties.lastModified || new Date()).toISOString(), tam: b.properties.contentLength || 0, equipo: (b.metadata && b.metadata.equipo || '').slice(0, 8), version: b.metadata && b.metadata.version || '' });
  }
  return out.sort((a, b) => b.nombre.localeCompare(a.nombre));
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const b = L.cuerpoJSON(req);
  const accion = String(b.accion || '');
  const clave = L.normClave(b.clave);
  const equipo = String(b.equipo || '').toLowerCase();
  const no = (motivo, mensaje) => { context.res = L.resp(200, { ok: false, motivo, mensaje }); };
  if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clave)) return no('clave_invalida', 'Clave de licencia no válida.');
  if (!/^[a-f0-9]{64}$/.test(equipo)) return no('equipo_invalido', 'No se pudo identificar este computador.');

  let t, lic;
  try { t = L.tablas(); await L.asegurarTablas(t); lic = await t.lic.getEntity('lic', clave); }
  catch (e) { if (e.statusCode === 404) return no('no_existe', 'Esa clave de licencia no existe.'); context.log.error(e); context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'Error del servidor.' }); return; }
  /* Sus datos son del cliente: aunque la licencia esté vencida o suspendida, puede respaldar y recuperar */
  if (!L.parseEquipos(lic).some(x => x.id === equipo)) return no('equipo_no_registrado', 'Este computador no está activado con esa licencia.');

  try {
    const c = await contenedor();
    if (accion === 'subir') {
      const buf = Buffer.from(String(b.datos || ''), 'base64');
      if (buf.length < 32 || buf.slice(0, 4).toString() !== 'VXB1') return no('datos_invalidos', 'La copia llegó dañada.');
      if (buf.length > MAX_BYTES) return no('muy_grande', 'La copia es demasiado grande.');
      const ahora = new Date().toISOString();
      const nombre = `${clave}/${ahora.replace(/[:.]/g, '-')}.vxb`;
      await c.getBlockBlobClient(nombre).uploadData(buf, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' }, metadata: { equipo: equipo.slice(0, 16), version: String(b.version || '').replace(/[^\w .-]/g, '').slice(0, 30) } });
      const todas = await listar(c, clave);
      for (const v of todas.slice(MAX_COPIAS)) await c.deleteBlob(v.nombre).catch(() => {});
      await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, ultimoRespaldo: ahora, respaldoTam: buf.length, respaldos: Math.min(todas.length, MAX_COPIAS) }, 'Merge').catch(() => {});
      context.res = L.resp(200, { ok: true, nombre, fecha: ahora, tam: buf.length }); return;
    }
    if (accion === 'listar') { context.res = L.resp(200, { ok: true, copias: await listar(c, clave) }); return; }
    if (accion === 'bajar') {
      const nombre = String(b.nombre || '');
      if (!nombre.startsWith(clave + '/') || nombre.includes('..')) return no('nombre_invalido', 'Copia no válida.');
      const buf = await c.getBlockBlobClient(nombre).downloadToBuffer().catch(e => { if (e.statusCode === 404) return null; throw e; });
      if (!buf) return no('no_existe_copia', 'Esa copia ya no existe.');
      await L.evento(t, clave, 'restauracion', `copia ${nombre.split('/')[1]} · equipo ${equipo.slice(0, 12)}`);
      context.res = L.resp(200, { ok: true, datos: buf.toString('base64') }); return;
    }
    no('accion_invalida', 'Acción no válida.');
  } catch (e) {
    context.log.error(e);
    context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'No se pudo guardar la copia. Se intentará de nuevo más tarde.' });
  }
};
