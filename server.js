const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

const Redis = require("ioredis");
const pool = require("./db");

// 🔥 REDIS PROTEGIDO
let redis;
try{
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    tls: {}
  });
}catch(e){
  console.error("Redis init error");
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
    "http://localhost:3001"
  ]
}));

app.use(express.json());

// ================= FRONTEND SAFE =================
const frontendPath = path.join(__dirname, "frontend");
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  const indexPath = path.join(frontendPath, "index.html");

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.send("🔥 Backend activo - API funcionando");
});

// ================= CONFIG =================
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const SECRET_SALT = process.env.SECRET_SALT || "fallback_seguro";
const IPQS_KEY = process.env.IPQS_KEY;

if(!TURNSTILE_SECRET){
  console.error("❌ FALTA TURNSTILE_SECRET");
}

if(!process.env.REDIS_URL){
  console.error("❌ FALTA REDIS_URL");
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

async function verifyCaptcha(captcha, ip){
  try{
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

  } catch(e){
    return false;
  }
}

// 🔥 CACHE IP CHECK
async function checkIP(ip){
  try{

    const cacheKey = `ipcheck:${ip}`;
    const cached = await redis?.get(cacheKey);

    if(cached){
      return cached === "1";
    }

    if(!IPQS_KEY){
      return true;
    }

    const res = await fetch(`https://ipqualityscore.com/api/json/ip/${IPQS_KEY}/${ip}`);
    const data = await res.json();

    let ipOk = true;

    if(data.proxy || data.vpn || data.tor) ipOk = false;
    if(data.fraud_score > 85) ipOk = false;

    await redis?.set(cacheKey, ipOk ? "1" : "0", "EX", 300);

    return ipOk;

  }catch(e){
    return true;
  }
}

async function rateLimit(ip, fingerprint){
  try{

    const ipKey = `rate_ip:${ip}`;
    const devKey = `rate_dev:${fingerprint}`;
    const comboKey = `combo:${fingerprint}:${ip}`;

    const pipeline = redis.pipeline();

    pipeline.incr(ipKey);
    pipeline.incr(devKey);
    pipeline.incr(comboKey);

    const result = await pipeline.exec();

    const ipCount = result[0][1];
    const devCount = result[1][1];
    const combo = result[2][1];

    if(ipCount === 1) await redis.expire(ipKey, 60);
    if(devCount === 1) await redis.expire(devKey, 60);
    if(combo === 1) await redis.expire(comboKey, 60);

    if(ipCount > 25 || devCount > 10){
      throw new Error("RATE_LIMIT");
    }

    if(combo > 5){
      throw new Error("BOT_DETECTED");
    }

  }catch(e){
    console.error("Rate limit error");
  }
}

async function globalBurstProtection(){
  try{
    const count = await redis.incr("burst");

    if(count === 1){
      await redis.expire("burst", 1);
    }

    if(count > 200){
      throw new Error("BURST");
    }
  }catch(e){
    console.error("Redis burst error");
  }
}

async function riskScore(ip, fingerprint){
  try{
    const key = `risk:${fingerprint}`;
    let score = await redis.incr(key);

    if(score === 1){
      await redis.expire(key, 3600);
    }

    return score;
  }catch(e){
    return 1;
  }
}

// ================= VOTE =================
app.post("/vote", async (req, res) => {
  try {
    const { option_id, poll_id = 1, device_id, captcha } = req.body;

    if (!option_id || !device_id || !captcha) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    if(!VALID_OPTIONS.includes(Number(option_id))){
      return res.status(400).json({ error: "Opción inválida" });
    }

    if(typeof device_id !== "string" || device_id.length < 20){
      return res.status(400).json({ error: "Device inválido" });
    }

    const ip = getIP(req);
    const userAgent = req.headers["user-agent"] || "unknown";
    const fingerprint = hashDevice(device_id, userAgent, ip);

    const ipOk = await checkIP(ip);
    if(!ipOk){
      return res.status(403).json({ error: "Acceso restringido" });
    }

    const risk = await riskScore(ip, fingerprint);
    if(risk > 20){
      return res.status(403).json({ error: "Actividad sospechosa" });
    }

    await globalBurstProtection();
    await rateLimit(ip, fingerprint);

    const captchaOk = await verifyCaptcha(captcha, ip);
    if (!captchaOk) {
      return res.status(400).json({ error: "Captcha inválido" });
    }

    const lock = await redis.set(`vote:${fingerprint}`, "1", "NX", "EX", 86400);

    if(!lock){
      return res.status(403).json({ error: "Ya votaste" });
    }

    try{
      await redis.incr(`counter:${option_id}`);
    }catch(e){
      console.error("Redis counter error");
    }

    try{
      await pool.query(
        "INSERT INTO votes (poll_id, option_id, ip, fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [poll_id, option_id, ip, fingerprint]
      );
    }catch(e){
      console.error("DB ERROR:", e.message);
    }

    res.json({ ok: true });

  } catch (err) {

    if(err.message === "RATE_LIMIT"){
      return res.status(429).json({ error: "Demasiadas solicitudes" });
    }

    if(err.message === "BURST"){
      return res.status(503).json({ error: "Alta demanda" });
    }

    if(err.message === "BOT_DETECTED"){
      return res.status(403).json({ error: "Actividad sospechosa" });
    }

    res.status(500).json({ error: "Error servidor" });
  }
});

// ================= RESULTS =================
app.get("/results/:poll_id", async (req, res) => {
  try {

    const pipeline = redis.pipeline();

    VALID_OPTIONS.forEach(id=>{
      pipeline.get(`counter:${id}`);
    });

    const data = await pipeline.exec();

    const results = VALID_OPTIONS.map((id, i)=>{
      const votes = parseInt(data[i][1] || 0);
      return { option_id: id, votes };
    });

    const total = results.reduce((a,b)=>a+b.votes,0);

    res.json({ results, total });

  } catch (err) {
    res.status(500).json({ error: "Error resultados" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("🔥 SERVER FINAL 100% LISTO");
});