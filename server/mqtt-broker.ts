import dotenv from "dotenv";
dotenv.config(); // ✅ Garante que .env seja carregado antes de tudo

import mqtt, { IClientOptions, MqttClient } from "mqtt";
import { EventEmitter } from "events";

export interface MQTTSensorData {
  device: string;
  timestamp: number;
  level: number;
  temperature: number;
  current: number;
  flowRate: number;
  pump: boolean;
  efficiency: number;
  vibration: { x: number; y: number; z: number; rms: number };
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
  private client: MqttClient | null = null;
  private isConnected = false;
  private latestSensorData: MQTTSensorData | null = null;

  private readonly config: IClientOptions;
  private readonly topics = {
    sensors: process.env.MQTT_TOPIC_SENSORS || "acquasys/sensors",
    pumpControl: process.env.MQTT_TOPIC_PUMP_CONTROL || "acquasys/pump/control",
    pumpStatus: process.env.MQTT_TOPIC_PUMP_STATUS || "acquasys/pump/status",
    systemStatus: "acquasys/system/status",
    alerts: process.env.MQTT_TOPIC_ALERTS || "acquasys/alerts",
  };

  constructor() {
    super();

    const host = process.env.MQTT_HOST?.trim() || "test.mosquitto.org";
    const port = Number(process.env.MQTT_PORT) || 1883;

    this.config = {
      clientId: process.env.MQTT_CLIENT_ID || `acquasys_backend_${Math.random().toString(16).substring(2, 8)}`,
      clean: true,
      connectTimeout: 10000, // 10 segundos para timeout
      reconnectPeriod: 5000, // reconecta a cada 5 segundos
      keepalive: 60,
      username: process.env.MQTT_USER || undefined,
      password: process.env.MQTT_PASS || undefined,
    };

    if (!this.config.username) {
      console.warn("⚠️ MQTT: Conectando a broker pública sem autenticação (não recomendado em produção).");
    }

    // Pequeno delay para o backend estabilizar
    setTimeout(() => this.connect(host, port), 1500);
  }

  /** 🔗 Conecta ao broker MQTT */
  private connect(host: string, port: number): void {
    const brokerUrl = `mqtt://${host}:${port}`;
    console.log(`🔄 Conectando ao MQTT broker em ${brokerUrl} ...`);

    try {
      this.client = mqtt.connect(brokerUrl, this.config);

      this.client.on("connect", () => {
        this.isConnected = true;
        console.log(`✅ MQTT conectado com sucesso (${brokerUrl})`);
        this.subscribeToTopics();
        this.emit("connected");
      });

      this.client.on("message", (topic, message) => this.handleMessage(topic, message));

      this.client.on("error", (error) => {
        console.error("⚠️ Erro MQTT:", error.message);
        this.isConnected = false;
      });

      this.client.on("close", () => {
        if (this.isConnected) {
          console.warn("🔌 Conexão MQTT encerrada.");
        }
        this.isConnected = false;
        // reconexão automática
        setTimeout(() => this.connect(host, port), 5000);
      });

      this.client.on("offline", () => {
        console.warn("⚠️ MQTT offline - tentando reconectar...");
        this.isConnected = false;
      });

    } catch (error) {
      console.error("❌ Erro crítico ao conectar ao MQTT:", error);
      this.isConnected = false;
      // Tenta reconectar automaticamente
      setTimeout(() => this.connect(host, port), 8000);
    }
  }

  /** 🧭 Inscreve-se nos tópicos principais */
  private subscribeToTopics(): void {
    if (!this.client || !this.isConnected) return;

    const topicsToSubscribe = Object.values(this.topics);
    this.client.subscribe(topicsToSubscribe, { qos: 1 }, (error) => {
      if (error) {
        console.error("❌ Erro ao subscrever aos tópicos:", error);
      } else {
        console.log(`📡 Subscrito aos tópicos: ${topicsToSubscribe.join(", ")}`);
      }
    });
  }

  /** 📩 Processa mensagens recebidas */
  private handleMessage(topic: string, message: Buffer): void {
    try {
      const data = JSON.parse(message.toString());
      this.emit("message", topic, data);

      switch (topic) {
        case this.topics.sensors:
          this.latestSensorData = data;
          this.emit("sensorData", data);
          break;
        case this.topics.pumpStatus:
          this.emit("pumpStatus", data);
          break;
        case this.topics.systemStatus:
          this.emit("systemStatus", data);
          break;
      }
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem em ${topic}:`, error);
    }
  }

  /** ⚙️ Controla a bomba */
  public controlPump(action: "on" | "off" | "AUTO" | "MANUAL"): boolean {
    if (!this.client || !this.isConnected) {
      console.warn("⚠️ MQTT desconectado - controle ignorado");
      return false;
    }

    this.client.publish(this.topics.pumpControl, action.toUpperCase(), { qos: 1 });
    console.log(`🎮 Comando de bomba '${action.toUpperCase()}' publicado.`);
    return true;
  }

  /** 📨 Publica mensagem genérica MQTT */
  public publish(topic: string, message: string): void {
    if (!this.client || !this.isConnected) {
      console.warn("⚠️ MQTT desconectado - publish ignorado");
      return;
    }
    this.client.publish(topic, message, { qos: 0, retain: false });
    console.log(`📤 MQTT → ${topic}: ${message}`);
  }

  /** 🧪 Publica dados simulados (debug) */
  public publishTestData(): void {
    if (!this.client || !this.isConnected) {
      console.warn("⚠️ MQTT desconectado - não é possível enviar dados de teste.");
      return;
    }

    const payload = JSON.stringify({
      device: "acquasys_esp32_test",
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

    this.client.publish(this.topics.sensors, payload, { qos: 0 });
    console.log("🧪 Dados de teste MQTT publicados.");
  }

  /** 🔍 Últimos dados do sensor */
  public getLatestSensorData(): MQTTSensorData | null {
    return this.latestSensorData;
  }

  /** 🧠 Status da conexão */
  public isClientConnected(): boolean {
    return this.isConnected;
  }

  /** ℹ️ Informações do broker */
  public getConnectionInfo() {
    return {
      connected: this.isConnected,
      broker: `${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`,
      clientId: this.config.clientId,
      topics: this.topics,
    };
  }

  /** 🔌 Desconecta o cliente MQTT */
  public disconnect(): void {
    if (this.client) {
      console.log("🔌 Desconectando do MQTT...");
      this.client.end(true, () => {
        console.log("✅ MQTT desconectado com segurança.");
      });
      this.isConnected = false;
    }
  }
}

export const mqttBroker = new MQTTBrokerService();

process.on("SIGINT", () => {
  console.log("🛑 Encerrando serviço MQTT...");
  mqttBroker.disconnect();
  process.exit(0);
});

