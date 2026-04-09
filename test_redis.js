const Redis = require("ioredis");

const redis = new Redis({
  port: 6380
});

(async () => {
  try {
    await redis.set("test", "ok");
    const value = await redis.get("test");

    console.log("REDIS FUNCIONA:", value);

    process.exit(0);
  } catch (err) {
    console.error("ERROR REDIS:", err);
    process.exit(1);
  }
})();