#!/bin/bash

# AcquaSys v1.3 - Services & Application Orchestrator
echo "🚀 Orquestrando o ambiente AcquaSys..."

# Start MQTT Broker (Mosquitto)
echo "📡 Iniciando MQTT Broker (Mosquitto)..."
if ! pgrep -x "mosquitto" > /dev/null; then
    mosquitto -d
    if [ $? -eq 0 ]; then
        echo "✅ Mosquitto iniciado em segundo plano."
    else
        echo "❌ Falha ao iniciar o Mosquitto."
        exit 1 # Encerra o script se o Mosquitto falhar
    fi
else
    echo "✅ Mosquitto já está rodando."
fi

# Start InfluxDB
echo "🗄️ Iniciando InfluxDB com Flux habilitado..."
if command -v influxd &> /dev/null; then
    if ! pgrep -x "influxd" > /dev/null; then
        influxd -config influxdb.conf &
        INFLUX_PID=$!
        echo "✅ InfluxDB iniciado em segundo plano (PID: $INFLUX_PID)."
    else
        echo "✅ InfluxDB já está rodando."
    fi
else
    echo "⚠️ InfluxDB não instalado no ambiente."
fi

echo ""
echo "⏳ Aguardando os serviços de background iniciarem..."
# CORREÇÃO: Pausa estratégica de 5 segundos para garantir que Mosquitto e InfluxDB estejam prontos
sleep 5
echo "✅ Serviços prontos."
echo ""
echo "🚀 Iniciando Aplicação Principal (Backend)..."
echo "----------------------------------------------------"

# Inicia a aplicação Node.js em primeiro plano.
npm run dev