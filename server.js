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
let redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  tls: {}
});

redis.on("error", () => {
  console.error("❌ Redis error crítico");
  process.exit(1);
});

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

app.use(cors({
  origin: [
    "https://encuestaperu2026.com",
    "https://vote-app-hugt.onrender.com",
    "http://localhost:3001"
  ]
}));

app.use(express.json());

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

// 🔥 fingerprint reforzado
function hashDevice(device_id, userAgent, ip){
  return crypto.createHash("sha256")
    .update(device_id + "|" + userAgent + "|" + ip + "|" + SECRET_SALT)
    .digest("hex");
}

async function verifyCaptcha(captcha, ip){
  try{
    if(typeof captcha !== "string" || captcha.length < 20){
      return false;
    }

    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {"Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({
          secret: TURNSTILE_SECRET,
          response: captcha,
          remoteip: ip
        })
      }
    );

    const data = await verify.json();
    return data.success;

  }catch{
    return false;
  }
}

// ================= RATE LIMIT ULTRA =================
async function rateLimit(ip, fingerprint){

  const ipKey = `rate_ip:${ip}`;
  const devKey = `rate_dev:${fingerprint}`;
  const comboKey = `combo:${fingerprint}:${ip}`;
  const blockKey = `block:${fingerprint}`;

  if(await redis.get(blockKey)){
    throw new Error("BLOCKED");
  }

  const pipeline = redis.pipeline();
  pipeline.incr(ipKey);
  pipeline.incr(devKey);
  pipeline.incr(comboKey);

  const result = await pipeline.exec();

  const ipCount = result[0][1];
  const devCount = result[1][1];
  const combo = result[2][1];

  if(ipCount === 1) await redis.expire(ipKey, 120);
  if(devCount === 1) await redis.expire(devKey, 300);
  if(combo === 1) await redis.expire(comboKey, 120);

  if(ipCount > 15 || devCount > 6){
    await redis.set(blockKey, "1", "EX", 900);
    throw new Error("RATE_LIMIT");
  }

  if(combo > 3){
    await redis.set(blockKey, "1", "EX", 1800);
    throw new Error("BOT_DETECTED");
  }
}

// ================= BURST =================
async function globalBurstProtection(){

  const key = "burst";
  const count = await redis.incr(key);

  if(count === 1){
    await redis.expire(key, 1);
  }

  if(count > 120){
    await redis.set("lock", "1", "EX", 5);
    throw new Error("BURST");
  }

  if(await redis.get("lock")){
    throw new Error("BURST");
  }
}

// ================= IA COMPORTAMIENTO =================
async function behaviorAnalysis(fingerprint){

  const now = Date.now();
  const key = `behavior:${fingerprint}`;

  const last = await redis.get(key);
  await redis.set(key, now, "EX", 600);

  if(!last) return;

  const diff = now - parseInt(last);

  // 🔥 modelo más realista
  if(diff < 400){
    await redis.incr(`bot:${fingerprint}`);
  }

  if(diff > 400 && diff < 1800){
    await redis.incr(`pattern:${fingerprint}`);
  }

  if(diff > 1800){
    await redis.decr(`pattern:${fingerprint}`);
  }

  const bot = parseInt(await redis.get(`bot:${fingerprint}`) || 0);
  const pattern = parseInt(await redis.get(`pattern:${fingerprint}`) || 0);

  if(bot > 4){
    await redis.set(`block:${fingerprint}`, "1", "EX", 3600);
    throw new Error("AI_BOT");
  }

  if(pattern > 8){
    await redis.set(`block:${fingerprint}`, "1", "EX", 1800);
    throw new Error("AI_PATTERN");
  }
}

// ================= RISK =================
async function riskScore(fingerprint){

  const key = `risk:${fingerprint}`;
  let score = await redis.incr(key);

  if(score === 1){
    await redis.expire(key, 7200);
  }

  if(score > 8){
    await redis.set(`block:${fingerprint}`, "1", "EX", 3600);
    throw new Error("HIGH_RISK");
  }

  return score;
}

// ================= VOTE =================
app.post("/vote", async (req, res) => {
  try {

    const { option_id, device_id, captcha } = req.body;

    if (!option_id || !device_id || !captcha) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    if(!VALID_OPTIONS.includes(Number(option_id))){
      return res.status(400).json({ error: "Opción inválida" });
    }

    const ip = getIP(req);
    const ua = req.headers["user-agent"] || "";
    const fingerprint = hashDevice(device_id, ua, ip);

    // 🔥 LOCK ATÓMICO (ANTI DOBLE VOTO REAL)
    const lock = await redis.set(`vote:${fingerprint}`, "1", "NX", "EX", 86400);
    if(!lock){
      return res.status(403).json({ error: "Ya votaste" });
    }

    await globalBurstProtection();
    await rateLimit(ip, fingerprint);
    await behaviorAnalysis(fingerprint);
    await riskScore(fingerprint);

    const captchaOk = await verifyCaptcha(captcha, ip);
    if (!captchaOk) {
      await redis.del(`vote:${fingerprint}`);
      return res.status(400).json({ error: "Captcha inválido" });
    }

    await redis.incr(`counter:${option_id}`);

    try{
      await pool.query(
        "INSERT INTO votes (option_id, ip, fingerprint) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [option_id, ip, fingerprint]
      );
    }catch(e){
      console.error("DB error");
    }

    res.json({ ok: true });

  } catch (err) {

    if(err.message === "RATE_LIMIT") return res.status(429).json({ error: "Demasiadas solicitudes" });
    if(err.message === "BURST") return res.status(503).json({ error: "Alta demanda" });
    if(err.message === "BOT_DETECTED") return res.status(403).json({ error: "Bot detectado" });
    if(err.message === "BLOCKED") return res.status(403).json({ error: "Bloqueado" });
    if(err.message === "HIGH_RISK") return res.status(403).json({ error: "Riesgo alto" });
    if(err.message === "AI_BOT") return res.status(403).json({ error: "IA detectó bot" });
    if(err.message === "AI_PATTERN") return res.status(403).json({ error: "Patrón sospechoso" });

    res.status(500).json({ error: "Error servidor" });
  }
});

// ================= RESULTS =================
app.get("/results/:poll_id", async (req, res) => {
  try{

    const pipeline = redis.pipeline();
    VALID_OPTIONS.forEach(id=> pipeline.get(`counter:${id}`));

    const data = await pipeline.exec();

    const results = VALID_OPTIONS.map((id,i)=>({
      option_id:id,
      votes: parseInt(data[i][1] || 0)
    }));

    const total = results.reduce((a,b)=>a+b.votes,0);

    res.json({ results, total });

  }catch{
    res.status(500).json({ error: "Error resultados" });
  }
});

app.listen(process.env.PORT || 3001, ()=>{
  console.log("🔥 ULTRA ANTIFRAUDE ACTIVO");
});