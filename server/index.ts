// ✅ Importa e carrega as variáveis do arquivo .env antes de tudo
import dotenv from "dotenv";
dotenv.config();

console.log("✅ Porta do .env:", process.env.PORT);

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes.js";

// ✅ Logger simples (substitui Vite log)
const log = (...args: any[]) => console.log("[AcquaSys]", ...args);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ✅ Habilita CORS para o frontend hospedado na Vercel
app.use(cors({
  origin: process.env.FRONTEND_URL || "https://acquasys-frontend.vercel.app",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ✅ Middleware de log das requisições
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 150) logLine = logLine.slice(0, 149) + "…";
      log(logLine);
    }
  });

  next();
});

(async () => {
  // ✅ Inicializa rotas da API
  await registerRoutes(app);

  // Middleware global de erros
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    log("❌ Erro no servidor:", message);
  });

  // ✅ Lê a variável PORT do .env (Render define automaticamente)
  const port = parseInt(process.env.PORT || "5000", 10);

  // ✅ Inicia o servidor Express corretamente
  app.listen(port, "0.0.0.0", () => {
    log(`✅ Servidor rodando na porta ${port}`);
    log(`🌱 Ambiente: ${process.env.NODE_ENV || "development"}`);
    log(`🌐 CORS liberado para: ${process.env.FRONTEND_URL || "https://acquasys-frontend.vercel.app"}`);
  });

  log("Frontend hospedado na Vercel. Servidor backend iniciado...");
})();
