// ✅ Carrega variáveis de ambiente (.env)
import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { registerRoutes } from "./routes.js";
import { mqttInfluxIntegration } from "./mqtt-influx-integration.js";
import { telegramBot } from "./telegram-service.js";

// ==============================
// 🔧 Inicialização do servidor
// ==============================
const log = (...args: any[]) => console.log("[AcquaSys]", ...args);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ==============================
// 🌍 CORS seguro e completo
// ==============================
const allowedOrigins = [
  process.env.FRONTEND_URL || "https://acquasys-frontend.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("🚫 Bloqueado por CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Garante headers CORS em todas as respostas
app.use((_req, res, next) => {
  res.header(
    "Access-Control-Allow-Origin",
    process.env.FRONTEND_URL || "https://acquasys-frontend.vercel.app"
  );
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// ==============================
// 🧾 Logger de requisições REST
// ==============================
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let captured: any = undefined;

  const originalJson = res.json;
  res.json = function (body, ...args) {
    captured = body;
    return originalJson.apply(res, [body, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const preview = captured ? JSON.stringify(captured).slice(0, 120) : "";
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms ${preview}`);
    }
  });

  next();
});

// ==============================
// 🚀 Inicialização principal
// ==============================
(async () => {
  const httpServer = createServer(app);
  await registerRoutes(app);

  // ==============================
  // 🌐 WEBSOCKET
  // ==============================
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  mqttInfluxIntegration.setWebSocketServer(wss);

  wss.on("connection", (ws) => {
    log("🔌 Cliente WebSocket conectado");

    // Mensagem inicial
    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "Conectado ao AcquaSys Backend",
        version: process.env.npm_package_version || "1.0.0",
      })
    );

    // Recebe comandos do frontend (ex: controle manual)
    ws.on("message", (msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload?.type === "controlPump") {
          mqttInfluxIntegration.controlPump(payload.action);
        }
      } catch (err) {
        console.warn("⚠️ Erro ao processar mensagem WS:", err);
      }
    });

    ws.on("close", () => log("🔌 Cliente WebSocket desconectado."));
  });

  // ==============================
  // 📡 Reenvio de eventos do Telegram para o Frontend
  // ==============================
  telegramBot.on("log", (msg: string) => {
    log("🤖 Log Telegram:", msg);
    // broadcast para todos os clientes
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(
          JSON.stringify({
            type: "telegramLog",
            data: { message: msg, ts: new Date().toISOString() },
          })
        );
      }
    });
  });

  // ==============================
  // ⚙️ Middleware global de erros
  // ==============================
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    log("❌ Erro no servidor:", err.message);
    res.status(status).json({ message: err.message || "Internal Server Error" });
  });

  // ==============================
  // 🔌 Inicializa servidor HTTP
  // ==============================
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    log(`✅ Servidor rodando na porta ${port}`);
    log(`🌱 Ambiente: ${process.env.NODE_ENV || "development"}`);
    log(`🌐 CORS liberado para: ${allowedOrigins.join(", ")}`);
    log("🖥️ Frontend hospedado na Vercel.");
    log("🚀 Backend AcquaSys iniciado com sucesso.");
  });
})();

