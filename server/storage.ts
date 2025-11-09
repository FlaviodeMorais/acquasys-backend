import { randomUUID } from "crypto";

// ✅ Tipos definidos localmente (substituem os de @shared/schema)
export interface SensorData {
  id: string;
  device?: string;
  level: number;
  temperature: number;
  current: number;
  flowRate: number;
  pump: boolean;
  efficiency: number;
  vibration?: {
    x: number;
    y: number;
    z: number;
    rms: number;
  };
  runtime: number;
  heap: number;
  rssi: number;
  timestamp: Date;
}

export type InsertSensorData = Omit<SensorData, "id" | "timestamp">;

export interface MLPrediction {
  id: string;
  timestamp: Date;
  predictionType: string;
  value: number;
  confidence: number;
}

export type InsertMLPrediction = Omit<MLPrediction, "id" | "timestamp">;

export interface SystemAlert {
  id: string;
  type: "info" | "warning" | "error" | "success";
  title: string;
  message: string;
  acknowledged: boolean;
  timestamp: Date;
}

export type InsertSystemAlert = Omit<SystemAlert, "id" | "timestamp" | "acknowledged">;

export interface SystemConfig {
  id: string;
  pumpMode: "auto" | "manual";
  pumpStatus: boolean;
  systemStatus: "operational" | "error" | "maintenance";
  lastMaintenance: Date | null;
  operationHours: number;
}

export type InsertSystemConfig = Partial<SystemConfig>;

// ✅ Interface de persistência
export interface IStorage {
  addSensorData(data: InsertSensorData): Promise<SensorData>;
  getLatestSensorData(): Promise<SensorData | undefined>;
  getSensorDataHistory(limit?: number): Promise<SensorData[]>;

  addMLPrediction(prediction: InsertMLPrediction): Promise<MLPrediction>;
  getLatestMLPrediction(): Promise<MLPrediction | undefined>;
  getMLPredictionHistory(limit?: number): Promise<MLPrediction[]>;

  addSystemAlert(alert: InsertSystemAlert): Promise<SystemAlert>;
  getSystemAlerts(limit?: number): Promise<SystemAlert[]>;
  acknowledgeAlert(id: string): Promise<boolean>;

  getSystemConfig(): Promise<SystemConfig>;
  updateSystemConfig(config: Partial<InsertSystemConfig>): Promise<SystemConfig>;
}

// ✅ Implementação em memória
export class MemStorage implements IStorage {
  private sensorDataStore: Map<string, SensorData>;
  private mlPredictionsStore: Map<string, MLPrediction>;
  private systemAlertsStore: Map<string, SystemAlert>;
  private systemConfigStore: SystemConfig;
  private sensorDataHistory: SensorData[] = [];
  private mlPredictionHistory: MLPrediction[] = [];

  constructor() {
    this.sensorDataStore = new Map();
    this.mlPredictionsStore = new Map();
    this.systemAlertsStore = new Map();

    this.systemConfigStore = {
      id: randomUUID(),
      pumpMode: "auto",
      pumpStatus: false,
      systemStatus: "operational",
      lastMaintenance: null,
      operationHours: 147.2,
    };

    this.initializeDefaultAlerts();
  }

  private initializeDefaultAlerts() {
    const alerts: InsertSystemAlert[] = [
      {
        type: "success",
        title: "Otimização do Sistema Completa",
        message:
          "Modelo de IA atualizado com os dados mais recentes - Precisão melhorou para 89.2%",
      },
      {
        type: "warning",
        title: "Vibração Elevada Detectada",
        message:
          "Vibração da bomba ligeiramente acima do normal - Monitore as mudanças",
      },
      {
        type: "info",
        title: "Lembrete de Manutenção Programada",
        message:
          "Próxima janela de manutenção agendada para segunda-feira às 2:00",
      },
    ];

    alerts.forEach((alert) => this.addSystemAlert(alert));
  }

  async addSensorData(data: InsertSensorData): Promise<SensorData> {
    const id = randomUUID();
    const sensorData: SensorData = { ...data, id, timestamp: new Date() };

    this.sensorDataStore.set(id, sensorData);
    this.sensorDataHistory.push(sensorData);

    if (this.sensorDataHistory.length > 1000) {
      this.sensorDataHistory = this.sensorDataHistory.slice(-1000);
    }

    return sensorData;
  }

  async getLatestSensorData(): Promise<SensorData | undefined> {
    return this.sensorDataHistory.at(-1);
  }

  async getSensorDataHistory(limit = 50): Promise<SensorData[]> {
    return this.sensorDataHistory.slice(-limit);
  }

  async addMLPrediction(prediction: InsertMLPrediction): Promise<MLPrediction> {
    const id = randomUUID();
    const mlPrediction: MLPrediction = { ...prediction, id, timestamp: new Date() };

    this.mlPredictionsStore.set(id, mlPrediction);
    this.mlPredictionHistory.push(mlPrediction);

    if (this.mlPredictionHistory.length > 100) {
      this.mlPredictionHistory = this.mlPredictionHistory.slice(-100);
    }

    return mlPrediction;
  }

  async getLatestMLPrediction(): Promise<MLPrediction | undefined> {
    return this.mlPredictionHistory.at(-1);
  }

  async getMLPredictionHistory(limit = 20): Promise<MLPrediction[]> {
    return this.mlPredictionHistory.slice(-limit);
  }

  async addSystemAlert(alert: InsertSystemAlert): Promise<SystemAlert> {
    const id = randomUUID();
    const systemAlert: SystemAlert = {
      ...alert,
      id,
      timestamp: new Date(),
      acknowledged: false,
    };
    this.systemAlertsStore.set(id, systemAlert);
    return systemAlert;
  }

  async getSystemAlerts(limit = 10): Promise<SystemAlert[]> {
    return Array.from(this.systemAlertsStore.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async acknowledgeAlert(id: string): Promise<boolean> {
    const alert = this.systemAlertsStore.get(id);
    if (!alert) return false;

    alert.acknowledged = true;
    this.systemAlertsStore.set(id, alert);
    return true;
  }

  async getSystemConfig(): Promise<SystemConfig> {
    return this.systemConfigStore;
  }

  async updateSystemConfig(
    config: Partial<InsertSystemConfig>
  ): Promise<SystemConfig> {
    this.systemConfigStore = { ...this.systemConfigStore, ...config };
    return this.systemConfigStore;
  }
}

export const storage = new MemStorage();
