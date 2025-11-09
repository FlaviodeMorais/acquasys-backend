import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage.js";
import { mqttInfluxIntegration } from "./mqtt-influx-integration.js";
import { telegramBot } from "./telegram-service.js";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // ================= SENSOR DATA =================
  app.get("/api/sensor-data/latest", async (req: Request, res: Response) => {
    try {
      const mqttData = await mqttInfluxIntegration.getLatestData?.();

      if (mqttData?.mqtt) {
        const apiData = {
          id: `mqtt_${mqttData.mqtt.device}_${Date.now()}`,
          level: mqttData.mqtt.level,
          temperature: mqttData.mqtt.temperature,
          current: mqttData.mqtt.current,
          flowRate: mqttData.mqtt.flowRate,
          vibration: mqttData.mqtt.vibration?.rms ?? 0,
          pumpStatus: mqttData.mqtt.pump,
          timestamp: new Date().toISOString(),
        };
        res.json(apiData);
      } else {
        const data = await storage.getLatestSensorData();
        res.json(data);
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch sensor data" });
    }
  });

  app.get("/api/sensor-data/history", async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const historicalData =
        (await mqttInfluxIntegration.getHistoricalData?.(24)) || [];

      if (historicalData.length > 0) {
        const apiHistory = historicalData.slice(-limit).map((reading: any, index: number) => ({
          id: `influx_${reading.device}_${index}`,
          level: reading.level,
          temperature: reading.temperature,
          current: reading.current,
          flowRate: reading.flowRate,
          vibration: reading.vibration_rms ?? 0,
          pumpStatus: reading.pump,
          timestamp: new Date(reading.timestamp).toISOString(),
        }));
        res.json(apiHistory);
      } else {
        const data = await storage.getSensorDataHistory(limit);
        res.json(data);
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch sensor data history" });
    }
  });

  // ================= ML PREDICTIONS =================
  app.get("/api/ml-predictions/latest", async (req: Request, res: Response) => {
    try {
      const prediction = await storage.getLatestMLPrediction();
      res.json(prediction);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch ML prediction" });
    }
  });

  // ================= ALERTS =================
  app.get("/api/system-alerts", async (_req: Request, res: Response) => {
    try {
      const alerts = await storage.getSystemAlerts();
      res.json(alerts);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch system alerts" });
    }
  });

  // ================= SYSTEM CONFIG =================
  app.get("/api/system-config", async (_req: Request, res: Response) => {
    try {
      const config = await storage.getSystemConfig();
      res.json(config);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch system config" });
    }
  });

  // ================= MQTT ROUTES =================
  app.get("/api/mqtt/sensor-data/latest", async (_req: Request, res: Response) => {
    try {
      const data = await mqttInfluxIntegration.getLatestData?.();
      if (data?.mqtt) {
        const transformedData = {
          id: data.mqtt.device || "mqtt_device",
          timestamp: data.timestamp || new Date().toISOString(),
          level: data.mqtt.level ?? 0,
          temperature: data.mqtt.temperature ?? 0,
          flowRate: data.mqtt.flowRate ?? 0,
          current: data.mqtt.current ?? 0,
          vibration: data.mqtt.vibration?.rms ?? 0,
          pumpStatus: data.mqtt.pump ?? false,
          efficiency: data.mqtt.efficiency ?? 0,
          connectionStatus: "connected",
        };
        res.json(transformedData);
      } else {
        res.status(404).json({ error: "No MQTT data available" });
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch MQTT sensor data" });
    }
  });

  app.get("/api/mqtt/sensor-data/history", async (req: Request, res: Response) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const data = await mqttInfluxIntegration.getHistoricalData?.(hours);
      res.json(data || []);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch MQTT sensor history" });
    }
  });

  app.post("/api/mqtt/pump/control", async (req: Request, res: Response) => {
    try {
      const { action } = req.body;
      if (!["on", "off", "auto"].includes(action)) {
        return res.status(400).json({ error: "Invalid action" });
      }
      const success = mqttInfluxIntegration.controlPump?.(action);
      if (success) res.json({ success: true });
      else res.status(500).json({ error: "Failed to control pump" });
    } catch (error) {
      res.status(500).json({ error: "Failed to send pump command" });
    }
  });

  // ================= TELEGRAM TEST =================
  app.post("/api/telegram/test", async (_req: Request, res: Response) => {
    try {
      const isConnected = await telegramBot.testConnection?.();
      if (isConnected) {
        await telegramBot.sendAlert?.({
          device: "AcquaSys Test",
          level: 75.5,
          current: 3.2,
          vibration: 1.2,
          pumpStatus: true,
          timestamp: new Date(),
          alertType: "info",
          message: "🧪 Teste de conectividade do bot - Sistema funcionando!",
        });
        res.json({ success: true });
      } else {
        res.status(500).json({ error: "Telegram bot not connected" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to test Telegram bot" });
    }
  });

  // ================= PUMP CONTROL =================
  const addAlert = async (title: string, message: string) => {
    await storage.addSystemAlert({
      type: "info",
      title,
      message,
    });
  };

  app.post("/api/pump/start", async (_req: Request, res: Response) => {
    try {
      await storage.updateSystemConfig({ pumpStatus: true, pumpMode: "manual" });
      await addAlert("Bomba Ligada", "Bomba ligada manualmente via painel");
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to start pump" });
    }
  });

  app.post("/api/pump/stop", async (_req: Request, res: Response) => {
    try {
      await storage.updateSystemConfig({ pumpStatus: false, pumpMode: "manual" });
      await addAlert("Bomba Parada", "Bomba parada manualmente via painel");
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to stop pump" });
    }
  });

  app.post("/api/pump/auto", async (_req: Request, res: Response) => {
    try {
      await storage.updateSystemConfig({ pumpMode: "auto" });
      await addAlert("Modo Automático", "Bomba alterada para modo automático");
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to switch mode" });
    }
  });

  // ================= WEBSOCKET =================
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  mqttInfluxIntegration.setWebSocketServer?.(wss);

  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected via WebSocket");
    sendLatestData(ws);
    ws.on("close", () => console.log("Client disconnected"));
  });

  async function sendLatestData(ws?: WebSocket) {
    try {
      const sensorData = await storage.getLatestSensorData();
      const mlPrediction = await storage.getLatestMLPrediction();
      const systemConfig = await storage.getSystemConfig();

      const payload = JSON.stringify({
        type: "data-update",
        sensorData,
        mlPrediction,
        systemConfig,
        timestamp: new Date().toISOString(),
      });

      if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
      else
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        });
    } catch (error) {
      console.error("WebSocket error:", error);
    }
  }

  return httpServer;
}
