const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "../frontend")));

// ================= API =================
app.post("/vote", async (req, res) => {
try {
const { option_id } = req.body;

// 🔥 IP REAL
let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
if (ip.includes(",")) ip = ip.split(",")[0].trim();

// 🔥 USER AGENT
const userAgent = req.headers["user-agent"] || "";

// 🔥 FINGERPRINT REAL (backend)
const fingerprint = crypto
.createHash("sha256")
.update(ip + userAgent)
.digest("hex");

// 🔥 INSERT CON BLOQUEO DB
await pool.query(
"INSERT INTO votes (option_id, device_id, ip, fingerprint) VALUES ($1,$2,$3,$4)",
[option_id, userAgent, ip, fingerprint]
);

res.json({ ok: true });

} catch (err) {
return res.status(400).json({ error: "Ya votaste" });
}
});

app.get("/results/:id", async (req, res) => {
const result = await pool.query(
"SELECT option_id, COUNT(*) as votes FROM votes GROUP BY option_id"
);

res.json({
results: result.rows,
total: result.rows.reduce((a, b) => a + parseInt(b.votes), 0)
});
});

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(3001, "0.0.0.0", () => {
console.log("🔥 ULTRA PRO SERVER corriendo en http://0.0.0.0:3001");
});