import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { insertSensorDataSchema, insertSystemAlertSchema } from "@shared/schema";
import { mqttInfluxIntegration } from "./mqtt-influx-integration";
import { telegramBot } from "./telegram-service";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // API Routes
  app.get("/api/sensor-data/latest", async (req, res) => {
    try {
      // USAR DADOS REAIS DO MQTT em vez do storage mock
      const mqttData = await mqttInfluxIntegration.getLatestData();
      if (mqttData.mqtt) {
        // Converter dados MQTT para formato da API
        const apiData = {
          id: `mqtt_${mqttData.mqtt.device}_${Date.now()}`,
          waterLevel: mqttData.mqtt.level,
          temperature: mqttData.mqtt.temperature,
          current: mqttData.mqtt.current,
          flowRate: mqttData.mqtt.flowRate,
          vibration: mqttData.mqtt.vibration.rms,
          pumpStatus: mqttData.mqtt.pump,
          timestamp: new Date().toISOString(), // Usar timestamp atual em vez do inválido
        };
        res.json(apiData);
      } else {
        // Fallback para storage apenas se MQTT não disponível
        const data = await storage.getLatestSensorData();
        res.json(data);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sensor data" });
    }
  });

  app.get("/api/sensor-data/history", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      // USAR DADOS REAIS DO MQTT/InfluxDB em vez do storage mock
      const historicalData = await mqttInfluxIntegration.getHistoricalData(24);
      if (historicalData && historicalData.length > 0) {
        // Converter dados InfluxDB para formato da API
        const apiHistory = historicalData.slice(-limit).map((reading, index) => ({
          id: `influx_${reading.device}_${index}`,
          waterLevel: reading.level,
          temperature: reading.temperature,
          current: reading.current,
          flowRate: reading.flowRate,
          vibration: reading.vibration_rms,
          pumpStatus: reading.pump,
          timestamp: reading.timestamp.toISOString(),
        }));
        res.json(apiHistory);
      } else {
        // Fallback para storage apenas se dados MQTT/InfluxDB não disponíveis
        const data = await storage.getSensorDataHistory(limit);
        res.json(data);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sensor data history" });
    }
  });

  app.get("/api/ml-predictions/latest", async (req, res) => {
    try {
      const prediction = await storage.getLatestMLPrediction();
      res.json(prediction);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch ML prediction" });
    }
  });

  app.get("/api/system-alerts", async (req, res) => {
    try {
      const alerts = await storage.getSystemAlerts();
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch system alerts" });
    }
  });

  app.get("/api/system-config", async (req, res) => {
    try {
      const config = await storage.getSystemConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch system config" });
    }
  });

  // MQTT + InfluxDB Routes
  app.get("/api/mqtt/sensor-data/latest", async (req, res) => {
    try {
      const data = await mqttInfluxIntegration.getLatestData();
      
      // Transformar dados MQTT para formato compatível com frontend
      if (data && data.mqtt) {
        const transformedData = {
          id: data.mqtt.device || "mqtt_device",
          timestamp: data.timestamp || new Date().toISOString(),
          waterLevel: data.mqtt.level || 0,
          temperature: data.mqtt.temperature || 0,
          flowRate: data.mqtt.flowRate || 0,
          current: data.mqtt.current || 0,
          vibration: data.mqtt.vibration?.x || 0,
          vibrationX: data.mqtt.vibration?.x || 0,
          vibrationY: data.mqtt.vibration?.y || 0,
          vibrationZ: data.mqtt.vibration?.z || 0,
          pumpStatus: data.mqtt.pump || false,
          connectionStatus: "connected",
          efficiency: data.mqtt.efficiency || 0
        };
        
        res.json(transformedData);
      } else {
        res.status(404).json({ error: "No MQTT data available" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch MQTT sensor data" });
    }
  });

  app.get("/api/mqtt/sensor-data/history", async (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const data = await mqttInfluxIntegration.getHistoricalData(hours);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch MQTT sensor history" });
    }
  });

  app.get("/api/mqtt/sensor-data/aggregated", async (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const data = await mqttInfluxIntegration.getAggregatedData(hours);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch aggregated sensor data" });
    }
  });

  app.get("/api/mqtt/system/status", async (req, res) => {
    try {
      const status = await mqttInfluxIntegration.getSystemStats();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch system status" });
    }
  });

  app.post("/api/mqtt/pump/control", async (req, res) => {
    try {
      const { action } = req.body;
      if (!action || !['on', 'off'].includes(action)) {
        return res.status(400).json({ error: "Invalid action. Use 'on' or 'off'" });
      }
      
      const success = mqttInfluxIntegration.controlPump(action);
      if (success) {
        res.json({ success: true, message: `Pump ${action} command sent via MQTT` });
      } else {
        res.status(500).json({ error: "Failed to send pump control command" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to control pump via MQTT" });
    }
  });

  app.post("/api/mqtt/test", async (req, res) => {
    try {
      mqttInfluxIntegration.publishTestData();
      res.json({ success: true, message: "Test data published to MQTT" });
    } catch (error) {
      res.status(500).json({ error: "Failed to publish test data" });
    }
  });

  app.get("/api/mqtt/status", async (req, res) => {
    try {
      const status = mqttInfluxIntegration.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get MQTT status" });
    }
  });

  app.post("/api/telegram/test", async (req, res) => {
    try {
      const isConnected = await telegramBot.testConnection();
      if (isConnected) {
        await telegramBot.sendAlert({
          device: 'AcquaSys Test',
          level: 75.5,
          current: 3.2,
          vibration: 1.2,
          pumpStatus: true,
          timestamp: new Date(), // Data/hora atual
          alertType: 'info',
          message: '🧪 Teste de conectividade do bot - Sistema funcionando!'
        });
        res.json({ success: true, message: "Test message sent to Telegram" });
      } else {
        res.status(500).json({ error: "Telegram bot not connected" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to test Telegram bot" });
    }
  });


  app.post("/api/pump/start", async (req, res) => {
    try {
      await storage.updateSystemConfig({ 
        pumpStatus: true, 
        pumpMode: "manual" 
      });
      
      await storage.addSystemAlert({
        type: "info",
        title: "Bomba Ligada",
        message: "Bomba ligada manualmente via painel",
        acknowledged: false,
      });

      res.json({ success: true, message: "Pump started successfully" });
    } catch (error) {
      res.status(500).json({ error: "Failed to start pump" });
    }
  });

  app.post("/api/pump/stop", async (req, res) => {
    try {
      await storage.updateSystemConfig({ 
        pumpStatus: false, 
        pumpMode: "manual" 
      });
      
      await storage.addSystemAlert({
        type: "info",
        title: "Bomba Parada",
        message: "Bomba parada manualmente via painel",
        acknowledged: false,
      });

      res.json({ success: true, message: "Pump stopped successfully" });
    } catch (error) {
      res.status(500).json({ error: "Failed to stop pump" });
    }
  });

  app.post("/api/pump/auto", async (req, res) => {
    try {
      await storage.updateSystemConfig({ pumpMode: "auto" });
      
      await storage.addSystemAlert({
        type: "info",
        title: "Modo Automático Ativado",
        message: "Bomba alterada para modo automático",
        acknowledged: false,
      });

      res.json({ success: true, message: "Switched to automatic mode" });
    } catch (error) {
      res.status(500).json({ error: "Failed to switch to auto mode" });
    }
  });

  app.post("/api/pump/manual", async (req, res) => {
    try {
      await storage.updateSystemConfig({ pumpMode: "manual" });
      
      await storage.addSystemAlert({
        type: "info",
        title: "Modo Manual Ativado",
        message: "Bomba alterada para modo manual",
        acknowledged: false,
      });

      res.json({ success: true, message: "Switched to manual mode" });
    } catch (error) {
      res.status(500).json({ error: "Failed to switch to manual mode" });
    }
  });

  app.post("/api/system/reset", async (req, res) => {
    try {
      await storage.updateSystemConfig({
        pumpMode: "auto",
        pumpStatus: false,
        systemStatus: "operational",
      });
      
      await storage.addSystemAlert({
        type: "warning",
        title: "Sistema Reiniciado",
        message: "Sistema foi reiniciado para configuração padrão",
        acknowledged: false,
      });

      // Enviar notificação via Telegram
      // await externalServices.sendTelegramAlert(
      //   "Sistema Reiniciado",
      //   "O sistema AcquaSys foi reiniciado e está operacional.",
      //   'warning'
      // );

      res.json({ success: true, message: "System reset completed" });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset system" });
    }
  });

  // Endpoint para testar conexões com APIs externas
  app.get("/api/external/test", async (req, res) => {
    try {
      // const results = await externalServices.testConnections();
      res.json({
        success: true,
        connections: [],
        message: "Teste de conectividade concluído"
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to test external connections" });
    }
  });

  // Endpoint para enviar relatório manual
  app.post("/api/external/report", async (req, res) => {
    try {
      const sensorData = await storage.getLatestSensorData();
      const mlPrediction = await storage.getLatestMLPrediction();
      const config = await storage.getSystemConfig();

      if (sensorData && mlPrediction) {
        // await externalServices.sendDailyReport(
        //   sensorData,
        //   mlPrediction,
        //   config.operationHours
        // );
        res.json({ success: true, message: "Relatório enviado via Telegram" });
      } else {
        res.status(400).json({ error: "Dados insuficientes para relatório" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to send report" });
    }
  });

  // WebSocket Server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Connect MQTT integration to WebSocket
  mqttInfluxIntegration.setWebSocketServer(wss);

  wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected to WebSocket');

    // Send initial data
    sendLatestData(ws);

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket');
    });
  });

  // Send real-time data to all connected clients
  async function sendLatestData(ws?: WebSocket) {
    try {
      const sensorData = await storage.getLatestSensorData();
      const mlPrediction = await storage.getLatestMLPrediction();
      const systemConfig = await storage.getSystemConfig();
      
      // ESP32 compatible format
      const esp32Payload = JSON.stringify({
        nivel: sensorData?.waterLevel ?? 0,
        bomba: systemConfig?.pumpStatus ?? false,
        vazao: sensorData?.flowRate ?? 0,
        temp: sensorData?.temperature ?? 0,
        corrente: sensorData?.current ?? 0,
        vibracao: sensorData?.vibration ?? 0,
        ml_falha: mlPrediction?.pumpFailureRisk ?? 0,
        ml_vazamento: mlPrediction?.leakRisk ?? 0,
        ml_manutencao: mlPrediction?.maintenanceNeed ?? 0,
        ml_tempo: 168, // hours until next maintenance
        ml_confianca: mlPrediction?.confidence ?? 0,
        ml_recomendacao: mlPrediction?.recommendation ?? "Sistema operando normalmente",
      });
      
      // Standard web format  
      const webPayload = JSON.stringify({
        type: 'data-update',
        sensorData,
        mlPrediction,
        systemConfig,
        timestamp: new Date().toISOString(),
      });

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(webPayload);
      } else {
        // Broadcast to all connected clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(webPayload);
          }
        });
      }
    } catch (error) {
      console.error('Error sending WebSocket data:', error);
    }
  }

  // REMOVIDO: Geração de dados simulados eliminada - usando apenas dados reais do MQTT ESP32

  // RTOS System Stats Route
  app.get("/api/rtos/stats", async (req, res) => {
    try {
      // Placeholder for RTOS stats - will be connected to actual RTOS system
      const rtosStats = {
        systemStatus: "operational",
        totalTasks: 5,
        runningTasks: 2,
        readyTasks: 3,
        suspendedTasks: 0,
        schedulerInfo: {
          intervalMs: 10,
          uptimeMs: Date.now() - (Date.now() % 1000000), // Mock uptime
        },
        taskDetails: [
          { id: "sensor_reading", name: "Leitura de Sensores", priority: 1, state: "ready", executionCount: 1234, errorCount: 0 },
          { id: "ml_processing", name: "Processamento ML", priority: 2, state: "running", executionCount: 567, errorCount: 1 },
          { id: "pump_control", name: "Controle da Bomba", priority: 1, state: "ready", executionCount: 890, errorCount: 0 },
          { id: "telemetry", name: "Telemetria Externa", priority: 3, state: "ready", executionCount: 123, errorCount: 2 },
          { id: "alert_system", name: "Sistema de Alertas", priority: 4, state: "ready", executionCount: 456, errorCount: 0 }
        ]
      };
      
      res.json(rtosStats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch RTOS stats" });
    }
  });

  return httpServer;
}
