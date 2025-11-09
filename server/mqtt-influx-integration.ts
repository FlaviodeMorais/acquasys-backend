// server/mqtt-influx-integration.ts
import { mqttBroker, type MQTTSensorData } from "./mqtt-broker.js";
import { influxDB } from "./influxdb-client.js";
import { telegramBot, type AlertData } from "./telegram-service.js";
import { WebSocketServer, WebSocket } from "ws";
import { formatInTimeZone } from "date-fns-tz";

class MQTTInfluxIntegration {
  private isInitialized = false;
  private wsServer: WebSocketServer | null = null;
  private previousWaterLevel: number | null = null;

  private systemConfig = {
    pumpAutoMode: true,
    lowWaterThreshold: 20.0,
    highWaterThreshold: 95.0,
    efficiencyHistory: [] as number[],
  };

  private lastAlertTimes: Record<string, number> = {};
  private readonly ALERT_COOLDOWN = 10 * 60 * 1000;
  private readonly PING_INTERVAL = 30_000;

  constructor() {
    this.initialize().catch((err) =>
      console.error("Erro ao inicializar integração:", err)
    );
  }

  /** WebSocket setup */
  public setWebSocketServer(wss: WebSocketServer): void {
    this.wsServer = wss;
    console.log("🌐 WebSocket ativo - aguardando conexões...");

    wss.on("connection", (socket: WebSocket) => {
      console.log("✅ Cliente WebSocket conectado.");
      socket.send(
        JSON.stringify({
          type: "welcome",
          data: { pumpAutoMode: this.systemConfig.pumpAutoMode },
        })
      );

      socket.on("message", (msg) => {
        try {
          const payload = JSON.parse(msg.toString());
          if (payload?.type === "controlPump" && payload?.action) {
            this.controlPump(payload.action);
          }
        } catch (err) {
          console.warn("⚠️ Erro ao processar mensagem WS:", err);
        }
      });

      socket.on("close", () => {
        console.log("🔌 Cliente WebSocket desconectado.");
      });
    });

    setInterval(() => this.broadcast("ping", { ts: Date.now() }), this.PING_INTERVAL);
  }

  private broadcast(type: string, data: any): void {
    if (!this.wsServer) return;
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const client of this.wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log("🔧 Inicializando integração MQTT + InfluxDB + Telegram...");
    this.setupMQTTEventHandlers();
    this.setupTelegramEventHandlers();
    await new Promise((r) => setTimeout(r, 1000));
    this.isInitialized = true;
    await this.testTelegramConnection();
    console.log("✅ Integração inicializada.");
  }

  private setupMQTTEventHandlers(): void {
    mqttBroker.on("sensorData", async (data: MQTTSensorData) => {
      try {
        this.automaticPumpControl(data);
        await this.checkAndSendAlerts(data);
        const efficiency = this.calculateEfficiency(data);
        data.efficiency = efficiency;

        if (influxDB?.writeSensorData) await influxDB.writeSensorData(data);
        this.broadcast("sensorData", { ...data, efficiency });
        this.previousWaterLevel = data.level;
      } catch (err) {
        console.error("❌ Erro processando sensorData:", err);
      }
    });
  }

  private automaticPumpControl(data: MQTTSensorData): void {
    if (!this.systemConfig.pumpAutoMode) return;
    if (data.level <= this.systemConfig.lowWaterThreshold && !data.pump) {
      this.controlPump("on");
      this.broadcast("pumpStatus", { pump: true });
    } else if (data.level >= this.systemConfig.highWaterThreshold && data.pump) {
      this.controlPump("off");
      this.broadcast("pumpStatus", { pump: false });
    }
  }

  private setupTelegramEventHandlers(): void {
    telegramBot.on("pumpControl", async ({ action }: any) => {
      this.controlPump(action);
      await telegramBot.sendCommandResponse(`🚰 Bomba ${action}`);
    });
  }

  private calculateEfficiency(data: MQTTSensorData): number {
    if (!data.pump || data.current <= 0.1) return 100;
    const eff = (180 / (data.current * 220)) * 100;
    return Math.max(0, Math.min(100, eff));
  }

  private async checkAndSendAlerts(data: MQTTSensorData): Promise<void> {
    const now = Date.now();
    const alerts: Array<{ type: "warning" | "critical"; message: string; key: string }> = [];
    if (data.level < 10)
      alerts.push({ type: "critical", message: `⚠️ Nível crítico: ${data.level.toFixed(1)}%`, key: "low" });
    if (data.current > 5)
      alerts.push({ type: "warning", message: `⚡ Corrente alta: ${data.current.toFixed(2)}A`, key: "current" });

    for (const a of alerts) {
      const last = this.lastAlertTimes[a.key] || 0;
      if (now - last > this.ALERT_COOLDOWN) {
        const vibrationValue =
          typeof data.vibration === "object" ? data.vibration.rms ?? 0 : Number(data.vibration ?? 0);
        const payload: AlertData = {
          device: data.device ?? "unknown",
          level: data.level,
          current: data.current,
          vibration: vibrationValue,
          pumpStatus: data.pump,
          alertType: a.type,
          message: a.message,
          timestamp: new Date(),
        };
        await telegramBot.sendAlert(payload);
        this.lastAlertTimes[a.key] = now;
        this.broadcast("systemAlert", payload);
      }
    }
  }

  private async testTelegramConnection(): Promise<void> {
    try {
      const ok = await telegramBot.testConnection();
      if (ok) {
        const payload: AlertData = {
          device: "AcquaSys Backend",
          level: 0,
          current: 0,
          vibration: 0,
          pumpStatus: false,
          alertType: "info",
          message: `🚀 Sistema AcquaSys iniciado (${new Date().toLocaleString()})`,
          timestamp: new Date(),
        };
        await telegramBot.sendAlert(payload);
      }
    } catch (err) {
      console.warn("⚠️ Teste Telegram falhou:", err);
    }
  }

  public async getLatestData(): Promise<{ mqtt: any; timestamp: string } | null> {
    try {
      if (influxDB?.getLatestReadings) {
        const arr = await influxDB.getLatestReadings(1);
        if (arr?.length) return { mqtt: arr[0], timestamp: new Date().toISOString() };
      }
      const cached = mqttBroker.getLatestSensorData?.();
      if (cached) return { mqtt: cached, timestamp: new Date().toISOString() };
      return null;
    } catch {
      return null;
    }
  }

  public async getHistoricalData(hours = 24): Promise<any[]> {
    try {
      if (influxDB?.getLatestReadings) return (await influxDB.getLatestReadings(hours)) ?? [];
      return [];
    } catch {
      return [];
    }
  }

  public controlPump(action: "on" | "off" | "auto" | "AUTO" | "MANUAL"): boolean {
    try {
      const topic = "acquasys/pump/control";
      mqttBroker.publish?.(topic, String(action));
      this.broadcast("pumpStatus", { pump: String(action).toLowerCase() === "on", action });
      return true;
    } catch {
      return false;
    }
  }
}

export const mqttInfluxIntegration = new MQTTInfluxIntegration();

