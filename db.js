const { Pool } = require('pg');

// 🔥 PRODUCCIÓN (Render)
const connectionString = process.env.DATABASE_URL;

let pool;

if (connectionString) {
  console.log("🌐 Modo PRODUCCIÓN (Render DB)");

  pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
    max: 20, // 🔥 MEJORADO PARA ALTA CARGA
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

} else {
  console.log("💻 Modo LOCAL");

  pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'vote_app',
    password: '221170',
    port: 5432,
  });
}

// 🔥 TEST DE CONEXIÓN (puedes dejarlo si quieres debug)
pool.connect()
  .then(client => {
    console.log("✅ PostgreSQL conectado");
    client.release();
  })
  .catch(err => {
    console.error("❌ ERROR PostgreSQL:", err.message);
  });

// 🔥 MANEJO GLOBAL DE ERRORES
pool.on('error', (err) => {
  console.error("❌ ERROR inesperado PostgreSQL:", err.message);
});

module.exports = pool;