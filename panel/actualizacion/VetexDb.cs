// VETEX - Servidor de datos del local (varias cajas)
// Corre dentro del puente de impresion del equipo PRINCIPAL (impresora.ps1 lo compila con Add-Type).
// Las demas cajas se conectan por la red del local al puerto 17778.
// Compatible con C# 5 / .NET Framework 4.x (Windows PowerShell 5.1).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public static class VetexJson
{
    public static object Parse(string s) { int i = 0; object v = Val(s, ref i); return v; }
    static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
    static object Val(string s, ref int i)
    {
        Ws(s, ref i);
        if (i >= s.Length) throw new FormatException("JSON incompleto");
        char c = s[i];
        if (c == '{')
        {
            var d = new Dictionary<string, object>(); i++; Ws(s, ref i);
            if (s[i] == '}') { i++; return d; }
            while (true)
            {
                Ws(s, ref i); string k = Str(s, ref i); Ws(s, ref i);
                if (s[i] != ':') throw new FormatException("Se esperaba :"); i++;
                d[k] = Val(s, ref i); Ws(s, ref i);
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return d; }
                throw new FormatException("Se esperaba , o }");
            }
        }
        if (c == '[')
        {
            var l = new List<object>(); i++; Ws(s, ref i);
            if (s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(Val(s, ref i)); Ws(s, ref i);
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return l; }
                throw new FormatException("Se esperaba , o ]");
            }
        }
        if (c == '"') return Str(s, ref i);
        if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
        if (s.Length - i >= 5 && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
        if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
        int st = i;
        while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
        if (st == i) throw new FormatException("Valor no valido");
        return double.Parse(s.Substring(st, i - st), NumberStyles.Float, CultureInfo.InvariantCulture);
    }
    static string Str(string s, ref int i)
    {
        if (s[i] != '"') throw new FormatException("Se esperaba texto"); i++;
        var b = new StringBuilder();
        while (true)
        {
            char c = s[i++];
            if (c == '"') return b.ToString();
            if (c != '\\') { b.Append(c); continue; }
            char e = s[i++];
            switch (e)
            {
                case 'n': b.Append('\n'); break;
                case 'r': b.Append('\r'); break;
                case 't': b.Append('\t'); break;
                case 'b': b.Append('\b'); break;
                case 'f': b.Append('\f'); break;
                case 'u': b.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                default: b.Append(e); break;
            }
        }
    }
    public static string Write(object v) { var b = new StringBuilder(); W(v, b); return b.ToString(); }
    public static void W(object v, StringBuilder b)
    {
        if (v == null) { b.Append("null"); return; }
        if (v is string) { Q((string)v, b); return; }
        if (v is bool) { b.Append((bool)v ? "true" : "false"); return; }
        if (v is double || v is int || v is long || v is float || v is decimal)
        {
            double d = Convert.ToDouble(v, CultureInfo.InvariantCulture);
            if (double.IsNaN(d) || double.IsInfinity(d)) { b.Append("null"); return; }
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15) b.Append(((long)d).ToString(CultureInfo.InvariantCulture));
            else b.Append(d.ToString("R", CultureInfo.InvariantCulture));
            return;
        }
        var dict = v as Dictionary<string, object>;
        if (dict != null)
        {
            b.Append('{'); bool first = true;
            foreach (var kv in dict) { if (!first) b.Append(','); first = false; Q(kv.Key, b); b.Append(':'); W(kv.Value, b); }
            b.Append('}'); return;
        }
        var list = v as List<object>;
        if (list != null)
        {
            b.Append('['); for (int k = 0; k < list.Count; k++) { if (k > 0) b.Append(','); W(list[k], b); }
            b.Append(']'); return;
        }
        Q(v.ToString(), b);
    }
    static void Q(string s, StringBuilder b)
    {
        b.Append('"');
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n");
            else if (c == '\r') b.Append("\\r");
            else if (c == '\t') b.Append("\\t");
            else if (c < ' ' || c == (char)0x2028 || c == (char)0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        b.Append('"');
    }
}

public static class VetexDb
{
    class Cambio { public long S; public string C; public string I; public Dictionary<string, object> D; }

    static readonly object Lk = new object();
    static Dictionary<string, Dictionary<string, Dictionary<string, object>>> cols = new Dictionary<string, Dictionary<string, Dictionary<string, object>>>();
    static List<Cambio> log = new List<Cambio>();
    static long seq = 0, logBase = 0;
    static int escritosDesdeFoto = 0;
    static string dir, clave, archivoLog, archivoFoto;
    static TcpListener listener;
    static Thread hilo;
    static StreamWriter logWriter;
    public static bool Activo { get { return listener != null; } }
    public static string UltimoError = "";
    // Carpeta de VETEX (donde esta VETEX.html): desde ahi se le entrega el programa a las tablets
    public static string AppDir = "";
    public static int PuertoPuente = 17777;
    // Cada pedido se atiende en su propio hilo: aqui se recuerda si ese navegador acepta respuestas comprimidas
    [ThreadStatic] static bool aceptaGzip;
    static byte[] Comprimir(byte[] datos, out bool hecho)
    {
        hecho = false;
        if (!aceptaGzip || datos.Length < 2048) return datos;
        using (var ms = new MemoryStream())
        {
            using (var gz = new GZipStream(ms, CompressionMode.Compress, true)) gz.Write(datos, 0, datos.Length);
            hecho = true; return ms.ToArray();
        }
    }

    public static void Start(int puerto, string carpeta, string claveAcceso)
    {
        lock (Lk)
        {
            if (listener != null) return;
            dir = carpeta; clave = claveAcceso ?? "";
            Directory.CreateDirectory(dir);
            archivoLog = Path.Combine(dir, "vetex-datos.jsonl");
            archivoFoto = Path.Combine(dir, "vetex-datos.foto.json");
            Cargar();
            logWriter = new StreamWriter(new FileStream(archivoLog, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            logWriter.AutoFlush = true;
            listener = new TcpListener(IPAddress.Any, puerto);
            listener.Start();
            hilo = new Thread(Aceptar); hilo.IsBackground = true; hilo.Start();
        }
    }
    public static void Stop()
    {
        lock (Lk)
        {
            try { if (listener != null) listener.Stop(); } catch { }
            listener = null;
            try { if (logWriter != null) { Foto(); logWriter.Dispose(); } } catch { }
            logWriter = null;
        }
    }
    public static long Seq { get { lock (Lk) { return seq; } } }
    // Si el servidor ya estaba encendido (de un intento anterior), se le cambia el codigo sin apagarlo
    public static void CambiarClave(string nueva) { lock (Lk) { clave = nueva ?? ""; } }

    // ---------- Persistencia: foto completa + registro de cambios (una linea por cambio) ----------
    static void Cargar()
    {
        cols.Clear(); seq = 0;
        if (File.Exists(archivoFoto))
        {
            var f = VetexJson.Parse(File.ReadAllText(archivoFoto, Encoding.UTF8)) as Dictionary<string, object>;
            if (f != null)
            {
                seq = (long)Convert.ToDouble(f["seq"], CultureInfo.InvariantCulture);
                var cs = f["cols"] as Dictionary<string, object>;
                foreach (var c in cs)
                {
                    var docs = new Dictionary<string, Dictionary<string, object>>();
                    foreach (var d in (Dictionary<string, object>)c.Value) docs[d.Key] = (Dictionary<string, object>)d.Value;
                    cols[c.Key] = docs;
                }
            }
        }
        if (File.Exists(archivoLog))
        {
            foreach (var linea in File.ReadAllLines(archivoLog, Encoding.UTF8))
            {
                if (linea.Trim().Length == 0) continue;
                Dictionary<string, object> x;
                try { x = VetexJson.Parse(linea) as Dictionary<string, object>; } catch { continue; } // linea cortada por un apagon
                long s = (long)Convert.ToDouble(x["s"], CultureInfo.InvariantCulture);
                if (s <= seq) continue;
                Aplicar((string)x["c"], (string)x["i"], x["d"] as Dictionary<string, object>);
                seq = s;
            }
        }
        logBase = seq; log.Clear();
    }
    static void Aplicar(string c, string i, Dictionary<string, object> d)
    {
        Dictionary<string, Dictionary<string, object>> docs;
        if (!cols.TryGetValue(c, out docs)) { docs = new Dictionary<string, Dictionary<string, object>>(); cols[c] = docs; }
        if (d == null) docs.Remove(i); else docs[i] = d;
    }
    static void Registrar(string c, string i, Dictionary<string, object> d)
    {
        seq++;
        Aplicar(c, i, d);
        var x = new Dictionary<string, object>(); x["s"] = (double)seq; x["c"] = c; x["i"] = i; x["d"] = d;
        logWriter.WriteLine(VetexJson.Write(x));
        log.Add(new Cambio { S = seq, C = c, I = i, D = d });
        if (log.Count > 20000) { log.RemoveRange(0, 5000); logBase = log[0].S - 1; }
        escritosDesdeFoto++;
    }
    static void Foto()
    {
        var f = new Dictionary<string, object>(); f["seq"] = (double)seq;
        var cs = new Dictionary<string, object>();
        foreach (var c in cols) { var docs = new Dictionary<string, object>(); foreach (var d in c.Value) docs[d.Key] = d.Value; cs[c.Key] = docs; }
        f["cols"] = cs;
        string tmp = archivoFoto + ".tmp";
        File.WriteAllText(tmp, VetexJson.Write(f), new UTF8Encoding(false));
        if (File.Exists(archivoFoto))
        {
            // copia diaria de seguridad (se guardan las ultimas 14)
            string resp = Path.Combine(dir, "copias"); Directory.CreateDirectory(resp);
            string hoy = Path.Combine(resp, "vetex-datos-" + DateTime.Now.ToString("yyyy-MM-dd") + ".json");
            if (!File.Exists(hoy)) File.Copy(archivoFoto, hoy);
            var viejas = Directory.GetFiles(resp, "vetex-datos-*.json"); Array.Sort(viejas);
            for (int k = 0; k < viejas.Length - 14; k++) { try { File.Delete(viejas[k]); } catch { } }
            File.Delete(archivoFoto);
        }
        File.Move(tmp, archivoFoto);
        logWriter.Flush(); logWriter.BaseStream.SetLength(0);
        escritosDesdeFoto = 0;
    }

    // ---------- HTTP ----------
    static void Aceptar()
    {
        while (true)
        {
            TcpClient cl;
            try { var l = listener; if (l == null) return; cl = l.AcceptTcpClient(); }
            catch { return; }
            ThreadPool.QueueUserWorkItem(Atender, cl);
        }
    }
    static void Atender(object o)
    {
        var cl = (TcpClient)o;
        try
        {
            cl.ReceiveTimeout = 15000; cl.SendTimeout = 30000;
            var ns = cl.GetStream();
            var cab = new MemoryStream(); int prev = 0, b, n = 0;
            // lee encabezados hasta \r\n\r\n
            int[] ult = new int[4];
            while ((b = ns.ReadByte()) >= 0)
            {
                cab.WriteByte((byte)b); n++;
                ult[0] = ult[1]; ult[1] = ult[2]; ult[2] = ult[3]; ult[3] = b;
                if (ult[0] == 13 && ult[1] == 10 && ult[2] == 13 && ult[3] == 10) break;
                if (n > 65536) return;
            }
            prev = n;
            string head = Encoding.ASCII.GetString(cab.ToArray());
            string[] lineas = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] rl = lineas[0].Split(' ');
            if (rl.Length < 2) return;
            string metodo = rl[0], url = rl[1];
            int largo = 0; string claveReq = ""; aceptaGzip = false;
            foreach (var l in lineas)
            {
                int p = l.IndexOf(':'); if (p < 0) continue;
                string k = l.Substring(0, p).Trim().ToLowerInvariant(), v = l.Substring(p + 1).Trim();
                if (k == "content-length") int.TryParse(v, out largo);
                if (k == "x-vetex-clave") claveReq = v;
                if (k == "accept-encoding") aceptaGzip = v.IndexOf("gzip", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            if (largo > 200 * 1024 * 1024) { Responder(ns, 400, "{\"ok\":false,\"error\":\"muy grande\"}"); return; }
            var cuerpo = new byte[largo]; int leidos = 0;
            while (leidos < largo) { int r = ns.Read(cuerpo, leidos, largo - leidos); if (r <= 0) break; leidos += r; }
            string body = Encoding.UTF8.GetString(cuerpo, 0, leidos);
            string ruta = url, query = "";
            int qi = url.IndexOf('?'); if (qi >= 0) { ruta = url.Substring(0, qi); query = url.Substring(qi + 1); }

            if (metodo == "OPTIONS") { Responder(ns, 204, ""); return; }
            // Tablets y celulares: abren http://IP:17778/ en Chrome y reciben VETEX desde este equipo
            if (metodo == "GET" && (ruta == "/" || ruta == "/index.html" || ruta == "/vetex")) { Archivo(ns, "VETEX.html", "text/html; charset=utf-8"); return; }
            if (metodo == "GET" && ruta == "/icono.png") { Archivo(ns, "vetex-icono.png", "image/png"); return; }
            if (metodo == "GET" && ruta == "/manifest.webmanifest")
            {
                Enviar(ns, 200, "application/manifest+json", Encoding.UTF8.GetBytes("{\"name\":\"VETEX\",\"short_name\":\"VETEX\",\"start_url\":\"/\",\"display\":\"standalone\",\"orientation\":\"any\",\"background_color\":\"#14102A\",\"theme_color\":\"#14102A\",\"icons\":[{\"src\":\"/icono.png\",\"sizes\":\"512x512\",\"type\":\"image/png\"}]}"));
                return;
            }
            // La clave tambien puede venir en la direccion (?k=): asi el navegador no necesita la consulta previa (CORS) de un encabezado propio
            foreach (var par in query.Split('&')) if (par.StartsWith("k=")) claveReq = Uri.UnescapeDataString(par.Substring(2));
            bool auth = clave.Length > 0 && claveReq == clave;
            if (ruta == "/db/ping") { Responder(ns, 200, "{\"ok\":true,\"app\":\"VETEX-servidor\",\"seq\":" + Seq + ",\"auth\":" + (auth ? "true" : "false") + "}"); return; }
            if (!auth) { Responder(ns, 403, "{\"ok\":false,\"error\":\"Codigo de conexion incorrecto\"}"); return; }

            if (metodo == "GET" && ruta == "/db/todo") { Responder(ns, 200, Todo()); return; }
            if (metodo == "GET" && ruta == "/db/cambios")
            {
                long desde = 0;
                foreach (var par in query.Split('&')) if (par.StartsWith("desde=")) long.TryParse(par.Substring(6), out desde);
                Responder(ns, 200, Cambios(desde)); return;
            }
            if (metodo == "POST" && ruta == "/db/escribir") { Responder(ns, 200, Escribir(body)); return; }
            // Aviso de pago: el celular del dueno reenvia aqui la notificacion de Nequi/Daviplata (texto tal cual)
            if (metodo == "POST" && ruta == "/db/aviso") { Responder(ns, 200, Aviso(query, body)); return; }
            if (metodo == "POST" && ruta == "/db/contador") { Responder(ns, 200, Contador(body)); return; }
            // Impresora del principal para las tablets: solo estas dos rutas del puente, nunca las demas
            if (metodo == "GET" && ruta == "/db/puente/estado") { Responder(ns, 200, Puente("GET", "/estado", null)); return; }
            if (metodo == "POST" && ruta == "/db/puente/imprimir") { Responder(ns, 200, Puente("POST", "/imprimir", body)); return; }
            Responder(ns, 404, "{\"ok\":false,\"error\":\"No encontrado\"}");
        }
        catch (Exception e)
        {
            UltimoError = e.Message;
            try { Responder(cl.GetStream(), 500, "{\"ok\":false,\"error\":" + VetexJson.Write(e.Message) + "}"); } catch { }
        }
        finally { try { cl.Close(); } catch { } }
    }
    static void Archivo(Stream ns, string nombre, string tipo)
    {
        string f = AppDir.Length > 0 ? Path.Combine(AppDir, nombre) : "";
        if (f.Length == 0 || !File.Exists(f)) { Enviar(ns, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("VETEX no encontrado en este equipo")); return; }
        byte[] datos; using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { datos = new byte[fs.Length]; int k = 0; while (k < datos.Length) { int r = fs.Read(datos, k, datos.Length - k); if (r <= 0) break; k += r; } }
        Enviar(ns, 200, tipo, datos);
    }
    static void Enviar(Stream ns, int code, string tipo, byte[] body)
    {
        bool gz; body = Comprimir(body, out gz);
        string h = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Not Found") + "\r\n" +
            "Content-Type: " + tipo + "\r\nContent-Length: " + body.Length + "\r\n" + (gz ? "Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n" : "") +
            "Cache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(h);
        ns.Write(hb, 0, hb.Length); if (body.Length > 0) ns.Write(body, 0, body.Length); ns.Flush();
    }
    // Pasa el pedido al puente de impresion de este mismo equipo (127.0.0.1); sin encabezado Origin, que el puente exige
    static string Puente(string metodo, string ruta, string cuerpo)
    {
        try
        {
            var rq = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + PuertoPuente + ruta);
            rq.Method = metodo; rq.Timeout = 20000; rq.ReadWriteTimeout = 20000; rq.Proxy = null; rq.KeepAlive = false;
            if (cuerpo != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(cuerpo); rq.ContentType = "text/plain"; rq.ContentLength = b.Length;
                using (var s = rq.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            using (var rs = (HttpWebResponse)rq.GetResponse())
            using (var rd = new StreamReader(rs.GetResponseStream(), Encoding.UTF8)) return rd.ReadToEnd();
        }
        catch (WebException e)
        {
            if (e.Response != null) { try { using (var rd = new StreamReader(e.Response.GetResponseStream(), Encoding.UTF8)) return rd.ReadToEnd(); } catch { } }
            return "{\"ok\":false,\"error\":\"La impresora del equipo principal no responde\"}";
        }
        catch (Exception e) { return "{\"ok\":false,\"error\":" + VetexJson.Write(e.Message) + "}"; }
    }
    static void Responder(Stream ns, int code, string texto)
    {
        bool gz; byte[] body = Comprimir(Encoding.UTF8.GetBytes(texto), out gz);
        string estado = code == 200 ? "OK" : code == 204 ? "No Content" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 400 ? "Bad Request" : "Error";
        string h = "HTTP/1.1 " + code + " " + estado + "\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: " + body.Length + "\r\n" + (gz ? "Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n" : "") +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, X-Vetex-Clave\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Access-Control-Allow-Local-Network: true\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(h);
        ns.Write(hb, 0, hb.Length);
        if (body.Length > 0) ns.Write(body, 0, body.Length);
        ns.Flush();
    }

    // ---------- Operaciones ----------
    static string Todo()
    {
        lock (Lk)
        {
            var b = new StringBuilder();
            b.Append("{\"ok\":true,\"seq\":").Append(seq).Append(",\"cols\":{");
            bool fc = true;
            foreach (var c in cols)
            {
                if (!fc) b.Append(','); fc = false;
                b.Append(VetexJson.Write(c.Key)).Append(":{");
                bool fd = true;
                foreach (var d in c.Value) { if (!fd) b.Append(','); fd = false; b.Append(VetexJson.Write(d.Key)).Append(':'); VetexJson.W(d.Value, b); }
                b.Append('}');
            }
            b.Append("}}");
            return b.ToString();
        }
    }
    static string Cambios(long desde)
    {
        lock (Lk)
        {
            if (desde < logBase) return "{\"ok\":true,\"reset\":true,\"seq\":" + seq + "}";
            var b = new StringBuilder();
            b.Append("{\"ok\":true,\"seq\":").Append(seq).Append(",\"cambios\":[");
            bool f = true;
            foreach (var x in log)
            {
                if (x.S <= desde) continue;
                if (!f) b.Append(','); f = false;
                b.Append("{\"c\":").Append(VetexJson.Write(x.C)).Append(",\"i\":").Append(VetexJson.Write(x.I)).Append(",\"d\":");
                VetexJson.W(x.D, b); b.Append('}');
            }
            b.Append("]}");
            return b.ToString();
        }
    }
    static Dictionary<string, object> Copia(Dictionary<string, object> d) { return d == null ? null : new Dictionary<string, object>(d); }
    static string Escribir(string body)
    {
        var req = VetexJson.Parse(body) as Dictionary<string, object>;
        var ops = req["ops"] as List<object>;
        var res = new List<object>();
        lock (Lk)
        {
            // Reserva de stock: si dos cajas venden la ultima unidad al mismo tiempo, la segunda se rechaza (todo o nada)
            var falta = new List<object>();
            foreach (var o in ops)
            {
                var op = (Dictionary<string, object>)o;
                if ((op["t"] as string) != "reservar") continue;
                string c0 = (string)op["c"], i0 = (string)op["i"];
                Dictionary<string, Dictionary<string, object>> d0; Dictionary<string, object> a0 = null;
                if (cols.TryGetValue(c0, out d0)) d0.TryGetValue(i0, out a0);
                double st = 0, n = 0;
                try { if (a0 != null && a0.ContainsKey("stock") && a0["stock"] != null) st = Convert.ToDouble(a0["stock"]); } catch { }
                try { n = Convert.ToDouble(((Dictionary<string, object>)op["d"])["n"]); } catch { }
                if (a0 == null || st + 1e-9 < n) { var f = new Dictionary<string, object>(); f["i"] = i0; f["disp"] = st; falta.Add(f); }
            }
            if (falta.Count > 0) { var no = new Dictionary<string, object>(); no["ok"] = false; no["error"] = "stock"; no["falta"] = falta; return VetexJson.Write(no); }
            foreach (var o in ops)
            {
                var op = (Dictionary<string, object>)o;
                string t = (string)op["t"], c = (string)op["c"], i = (string)op["i"];
                if (string.IsNullOrEmpty(c) || string.IsNullOrEmpty(i)) continue;
                Dictionary<string, Dictionary<string, object>> docs; Dictionary<string, object> actual = null;
                if (cols.TryGetValue(c, out docs)) docs.TryGetValue(i, out actual);
                Dictionary<string, object> nuevo;
                if (t == "delete") nuevo = null;
                else if (t == "set") nuevo = Resolver(null, op["d"] as Dictionary<string, object>);
                else if (t == "update") nuevo = Resolver(actual, op["d"] as Dictionary<string, object>);
                else if (t == "reservar")
                {
                    double st = 0, n = 0;
                    try { if (actual != null && actual["stock"] != null) st = Convert.ToDouble(actual["stock"]); } catch { }
                    try { n = Convert.ToDouble(((Dictionary<string, object>)op["d"])["n"]); } catch { }
                    var cambio = new Dictionary<string, object>(); cambio["stock"] = Math.Round((st - n) * 1000) / 1000;
                    nuevo = Resolver(actual, cambio);
                }
                else continue;
                Registrar(c, i, nuevo);
                var r = new Dictionary<string, object>(); r["c"] = c; r["i"] = i; r["d"] = nuevo; res.Add(r);
            }
            if (escritosDesdeFoto > 3000) Foto();
            var out1 = new Dictionary<string, object>(); out1["ok"] = true; out1["seq"] = (double)seq; out1["docs"] = res;
            return VetexJson.Write(out1);
        }
    }
    // Mezcla campos; {"__inc":n} suma n al valor actual (para el stock: dos cajas pueden vender a la vez)
    static Dictionary<string, object> Resolver(Dictionary<string, object> actual, Dictionary<string, object> d)
    {
        var r = actual == null ? new Dictionary<string, object>() : new Dictionary<string, object>(actual);
        if (d == null) return r;
        foreach (var kv in d)
        {
            var esp = kv.Value as Dictionary<string, object>;
            if (esp != null && esp.Count == 1 && esp.ContainsKey("__inc"))
            {
                double prev = 0; object pv;
                if (r.TryGetValue(kv.Key, out pv) && pv != null) { try { prev = Convert.ToDouble(pv, CultureInfo.InvariantCulture); } catch { prev = 0; } }
                double v = prev + Convert.ToDouble(esp["__inc"], CultureInfo.InvariantCulture);
                r[kv.Key] = Math.Round(v * 1000) / 1000;
            }
            else r[kv.Key] = kv.Value;
        }
        return r;
    }
    static string Aviso(string query, string body)
    {
        string app = "";
        foreach (var par in query.Split('&')) if (par.StartsWith("app=")) app = Uri.UnescapeDataString(par.Substring(4).Replace('+', ' '));
        string texto = (body ?? "").Trim();
        if (texto.StartsWith("texto=")) texto = Uri.UnescapeDataString(texto.Substring(6).Replace('+', ' '));
        if (texto.Length == 0) return "{\"ok\":false,\"error\":\"Aviso vacio\"}";
        if (texto.Length > 1500) texto = texto.Substring(0, 1500);
        if (app.Length > 40) app = app.Substring(0, 40);
        var d = new Dictionary<string, object>();
        d["app"] = app; d["texto"] = texto; d["recibido"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        string id = "av" + DateTime.UtcNow.Ticks.ToString();
        lock (Lk) { Registrar("avisos", id, d); if (escritosDesdeFoto > 3000) Foto(); }
        return "{\"ok\":true,\"id\":\"" + id + "\"}";
    }
    static string Contador(string body)
    {
        var req = VetexJson.Parse(body) as Dictionary<string, object>;
        string nombre = (string)req["nombre"];
        long piso = req.ContainsKey("piso") && req["piso"] != null ? (long)Convert.ToDouble(req["piso"], CultureInfo.InvariantCulture) : 1;
        lock (Lk)
        {
            Dictionary<string, Dictionary<string, object>> docs; Dictionary<string, object> d = null;
            if (cols.TryGetValue("_contadores", out docs)) docs.TryGetValue(nombre, out d);
            long v = d != null ? (long)Convert.ToDouble(d["v"], CultureInfo.InvariantCulture) + 1 : 1;
            if (v < piso) v = piso;
            var nd = new Dictionary<string, object>(); nd["v"] = (double)v;
            Registrar("_contadores", nombre, nd);
            return "{\"ok\":true,\"valor\":" + v + "}";
        }
    }
}
