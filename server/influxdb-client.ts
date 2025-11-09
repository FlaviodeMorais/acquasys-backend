import { InfluxDB, Point, WriteApi, QueryApi } from "@influxdata/influxdb-client";
import type { MQTTSensorData } from "./mqtt-broker.js";

// Interface para definir a configuração do InfluxDB
interface InfluxDBConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
}

class InfluxDBService {
  private writeApi: WriteApi;
  private queryApi: QueryApi;
  private config: InfluxDBConfig;
  private isHealthy = false;
  private inMemoryStore: MQTTSensorData[] = []; // Armazenamento em memória simples como fallback

  constructor() {
    this.config = {
      url: process.env.INFLUX_URL || "http://localhost:8086",
      token: process.env.INFLUX_TOKEN || "acquasys-token-local-dev",
      org: process.env.INFLUX_ORG || "acquasys",
      bucket: process.env.INFLUX_BUCKET || "water_sensors",
    };

    console.log(`🗄️ Inicializando InfluxDB client para ${this.config.url}`);

    const influxDB = new InfluxDB({
      url: this.config.url,
      token: this.config.token,
    });

    this.writeApi = influxDB.getWriteApi(this.config.org, this.config.bucket, "ns");
    this.queryApi = influxDB.getQueryApi(this.config.org);

    // Inicia a verificação de saúde após um pequeno atraso
    setTimeout(() => this.checkHealth(), 3000);
  }

  private async checkHealth(): Promise<void> {
    try {
      await this.queryApi.queryRaw(
        `from(bucket: "${this.config.bucket}") |> range(start: -1m) |> limit(n:1)`
      );
      this.isHealthy = true;
      console.log("💾 InfluxDB: Conexão bem-sucedida.");
    } catch (error) {
      this.isHealthy = false;
      console.warn(
        "⚠️ InfluxDB não disponível. O sistema usará o armazenamento em memória como fallback."
      );
    }
  }

  public async writeSensorData(data: MQTTSensorData): Promise<void> {
    // Armazena em memória primeiro
    this.inMemoryStore.push(data);
    if (this.inMemoryStore.length > 100) {
      this.inMemoryStore.shift();
    }

    // Se o InfluxDB não estiver saudável, evita tentar gravar
    if (!this.isHealthy) return;

    try {
      const point = new Point("sensor_readings")
        .tag("device", data.device)
        .timestamp(new Date(data.timestamp))
        .floatField("level", data.level)
        .floatField("temperature", data.temperature)
        .floatField("current", data.current)
        .floatField("flowRate", data.flowRate)
        .booleanField("pump", data.pump)
        .floatField("efficiency", data.efficiency)
        .floatField("vibration_rms", data.vibration?.rms ?? 0)
        .intField("runtime", data.runtime)
        .intField("heap", data.heap)
        .intField("rssi", data.rssi);

      this.writeApi.writePoint(point);
      await this.writeApi.flush();

      if (process.env.NODE_ENV === "development") {
        console.log(`📊 Dados enviados ao InfluxDB - Nível: ${data.level}%`);
      }
    } catch (error) {
      console.error("❌ Erro ao escrever no InfluxDB:", error);
      this.isHealthy = false;
      console.warn("⚠️ Conexão com InfluxDB perdida. Ativando fallback para memória.");
    }
  }

  // Consulta simplificada ou fallback
  public async getLatestReadings(limit: number = 50): Promise<MQTTSensorData[]> {
    if (this.isHealthy) {
      try {
        const query = `
          from(bucket: "${this.config.bucket}")
          |> range(start: -1h)
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: ${limit})
        `;
        // Aqui futuramente podemos parsear os resultados
        console.log("🔍 Executando query no InfluxDB:", query);
      } catch (error) {
        console.warn("⚠️ Falha ao consultar InfluxDB, retornando dados em memória.");
      }
    }

    // Fallback em memória
    return this.inMemoryStore.slice(-limit);
  }

  public isConnected(): boolean {
    return this.isHealthy;
  }

  public async close(): Promise<void> {
    try {
      await this.writeApi.close();
      console.log("✅ Conexão com InfluxDB encerrada.");
    } catch (err) {
      console.error("❌ Erro ao fechar InfluxDB:", err);
    }
  }
}

// Exporta instância única
export const influxDB = new InfluxDBService();
