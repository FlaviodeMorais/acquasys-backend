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
  
  // Configuração aprimorada com suporte a autenticação via variáveis de ambiente
  private readonly config;

  private readonly topics = {
    sensors: 'acquasys/sensors',
    pumpControl: 'acquasys/pump/control',
    pumpStatus: 'acquasys/pump/status',
    systemStatus: 'acquasys/system/status',
    alerts: 'acquasys/alerts' // Adicionado para consistência
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
      reconnectPeriod: 10000, // Tenta reconectar a cada 10 segundos
      keepalive: 60,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
    };
    
    if (!this.config.username) {
        console.warn('⚠️ MQTT: Conectando a um broker público sem autenticação. Não recomendado para produção.');
    }

    // Adiciona um pequeno delay para dar tempo aos outros serviços de iniciarem
    setTimeout(() => this.connect(), 2000);
  }

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

      // CORREÇÃO: O erro agora é tratado de forma não-fatal.
      // A aplicação não irá mais travar, e a biblioteca tentará reconectar sozinha.
      this.client.on('error', (error) => {
        console.error('⚠️ Erro MQTT:', error.message);
        this.isConnected = false;
        this.emit('error', error);
      });

      this.client.on('close', () => {
        if(this.isConnected) {
            console.log('🔌 Conexão MQTT fechada.');
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

  private subscribeToTopics(): void {
    if (!this.client || !this.isConnected) return;

    const topicsToSubscribe = [
      this.topics.sensors,
      this.topics.pumpStatus,
      this.topics.systemStatus,
      this.topics.alerts
    ];

    this.client.subscribe(topicsToSubscribe, { qos: 1 }, (error) => {
      if (error) {
        console.error(`❌ Erro ao subscrever aos tópicos:`, error);
      } else {
        console.log(`📡 Subscrito aos tópicos: ${topicsToSubscribe.join(', ')}`);
      }
    });
  }

  private handleMessage(topic: string, message: Buffer): void {
    try {
      const data = JSON.parse(message.toString());
      this.emit('message', topic, data); // Emite um evento genérico para o integration layer decidir

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
      console.error(`❌ Erro ao processar mensagem MQTT no tópico ${topic}:`, error);
    }
  }

  public controlPump(action: 'on' | 'off' | 'AUTO' | 'MANUAL'): boolean {
    if (!this.client || !this.isConnected) {
      console.error('❌ MQTT não conectado - não é possível controlar bomba');
      return false;
    }

    this.client.publish(this.topics.pumpControl, action.toUpperCase(), { qos: 1 });
    console.log(`🎮 Comando de bomba '${action.toUpperCase()}' publicado.`);
    return true;
  }

  public getLatestSensorData(): MQTTSensorData | null {
    return this.latestSensorData;
  }

  public isClientConnected(): boolean {
    return this.isConnected;
  }

  public getConnectionInfo() {
    return {
      connected: this.isConnected,
      broker: `${this.config.host}:${this.config.port}`,
      clientId: this.config.clientId,
      topics: this.topics,
    };
  }

  public disconnect(): void {
    if (this.client) {
      console.log('🔌 Desconectando MQTT...');
      this.client.end();
      this.isConnected = false;
    }
  }

  // ... (função publishTestData pode ser mantida como está)
}

// Singleton instance
export const mqttBroker = new MQTTBrokerService();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Encerrando MQTT broker...');
  mqttBroker.disconnect();
  process.exit(0);
});