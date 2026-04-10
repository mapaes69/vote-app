const { Pool } = require('pg');

const pool = new Pool({
  connectionString: "PEGA_AQUI_TU_DATABASE_URL",
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await pool.query(`CREATE UNIQUE INDEX unique_vote ON votes(fingerprint);`);
  console.log("✅ INDEX CREADO");
  process.exit();
})();