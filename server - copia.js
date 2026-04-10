const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

const Redis = require("ioredis");
const pool = require("./db");

// ================= REDIS =================
let redis;

try {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    connectTimeout: 5000,
    enableReadyCheck: false
  });

  redis.on("error", () => {
    console.log("⚠️ Redis degradado");
  });

} catch {
  console.error("⚠️ Redis no disponible");
}

if(!process.env.REDIS_URL){
  console.error("❌ FALTA REDIS_URL");
  process.exit(1);
}

const app = express();

app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "50kb" }));

app.use(cors({
  origin: [
    "https://encuestaperu2026.com",
    "https://vote-app-hugt.onrender.com"
  ]
}));

// ================= FRONTEND =================
const frontendPath = path.join(__dirname, "frontend");
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.send("🔥 Backend activo");
});

// ================= CONFIG =================
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const SECRET_SALT = process.env.SECRET_SALT || "ultra_seguro";

if(!TURNSTILE_SECRET){
  console.error("❌ FALTA TURNSTILE_SECRET");
  process.exit(1);
}

const VALID_OPTIONS = [1,2,3,4,5,6,7,8,9];

// ================= HELPERS =================
function getIP(req){
  let ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
  if(ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function hashDevice(device_id, userAgent, ip){
  return crypto.createHash("sha256")
    .update(device_id + "|" + userAgent + "|" + ip + "|" + SECRET_SALT)
    .digest("hex");
}

// ================= CAPTCHA =================
async function verifyCaptcha(captcha, ip){
  try{
    if(typeof captcha !== "string" || captcha.length < 10){
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {"Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({
          secret: TURNSTILE_SECRET,
          response: captcha,
          remoteip: ip
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    if(!verify.ok){
      return false;
    }

    const data = await verify.json();
    return data.success === true;

  }catch{
    return false;
  }
}

// ================= SAFE REDIS =================
async function safeRedis(fn){
  try{
    if(!redis) return null;

    let done = false;

    const result = await Promise.race([
      fn().then(r=>{
        done = true;
        return r;
      }),
      new Promise(resolve=>setTimeout(()=>{
        if(!done) resolve(null);
      }, 2500))
    ]);

    return result;

  }catch{
    return null;
  }
}

// ================= FALLBACK MEMORIA =================
const memoryRate = new Map();

// ================= DETECCIÓN HUMANA =================
const voteTiming = new Map();

function detectBot(fingerprint){
  const now = Date.now();

  if(!voteTiming.has(fingerprint)){
    voteTiming.set(fingerprint, []);
  }

  const arr = voteTiming.get(fingerprint).filter(t => now - t < 10000);
  arr.push(now);
  voteTiming.set(fingerprint, arr);

  if(arr.length > 2){
    return true;
  }

  return false;
}

// ================= RATE LIMIT =================
async function rateLimit(ip, fingerprint){
  try {
    const result = await safeRedis(async ()=>{
      const ipKey = `rate_ip:${ip}`;
      const devKey = `rate_dev:${fingerprint}`;

      const ipCount = await redis.incr(ipKey);
      const devCount = await redis.incr(devKey);

      if(ipCount === 1) await redis.expire(ipKey, 120);
      if(devCount === 1) await redis.expire(devKey, 300);

      if(ipCount > 15 || devCount > 6){
        throw new Error("RATE_LIMIT");
      }
    });

    if(result === null){
      const now = Date.now();

      if(!memoryRate.has(ip)){
        memoryRate.set(ip, []);
      }

      const arr = memoryRate.get(ip).filter(t => now - t < 60000);
      arr.push(now);
      memoryRate.set(ip, arr);

      if(arr.length > 20){
        throw new Error("RATE_LIMIT");
      }

      return;
    }

  } catch {
    throw new Error("RATE_LIMIT");
  }
}

// ================= RESULTS =================
app.get("/results/:poll_id", async (req, res) => {
  try {

    let total = 0;

    const data = await safeRedis(async ()=>{
      const pipeline = redis.pipeline();
      VALID_OPTIONS.forEach(id=>{
        pipeline.get(`counter:${id}`);
      });

      return await Promise.race([
        pipeline.exec(),
        new Promise(resolve=>setTimeout(()=>resolve(null), 2500))
      ]);
    });

    if(!data){
      return res.json({ results: [], total: 0 });
    }

    const results = VALID_OPTIONS.map((id,i)=>{
      const votes = parseInt(data?.[i]?.[1] || 0);
      total += votes;
      return { option_id:id, votes };
    });

    res.json({ results, total });

  } catch {
    res.json({ results: [], total: 0 });
  }
});

// ================= VOTE =================
app.post("/vote", async (req, res) => {
  try {

    const { option_id, device_id, captcha } = req.body;

    if (!option_id || !device_id || !captcha) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    if (typeof device_id !== "string" || device_id.length < 20 || device_id.length > 100) {
      return res.status(400).json({ error: "device_id inválido" });
    }

    if(!VALID_OPTIONS.includes(Number(option_id))){
      return res.status(400).json({ error: "Opción inválida" });
    }

    const ip = getIP(req);
    const ua = req.headers["user-agent"] || "";
    const fingerprint = hashDevice(device_id, ua, ip);

    if(detectBot(fingerprint)){
      return res.status(429).json({ error: "Actividad sospechosa" });
    }

    const captchaOk = await verifyCaptcha(captcha, ip);
    if (!captchaOk) {
      return res.status(400).json({ error: "Captcha inválido" });
    }

    await rateLimit(ip, fingerprint);

    const lock = await safeRedis(() =>
      redis.set(`vote:${fingerprint}`, "1", "NX", "EX", 86400)
    );

    if(lock !== "OK" && lock !== null){
      return res.status(403).json({ error: "Ya votaste" });
    }

    await safeRedis(()=> redis.incr(`counter:${option_id}`));

    try {
      await Promise.race([
        pool.query(
          "INSERT INTO votes (option_id, device_id, ip, fingerprint) VALUES ($1,$2,$3,$4)",
          [option_id, device_id, ip, fingerprint]
        ),
        new Promise((_, reject)=>setTimeout(()=>reject(new Error("DB_TIMEOUT")),3000))
      ]);
    } catch (e) {

      if(e.message === "DB_TIMEOUT"){
        return res.status(500).json({ error: "DB lenta, intenta nuevamente" });
      }

      return res.status(403).json({ error: "Ya votaste (DB)" });
    }

    res.json({ ok: true });

  } catch (err) {
    if(err.message === "RATE_LIMIT"){
      return res.status(429).json({ error: "Demasiadas solicitudes" });
    }

    res.status(500).json({ error: "Error servidor" });
  }
});

app.listen(process.env.PORT || 3001, ()=>{
  console.log("🔥 SERVER PRODUCCIÓN EMPRESA ACTIVO");
});