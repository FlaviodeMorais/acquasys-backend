import { mqttBroker, type MQTTSensorData } from "./mqtt-broker.js";
import { influxDB } from "./influxdb-client.js";
import { telegramBot } from "./telegram-service.js";
import { WebSocketServer, WebSocket } from "ws";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Integração MQTT + InfluxDB + Telegram + WebSockets (backend do AcquaSys)
 * 🔁 Versão otimizada com comunicação bidirecional e keep-alive
 */
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
  private readonly ALERT_COOLDOWN = 10 * 60 * 1000; // 10 minutos
  private readonly PING_INTERVAL = 30000; // 30s para manter socket ativo

  constructor() {
    this.initialize().catch((err) =>
      console.error("Erro ao inicializar integração (constructor):", err)
    );
  }

  /** Conecta o servidor WebSocket e habilita comunicação bilateral */
  public setWebSocketServer(wss: WebSocketServer): void {
    this.wsServer = wss;

    console.log("🌐 WebSocket ativo - aguardando conexões de frontend...");

    // Conexões
    wss.on("connection", (socket: WebSocket) => {
      console.log("✅ Cliente WebSocket conectado.");

      // Envia status inicial
      socket.send(
        JSON.stringify({
          type: "welcome",
          data: {
            connected: true,
            pumpAutoMode: this.systemConfig.pumpAutoMode,
          },
        })
      );

      // Recebe comandos do frontend (controle remoto)
      socket.on("message", async (msg) => {
        try {
          const { type, action } = JSON.parse(msg.toString());
          if (type === "controlPump") {
            console.log(`🕹️ Comando recebido via WebSocket: ${action}`);
            this.controlPump(action);
          }
        } catch (err) {
          console.error("⚠️ Erro ao interpretar mensagem WS:", err);
        }
      });

      socket.on("close", () => {
        console.log("🔌 Cliente WebSocket desconectado.");
      });
    });

    // PING keep-alive automático
    setInterval(() => this.broadcast("ping", { ts: Date.now() }), this.PING_INTERVAL);
  }

  /** Envia mensagem broadcast via WebSocket (com limpeza automática) */
  private broadcast(type: string, data: any): void {
    if (!this.wsServer) return;
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });

    let active = 0;
    let closed = 0;

    for (const client of this.wsServer.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          active++;
        } else {
          closed++;
          client.terminate();
        }
      } catch (err) {
        closed++;
      }
    }

    if (active > 0)
      console.debug(`📡 Broadcast '${type}' enviado a ${active} cliente(s)` +
        (closed > 0 ? ` (${closed} desconectado(s))` : ""));
  }

  /** Inicialização completa (MQTT, Telegram, WS) */
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log("🔧 Inicializando integração MQTT + InfluxDB + Telegram...");

    this.setupMQTTEventHandlers();
    this.setupTelegramEventHandlers();

    await new Promise((r) => setTimeout(r, 1000));
    this.isInitialized = true;
    console.log("✅ Integração inicializada e pronta.");

    try {
      await this.testTelegramConnection();
    } catch (err) {
      console.warn("⚠️ Falha ao conectar Telegram (não crítico):", err);
    }
  }

  /** Recebe dados do ESP32 via MQTT */
  private setupMQTTEventHandlers(): void {
    mqttBroker.on("sensorData", async (data: MQTTSensorData) => {
      try {
        this.automaticPumpControl(data);
        await this.checkAndSendAlerts(data);

        const efficiency = this.calculateEfficiency(data);
        data.efficiency = efficiency;

        // Gravação no Influx
        if (influxDB?.writeSensorData) await influxDB.writeSensorData(data);

        // Envio instantâneo ao frontend
        this.broadcast("sensorData", {
          ...data,
          efficiency,
          timestamp: new Date(data.timestamp).toISOString(),
        });

        this.previousWaterLevel = data.level;
      } catch (err) {
        console.error("❌ Erro ao processar sensorData:", err);
      }
    });

    mqttBroker.on("pumpStatus", (payload: any) => {
      this.broadcast("pumpStatus", payload);
    });
  }

  /** Controle automático da bomba (executa comandos MQTT e atualiza front) */
  private automaticPumpControl(data: MQTTSensorData): void {
    if (!this.systemConfig.pumpAutoMode) return;

    if (data.level <= this.systemConfig.lowWaterThreshold && !data.pump) {
      console.log(`🤖 AUTO: Nível baixo (${data.level}%), ligando bomba...`);
      this.controlPump("on");
    } else if (data.level >= this.systemConfig.highWaterThreshold && data.pump) {
      console.log(`🤖 AUTO: Nível alto (${data.level}%), desligando bomba...`);
      this.controlPump("off");
    }
  }

  /** Telegram Bot - eventos e comandos remotos */
  private setupTelegramEventHandlers(): void {
    telegramBot.on("pumpModeChange", async ({ mode }: any) => {
      this.systemConfig.pumpAutoMode = mode === "auto";
      mqttBroker.controlPump(mode === "auto" ? "AUTO" : "MANUAL");
      await telegramBot.sendCommandResponse(`✅ <b>Modo ${mode}</b> ativado.`);
      this.broadcast("systemConfig", { pumpAutoMode: this.systemConfig.pumpAutoMode });
    });

    telegramBot.on("pumpControl", async ({ action }: any) => {
      this.controlPump(action);
      await telegramBot.sendCommandResponse(`🚰 Bomba ${action.toUpperCase()} via Telegram`);
    });
  }

  /** Envia comando da bomba ao ESP32 e frontend */
  public controlPump(action: "on" | "off" | "auto" | "AUTO" | "MANUAL"): boolean {
    try {
      const topic = "acquasys/pump/control";
      mqttBroker.publish(topic, action.toUpperCase());
      console.log(`🚀 Comando MQTT enviado: ${action}`);
      this.broadcast("pumpStatus", { pump: action === "on", action, source: "backend" });
      return true;
    } catch (error) {
      console.error("❌ Erro ao enviar comando da bomba:", error);
      return false;
    }
  }

  /** Cálculo de eficiência */
  private calculateEfficiency(data: MQTTSensorData): number {
    if (!data.pump || data.current <= 0.1) return 100;
    const currentPower = data.current * 220;
    const idealPower = 180;
    let eff = (idealPower / currentPower) * 100;
    if (data.vibration?.rms > 1.0) eff -= (data.vibration.rms - 1.0) * 10;
    if (data.temperature < 15 || data.temperature > 40)
      eff -= Math.abs(data.temperature - 27.5) * 0.5;
    eff = Math.max(0, Math.min(100, eff));
    this.systemConfig.efficiencyHistory.push(eff);
    if (this.systemConfig.efficiencyHistory.length > 20)
      this.systemConfig.efficiencyHistory.shift();
    return (
      this.systemConfig.efficiencyHistory.reduce((a, b) => a + b, 0) /
      this.systemConfig.efficiencyHistory.length
    );
  }

  /** Sistema de alertas automáticos */
  private async checkAndSendAlerts(data: MQTTSensorData): Promise<void> {
    const now = Date.now();
    const alerts: { type: string; message: string; key: string }[] = [];

    if (data.level < 10)
      alerts.push({
        type: "critical",
        message: `⚠️ Nível crítico: ${data.level.toFixed(1)}%`,
        key: "low_water",
      });

    if (data.current > 5)
      alerts.push({
        type: "warning",
        message: `⚡ Corrente alta: ${data.current.toFixed(2)}A`,
        key: "high_current",
      });

    for (const alert of alerts) {
      const last = this.lastAlertTimes[alert.key] || 0;
      if (now - last > this.ALERT_COOLDOWN) {
        await telegramBot.sendAlert({
          device: data.device,
          alertType: alert.type,
          message: alert.message,
          timestamp: new Date(),
        });
        this.lastAlertTimes[alert.key] = now;
        this.broadcast("systemAlert", alert);
      }
    }
  }

/** 🔎 Testa a conexão do bot Telegram no startup */
private async testTelegramConnection(): Promise<void> {
  try {
    const isConnected = await telegramBot.testConnection();

    if (isConnected) {
      const version = process.env.npm_package_version || "1.0.0";
      const timestamp = new Date().toLocaleString("pt-BR");

      await telegramBot.sendAlert({
        device: "AcquaSys Backend",
        alertType: "info",
        message: `🚀 Sistema AcquaSys v${version} iniciado com sucesso\n🕒 ${timestamp}\n📡 Monitoramento ativo.`,
        timestamp: new Date(),
      });

      console.log("✅ Telegram conectado e mensagem de inicialização enviada com sucesso.");
    } else {
      console.warn("⚠️ TelegramBot não respondeu ao teste de conexão.");
    }
  } catch (error) {
    console.error("❌ Erro ao testar conexão do TelegramBot:", error);
  }
}


export const mqttInfluxIntegration = new MQTTInfluxIntegration();

