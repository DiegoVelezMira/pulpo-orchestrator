import { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import Database from "better-sqlite3";

// Acceso por oficina (Pulpo v1): una clave compartida por oficina + el nombre de la persona
// (solo para el historial, sin verificar) y un acceso de administrador aparte.
// La oficina SIEMPRE sale de la sesión firmada, nunca de lo que mande el navegador.

const COOKIE = "pulpo_sesion";
const DURACION_MS = 12 * 3600 * 1000;
const MAX_FALLOS_IP = 3; // por oficina y dirección de red
const MAX_FALLOS_OFICINA = 10; // por oficina, sumando todas las direcciones

type Sesion = { r: "o" | "a"; o: number | null; n: string; e: number };

export function iniciarTablasAcceso(db: Database.Database) {
  try {
    db.exec(`ALTER TABLE offices ADD COLUMN clave_hash TEXT`);
  } catch {
    // ya existe
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS acceso_intentos (
      scope TEXT PRIMARY KEY,
      fallos INTEGER NOT NULL DEFAULT 0,
      bloqueado_hasta INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// --- Claves ---------------------------------------------------------------

export function hashClave(clave: string): string {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(clave, sal, 32);
  return `scrypt$${sal.toString("hex")}$${h.toString("hex")}`;
}

export function verificarClave(clave: string, guardado: string | null | undefined): boolean {
  if (!guardado) return false;
  const p = guardado.split("$");
  if (p.length !== 3 || p[0] !== "scrypt") return false;
  const esperado = Buffer.from(p[2], "hex");
  const h = crypto.scryptSync(clave, Buffer.from(p[1], "hex"), esperado.length);
  return crypto.timingSafeEqual(h, esperado);
}

const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin O, I, L, 0, 1
export function generarClave(): string {
  const b = crypto.randomBytes(16);
  const c = Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join("");
  return c.match(/.{4}/g)!.join("-");
}

function igualesSeguro(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- Sesión firmada en cookie -----------------------------------------------

function b64u(s: Buffer | string) {
  return Buffer.from(s).toString("base64url");
}

function firmar(secreto: string, payload: string) {
  return crypto.createHmac("sha256", secreto).update(payload).digest("base64url");
}

function leerCookie(req: Request, nombre: string): string | null {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const parte of h.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function limpiarNombre(n: unknown): string {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// --- Configuración --------------------------------------------------------

export function configurarAcceso(app: Express, db: Database.Database) {
  const publico = process.env.PULPO_PUBLIC === "1";
  let secreto = process.env.PULPO_SESSION_SECRET || "";
  let adminKey = process.env.PULPO_ADMIN_KEY || "";
  const bloqueoMin = Math.max(1, Number(process.env.PULPO_BLOQUEO_MIN) || 15);

  if (publico) {
    if (secreto.length < 32 || adminKey.length < 16) {
      console.error("✗ PULPO_PUBLIC=1 exige PULPO_SESSION_SECRET (32+ caracteres) y PULPO_ADMIN_KEY (16+). No se inicia.");
      process.exit(1);
    }
    app.set("trust proxy", 1);
  } else {
    if (!secreto) {
      secreto = crypto.randomBytes(32).toString("hex");
      console.warn("! PULPO_SESSION_SECRET no definida: las sesiones se pierden al reiniciar.");
    }
    if (!adminKey) {
      adminKey = generarClave();
      console.warn(`! PULPO_ADMIN_KEY no definida: clave de administrador temporal de esta ejecución: ${adminKey}`);
    }
  }

  const ahora = () => Date.now();

  function emitir(req: Request, res: Response, s: Omit<Sesion, "e">) {
    const payload = b64u(JSON.stringify({ ...s, e: ahora() + DURACION_MS }));
    const seguro = publico || req.secure || req.headers["x-forwarded-proto"] === "https";
    res.append(
      "Set-Cookie",
      `${COOKIE}=${payload}.${firmar(secreto, payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACION_MS / 1000}${seguro ? "; Secure" : ""}`
    );
  }

  function leerSesion(req: Request): Sesion | null {
    const c = leerCookie(req, COOKIE);
    if (!c) return null;
    const i = c.lastIndexOf(".");
    if (i < 1) return null;
    const payload = c.slice(0, i);
    const firma = c.slice(i + 1);
    const esperada = firmar(secreto, payload);
    if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Sesion;
      if (!s || (s.r !== "o" && s.r !== "a") || typeof s.e !== "number" || s.e < ahora()) return null;
      return s;
    } catch {
      return null;
    }
  }

  // --- Bloqueo por intentos ---
  function bloqueadoHasta(scope: string): number {
    const f = db.prepare("SELECT bloqueado_hasta FROM acceso_intentos WHERE scope = ?").get(scope) as any;
    return f && f.bloqueado_hasta > ahora() ? f.bloqueado_hasta : 0;
  }
  function registrarFallo(scope: string, max: number) {
    const f = db.prepare("SELECT fallos, bloqueado_hasta FROM acceso_intentos WHERE scope = ?").get(scope) as any;
    let fallos = (f && f.bloqueado_hasta <= ahora() && f.bloqueado_hasta !== 0 ? 0 : f?.fallos ?? 0) + 1;
    let hasta = 0;
    if (fallos >= max) {
      hasta = ahora() + bloqueoMin * 60 * 1000;
      fallos = 0;
    }
    db.prepare(
      "INSERT INTO acceso_intentos (scope, fallos, bloqueado_hasta) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta"
    ).run(scope, fallos, hasta);
  }
  function limpiarFallos(scope: string) {
    db.prepare("DELETE FROM acceso_intentos WHERE scope = ?").run(scope);
  }
  function respuestaBloqueo(res: Response, hasta: number) {
    const min = Math.max(1, Math.ceil((hasta - ahora()) / 60000));
    return res.status(429).json({
      status: "error",
      codigo: "bloqueado",
      error: `Demasiados intentos con la clave. Por seguridad, espera ${min} minuto${min === 1 ? "" : "s"} antes de intentarlo de nuevo.`,
    });
  }

  // --- Protección contra peticiones de otro origen ---
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    const origen = req.headers.origin;
    if (origen) {
      try {
        if (new URL(origen).host !== req.headers.host) return res.status(403).json({ status: "error", error: "Origen no permitido" });
      } catch {
        return res.status(403).json({ status: "error", error: "Origen no permitido" });
      }
    }
    next();
  });

  // --- Rutas públicas de acceso ---
  app.get("/api/acceso/estado", (req, res) => {
    const s = leerSesion(req);
    if (!s) return res.status(401).json({ autenticado: false });
    const of = s.o ? (db.prepare("SELECT id, name FROM offices WHERE id = ?").get(s.o) as any) : null;
    res.json({ autenticado: true, rol: s.r === "a" ? "admin" : "oficina", nombre: s.n, oficina: of ? { id: of.id, nombre: of.name } : null });
  });

  app.get("/api/acceso/oficina/:id", (req, res) => {
    const of = db.prepare("SELECT id, name FROM offices WHERE id = ?").get(Number(req.params.id)) as any;
    if (!of) return res.status(404).json({ status: "error", error: "Oficina no encontrada" });
    res.json({ id: of.id, nombre: of.name });
  });

  app.post("/api/acceso/entrar", (req, res) => {
    const officeId = Number(req.body?.officeId);
    const nombre = limpiarNombre(req.body?.nombre);
    const clave = String(req.body?.clave ?? "");
    if (!Number.isInteger(officeId) || !nombre || !clave) {
      return res.status(400).json({ status: "error", error: "Escribe tu nombre y la clave de la oficina." });
    }
    const ip = req.ip || "desconocida";
    const sIp = `o:${officeId}:${ip}`;
    const sOf = `o:${officeId}:*`;
    const b = Math.max(bloqueadoHasta(sIp), bloqueadoHasta(sOf));
    if (b) return respuestaBloqueo(res, b);
    const of = db.prepare("SELECT id, clave_hash FROM offices WHERE id = ?").get(officeId) as any;
    // Se verifica aunque la oficina no exista, para no revelar qué oficinas hay por el tiempo de respuesta.
    const ok = of ? verificarClave(clave, of.clave_hash) : verificarClave(clave, "scrypt$00$00");
    if (!ok) {
      registrarFallo(sIp, MAX_FALLOS_IP);
      registrarFallo(sOf, MAX_FALLOS_OFICINA);
      const nb = Math.max(bloqueadoHasta(sIp), bloqueadoHasta(sOf));
      if (nb) return respuestaBloqueo(res, nb);
      return res.status(401).json({ status: "error", codigo: "clave", error: "La clave no es correcta. Revísala e inténtalo de nuevo." });
    }
    limpiarFallos(sIp);
    emitir(req, res, { r: "o", o: officeId, n: nombre });
    res.json({ status: "ok", nombre });
  });

  app.post("/api/acceso/admin", (req, res) => {
    const clave = String(req.body?.clave ?? "");
    const scope = `a:${req.ip || "desconocida"}`;
    const b = bloqueadoHasta(scope);
    if (b) return respuestaBloqueo(res, b);
    if (!clave || !igualesSeguro(clave, adminKey)) {
      registrarFallo(scope, MAX_FALLOS_IP);
      const nb = bloqueadoHasta(scope);
      if (nb) return respuestaBloqueo(res, nb);
      return res.status(401).json({ status: "error", codigo: "clave", error: "La clave no es correcta. Revísala e inténtalo de nuevo." });
    }
    limpiarFallos(scope);
    emitir(req, res, { r: "a", o: null, n: limpiarNombre(req.body?.nombre) || "Administrador" });
    res.json({ status: "ok" });
  });

  app.post("/api/acceso/salir", (req, res) => {
    res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ status: "ok" });
  });

  // --- Barrera: todo lo demás exige sesión ---
  const PUBLICAS = new Set(["/health", "/entrar.html", "/gmail/oauth/callback"]);

  function oficinaPermitida(req: Request, s: Sesion): boolean {
    const p = req.path;
    let m = p.match(/^\/offices\/(\d+)(\/|$)/) || p.match(/^\/api\/crews\/oficinas\/(\d+)(\/|$)/);
    if (m) return Number(m[1]) === s.o;
    if (req.method === "POST" && (p === "/api/crews/contable/lote" || p === "/api/crews/contable/procesar")) {
      return Number(req.body?.officeId) === s.o;
    }
    if (req.method === "GET" && /^\/api\/crews\/contable\/lote\/[0-9a-f-]{36}$/.test(p)) return true; // id aleatorio
    m = p.match(/^\/tasks\/(\d+)\//);
    if (m) {
      const t = db.prepare("SELECT office_id FROM tasks WHERE id = ?").get(Number(m[1])) as any;
      return !!t && t.office_id === s.o;
    }
    return false; // lo demás es solo del administrador
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (PUBLICAS.has(req.path) || req.path.startsWith("/api/acceso/")) return next();
    const s = leerSesion(req);
    const esApi = /^\/(api|offices|tasks|directives|learnings|classify)(\/|$)/.test(req.path);
    if (!s) {
      if (esApi) return res.status(401).json({ status: "error", codigo: "sin_sesion", error: "Debes entrar con la clave de la oficina." });
      return res.redirect("/entrar.html" + (req.query.oficina ? `?oficina=${encodeURIComponent(String(req.query.oficina))}` : ""));
    }
    (req as any).sesion = s;
    if (req.path.startsWith("/api/admin/") && s.r !== "a") {
      return res.status(403).json({ status: "error", error: "Solo el administrador." });
    }
    if (s.r === "o" && esApi && !req.path.startsWith("/api/admin/")) {
      if (!oficinaPermitida(req, s)) {
        return res.status(403).json({ status: "error", error: "Esta oficina no tiene acceso a ese recurso." });
      }
      // El nombre del historial es el que la persona escribió al entrar, no el que mande el navegador.
      if (req.method === "POST" && /\/documentos\/[^/]+\/revision$/.test(req.path) && req.body && typeof req.body === "object") {
        req.body.revisor = s.n;
      }
    }
    next();
  });

  // --- Administrador: oficinas y claves ---
  app.get("/api/admin/oficinas", (_req, res) => {
    const filas = db.prepare("SELECT id, name, created_at, clave_hash IS NOT NULL AS tiene_clave FROM offices ORDER BY id").all();
    res.json(filas);
  });

  app.post("/api/admin/oficinas", (req, res) => {
    const nombre = limpiarNombre(req.body?.name);
    if (!nombre) return res.status(400).json({ status: "error", error: "Escribe el nombre de la oficina." });
    if (db.prepare("SELECT id FROM offices WHERE name = ?").get(nombre)) {
      return res.status(409).json({ status: "error", error: "Ya existe una oficina con ese nombre." });
    }
    const clave = generarClave();
    const info = db.prepare("INSERT INTO offices (name, clave_hash) VALUES (?, ?)").run(nombre, hashClave(clave));
    res.status(201).json({ status: "ok", id: Number(info.lastInsertRowid), name: nombre, clave }); // la clave solo se muestra aquí
  });

  app.post("/api/admin/oficinas/:id/clave", (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare("SELECT id FROM offices WHERE id = ?").get(id)) return res.status(404).json({ status: "error", error: "Oficina no encontrada" });
    const clave = typeof req.body?.clave === "string" && req.body.clave.length >= 12 ? req.body.clave : generarClave();
    db.prepare("UPDATE offices SET clave_hash = ? WHERE id = ?").run(hashClave(clave), id);
    db.prepare("DELETE FROM acceso_intentos WHERE scope LIKE ?").run(`o:${id}:%`);
    res.json({ status: "ok", id, clave }); // la clave solo se muestra aquí
  });
}
