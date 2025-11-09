// check-env.js
import dotenv from "dotenv";
dotenv.config();

const requiredVars = [
  "NODE_ENV",
  "PORT",
  "MQTT_HOST",
  "MQTT_PORT",
  "MQTT_TOPIC_SENSORS",
  "MQTT_TOPIC_PUMP_CONTROL",
  "MQTT_TOPIC_PUMP_STATUS",
  "MQTT_TOPIC_ALERTS",
  "INFLUX_URL",
  "INFLUX_DB",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "FRONTEND_URL",
  "DATABASE_URL",
];

console.log("🔍 Verificando variáveis do .env:\n");

let missing = [];

for (const key of requiredVars) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    console.log(`❌ ${key} → ausente ou vazio`);
    missing.push(key);
  } else {
    console.log(`✅ ${key} → ${value}`);
  }
}

if (missing.length > 0) {
  console.log("\n⚠️ Variáveis ausentes:", missing.join(", "));
  process.exit(1);
} else {
  console.log("\n✅ Todas as variáveis obrigatórias estão configuradas corretamente!");
}
