const { Pool } = require('pg');

// 🔥 DETECTA SI ESTÁ EN PRODUCCIÓN (Render)
const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false,
      },
    })
  : new Pool({
      user: 'postgres',
      host: 'localhost',
      database: 'vote_app',
      password: '221170',
      port: 5432,
    });

module.exports = pool;