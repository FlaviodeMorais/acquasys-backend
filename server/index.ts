// ✅ Carrega variáveis de ambiente (.env)
import dotenv from "dotenv";
dotenv.config();

console.log("✅ Porta do .env:", process.env.PORT);

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer } from "http";
import { registerRoutes } from "./routes.js";

// ✅ Logger simples e padronizado
const log = (...args: any[]) => console.log("[AcquaSys]", ...args);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ✅ CORS seguro e flexível (Vercel + local + Render)
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

// ✅ Middleware de log das requisições REST
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const preview = JSON.stringify(capturedJsonResponse).slice(0, 120);
        logLine += ` :: ${preview}${preview.length >= 120 ? "…" : ""}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  // ✅ Registra rotas e integra WebSocket
  const server = await registerRoutes(app);

  // ✅ Middleware global de erros
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    log("❌ Erro no servidor:", message);
    res.status(status).json({ message });
  });

  // ✅ Define porta do ambiente (Render define automaticamente)
  const port = parseInt(process.env.PORT || "5000", 10);

  // ✅ Inicia o servidor (Render/Local)
  server.listen(port, "0.0.0.0", () => {
    log(`✅ Servidor rodando na porta ${port}`);
    log(`🌱 Ambiente: ${process.env.NODE_ENV || "development"}`);
    log(`🌐 CORS liberado para: ${allowedOrigins.join(", ")}`);
  });

  log("🚀 Backend AcquaSys iniciado com sucesso.");
  log("🖥️ Frontend hospedado na Vercel.");
})();
