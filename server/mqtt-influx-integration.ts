import { mqttBroker, type MQTTSensorData } from "./mqtt-broker.js";
import { influxDB } from "./influxdb-client.js";
import { telegramBot } from "./telegram-service.js";
import { WebSocketServer, WebSocket } from "ws";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Integração MQTT + InfluxDB + Telegram + WebSockets (backend do AcquaSys)
 *
 * Melhorias:
 * - broadcast otimizado (conta clientes)
 * - pumpStatus broadcast quando a bomba muda
 * - await em envios ao Telegram para garantir entrega
 * - tratamento resiliente de inicialização e de chamadas ao influxDB
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
    // inicializa assincronamente (erro tratado internamente)
    this.initialize().catch((err) =>
      console.error("Erro ao inicializar integração (constructor):", err)
    );
  }

  /** Conecta o servidor WebSocket (chamado a partir de routes) */
  public setWebSocketServer(wss: WebSocketServer): void {
    this.wsServer = wss;
  }

  /** Envia mensagem broadcast via WebSocket - agora com contagem e proteção */
  private broadcast(type: string, data: any): void {
    if (!this.wsServer) return;
    const message = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString(),
    });

    let count = 0;
    for (const client of this.wsServer.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          count++;
        }
      } catch (err) {
        // não pare o broadcast por causa de um client com problema
        console.warn("⚠️ Erro enviando broadcast a um cliente:", err);
      }
    }
    if (count > 0) console.debug(`📡 Broadcast '${type}' enviado a ${count} cliente(s).`);
  }

  /** Inicialização completa (resiliente) */
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log("🔧 Inicializando integração MQTT + InfluxDB + Telegram...");

    try {
      this.setupMQTTEventHandlers();
      this.setupTelegramEventHandlers();

      // pequeno delay para evitar race conditions
      await new Promise((resolve) => setTimeout(resolve, 1200));

      this.isInitialized = true;
      console.log("✅ Integração MQTT + InfluxDB inicializada com sucesso.");

      // Teste de telegram — não bloqueia a inicialização em caso de falha
      try {
        await this.testTelegramConnection();
      } catch (err) {
        console.warn("⚠️ Falha no teste do Telegram (não crítico):", err);
      }
    } catch (err) {
      console.error("❌ Falha ao inicializar integração:", err);
    }
  }

  /** Configura listeners MQTT */
  private setupMQTTEventHandlers(): void {
    mqttBroker.on("sensorData", async (data: MQTTSensorData) => {
      try {
        // Controle automático -> pode publicar comandos se necessário
        this.automaticPumpControl(data);

        // Gera e envia alertas se adequado
        await this.checkAndSendAlerts(data);

        // Calcula eficiência (e atualiza histórico interno)
        const efficiency = this.calculateEfficiency(data);
        data.efficiency = efficiency;

        // Insere no Influx (se disponível)
        try {
          if (influxDB && typeof influxDB.writeSensorData === "function") {
            await influxDB.writeSensorData(data);
          } else {
            console.debug("⚠️ influxDB.writeSensorData não disponível; pulando gravação.");
          }
        } catch (err) {
          console.error("❌ Erro ao gravar no InfluxDB:", err);
        }

        // Transmite via WebSocket para frontends conectados
        this.broadcast("sensorData", {
          ...data,
          efficiency,
          timestamp: new Date(data.timestamp).toISOString(),
        });

        // Atualiza estado anterior para detecção de queda rápida (vazamento)
        this.previousWaterLevel = data.level;
      } catch (error) {
        console.error("❌ Erro ao processar dados do sensor:", error);
      }
    });

    // também propague outros tópicos MQTT para o websocket quando chegarem
    mqttBroker.on("pumpStatus", (payload: any) => {
      this.broadcast("pumpStatus", payload);
    });

    mqttBroker.on("systemStatus", (payload: any) => {
      this.broadcast("systemStatus", payload);
    });
  }

  /** Controle automático da bomba baseado no nível */
  private automaticPumpControl(data: MQTTSensorData): void {
    if (!this.systemConfig.pumpAutoMode) return;

    if (data.level <= this.systemConfig.lowWaterThreshold && !data.pump) {
      console.log(`🤖 AUTO: Nível baixo (${data.level}%), ligando a bomba...`);
      this.controlPump("on"); // usa método local para broadcast também
      // broadcast extra para o frontend (status imediato)
      this.broadcast("pumpStatus", { pump: true, level: data.level, source: "auto" });
    } else if (data.level >= this.systemConfig.highWaterThreshold && data.pump) {
      console.log(`🤖 AUTO: Nível alto (${data.level}%), desligando a bomba...`);
      this.controlPump("off");
      this.broadcast("pumpStatus", { pump: false, level: data.level, source: "auto" });
    }
  }

  /** Configura handlers do bot Telegram */
  private setupTelegramEventHandlers(): void {
    console.log("🤖 Configurando comandos do bot Telegram...");

    telegramBot.on("pumpModeChange", async ({ mode, userId }: any) => {
      try {
        console.log(`🔧 ${userId} alterou modo para: ${mode}`);
        this.systemConfig.pumpAutoMode = mode === "auto";

        // Comando de modo - apenas publica para o hardware (é interpretado pelo ESP/firmware)
        mqttBroker.controlPump(mode === "auto" ? "AUTO" : "MANUAL");
        const modeText = mode === "auto" ? "Automático" : "Manual";
        await telegramBot.sendCommandResponse(`✅ <b>Modo ${modeText} ativado.</b>`);
        // notifica frontends
        this.broadcast("systemConfig", { pumpAutoMode: this.systemConfig.pumpAutoMode });
      } catch (err) {
        console.error("❌ Erro ao processar pumpModeChange:", err);
      }
    });

    telegramBot.on("pumpControl", async ({ action, userId }: any) => {
      try {
        if (this.systemConfig.pumpAutoMode) {
          await telegramBot.sendCommandResponse(
            "⚠️ <b>Sistema em modo automático!</b>\nUse /manual para assumir o controle."
          );
          return;
        }
        const success = this.controlPump(action); // já faz publish + broadcast
        if (success) {
          const actionText = action === "on" ? "LIGADA" : "DESLIGADA";
          await telegramBot.sendCommandResponse(`✅ <b>Bomba ${actionText}</b> por comando manual.`);
        } else {
          await telegramBot.sendCommandResponse('❌ <b>Erro!</b> Não foi possível enviar comando para o ESP32.');
        }
      } catch (err) {
        console.error("❌ Erro ao processar pumpControl:", err);
      }
    });

    telegramBot.on("requestSystemStatus", async ({ chatId }: any) => {
      try {
        const systemStatus = await this.getCompleteSystemStatus();
        await (telegramBot as any).sendMessage(chatId, systemStatus, "HTML");
      } catch (err) {
        console.error("❌ Erro ao responder requestSystemStatus:", err);
      }
    });
  }

  /** Monta mensagem de status detalhado para Telegram */
  private async getCompleteSystemStatus(): Promise<string> {
    // tenta recuperar a última leitura do influx ou do cache do mqttBroker
    let latestData: MQTTSensorData | null = null;
    try {
      if (influxDB && typeof influxDB.getLatestReadings === "function") {
        const readings = await influxDB.getLatestReadings(1);
        latestData = readings && readings.length > 0 ? readings[0] : null;
      }
    } catch (err) {
      console.warn("⚠️ Falha obtendo leitura do Influx para status:", err);
    }

    if (!latestData && typeof mqttBroker.getLatestSensorData === "function") {
      latestData = mqttBroker.getLatestSensorData();
    }

    if (!latestData) {
      return "❌ <b>Sistema Offline</b>\n\nNenhum dado recente disponível do ESP32.";
    }

    const efficiency = this.calculateEfficiency(latestData);
    const mode = this.systemConfig.pumpAutoMode ? "Automático" : "Manual";
    const uptime = Math.floor((latestData.runtime ?? 0) / 1000);
    const uptimeMin = Math.floor(uptime / 60);
    const uptimeSec = uptime % 60;
    const timestamp = formatInTimeZone(new Date(), "America/Sao_Paulo", "dd/MM/yyyy, HH:mm:ss");

    return (
      `📊 <b>Status do Sistema AcquaSys</b>\n\n` +
      `📡 <b>Conectividade:</b>\n` +
      `• MQTT: ${mqttBroker.isClientConnected() ? "🟢 Conectado" : "🔴 Desconectado"}\n` +
      `• ESP32: ${latestData ? "🟢 Online" : "🔴 Offline"}\n\n` +
      `💧 <b>Sensores:</b>\n` +
      `• Nível: ${latestData.level.toFixed(1)}%\n` +
      `• Temperatura: ${latestData.temperature.toFixed(1)}°C\n` +
      `• Corrente: ${latestData.current.toFixed(2)}A\n` +
      `• Vibração: ${latestData.vibration?.rms?.toFixed(3) ?? "0.000"}G\n\n` +
      `🚰 <b>Bomba:</b>\n` +
      `• Status: ${latestData.pump ? "🟢 LIGADA" : "🔴 DESLIGADA"}\n` +
      `• Modo: ${mode}\n` +
      `• Eficiência: ${efficiency.toFixed(1)}%\n\n` +
      `🖥️ <b>ESP32:</b>\n` +
      `• Uptime: ${uptimeMin}min ${uptimeSec}s\n` +
      `• Memória livre: ${Math.round((latestData.heap ?? 0) / 1024)}KB\n` +
      `• WiFi: ${latestData.rssi ?? 0}dBm\n\n` +
      `🕐 <b>Última atualização:</b> ${timestamp}`
    );
  }

  /** Cálculo dinâmico de eficiência operacional */
  private calculateEfficiency(data: MQTTSensorData): number {
    if (!data || !data.vibration) return 0;
    if (!data.pump || data.current <= 0.1) {
      return 100.0;
    }

    const currentPower = data.current * 220;
    const idealPower = 180;
    let efficiency = (idealPower / currentPower) * 100;

    if (data.vibration.rms > 1.0) efficiency -= (data.vibration.rms - 1.0) * 10;
    if (data.temperature < 15 || data.temperature > 40) efficiency -= Math.abs(data.temperature - 27.5) * 0.5;

    efficiency = Math.max(0, Math.min(100, efficiency));

    this.systemConfig.efficiencyHistory.push(efficiency);
    if (this.systemConfig.efficiencyHistory.length > 20) this.systemConfig.efficiencyHistory.shift();

    // Média móvel simples
    const avg = this.systemConfig.efficiencyHistory.reduce((a, b) => a + b, 0) / Math.max(1, this.systemConfig.efficiencyHistory.length);
    return avg;
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
    } else if (data.level < this.systemConfig.lowWaterThreshold && !data.pump && this.systemConfig.pumpAutoMode) {
      alerts.push({
        type: "warning",
        message: `📉 Nível baixo (${data.level.toFixed(1)}%) e bomba não ligou no modo automático.`,
        key: "low_water_pump_fail",
      });
    }

    if (data.vibration?.rms > 2.5) {
      alerts.push({
        type: "warning",
        message: `📳 Vibração elevada: ${data.vibration.rms.toFixed(3)}G.`,
        key: "high_vibration",
      });
    }

    if (data.current > 5.0) {
      alerts.push({
        type: "warning",
        message: `⚡ Corrente alta: ${data.current.toFixed(2)}A.`,
        key: "high_current",
      });
    }

    for (const alert of alerts) {
      const lastAlert = this.lastAlertTimes[alert.key] || 0;
      if (now - lastAlert > this.ALERT_COOLDOWN) {
        try {
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
          // também notifica frontends via websocket
          this.broadcast("systemAlert", { ...alert, level: data.level, device: data.device });
        } catch (err) {
          console.error("❌ Erro ao enviar alerta Telegram:", err);
        }
      }
    }
  }

  /** Teste de conexão inicial do bot */
  private async testTelegramConnection(): Promise<void> {
    try {
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
    } catch (err) {
      console.warn("⚠️ Teste Telegram falhou (não crítico):", err);
    }
  }

  /** Retorna a última leitura (do InfluxDB ou cache MQTT) */
  public async getLatestData(): Promise<{ mqtt: any; timestamp: string } | null> {
    try {
      // Preferência: Influx (mais confiável historicamente)
      if (influxDB && typeof influxDB.getLatestReadings === "function") {
        const readings = await influxDB.getLatestReadings(1);
        if (readings && readings.length > 0) return { mqtt: readings[0], timestamp: new Date().toISOString() };
      }

      // Fallback: cache do broker (se existir)
      if (typeof mqttBroker.getLatestSensorData === "function") {
        const cached = mqttBroker.getLatestSensorData();
        if (cached) return { mqtt: cached, timestamp: new Date().toISOString() };
      }

      return null;
    } catch (error) {
      console.error("❌ Erro ao obter última leitura:", error);
      return null;
    }
  }

  /** Retorna histórico de leituras (últimas N horas) */
  public async getHistoricalData(hours = 24): Promise<any[]> {
    try {
      if (influxDB && typeof influxDB.getLatestReadings === "function") {
        // espera que getLatestReadings aceite parâmetro de horas; se não, ajuste no influxDB-client
        const readings = await influxDB.getLatestReadings(hours);
        return readings || [];
      }

      console.debug("⚠️ getLatestReadings não disponível no influxDB; retornando array vazio.");
      return [];
    } catch (error) {
      console.error("❌ Erro ao obter histórico:", error);
      return [];
    }
  }

  /** Envia comando de controle da bomba via MQTT + notifica frontends */
  public controlPump(action: "on" | "off" | "auto" | "AUTO" | "MANUAL"): boolean {
    try {
      const topic = "acquasys/pump/control";
      // usa mqttBroker.publish (implementado no mqtt-broker)
      if (typeof mqttBroker.publish === "function") {
        mqttBroker.publish(topic, String(action));
      } else if (typeof mqttBroker.controlPump === "function") {
        // fallback para API antiga
        mqttBroker.controlPump(action as any);
      } else {
        console.warn("⚠️ mqttBroker não possui publish/controlPump implementado corretamente.");
        return false;
      }

      console.log(`🚰 Comando enviado via MQTT: ${action}`);
      // notifica frontends instantaneamente
      this.broadcast("pumpStatus", { pump: action === "on", action, source: "backend" });
      return true;
    } catch (error) {
      console.error("❌ Erro ao enviar comando da bomba:", error);
      return false;
    }
  }
}

export const mqttInfluxIntegration = new MQTTInfluxIntegration();
