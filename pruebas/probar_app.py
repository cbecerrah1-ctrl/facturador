"""Batería de pruebas del Facturador. Cada prueba dice lo que la app DEBE hacer."""
import asyncio, base64, json, subprocess, sys
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090/"
R = []
def chk(nombre, ok, detalle=""):
    R.append((nombre, bool(ok), detalle)); print(("PASA " if ok else "FALLA") + f"  {nombre}" + (f"  -> {detalle}" if detalle and not ok else ""))

async def nueva(b, movil=False):
    ctx = await b.new_context(**(b._pw.devices["Pixel 7"] if movil else {"viewport": {"width": 1360, "height": 860}}), accept_downloads=True)
    pg = await ctx.new_page(); pg._errs = []
    pg.on("pageerror", lambda e: pg._errs.append(str(e)))
    pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await pg.goto(URL); await pg.wait_for_function("!document.querySelector('#splash')", timeout=6000)
    return ctx, pg

async def agregar(pg, texto):
    await pg.fill("#buscar-prod", texto); await pg.dispatch_event("#buscar-prod", "input"); await pg.wait_for_timeout(80)
    await pg.press("#buscar-prod", "Enter")

async def libre(pg, desc, cant, precio):
    await pg.click("#agregar-libre")
    fila = pg.locator("#items .item").last
    await fila.locator(".desc").fill(desc); await fila.locator(".cant").fill(cant); await fila.locator(".precio").fill(precio)

async def generar(pg):
    await pg.click("#generar"); await pg.wait_for_timeout(500)

docs = lambda pg: pg.evaluate("E.documentos.map(d=>d.numero)")
async def pdf_texto(pg, numero):
    b64 = await pg.evaluate("""async n=>{const d=E.documentos.find(x=>x.numero===n);const bl=await PDF.crear(d,E.cfg);
      const u=new Uint8Array(await bl.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)}""", numero)
    open("./t.pdf", "wb").write(base64.b64decode(b64))
    txt = subprocess.run(["pdftotext", "-layout", "./t.pdf", "-"], capture_output=True, text=True).stdout
    pags = subprocess.run(["pdfinfo", "./t.pdf"], capture_output=True, text=True).stdout
    return txt, int([l for l in pags.splitlines() if l.startswith("Pages")][0].split()[-1])

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); b._pw = p

        # ---------- 1. Carga ----------
        ctx, pg = await nueva(b)
        chk("Carga sin errores y con 6 trabajos en el inventario", not pg._errs and await pg.evaluate("E.inventario.length") == 6, pg._errs)

        # ---------- 1b. Facilidad de uso ----------
        chk("La lista de trabajos se ve sin escribir nada", await pg.locator("#catalogo [data-cat]").count() == 6)
        await pg.locator("#catalogo [data-cat]").first.click(); await pg.locator("#catalogo [data-cat]").first.click()
        chk("Tocar dos veces un trabajo suma 2", await pg.evaluate("items.length") == 1 and await pg.evaluate("items[0].cantidad") == 2)
        await pg.click("[data-mas='0']"); await pg.click("[data-menos='0']"); await pg.click("[data-menos='0']"); await pg.click("[data-menos='0']")
        chk("Los botones + y − cambian la cantidad y no bajan de 1", await pg.evaluate("items[0].cantidad") == 1)
        await pg.click("[data-quitar='0']")
        chk("Quitar deja la lista vacía", await pg.evaluate("items.length") == 0)
        await pg.click("#generar")
        chk("Si falta algo, dice qué paso revisar", "paso 3" in await pg.inner_text("#aviso"))
        await pg.fill("#buscar-prod", "zzzz"); await pg.dispatch_event("#buscar-prod", "input")
        chk("Buscar algo que no existe explica qué hacer", "No hay trabajos con esa palabra" in await pg.inner_text("#catalogo"))
        await pg.fill("#buscar-prod", ""); await pg.dispatch_event("#buscar-prod", "input")
        tam0 = await pg.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        await pg.click('nav [data-vista="ajustes"]'); await pg.click('[data-tam="muy-grande"]')
        tam1 = await pg.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        chk("La letra normal es de al menos 18 px y 'Muy grande' la agranda", tam0 >= 18 and tam1 > tam0 * 1.2, [tam0, tam1])
        await pg.reload(); await pg.wait_for_function("!document.querySelector('#splash')", timeout=6000)
        chk("El tamaño de letra se recuerda al volver a abrir", await pg.evaluate("document.documentElement.dataset.tam") == "muy-grande")
        await pg.click('nav [data-vista="ajustes"]'); await pg.click('[data-tam="normal"]'); await pg.click('nav [data-vista="nuevo"]')
        pequenos = await pg.evaluate("""[...document.querySelectorAll('#v-nuevo button, #v-nuevo input')].filter(e=>e.offsetParent).filter(e=>e.getBoundingClientRect().height < 44).map(e=>e.id||e.className)""")
        chk("Botones y campos de al menos 44 px de alto (fáciles de tocar)", not pequenos, pequenos)

        # ---------- 2. Cotización normal y doble clic ----------
        await pg.fill("#c-nombre", "Edwuin Daniel Gil Gómez"); await pg.fill("#c-documento", "1023456789")
        await pg.fill("#c-telefono", "310 123 4567"); await pg.fill("#c-vehiculo", "Ambulancia Renault Master"); await pg.fill("#c-placa", "jkl123")
        await agregar(pg, "camilla"); await agregar(pg, "base camilla")
        await libre(pg, "Cojinería cabina", "1", "120.000")
        await generar(pg)
        d = await docs(pg)
        chk("Cotización COT-A0001 creada por $350.000", d == ["COT-A0001"] and await pg.evaluate("E.documentos[0].total") == 350000, d)
        await pg.click("#generar", force=True); await pg.wait_for_timeout(500)
        chk("Un segundo clic en Generar no duplica el documento", len(await docs(pg)) == 1, await docs(pg))
        chk("La placa se guarda en mayúsculas", await pg.evaluate("E.documentos[0].cliente.placa") == "JKL123")

        # ---------- 3. Validaciones ----------
        await pg.click("#l-nuevo")
        await generar(pg)
        chk("Sin trabajos no deja generar", len(await docs(pg)) == 1 and "trabajo" in (await pg.inner_text("#aviso")).lower())
        await libre(pg, "Trabajo de prueba", "1", "0"); await generar(pg)
        chk("Con total en $0 no deja generar", len(await docs(pg)) == 1, await pg.inner_text("#aviso"))
        await pg.locator("#items .item .precio").last.fill("-50000"); await generar(pg)
        chk("Con precio negativo no deja generar", len(await docs(pg)) == 1, await pg.inner_text("#aviso"))
        await pg.locator("#items .item .cant").last.fill("2,5"); await pg.locator("#items .item .precio").last.fill("100000")
        await pg.click('.tipos [data-tipo="FACTURA"]'); await generar(pg)
        chk("Cantidad decimal 2,5 × $100.000 = $250.000", await pg.evaluate("E.documentos[0].total") == 250000, await pg.evaluate("E.documentos[0].total"))
        chk("Factura sin nombre queda como Consumidor final", await pg.evaluate("E.documentos[0].cliente.nombre") == "Consumidor final")
        msg = await pg.evaluate("mensaje(E.documentos[0])")
        chk("El mensaje de WhatsApp no saluda a 'Consumidor final'", "Hola Consumidor" not in msg, msg)

        # ---------- 3b. Sin C.C. ni NIT ----------
        await pg.click("#l-nuevo"); await pg.click('.tipos [data-tipo="FACTURA"]')
        await pg.fill("#c-nombre", "Cliente sin cédula"); await agregar(pg, "tapete")
        n0 = len(await docs(pg)); await generar(pg)
        chk("Factura con nombre y sin C.C./NIT se crea", len(await docs(pg)) == n0 + 1 and await pg.evaluate("E.documentos[0].cliente.documento") == "", await pg.inner_text("#aviso"))
        await pg.click("#l-nuevo"); await pg.click('.tipos [data-tipo="FACTURA"]'); await agregar(pg, "tapete"); await generar(pg)
        chk("Factura a consumidor final no inventa un número de documento", await pg.evaluate("E.documentos[0].cliente.documento") == "", await pg.evaluate("E.documentos[0].cliente.documento"))
        await pg.click("#l-nuevo"); await pg.click('.tipos [data-tipo="CUENTA_COBRO"]')
        await pg.fill("#c-nombre", "Taller El Amigo"); await pg.fill("#concepto", "Arreglo de silla"); await pg.fill("#valor", "50000")
        n0 = len(await docs(pg)); await generar(pg)
        chk("Cuenta de cobro sin C.C./NIT se crea", len(await docs(pg)) == n0 + 1, await pg.inner_text("#aviso"))
        txt, _ = await pdf_texto(pg, (await docs(pg))[0])
        chk("El PDF muestra — donde iría la C.C./NIT", "C.C. / NIT" in txt and "—" in txt)
        await pg.evaluate("E.documentos = E.documentos.filter(d => !['FV-A0002','FV-A0003','CC-A0001'].includes(d.numero)); E.equipo.FV = 2; E.equipo.CC = 1")

        # ---------- 4. Cuenta de cobro ----------
        await pg.click("#l-nuevo"); await pg.click('.tipos [data-tipo="CUENTA_COBRO"]')
        await pg.fill("#c-nombre", "Ov Logistics SAS"); await pg.fill("#c-documento", "900496332"); await pg.fill("#valor", "200.000")
        n0 = len(await docs(pg)); await generar(pg)
        chk("Cuenta de cobro sin concepto ni trabajos no se genera", len(await docs(pg)) == n0, await pg.inner_text("#aviso"))
        await pg.fill("#concepto", "Tapetes de piso camión Dongfeng"); await generar(pg)
        chk("Cuenta de cobro por valor fijo: CC-A0001 por $200.000", (await docs(pg))[0] == "CC-A0001" and await pg.evaluate("E.documentos[0].total") == 200000)
        txt, _ = await pdf_texto(pg, "CC-A0001")
        chk("PDF de cuenta de cobro tiene el valor en letras", "DOSCIENTOS MIL PESOS" in txt)

        # ---------- 5. Muchos trabajos y caracteres raros ----------
        await pg.click("#l-nuevo"); await pg.click('.tipos [data-tipo="COTIZACION"]')
        await pg.fill("#c-nombre", "José “Pepe” Muñoz 🚗 & <b>Cía</b>")
        await pg.evaluate("for(let i=1;i<=45;i++) items.push({ref:'R'+i,descripcion:'Trabajo número '+i+' – con guion largo',cantidad:1,precio:1000,unidad:'und'}); pintarItems()")
        await generar(pg)
        num = (await docs(pg))[0]
        txt, pags = await pdf_texto(pg, num)
        chk("45 trabajos: el PDF se reparte en varias páginas", pags >= 2, f"{pags} páginas")
        chk("PDF con nombre raro conserva José, Muñoz y Cía", all(x in txt for x in ["José", "Muñoz", "Cía"]), txt[:300])
        chk("PDF sin caracteres basura del emoji", "Ø" not in txt and "=Þ" not in txt, [l for l in txt.splitlines() if "Muñoz" in l][:1])
        await pg.click('nav [data-vista="historial"]'); await pg.wait_for_timeout(200)
        chk("El historial muestra <b> como texto, no como código", await pg.locator("#h-lista b:text('Cía')").count() == 0)

        # ---------- 6. Facturar cotización ----------
        await pg.locator('[data-facturar="COT-A0001"]').click(); await pg.wait_for_timeout(200)
        chk("Pasar a factura pregunta en una ventana grande del programa", await pg.is_visible("#modal") and "factura" in (await pg.inner_text("#m-titulo")).lower())
        await pg.click("#m-acciones .primario"); await pg.wait_for_timeout(800)
        chk("Después pregunta si enviarla por WhatsApp", "¿Quiere enviarla" in await pg.inner_text("#m-texto"))
        await pg.click("#m-acciones button"); await pg.wait_for_timeout(150)
        fac = await pg.evaluate("E.documentos.find(d=>d.origen==='COT-A0001')")
        chk("Cotización convertida en factura FV-A0002", fac and fac["numero"] == "FV-A0002" and fac["total"] == 350000, fac and fac["numero"])
        chk("La cotización queda marcada como facturada", await pg.evaluate("E.documentos.find(d=>d.numero==='COT-A0001').estado") == "facturada")
        await pg.fill("#h-buscar", "jkl123"); await pg.wait_for_timeout(100)
        chk("Buscar por placa encuentra cotización y factura", await pg.locator("#h-lista .doc").count() == 2)

        # ---------- 7. Numeración nunca repite ----------
        await pg.click('nav [data-vista="ajustes"]'); await pg.evaluate("document.querySelector('.avanzado').open = true"); await pg.fill("#sig-FV", "1"); await pg.click("#guardar-equipo")
        await pg.click('nav [data-vista="nuevo"]'); await pg.click("#l-nuevo") if await pg.is_visible("#l-nuevo") else None
        await pg.click('.tipos [data-tipo="FACTURA"]'); await agregar(pg, "tapete"); await generar(pg)
        lista = await docs(pg)
        chk("Aunque bajen el contador, no se repite un número de factura", len(lista) == len(set(lista)), lista)

        # ---------- 8. Inventario ----------
        await pg.click('nav [data-vista="inventario"]'); await pg.click("#i-agregar")
        await pg.locator("#i-lista .inv").first.locator(".nom").fill("Cojinería cabina completa")
        await pg.locator("#i-lista .inv").first.locator(".cod").fill("coj-cb")
        await pg.locator("#i-lista .inv").first.locator(".precio").fill("180.000")
        await pg.click('nav [data-vista="inventario"]'); await pg.wait_for_timeout(150)
        chk("Volver a tocar Inventario no borra lo que estás editando", await pg.locator("#i-lista .inv").count() == 7)
        await pg.click("#i-guardar"); await pg.wait_for_timeout(200)
        chk("Producto nuevo guardado con precio $180.000", await pg.evaluate("E.inventario.find(p=>p.codigo==='COJ-CB')?.precio") == 180000)
        await pg.locator("#i-lista .inv").nth(1).locator(".cod").fill("TAP-SC"); await pg.click("#i-guardar"); await pg.wait_for_timeout(200)
        chk("Códigos repetidos no se guardan", await pg.evaluate("E.inventario.filter(p=>p.codigo==='TAP-SC').length") == 1)
        await pg.click("#i-agregar"); await pg.locator("#i-lista .inv").first.locator(".nom").fill('<img src=x onerror="window.__xss=1">'); await pg.click("#i-guardar")
        await pg.click('nav [data-vista="nuevo"]'); await pg.wait_for_timeout(100)
        await pg.fill("#buscar-prod", "img"); await pg.dispatch_event("#buscar-prod", "input"); await pg.wait_for_timeout(150)
        chk("Un nombre con código HTML no se ejecuta", not await pg.evaluate("window.__xss"))

        # ---------- 9. Autocompletar cliente ----------
        await pg.click("#l-nuevo") if await pg.is_visible("#l-nuevo") else None
        await pg.click("#mas-datos summary"); await pg.fill("#c-direccion", "Dirección vieja de otro cliente")
        await pg.fill("#c-nombre", "Ov Log"); await pg.dispatch_event("#c-nombre", "input"); await pg.wait_for_timeout(100); await pg.press("#c-nombre", "Enter")
        chk("Elegir un cliente guardado llena su NIT", await pg.input_value("#c-documento") == "900496332")
        chk("Elegir un cliente borra la dirección del cliente anterior", await pg.input_value("#c-direccion") != "Dirección vieja de otro cliente", await pg.input_value("#c-direccion"))

        # ---------- 10. Persistencia, ajustes y letra ----------
        await pg.click('nav [data-vista="ajustes"]'); await pg.fill('[data-cfg="responsable"]', "Responsable de prueba"); await pg.click("#guardar-cfg")
        await pg.evaluate("document.querySelector('.avanzado').open = true"); await pg.fill("#equipo", "b"); await pg.click("#guardar-equipo"); await pg.wait_for_timeout(200)
        antes = len(await docs(pg))
        await pg.reload(); await pg.wait_for_function("!document.querySelector('#splash')", timeout=6000); await pg.wait_for_timeout(300)
        chk("Tras recargar se conservan documentos, inventario y ajustes",
            len(await docs(pg)) == antes and await pg.evaluate("E.cfg.responsable") == "Responsable de prueba" and await pg.evaluate("E.inventario.some(p=>p.codigo==='COJ-CB')"))
        await agregar(pg, "tapete"); await generar(pg)
        chk("Con la letra B la numeración sigue como COT-B0001", (await docs(pg))[0] == "COT-B0001", (await docs(pg))[0])

        # ---------- 10b. Firma ----------
        await pg.click('nav [data-vista="ajustes"]')
        await pg.set_input_files("#firma-archivo", "./prueba.jpg"); await pg.wait_for_timeout(500)
        firma = await pg.evaluate("E.cfg.firma || ''")
        chk("Subir foto de firma la guarda como PNG", firma.startswith("data:image/png"), firma[:30])
        chk("La firma queda pequeña (menos de 60 KB)", len(firma) < 60000, len(firma))
        chk("La vista previa muestra la firma", await pg.is_visible("#firma-img") and await pg.is_visible("#firma-quitar"))
        alfa = await pg.evaluate("""async()=>{const im=new Image();im.src=E.cfg.firma;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let t=0;for(let i=3;i<d.length;i+=4)if(d[i]===0)t++;return t/(d.length/4)}""")
        chk("El fondo del papel queda transparente", alfa > 0.6, alfa)
        await pg.fill('[data-cfg="telefono"]', "300 000 0000"); await pg.click("#guardar-cfg"); await pg.wait_for_timeout(150)
        chk("Guardar los datos del negocio no borra la firma", (await pg.evaluate("E.cfg.firma || ''")) == firma)
        await pg.click('nav [data-vista="nuevo"]'); await pg.click("#l-nuevo") if await pg.is_visible("#l-nuevo") else None
        await agregar(pg, "tapete"); await generar(pg)
        await pdf_texto(pg, (await docs(pg))[0])
        imgs = subprocess.run(["pdfimages", "-list", "./t.pdf"], capture_output=True, text=True).stdout.strip().splitlines()[2:]
        chk("El PDF trae logo y firma", len(imgs) >= 2, imgs)
        await pg.click('nav [data-vista="ajustes"]'); await pg.click("#firma-dibujar")
        caja = await pg.locator("#firma-lienzo").bounding_box()
        await pg.click("#firma-guardar"); await pg.wait_for_timeout(100)
        chk("Guardar el lienzo vacío avisa y no cambia la firma", (await pg.evaluate("E.cfg.firma")) == firma)
        await pg.mouse.move(caja["x"] + 40, caja["y"] + 70); await pg.mouse.down()
        for i in range(12): await pg.mouse.move(caja["x"] + 40 + i * 30, caja["y"] + 70 + (25 if i % 2 else -15))
        await pg.mouse.up(); await pg.click("#firma-guardar"); await pg.wait_for_timeout(300)
        dibujada = await pg.evaluate("E.cfg.firma || ''")
        chk("Dibujar con el mouse guarda una firma nueva", dibujada.startswith("data:image/png") and dibujada != firma and await pg.locator("#firma-pad").is_hidden())
        await pg.click("#firma-quitar"); await pg.wait_for_timeout(150)
        chk("Quitar firma la borra", not await pg.evaluate("E.cfg.firma") and await pg.is_visible("#firma-vacia"))
        await pg.set_input_files("#firma-archivo", "./prueba.jpg"); await pg.wait_for_timeout(400)

        # ---------- 11. Copias de seguridad ----------
        async with pg.expect_download() as dl:
            await pg.click('nav [data-vista="ajustes"]'); await pg.click("#exportar")
        ruta = "./copia.json"; await (await dl.value).save_as(ruta)
        copia = json.load(open(ruta)); chk("La copia descargada trae todos los documentos", len(copia["documentos"]) == len(await docs(pg)))
        open("./mala.json", "w").write("{esto no es json")
        await pg.click("#importar-todo"); await pg.set_input_files("#archivo-copia", "./mala.json"); await pg.wait_for_timeout(300)
        chk("Un archivo dañado no rompe la app", "No se pudo cargar" in await pg.inner_text("#toast") and len(await docs(pg)) == len(copia["documentos"]))
        open("./otra.json", "w").write(json.dumps({"app": "facturador-v2", "inventario": "no es lista"}))
        await pg.click("#importar-inv"); await pg.set_input_files("#archivo-copia", "./otra.json"); await pg.wait_for_timeout(300)
        chk("Una copia con inventario inválido no daña el inventario", await pg.evaluate("Array.isArray(E.inventario) && E.inventario.length > 0"))
        chk("Sin errores de JavaScript en todo el recorrido de PC", not pg._errs, pg._errs)
        await ctx.close()

        # ---------- 12. Restaurar en un equipo nuevo ----------
        ctx, pg = await nueva(b)
        chk("En un equipo nuevo se ve el recuadro que pide los datos del negocio", await pg.is_visible("#falta-negocio"))
        await pg.click('nav [data-vista="ajustes"]'); await pg.click("#importar-todo")
        await pg.set_input_files("#archivo-copia", "datos-version2.json"); await pg.wait_for_timeout(300)
        await pg.click("#m-acciones .primario"); await pg.wait_for_timeout(500)
        chk("Restaurar datos-version2.json carga negocio e inventario",
            await pg.evaluate("E.cfg.identificacion") == json.load(open("datos-version2.json", encoding="utf-8"))["cfg"]["identificacion"] and await pg.evaluate("E.inventario.length") == 6)
        chk("Después de cargar los datos, el recuadro desaparece", await pg.locator("#falta-negocio").is_hidden())
        await ctx.close()

        # ---------- 13. Celular ----------
        ctx, pg = await nueva(b, movil=True)
        for v in ["nuevo", "historial", "inventario", "ajustes"]:
            await pg.click(f'nav [data-vista="{v}"]'); await pg.wait_for_timeout(150)
            ancho = await pg.evaluate("[document.documentElement.scrollWidth, innerWidth]")
            chk(f"Celular, {v}: sin desplazamiento horizontal", ancho[0] <= ancho[1], ancho)
        await pg.click('nav [data-vista="nuevo"]'); await agregar(pg, "silla"); await generar(pg)
        async with pg.expect_download() as dl:
            await pg.click("#l-compartir")
        chk("Celular sin menú de compartir: descarga el PDF como plan B", (await dl.value).suggested_filename == "COT-A0001.pdf")
        chk("Sin errores de JavaScript en el celular", not pg._errs, pg._errs)
        await ctx.close()

        # ---------- 14. Sin internet ----------
        ctx, pg = await nueva(b); await pg.wait_for_timeout(1500)
        await ctx.set_offline(True); await pg.reload()
        try:
            await pg.wait_for_function("!document.querySelector('#splash')", timeout=6000); ok = await pg.evaluate("typeof E==='object' && E.inventario.length>0")
        except Exception as e: ok = False
        chk("Abre sin internet después de la primera visita", ok)
        await ctx.close(); await b.close()

    fallas = [r for r in R if not r[1]]
    print(f"\nRESUMEN: {len(R)-len(fallas)} de {len(R)} pruebas pasan")
asyncio.run(main())
