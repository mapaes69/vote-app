// 👉 PEGA TODO ESTE BLOQUE

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

const Redis = require("ioredis");
const pool = require("./db");

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  tls: {}
});

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

const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const SECRET_SALT = process.env.SECRET_SALT;
const IPQS_KEY = process.env.IPQS_KEY;

const VALID_OPTIONS = [1,2,3,4,5,6,7,8,9];

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

// 🔥 VPN / PROXY CHECK
async function checkIP(ip){
  try{
    const res = await fetch(`https://ipqualityscore.com/api/json/ip/${IPQS_KEY}/${ip}`);
    const data = await res.json();

    if(data.proxy || data.vpn || data.tor) return false;
    if(data.fraud_score > 85) return false;

    return true;
  }catch(e){
    return true;
  }
}

async function rateLimit(ip, fingerprint){

  const ipKey = `rate_ip:${ip}`;
  const devKey = `rate_dev:${fingerprint}`;
  const comboKey = `combo:${fingerprint}:${ip}`;

  const [ipCount, devCount, combo] = await Promise.all([
    redis.incr(ipKey),
    redis.incr(devKey),
    redis.incr(comboKey)
  ]);

  if(ipCount === 1) await redis.expire(ipKey, 60);
  if(devCount === 1) await redis.expire(devKey, 60);
  if(combo === 1) await redis.expire(comboKey, 60);

  if(ipCount > 25 || devCount > 10){
    throw new Error("RATE_LIMIT");
  }

  if(combo > 5){
    throw new Error("BOT_DETECTED");
  }
}

async function globalBurstProtection(){
  const count = await redis.incr("burst");

  if(count === 1){
    await redis.expire("burst", 1);
  }

  if(count > 200){
    throw new Error("BURST");
  }
}

async function riskScore(ip, fingerprint){
  const key = `risk:${fingerprint}`;
  let score = await redis.incr(key);

  if(score === 1){
    await redis.expire(key, 3600);
  }

  return score;
}

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
    if(risk > 15){
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

    const count = await redis.incr(`counter:${option_id}`);
    if(!count){
      throw new Error("REDIS_FAIL");
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
  console.log("🔥 SERVER 100% NIVEL EXTREMO ACTIVO");
});