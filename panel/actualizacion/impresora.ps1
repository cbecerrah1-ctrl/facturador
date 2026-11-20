# ============================================================
#  VETEX - Puente de impresion directa (ESC/POS)
#  Recibe los recibos desde VETEX y los manda en crudo (RAW)
#  a la impresora termica: asi la impresora corta el papel y abre
#  el cajon monedero.
#  Solo escucha en este mismo computador (127.0.0.1, puerto 17777).
#  Lo abre automaticamente "Iniciar VETEX.bat".
# ============================================================
param([switch]$Prueba)
$ErrorActionPreference = 'Continue'
$port = 17777

$logDir = Join-Path $env:LOCALAPPDATA 'MostradorPOS'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'impresora.log'
function Write-Log([string]$m) {
  try { Add-Content -Path $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) } catch {}
}

# Identificador de este computador para la licencia de VETEX (huella anonima: no se manda el serial, solo su hash)
function Get-EquipoId {
  $partes = @()
  try { $partes += (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch {}
  try { $partes += (Get-CimInstance Win32_BaseBoard -OperationTimeoutSec 5 -ErrorAction Stop | Select-Object -First 1).SerialNumber } catch {}
  try { $partes += (Get-CimInstance Win32_BIOS -OperationTimeoutSec 5 -ErrorAction Stop | Select-Object -First 1).SerialNumber } catch {}
  $txt = 'VETEX|' + (($partes | ForEach-Object { ([string]$_).Trim() }) -join '|')
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($txt))
  return (($h | ForEach-Object { $_.ToString('x2') }) -join '')
}
$script:EquipoId = Get-EquipoId

# Varias cajas: este equipo puede ser el PRINCIPAL y guardar los datos del local (puerto 17778)
$script:SrvDir = Join-Path $env:LOCALAPPDATA 'VETEX\servidor'
$script:SrvCfg = Join-Path $script:SrvDir 'config.json'
$script:SrvErr = ''
function Get-Ips {
  $ips = @()
  try {
    foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($ni.OperationalStatus -ne 'Up' -or $ni.NetworkInterfaceType -eq 'Loopback') { continue }
      foreach ($a in $ni.GetIPProperties().UnicastAddresses) {
        if ($a.Address.AddressFamily -eq 'InterNetwork' -and -not $a.Address.ToString().StartsWith('169.254')) { $ips += $a.Address.ToString() }
      }
    }
  } catch {}
  return $ips
}
# --- VETEXDB-INICIO (generado por build/embed_vetexdb.py desde VetexDb.cs; no editar aqui) ---
$script:VetexDbSrc = @'
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
'@
# --- VETEXDB-FIN ---
function Start-Servidor([string]$clave, [int]$puerto) {
  if (-not ('VetexDb' -as [type])) {
    # El servidor va incluido en este mismo archivo: no depende de VetexDb.cs (que un antivirus podria quitar)
    try { Add-Type -TypeDefinition $script:VetexDbSrc }
    catch { Write-Log "Servidor de cajas no compilo: $($_.Exception.Message)"; throw 'No se pudo preparar el servidor de varias cajas en este computador. Revisa que el antivirus no este bloqueando VETEX y vuelve a abrirlo.' }
  }
  [VetexDb]::AppDir = $PSScriptRoot
  [VetexDb]::Start($puerto, $script:SrvDir, $clave)
  Write-Log "Servidor de datos activo en el puerto $puerto"
}
function Read-SrvCfg { if (Test-Path $script:SrvCfg) { try { return (Get-Content $script:SrvCfg -Raw | ConvertFrom-Json) } catch {} } return $null }

# Actualizaciones automaticas: solo descarga desde el servidor de VETEX y verifica la huella SHA-256
$script:UpdBase = 'https://wonderful-desert-0d7a5580f.3.azurestaticapps.net/actualizacion/'
function Get-Verificado($wc, [string]$archivo, [string]$sha, [string]$ver) {
  if ($archivo -notmatch '^[A-Za-z0-9_.-]+$') { throw "Nombre de archivo no valido: $archivo" }
  $tmp = Join-Path $env:TEMP ('vetex-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $wc.DownloadFile($script:UpdBase + $archivo + '?v=' + $ver, $tmp)
  $h = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
  if ($h -ne $sha.ToLower()) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; throw "La descarga de $archivo llego danada." }
  return $tmp
}
# Si falta el servidor de varias cajas (VetexDb.cs), se baja verificado del servidor de VETEX
function Restore-VetexDb {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient
  $info = $wc.DownloadString($script:UpdBase + 'version.json?t=' + [DateTime]::Now.Ticks) | ConvertFrom-Json
  $x = @($info.extras) | Where-Object { $_.archivo -eq 'VetexDb.cs' } | Select-Object -First 1
  if (-not $x) { throw 'El servidor no tiene VetexDb.cs' }
  $t = Get-Verificado $wc 'VetexDb.cs' ([string]$x.sha256) ([string]$info.version)
  Move-Item $t (Join-Path $PSScriptRoot 'VetexDb.cs') -Force
  Write-Log 'VetexDb.cs descargado'
}
function Update-Vetex {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient
  $info = $wc.DownloadString($script:UpdBase + 'version.json?t=' + [DateTime]::Now.Ticks) | ConvertFrom-Json
  $ver = [string]$info.version
  $dir = $PSScriptRoot
  $tmp = Get-Verificado $wc ([string]$info.archivo) ([string]$info.sha256) $ver
  $dest = Join-Path $dir 'VETEX.html'
  if (Test-Path $dest) { Copy-Item $dest (Join-Path $dir 'VETEX.anterior.html') -Force }
  Move-Item $tmp $dest -Force
  if ($info.puente -and $info.puente.sha256) {
    try {
      $t2 = Get-Verificado $wc ([string]$info.puente.archivo) ([string]$info.puente.sha256) $ver
      Move-Item $t2 (Join-Path $dir 'impresora.ps1') -Force
    } catch { Write-Log "No se actualizo el puente: $($_.Exception.Message)" }
  }
  if ($info.extras) {
    foreach ($x in $info.extras) {
      try { $t3 = Get-Verificado $wc ([string]$x.archivo) ([string]$x.sha256) $ver; Move-Item $t3 (Join-Path $dir ([string]$x.archivo)) -Force }
      catch { Write-Log "No se actualizo $($x.archivo): $($_.Exception.Message)" }
    }
  }
  Write-Log "VETEX actualizado a la version $ver"
  return $ver
}

# Si este equipo es el principal, arranca el servidor de datos del local
Write-Log "Puente iniciado desde: $PSScriptRoot"
$cfgSrv = Read-SrvCfg
if ($cfgSrv -and $cfgSrv.activo) {
  try { Start-Servidor ([string]$cfgSrv.clave) ([int]$cfgSrv.puerto) } catch { $script:SrvErr = $_.Exception.Message; Write-Log "No arranco el servidor: $($script:SrvErr)" }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MostradorRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, byte[] buf, int n, out int written);

  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      return "No se pudo abrir la impresora '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "Recibo VETEX";
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0)
        return "La impresora no acepto el trabajo (error " + Marshal.GetLastWin32Error() + ")";
      try {
        StartPagePrinter(h);
        int w;
        bool ok = WritePrinter(h, data, data.Length, out w);
        EndPagePrinter(h);
        if (!ok || w != data.Length)
          return "No se pudo enviar todo a la impresora (error " + Marshal.GetLastWin32Error() + ")";
      } finally { EndDocPrinter(h); }
      return "";
    } finally { ClosePrinter(h); }
  }
}
'@

function Get-Impresoras {
  $list = @()
  try { $list = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Select-Object Name, Default) }
  catch { try { $list = @(Get-WmiObject -Class Win32_Printer | Select-Object Name, Default) } catch {} }
  $items = @()
  foreach ($p in $list) {
    $def = 'false'; if ($p.Default) { $def = 'true' }
    $items += ('{"nombre":' + (ConvertTo-Json ([string]$p.Name)) + ',"predeterminada":' + $def + '}')
  }
  return '[' + ($items -join ',') + ']'
}

# ---------- Bascula: lee el peso por cable (puerto COM / USB-serial) o por red (TCP) ----------
# VETEX manda la configuracion en cada pedido; la conexion se deja abierta mientras no cambie.
# El puente solo devuelve los datos crudos; VETEX los interpreta (cada marca usa un formato distinto).
$script:BasPort = $null; $script:BasTcp = $null; $script:BasKey = ''
function Close-Bas {
  try { if ($script:BasPort) { $script:BasPort.Close(); $script:BasPort.Dispose() } } catch {}
  try { if ($script:BasTcp) { $script:BasTcp.Close() } } catch {}
  $script:BasPort = $null; $script:BasTcp = $null; $script:BasKey = ''
}
function Get-BasCmd([string]$s) {
  if (-not $s) { return '' }
  $s = $s.Replace('\r', "`r").Replace('\n', "`n")
  return [regex]::Replace($s, '\\x([0-9A-Fa-f]{2})', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) })
}
function Read-Bascula($req) {
  $key = ($req | ConvertTo-Json -Compress)
  $tipo = [string]$req.tipo; $pedir = ([string]$req.modo -eq 'pedir')
  if ($script:BasKey -ne $key) {
    Close-Bas
    if ($tipo -eq 'red') {
      $tc = New-Object System.Net.Sockets.TcpClient
      $ar = $tc.BeginConnect([string]$req.host, [int]$req.tcp, $null, $null)
      if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { try { $tc.Close() } catch {}; throw "La bascula no responde en $($req.host):$($req.tcp)" }
      $tc.EndConnect($ar); $script:BasTcp = $tc
    } else {
      $par = [System.IO.Ports.Parity]::None
      if ([string]$req.paridad -eq 'Even') { $par = [System.IO.Ports.Parity]::Even } elseif ([string]$req.paridad -eq 'Odd') { $par = [System.IO.Ports.Parity]::Odd }
      $bits = 8; if ([int]$req.bits -eq 7) { $bits = 7 }
      $sp = New-Object System.IO.Ports.SerialPort ([string]$req.puerto), ([int]$req.baudios), $par, $bits, ([System.IO.Ports.StopBits]::One)
      $sp.ReadTimeout = 300; $sp.WriteTimeout = 300; $sp.Encoding = [System.Text.Encoding]::ASCII
      try { $sp.Open() } catch { throw "No se pudo abrir $($req.puerto): no existe o lo esta usando otro programa" }
      $script:BasPort = $sp
    }
    $script:BasKey = $key
  }
  $acc = ''
  if ($script:BasPort) {
    $sp = $script:BasPort
    $sp.DiscardInBuffer()
    if ($pedir) { $c = Get-BasCmd ([string]$req.comando); if ($c) { $sp.Write($c) } }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 700) {
      if ($sp.BytesToRead -gt 0) { $acc += $sp.ReadExisting() } else { Start-Sleep -Milliseconds 30 }
      if ($pedir -and $acc -match "[\r\n\x03]" -and $acc.Length -gt 4) { break }
      if (-not $pedir -and $acc.Length -gt 120 -and $sw.ElapsedMilliseconds -gt 250) { break }
    }
  } else {
    $ns = $script:BasTcp.GetStream(); $b = New-Object byte[] 4096
    while ($ns.DataAvailable) { [void]$ns.Read($b, 0, $b.Length) }
    if ($pedir) { $c = [System.Text.Encoding]::ASCII.GetBytes((Get-BasCmd ([string]$req.comando))); if ($c.Length) { $ns.Write($c, 0, $c.Length) } }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 700) {
      if ($ns.DataAvailable) { $n = $ns.Read($b, 0, $b.Length); $acc += [System.Text.Encoding]::ASCII.GetString($b, 0, $n) } else { Start-Sleep -Milliseconds 30 }
      if ($pedir -and $acc -match "[\r\n\x03]" -and $acc.Length -gt 4) { break }
      if (-not $pedir -and $acc.Length -gt 120 -and $sw.ElapsedMilliseconds -gt 250) { break }
    }
  }
  if ($acc.Length -gt 400) { $acc = $acc.Substring($acc.Length - 400) }
  return $acc
}

function Send-Response($stream, [int]$code, [string]$text) {
  $names = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 500 = 'Internal Server Error' }
  $body = [System.Text.Encoding]::UTF8.GetBytes($text)
  $head = "HTTP/1.1 $code $($names[$code])`r`n" +
          "Content-Type: application/json; charset=utf-8`r`n" +
          "Content-Length: $($body.Length)`r`n" +
          "Access-Control-Allow-Origin: *`r`n" +
          "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
          "Access-Control-Allow-Headers: Content-Type`r`n" +
          "Access-Control-Allow-Private-Network: true`r`n" +
          "Access-Control-Allow-Local-Network: true`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

# ---------- Modo prueba: imprime directo desde Windows, sin el navegador ----------
if ($Prueba) {
  Write-Host ""
  Write-Host "  PRUEBA DE IMPRESORA - VETEX" -ForegroundColor Magenta
  Write-Host "  ---------------------------"
  $puente = $false
  try { $tc = New-Object System.Net.Sockets.TcpClient; $tc.Connect('127.0.0.1', $port); $tc.Close(); $puente = $true } catch {}
  if ($puente) { Write-Host "  [OK] El puente de VETEX esta abierto (puerto $port)." -ForegroundColor Green }
  else { Write-Host "  [!!] El puente de VETEX NO esta abierto. Se abre con 'Iniciar VETEX.bat'." -ForegroundColor Yellow }
  $list = @()
  try { $list = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | Select-Object Name, Default) } catch { try { $list = @(Get-WmiObject -Class Win32_Printer | Select-Object Name, Default) } catch {} }
  if (-not $list.Count) { Write-Host "  No se encontraron impresoras instaladas en Windows." -ForegroundColor Red; Read-Host "  Enter para cerrar"; exit 1 }
  Write-Host ""
  for ($i = 0; $i -lt $list.Count; $i++) { $d = ''; if ($list[$i].Default) { $d = '  (predeterminada)' }; Write-Host ("  [{0}] {1}{2}" -f ($i + 1), $list[$i].Name, $d) }
  Write-Host ""
  $n = Read-Host "  Escribe el numero de tu Xprinter y pulsa Enter"
  $idx = 0; if (-not [int]::TryParse($n, [ref]$idx) -or $idx -lt 1 -or $idx -gt $list.Count) { Write-Host "  Numero no valido." -ForegroundColor Red; Read-Host "  Enter para cerrar"; exit 1 }
  $impresora = $list[$idx - 1].Name
  $cajon = Read-Host "  Abrir tambien el cajon? (s/n)"
  $ms = New-Object System.IO.MemoryStream
  function Put([byte[]]$b) { $ms.Write($b, 0, $b.Length) }
  function Txt([string]$t) { Put ([System.Text.Encoding]::ASCII.GetBytes($t + "`n")) }
  Put @(27, 64); Put @(27, 97, 1); Put @(27, 69, 1, 29, 33, 17); Txt "VETEX"; Put @(29, 33, 0, 27, 69, 0)
  Txt "Prueba de impresion directa"; Txt (Get-Date).ToString("dd/MM/yyyy HH:mm"); Txt ""
  Put @(27, 97, 0); Txt "Si puedes leer esto, VETEX puede"; Txt "imprimir, cortar y abrir el cajon"; Txt "en esta impresora."; Txt ""
  if ($cajon -eq 's' -or $cajon -eq 'S') { Put @(27, 112, 0, 25, 250) }
  Put @(27, 100, 3); Put @(29, 86, 66, 0)
  $err = [MostradorRaw]::Send($impresora, $ms.ToArray())
  Write-Host ""
  if ($err -eq '') { Write-Host "  [OK] Enviado a '$impresora'. Debe salir un papel corto y cortarse solo." -ForegroundColor Green }
  else { Write-Host "  [!!] $err" -ForegroundColor Red }
  Write-Host ""
  Write-Host "  Si el papel salio bien pero VETEX no imprime directo, el problema es la conexion"
  Write-Host "  entre el navegador y el puente: cuentale a soporte lo que dice Ajustes > Impresora."
  Write-Host ""
  Read-Host "  Enter para cerrar"
  exit 0
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
try { $listener.Start() }
catch { Write-Log "Ya hay un puente abierto en el puerto $port. Este se cierra."; exit 0 }
Write-Log "Puente de impresion iniciado en 127.0.0.1:$port"
Write-Host "VETEX - puente de impresion activo. No cierres esta ventana mientras uses VETEX." -ForegroundColor Magenta

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 5000
    $stream = $client.GetStream()
    $buf = New-Object byte[] 65536
    $ms = New-Object System.IO.MemoryStream
    $hEnd = -1
    do {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -gt 0) { $ms.Write($buf, 0, $n) }
      $txt = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())
      $hEnd = $txt.IndexOf("`r`n`r`n")
    } while ($hEnd -lt 0 -and $n -gt 0 -and $ms.Length -lt 1048576)
    if ($hEnd -lt 0) { continue }

    $lines = $txt.Substring(0, $hEnd) -split "`r`n"
    $first = $lines[0] -split ' '
    $method = $first[0]; $path = $first[1]
    $len = 0; $origin = ''
    foreach ($l in $lines) {
      if ($l -match '^Content-Length:\s*(\d+)') { $len = [int]$matches[1] }
      elseif ($l -match '^Origin:\s*(.*)$') { $origin = $matches[1].Trim() }
    }
    $start = $hEnd + 4
    while (($ms.Length - $start) -lt $len) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $ms.Write($buf, 0, $n)
    }
    $all = $ms.ToArray()
    $body = ''
    if ($all.Length -gt $start) { $body = [System.Text.Encoding]::UTF8.GetString($all, $start, $all.Length - $start) }

    # Solo se aceptan pedidos de VETEX abierto desde este PC (archivo local)
    Write-Log "$method $path origen=$origin"
    if ($origin -and $origin -ne 'null') { Send-Response $stream 403 '{"ok":false,"error":"Origen no permitido"}'; continue }

    if ($method -eq 'OPTIONS') { Send-Response $stream 204 ''; continue }
    if ($method -eq 'GET' -and $path -like '/estado*') {
      Send-Response $stream 200 ('{"ok":true,"version":4,"impresoras":' + (Get-Impresoras) + '}'); continue
    }
    if ($method -eq 'GET' -and $path -like '/bascula/puertos*') {
      $ps = @(); try { $ps = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique) } catch {}
      Send-Response $stream 200 ('{"ok":true,"puertos":' + (ConvertTo-Json @($ps) -Compress) + '}'); continue
    }
    if ($method -eq 'POST' -and $path -like '/bascula/leer*') {
      try { $req = $body | ConvertFrom-Json; $raw = Read-Bascula $req; Send-Response $stream 200 ('{"ok":true,"crudo":' + (ConvertTo-Json ([string]$raw)) + '}') }
      catch { Close-Bas; $m = $_.Exception.Message; Send-Response $stream 200 ('{"ok":false,"error":' + (ConvertTo-Json ([string]$m)) + '}') }
      continue
    }
    if ($method -eq 'POST' -and $path -like '/bascula/cerrar*') { Close-Bas; Send-Response $stream 200 '{"ok":true}'; continue }
    if ($method -eq 'GET' -and $path -like '/equipo*') {
      Send-Response $stream 200 ('{"ok":true,"equipo":"' + $script:EquipoId + '"}'); continue
    }
    if ($method -eq 'GET' -and $path -like '/red*') {
      $c = Read-SrvCfg
      $o = [ordered]@{ ok = $true; activo = [bool](('VetexDb' -as [type]) -and [VetexDb]::Activo); configurado = [bool]($c -and $c.activo); puerto = 17778; clave = ''; ips = @(Get-Ips); error = $script:SrvErr }
      if ($c) { $o.clave = [string]$c.clave; $o.puerto = [int]$c.puerto }
      # Diagnostico: este mismo equipo prueba el servidor sin pasar por el navegador
      $o.prueba = ''
      if ($o.activo) {
        try { $rq = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + $o.puerto + '/db/ping'); $rq.Timeout = 3000; $rq.Proxy = $null
          $rs = $rq.GetResponse(); $rd = New-Object System.IO.StreamReader($rs.GetResponseStream()); $null = $rd.ReadToEnd(); $rs.Close(); $o.prueba = 'ok' }
        catch { $o.prueba = $_.Exception.Message }
        try { $o.ultimoError = [string][VetexDb]::UltimoError } catch {}
      }
      Send-Response $stream 200 ($o | ConvertTo-Json -Compress); continue
    }
    if ($method -eq 'POST' -and $path -like '/red/activar*') {
      try {
        $req = $body | ConvertFrom-Json
        $clave = [string]$req.clave
        if ($clave.Length -lt 8) { throw 'Codigo de conexion muy corto' }
        New-Item -ItemType Directory -Force -Path $script:SrvDir | Out-Null
        (@{ activo = $true; puerto = 17778; clave = $clave } | ConvertTo-Json) | Set-Content -Path $script:SrvCfg -Encoding UTF8
        if (('VetexDb' -as [type]) -and [VetexDb]::Activo) { [VetexDb]::CambiarClave($clave) } else { Start-Servidor $clave 17778 }
        $script:SrvErr = ''
        Send-Response $stream 200 ('{"ok":true,"ips":' + (ConvertTo-Json @(Get-Ips) -Compress) + '}')
      } catch { $m = $_.Exception.Message; $script:SrvErr = $m; Write-Log "Servidor: $m"; Send-Response $stream 200 ('{"ok":false,"error":' + (ConvertTo-Json $m) + '}') }
      continue
    }
    if ($method -eq 'POST' -and $path -like '/red/desactivar*') {
      try { if ('VetexDb' -as [type]) { [VetexDb]::Stop() }
        $c = Read-SrvCfg; if ($c) { (@{ activo = $false; puerto = [int]$c.puerto; clave = [string]$c.clave } | ConvertTo-Json) | Set-Content -Path $script:SrvCfg -Encoding UTF8 }
        Send-Response $stream 200 '{"ok":true}'
      } catch { Send-Response $stream 200 ('{"ok":false,"error":' + (ConvertTo-Json $_.Exception.Message) + '}') }
      continue
    }
    if ($method -eq 'POST' -and $path -like '/actualizar*') {
      try { $v = Update-Vetex; Send-Response $stream 200 ('{"ok":true,"version":' + (ConvertTo-Json $v) + '}') }
      catch { $m = "No se pudo actualizar: $($_.Exception.Message)"; Write-Log $m; Send-Response $stream 200 ('{"ok":false,"error":' + (ConvertTo-Json $m) + '}') }
      continue
    }
    if ($method -eq 'POST' -and $path -like '/imprimir*') {
      try {
        $req = $body | ConvertFrom-Json
        $bytes = [System.Convert]::FromBase64String([string]$req.datos)
        $err = [MostradorRaw]::Send([string]$req.impresora, $bytes)
        if ($err -eq '') { Send-Response $stream 200 '{"ok":true}' }
        else { Write-Log $err; Send-Response $stream 200 ('{"ok":false,"error":' + (ConvertTo-Json $err) + '}') }
      } catch {
        $m = "Pedido de impresion invalido: $($_.Exception.Message)"
        Write-Log $m; Send-Response $stream 400 ('{"ok":false,"error":' + (ConvertTo-Json $m) + '}')
      }
      continue
    }
    Send-Response $stream 404 '{"ok":false,"error":"No encontrado"}'
  } catch {
    Write-Log "Error: $($_.Exception.Message)"
  } finally {
    if ($client) { try { $client.Close() } catch {} }
  }
}
