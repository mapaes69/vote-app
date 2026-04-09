const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");
const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

const Redis = require("ioredis");
const pool = require("./db");

// 🔥 REDIS CORREGIDO
const redis = new Redis({
  port: 6380,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 50, 2000);
  }
});

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: ["*"] }));
app.use(express.json());

// ================= FRONTEND =================
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ================= CONFIG =================
// 🔥 PEGA TU CLAVE AQUÍ
const TURNSTILE_SECRET = "0x4AAAAAAC2UKBGuHi7mK-b9PrhVVYTpOG8";

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
    .update(device_id + "|" + userAgent + "|" + ip)
    .digest("hex");
}

// ================= CAPTCHA =================
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
    return data.success && data.hostname === "encuestaperu2026.com";

  } catch(e){
    return false;
  }
}

// ================= RATE LIMIT =================
async function rateLimit(ip){

  const key = `rate:${ip}`;

  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, 60);

  const res = await pipeline.exec();
  const count = res[0][1];

  if(count > 25){
    throw new Error("RATE_LIMIT");
  }
}

// ================= BURST =================
async function globalBurstProtection(){
  const count = await redis.incr("burst");

  if(count === 1){
    await redis.expire("burst", 1);
  }

  if(count > 200){
    throw new Error("BURST");
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

    await globalBurstProtection();
    await rateLimit(ip);

    const captchaOk = await verifyCaptcha(captcha, ip);
    if (!captchaOk) {
      return res.status(400).json({ error: "Captcha inválido" });
    }

    const lock = await redis.set(`vote:${fingerprint}`, "1", "NX", "EX", 86400);

    if(!lock){
      return res.status(403).json({ error: "Ya votaste" });
    }

    const pipeline = redis.pipeline();
    pipeline.incr(`counter:${option_id}`);
    pipeline.exec();

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
  console.log("🔥 SERVER LISTO Y FUNCIONANDO");
});