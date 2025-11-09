import mqtt from 'mqtt';
import { EventEmitter } from 'events';

export interface MQTTSensorData {
  device: string;
  timestamp: number;
  level: number;
  temperature: number;
  current: number;
  flowRate: number;
  pump: boolean;
  efficiency: number;
  vibration: {
    x: number;
    y: number;
    z: number;
    rms: number;
  };
  runtime: number;
  heap: number;
  rssi: number;
}

export interface MQTTPumpStatus {
  device_id: string;
  pump_status: boolean;
  timestamp: number;
  water_level: number;
  trigger: string;
}

export interface MQTTSystemStatus {
  device_id: string;
  status: string;
  timestamp: number;
  version: string;
}

class MQTTBrokerService extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;
  private latestSensorData: MQTTSensorData | null = null;

  // Configuração aprimorada
  private readonly config;

  private readonly topics = {
    sensors: 'acquasys/sensors',
    pumpControl: 'acquasys/pump/control',
    pumpStatus: 'acquasys/pump/status',
    systemStatus: 'acquasys/system/status',
    alerts: 'acquasys/alerts',
  };

  constructor() {
    super();

    const host = process.env.MQTT_HOST || 'broker.mqtt-dashboard.com';
    const port = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883;

    this.config = {
      host,
      port,
      clientId: `acquasys_backend_${Math.random().toString(16).substr(2, 8)}`,
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 10000, // reconecta a cada 10s
      keepalive: 60,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
    };

    if (!this.config.username) {
      console.warn('⚠️ MQTT: Conectando a broker pública sem autenticação (não recomendado em produção).');
    }

    // Pequeno delay para inicializar junto ao backend
    setTimeout(() => this.connect(), 2000);
  }

  /** 🔗 Conecta ao broker MQTT */
  private connect(): void {
    console.log(`🔄 Conectando ao MQTT broker em mqtt://${this.config.host}:${this.config.port}...`);

    try {
      this.client = mqtt.connect(this.config);

      this.client.on('connect', () => {
        console.log('✅ MQTT conectado com sucesso');
        this.isConnected = true;
        this.subscribeToTopics();
        this.emit('connected');
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message);
      });

      this.client.on('error', (error) => {
        console.error('⚠️ Erro MQTT:', error.message);
        this.isConnected = false;
        this.emit('error', error);
      });

      this.client.on('close', () => {
        if (this.isConnected) {
          console.log('🔌 Conexão MQTT encerrada.');
          this.isConnected = false;
          this.emit('disconnected');
        }
      });
    } catch (error) {
      console.error('❌ Erro crítico ao iniciar conexão MQTT:', error);
      this.emit('error', error);
      this.isConnected = false;
    }
  }

  /** 🧭 Inscreve-se nos tópicos principais */
  private subscribeToTopics(): void {
    if (!this.client || !this.isConnected) return;

    const topicsToSubscribe = [
      this.topics.sensors,
      this.topics.pumpStatus,
      this.topics.systemStatus,
      this.topics.alerts,
    ];

    this.client.subscribe(topicsToSubscribe, { qos: 1 }, (error) => {
      if (error) {
        console.error(`❌ Erro ao subscrever aos tópicos:`, error);
      } else {
        console.log(`📡 Subscrito: ${topicsToSubscribe.join(', ')}`);
      }
    });
  }

  /** 📩 Processa mensagens recebidas */
  private handleMessage(topic: string, message: Buffer): void {
    try {
      const data = JSON.parse(message.toString());
      this.emit('message', topic, data);

      switch (topic) {
        case this.topics.sensors:
          this.latestSensorData = data;
          this.emit('sensorData', data);
          break;
        case this.topics.pumpStatus:
          this.emit('pumpStatus', data);
          break;
        case this.topics.systemStatus:
          this.emit('systemStatus', data);
          break;
      }
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem em ${topic}:`, error);
    }
  }

  /** ⚙️ Controla a bomba */
  public controlPump(action: 'on' | 'off' | 'AUTO' | 'MANUAL'): boolean {
    if (!this.client || !this.isConnected) {
      console.error('❌ MQTT desconectado - não é possível controlar a bomba');
      return false;
    }

    this.client.publish(this.topics.pumpControl, action.toUpperCase(), { qos: 1 });
    console.log(`🎮 Comando de bomba '${action.toUpperCase()}' enviado.`);
    return true;
  }

  /** 📨 Publica mensagem genérica MQTT */
  public publish(topic: string, message: string): void {
    try {
      if (!this.client || !this.isConnected) {
        console.warn('⚠️ MQTT desconectado - publish ignorado');
        return;
      }
      this.client.publish(topic, message, { qos: 0, retain: false });
      console.log(`📤 MQTT → ${topic}: ${message}`);
    } catch (error) {
      console.error('❌ Erro ao publicar mensagem MQTT:', error);
    }
  }

  /** 🔍 Últimos dados de sensor */
  public getLatestSensorData(): MQTTSensorData | null {
    return this.latestSensorData;
  }

  /** 🧠 Status do cliente */
  public isClientConnected(): boolean {
    return this.isConnected;
  }

  /** ℹ️ Info de conexão */
  public getConnectionInfo() {
    return {
      connected: this.isConnected,
      broker: `${this.config.host}:${this.config.port}`,
      clientId: this.config.clientId,
      topics: this.topics,
    };
  }

  /** 🔌 Desconecta do broker */
  public disconnect(): void {
    if (this.client) {
      console.log('🔌 Desconectando do MQTT...');
      this.client.end();
      this.isConnected = false;
    }
  }

  /** 🧪 Publica dados de teste (debug) */
  public publishTestData(): void {
    if (!this.client || !this.isConnected) {
      console.warn('⚠️ MQTT desconectado - não é possível enviar dados de teste.');
      return;
    }

    const testPayload = JSON.stringify({
      device: 'acquasys_esp32_test',
      timestamp: Date.now(),
      level: 50 + Math.random() * 30,
      temperature: 24 + Math.random() * 5,
      current: 2 + Math.random(),
      flowRate: Math.random() * 30,
      pump: Math.random() > 0.5,
      efficiency: 80 + Math.random() * 10,
      vibration: { x: 0.2, y: 0.3, z: 0.1, rms: 0.25 },
      runtime: Math.random() * 1000,
      heap: 350000,
      rssi: -60,
    });

    this.client.publish(this.topics.sensors, testPayload, { qos: 0 });
    console.log('🧪 Dados de teste MQTT publicados.');
  }
}

// Singleton instance
export const mqttBroker = new MQTTBrokerService();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Encerrando MQTT broker...');
  mqttBroker.disconnect();
  process.exit(0);
});
