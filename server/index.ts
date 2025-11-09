// ✅ Importa e carrega as variáveis do arquivo .env antes de tudo
import dotenv from "dotenv";
dotenv.config();

console.log("✅ Porta do .env:", process.env.PORT);

import express, { Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes.js";

// ✅ Define um logger simples no lugar do 'log' do Vite
const log = (...args: any[]) => console.log("[AcquaSys]", ...args);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Middleware de log de requisições
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

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // Middleware global de erros
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // ✅ Backend agora roda independente do frontend (Vercel cuida do React)
  log("Frontend hospedado na Vercel. Servidor backend iniciado...");

  // ✅ Lê a variável PORT do .env (ou usa 5000 como padrão)
  const port = parseInt(process.env.PORT || "5000", 10);

  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`✅ Servidor rodando na porta ${port}`);
      log(`🌱 Ambiente: ${process.env.NODE_ENV || "development"}`);
    }
  );
})();
