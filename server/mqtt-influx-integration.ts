import { mqttBroker, type MQTTSensorData } from './mqtt-broker';
import { influxDB } from './influxdb-client';
import { telegramBot } from './telegram-service';
import { WebSocketServer, WebSocket } from 'ws';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * Camada de integração que orquestra MQTT, InfluxDB, Telegram e WebSockets.
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

  private lastAlertTimes: { [key: string]: number } = {};
  private readonly ALERT_COOLDOWN = 10 * 60 * 1000;

  constructor() {
    this.initialize();
  }

  public setWebSocketServer(wss: WebSocketServer): void {
    this.wsServer = wss;
  }

  private broadcast(type: string, data: any): void {
    if (!this.wsServer) return;
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    this.wsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    console.log('🔧 Inicializando integração...');
    
    this.setupMQTTEventHandlers();
    this.setupTelegramEventHandlers();

    await new Promise(resolve => setTimeout(resolve, 2000));
    this.isInitialized = true;
    console.log('✅ Integração MQTT + InfluxDB inicializada');
    
    await this.testTelegramConnection();
  }

  private setupMQTTEventHandlers(): void {
    mqttBroker.on('sensorData', async (data: MQTTSensorData) => {
      try {
        this.automaticPumpControl(data);
        this.checkAndSendAlerts(data);

        const efficiency = this.calculateEfficiency(data);
        data.efficiency = efficiency;

        await influxDB.writeSensorData(data);

        this.broadcast('sensorData', {
          ...data,
          efficiency: efficiency,
          timestamp: new Date(data.timestamp).toISOString(),
        });

        this.previousWaterLevel = data.level;
      } catch (error) {
        console.error('❌ Erro ao processar dados do sensor:', error);
      }
    });
  }

  private automaticPumpControl(data: MQTTSensorData): void {
    if (this.systemConfig.pumpAutoMode) {
      if (data.level <= this.systemConfig.lowWaterThreshold && !data.pump) {
        console.log(`🤖 AUTO: Nível baixo (${data.level}%), ligando a bomba...`);
        mqttBroker.controlPump('on');
      } else if (data.level >= this.systemConfig.highWaterThreshold && data.pump) {
        console.log(`🤖 AUTO: Nível alto (${data.level}%), desligando a bomba...`);
        mqttBroker.controlPump('off');
      }
    }
  }

  private setupTelegramEventHandlers(): void {
    console.log('🤖 Configurando handlers do bot Telegram...');

    telegramBot.on('pumpModeChange', ({ mode, userId }) => {
      console.log(`🔧 ${userId} alterou modo para: ${mode}`);
      this.systemConfig.pumpAutoMode = mode === 'auto';
      
      mqttBroker.controlPump(mode === 'auto' ? 'AUTO' : 'MANUAL'); 
      const modeText = mode === 'auto' ? 'Automático' : 'Manual';
      telegramBot.sendCommandResponse(`✅ <b>Modo ${modeText} ativado.</b>`);
    });

    telegramBot.on('pumpControl', ({ action, userId }) => {
      if (this.systemConfig.pumpAutoMode) {
        telegramBot.sendCommandResponse('⚠️ <b>Sistema em modo automático!</b>\n\nUse /manual para assumir o controle.');
        return;
      }
      const success = mqttBroker.controlPump(action);
      if (success) {
        const actionText = action === 'on' ? 'LIGADA' : 'DESLIGADA';
        telegramBot.sendCommandResponse(`✅ <b>Bomba ${actionText}</b> por comando manual.`);
      } else {
        telegramBot.sendCommandResponse('❌ <b>Erro!</b> Não foi possível enviar comando para o ESP32.');
      }
    });

    telegramBot.on('requestSystemStatus', async ({ chatId }) => {
        const systemStatus = await this.getCompleteSystemStatus();
        (telegramBot as any).sendMessage(chatId, systemStatus, 'HTML');
    });
  }

  private async getCompleteSystemStatus(): Promise<string> {
    const latestData = mqttBroker.getLatestSensorData();
    const mqttInfo = mqttBroker.getConnectionInfo();
      
    if (!latestData) {
      return '❌ <b>Sistema Offline</b>\n\nNenhum dado recente disponível do ESP32.';
    }

    const efficiency = this.calculateEfficiency(latestData);
    const mode = this.systemConfig.pumpAutoMode ? 'Automático' : 'Manual';
    const uptime = Math.floor(latestData.runtime / 1000);
    const uptimeMin = Math.floor(uptime / 60);
    const uptimeSec = uptime % 60;
    const timestamp = formatInTimeZone(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy, HH:mm:ss');

    return `📊 <b>Status do Sistema AcquaSys</b>\n\n` +
           `📡 <b>Conectividade:</b>\n` +
           `• MQTT: ${mqttInfo.connected ? '🟢 Conectado' : '🔴 Desconectado'}\n` +
           `• ESP32: 🟢 Online\n\n` +
           `💧 <b>Sensores:</b>\n` +
           `• Nível: ${latestData.level.toFixed(1)}%\n` +
           `• Temperatura: ${latestData.temperature.toFixed(1)}°C\n` +
           `• Corrente: ${latestData.current.toFixed(2)}A\n` +
           `• Vibração: ${latestData.vibration.rms.toFixed(3)}G\n\n` +
           `🚰 <b>Bomba:</b>\n` +
           `• Status: ${latestData.pump ? '🟢 LIGADA' : '🔴 DESLIGADA'}\n` +
           `• Modo: ${mode}\n` +
           `• Eficiência: ${efficiency.toFixed(1)}%\n\n` +
           `🖥️ <b>ESP32:</b>\n` +
           `• Uptime: ${uptimeMin}min ${uptimeSec}s\n` +
           `• Memória livre: ${Math.round(latestData.heap / 1024)}KB\n` +
           `• WiFi: ${latestData.rssi}dBm\n\n` +
           `🕐 <b>Última atualização:</b> ${timestamp}`;
  }

  private calculateEfficiency(data: MQTTSensorData): number {
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
    return this.systemConfig.efficiencyHistory.reduce((a, b) => a + b, 0) / this.systemConfig.efficiencyHistory.length;
  }

  private async checkAndSendAlerts(data: MQTTSensorData): Promise<void> {
    const now = Date.now();
    const alerts: Array<{ type: 'warning' | 'critical'; message: string; key: string; }> = [];

    if (this.previousWaterLevel !== null && !data.pump && this.previousWaterLevel > data.level) {
        const levelDrop = this.previousWaterLevel - data.level;
        if (levelDrop > 1.0) {
            alerts.push({ type: 'critical', message: `💧 VAZAMENTO DETECTADO! Nível caiu ${levelDrop.toFixed(1)}% com a bomba desligada.`, key: 'leak_detection' });
        }
    }

    if (data.level < 10) {
      alerts.push({ type: 'critical', message: `⚠️ NÍVEL CRÍTICO: Água em ${data.level.toFixed(1)}% - Risco de falta de água!`, key: 'low_water_critical'});
    } 
    else if (data.level < this.systemConfig.lowWaterThreshold && !data.pump && this.systemConfig.pumpAutoMode) {
      alerts.push({ type: 'warning', message: `📉 Nível baixo (${data.level.toFixed(1)}%) e bomba não ligou no modo automático.`, key: 'low_water_pump_fail'});
    }
    
    if (data.vibration.rms > 2.5) alerts.push({ type: 'warning', message: `📳 Vibração elevada: ${data.vibration.rms.toFixed(3)}G.`, key: 'high_vibration' });
    if (data.current > 5.0) alerts.push({ type: 'warning', message: `⚡ Corrente alta: ${data.current.toFixed(2)}A.`, key: 'high_current' });

    for (const alert of alerts) {
      const lastAlert = this.lastAlertTimes[alert.key] || 0;
      if (now - lastAlert > this.ALERT_COOLDOWN) {
        await telegramBot.sendAlert({
          device: data.device, level: data.level, current: data.current,
          vibration: data.vibration.rms, pumpStatus: data.pump, timestamp: new Date(),
          alertType: alert.type, message: alert.message
        });
        this.lastAlertTimes[alert.key] = now; 
      }
    }
  }

  private async testTelegramConnection(): Promise<void> {
    const isConnected = await telegramBot.testConnection();
    if (isConnected) {
      await telegramBot.sendAlert({
        device: 'AcquaSys Backend', alertType: 'info',
        message: `🚀 Sistema AcquaSys v${process.env.npm_package_version || '1.0'} iniciado - Monitoramento ativo!`,
        level: 0, current: 0, vibration: 0, pumpStatus: false, timestamp: new Date(),
      });
    }
  }
}

export const mqttInfluxIntegration = new MQTTInfluxIntegration();