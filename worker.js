const Redis = require("ioredis");
const redis = new Redis();

const pool = require("./db");

async function processQueue(){

  while(true){

    const data = await redis.brpop("vote_queue", 0);

    if(data){
      const vote = JSON.parse(data[1]);

      try{
        await pool.query(
          "INSERT INTO votes (poll_id, option_id, device_id, ip, fingerprint) VALUES ($1,$2,$3,$4,$5)",
          [vote.poll_id, vote.option_id, vote.device_id, vote.ip, vote.fingerprint]
        );
      } catch(e){
        // duplicados ignorados
      }
    }

  }
}

processQueue();