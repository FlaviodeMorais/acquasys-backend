import { mqttBroker, type MQTTSensorData } from "./mqtt-broker.js";
import { influxDB } from "./influxdb-client.js";
import { telegramBot } from "./telegram-service.js";
import { WebSocketServer, WebSocket } from "ws";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Integração MQTT + InfluxDB + Telegram + WebSockets (backend do AcquaSys)
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

  constructor() {
    this.initialize().catch((err) =>
      console.error("Erro ao inicializar integração:", err)
    );
  }

  /** Conecta o servidor WebSocket */
  public setWebSocketServer(wss: WebSocketServer): void {
    this.wsServer = wss;
  }

  /** Envia mensagem broadcast via WebSocket */
  private broadcast(type: string, data: any): void {
    if (!this.wsServer) return;
    const message = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString(),
    });
    this.wsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /** Inicialização completa */
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log("🔧 Inicializando integração MQTT + InfluxDB + Telegram...");

    this.setupMQTTEventHandlers();
    this.setupTelegramEventHandlers();

    // Delay curto para evitar race conditions
    await new Promise((resolve) => setTimeout(resolve, 2000));

    this.isInitialized = true;
    console.log("✅ Integração MQTT + InfluxDB inicializada com sucesso.");

    await this.testTelegramConnection();
  }

  /** Configura listeners MQTT */
  private setupMQTTEventHandlers(): void {
    mqttBroker.on("sensorData", async (data: MQTTSensorData) => {
      try {
        this.automaticPumpControl(data);
        await this.checkAndSendAlerts(data);

        const efficiency = this.calculateEfficiency(data);
        data.efficiency = efficiency;

        await influxDB.writeSensorData(data);

        this.broadcast("sensorData", {
          ...data,
          efficiency,
          timestamp: new Date(data.timestamp).toISOString(),
        });

        this.previousWaterLevel = data.level;
      } catch (error) {
        console.error("❌ Erro ao processar dados do sensor:", error);
      }
    });
  }

  /** Controle automático da bomba baseado no nível */
  private automaticPumpControl(data: MQTTSensorData): void {
    if (this.systemConfig.pumpAutoMode) {
      if (data.level <= this.systemConfig.lowWaterThreshold && !data.pump) {
        console.log(
          `🤖 AUTO: Nível baixo (${data.level}%), ligando a bomba...`
        );
        mqttBroker.controlPump("on");
      } else if (
        data.level >= this.systemConfig.highWaterThreshold &&
        data.pump
      ) {
        console.log(
          `🤖 AUTO: Nível alto (${data.level}%), desligando a bomba...`
        );
        mqttBroker.controlPump("off");
      }
    }
  }

  /** Configura handlers do bot Telegram */
  private setupTelegramEventHandlers(): void {
    console.log("🤖 Configurando comandos do bot Telegram...");

    telegramBot.on("pumpModeChange", ({ mode, userId }: any) => {
      console.log(`🔧 ${userId} alterou modo para: ${mode}`);
      this.systemConfig.pumpAutoMode = mode === "auto";

      mqttBroker.controlPump(mode === "auto" ? "AUTO" : "MANUAL");
      const modeText = mode === "auto" ? "Automático" : "Manual";
      telegramBot.sendCommandResponse(`✅ <b>Modo ${modeText} ativado.</b>`);
    });

    telegramBot.on("pumpControl", ({ action, userId }: any) => {
      if (this.systemConfig.pumpAutoMode) {
        telegramBot.sendCommandResponse(
          "⚠️ <b>Sistema em modo automático!</b>\nUse /manual para assumir o controle."
        );
        return;
      }
      const success = mqttBroker.controlPump(action);
      if (success) {
        const actionText = action === "on" ? "LIGADA" : "DESLIGADA";
        telegramBot.sendCommandResponse(
          `✅ <b>Bomba ${actionText}</b> por comando manual.`
        );
      } else {
        telegramBot.sendCommandResponse(
          "❌ <b>Erro!</b> Não foi possível enviar comando para o ESP32."
        );
      }
    });

    telegramBot.on("requestSystemStatus", async ({ chatId }: any) => {
      const systemStatus = await this.getCompleteSystemStatus();
      (telegramBot as any).sendMessage(chatId, systemStatus, "HTML");
    });
  }

  /** Monta mensagem de status detalhado para Telegram */
  private async getCompleteSystemStatus(): Promise<string> {
    const latestData = mqttBroker.getLatestSensorData?.();
    const mqttInfo = mqttBroker.getConnectionInfo?.();

    if (!latestData) {
      return "❌ <b>Sistema Offline</b>\nNenhum dado recente disponível do ESP32.";
    }

    const efficiency = this.calculateEfficiency(latestData);
    const mode = this.systemConfig.pumpAutoMode ? "Automático" : "Manual";
    const uptime = Math.floor(latestData.runtime / 1000);
    const uptimeMin = Math.floor(uptime / 60);
    const uptimeSec = uptime % 60;
    const timestamp = formatInTimeZone(
      new Date(),
      "America/Sao_Paulo",
      "dd/MM/yyyy, HH:mm:ss"
    );

    return (
      `📊 <b>Status do Sistema AcquaSys</b>\n\n` +
      `📡 <b>Conectividade:</b>\n` +
      `• MQTT: ${mqttInfo?.connected ? "🟢 Conectado" : "🔴 Desconectado"}\n` +
      `• ESP32: 🟢 Online\n\n` +
      `💧 <b>Sensores:</b>\n` +
      `• Nível: ${latestData.level.toFixed(1)}%\n` +
      `• Temperatura: ${latestData.temperature.toFixed(1)}°C\n` +
      `• Corrente: ${latestData.current.toFixed(2)}A\n` +
      `• Vibração: ${latestData.vibration.rms.toFixed(3)}G\n\n` +
      `🚰 <b>Bomba:</b>\n` +
      `• Status: ${latestData.pump ? "🟢 LIGADA" : "🔴 DESLIGADA"}\n` +
      `• Modo: ${mode}\n` +
      `• Eficiência: ${efficiency.toFixed(1)}%\n\n` +
      `🖥️ <b>ESP32:</b>\n` +
      `• Uptime: ${uptimeMin}min ${uptimeSec}s\n` +
      `• Memória livre: ${Math.round(latestData.heap / 1024)}KB\n` +
      `• WiFi: ${latestData.rssi}dBm\n\n` +
      `🕐 <b>Última atualização:</b> ${timestamp}`
    );
  }

  /** Cálculo dinâmico de eficiência operacional */
  private calculateEfficiency(data: MQTTSensorData): number {
    if (!data.pump || data.current <= 0.1) {
      return 100.0;
    }

    const currentPower = data.current * 220;
    const idealPower = 180;
    let efficiency = (idealPower / currentPower) * 100;

    if (data.vibration.rms > 1.0)
      efficiency -= (data.vibration.rms - 1.0) * 10;

    if (data.temperature < 15 || data.temperature > 40)
      efficiency -= Math.abs(data.temperature - 27.5) * 0.5;

    efficiency = Math.max(0, Math.min(100, efficiency));

    this.systemConfig.efficiencyHistory.push(efficiency);
    if (this.systemConfig.efficiencyHistory.length > 20)
      this.systemConfig.efficiencyHistory.shift();

    return (
      this.systemConfig.efficiencyHistory.reduce((a, b) => a + b, 0) /
      this.systemConfig.efficiencyHistory.length
    );
  }

  /** Lógica de detecção de falhas e envio de alertas */
  private async checkAndSendAlerts(data: MQTTSensorData): Promise<void> {
    const now = Date.now();
    const alerts: { type: "warning" | "critical"; message: string; key: string }[] = [];

    if (this.previousWaterLevel !== null && !data.pump && this.previousWaterLevel > data.level) {
      const levelDrop = this.previousWaterLevel - data.level;
      if (levelDrop > 1.0) {
        alerts.push({
          type: "critical",
          message: `💧 VAZAMENTO DETECTADO! Nível caiu ${levelDrop.toFixed(1)}% com a bomba desligada.`,
          key: "leak_detection",
        });
      }
    }

    if (data.level < 10) {
      alerts.push({
        type: "critical",
        message: `⚠️ NÍVEL CRÍTICO: Água em ${data.level.toFixed(1)}% - risco de falta de água!`,
        key: "low_water_critical",
      });
    } else if (
      data.level < this.systemConfig.lowWaterThreshold &&
      !data.pump &&
      this.systemConfig.pumpAutoMode
    ) {
      alerts.push({
        type: "warning",
        message: `📉 Nível baixo (${data.level.toFixed(
          1
        )}%) e bomba não ligou no modo automático.`,
        key: "low_water_pump_fail",
      });
    }

    if (data.vibration.rms > 2.5)
      alerts.push({
        type: "warning",
        message: `📳 Vibração elevada: ${data.vibration.rms.toFixed(3)}G.`,
        key: "high_vibration",
      });

    if (data.current > 5.0)
      alerts.push({
        type: "warning",
        message: `⚡ Corrente alta: ${data.current.toFixed(2)}A.`,
        key: "high_current",
      });

    for (const alert of alerts) {
      const lastAlert = this.lastAlertTimes[alert.key] || 0;
      if (now - lastAlert > this.ALERT_COOLDOWN) {
        await telegramBot.sendAlert({
          device: data.device,
          level: data.level,
          current: data.current,
          vibration: data.vibration.rms,
          pumpStatus: data.pump,
          timestamp: new Date(),
          alertType: alert.type,
          message: alert.message,
        });
        this.lastAlertTimes[alert.key] = now;
      }
    }
  }

   /** Teste de conexão inicial do bot */
  private async testTelegramConnection(): Promise<void> {
    const isConnected = await telegramBot.testConnection();
    if (isConnected) {
      await telegramBot.sendAlert({
        device: "AcquaSys Backend",
        alertType: "info",
        message: `🚀 Sistema AcquaSys v${process.env.npm_package_version || "1.0"} iniciado - monitoramento ativo!`,
        level: 0,
        current: 0,
        vibration: 0,
        pumpStatus: false,
        timestamp: new Date(),
      });
    }
  }

  /** 🔍 Retorna a última leitura (do InfluxDB ou cache MQTT) */
  public async getLatestData() {
    try {
      const readings = await influxDB.getLatestReadings(1);
      if (readings.length > 0) {
        return { mqtt: readings[0], timestamp: new Date().toISOString() };
      }
      return null;
    } catch (error) {
      console.error("❌ Erro ao obter última leitura:", error);
      return null;
    }
  }

  /** 📈 Retorna histórico de leituras (últimas N horas) */
  public async getHistoricalData(hours = 24) {
    try {
      const readings = await influxDB.getLatestReadings(hours);
      return readings;
    } catch (error) {
      console.error("❌ Erro ao obter histórico:", error);
      return [];
    }
  }

  /** ⚙️ Envia comando de controle da bomba via MQTT */
  public controlPump(action: "on" | "off" | "auto"): boolean {
    try {
      const topic = "acquasys/pump/control";
      mqttBroker.publish(topic, action);
      console.log(`🚰 Comando enviado via MQTT: ${action}`);
      return true;
    } catch (error) {
      console.error("❌ Erro ao enviar comando da bomba:", error);
      return false;
    }
  }
}

export const mqttInfluxIntegration = new MQTTInfluxIntegration();
