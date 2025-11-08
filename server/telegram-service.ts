import axios from 'axios';
import { EventEmitter } from 'events';
import { formatInTimeZone } from 'date-fns-tz';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown';
}

interface AlertData {
  device: string;
  level: number;
  current: number;
  vibration: number;
  pumpStatus: boolean;
  timestamp: Date;
  alertType: 'warning' | 'critical' | 'info';
  message: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

export class TelegramBotService extends EventEmitter {
  private botToken: string;
  private chatId: string;
  private baseUrl: string;
  private lastUpdateId = 0;
  private pollingActive = false;
  private retryDelay = 3000; // tempo de espera entre tentativas de polling

  constructor() {
    super();
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';

    if (!this.botToken || !this.chatId) {
      console.warn('⚠️ Telegram bot não configurado - verifique TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
      return;
    }

    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    console.log('🤖 Telegram bot configurado com sucesso.');
    this.startPolling();
  }

  // =======================
  // FORMATAÇÃO DE MENSAGENS
  // =======================
  private formatMessage(alert: AlertData): string {
    const alertIcon = { warning: '⚠️', critical: '🚨', info: 'ℹ️' }[alert.alertType];
    const pumpIcon = alert.pumpStatus ? '🟢' : '🔴';
    const timestamp = formatInTimeZone(alert.timestamp, 'America/Sao_Paulo', 'dd/MM/yyyy, HH:mm:ss');

    return `${alertIcon} <b>AcquaSys Alert</b>\n\n` +
           `📍 <b>Device:</b> ${alert.device}\n` +
           `💧 <b>Nível:</b> ${alert.level.toFixed(1)}%\n` +
           `⚡ <b>Corrente:</b> ${alert.current.toFixed(2)}A\n` +
           `📳 <b>Vibração:</b> ${alert.vibration.toFixed(3)}G\n` +
           `${pumpIcon} <b>Bomba:</b> ${alert.pumpStatus ? 'LIGADA' : 'DESLIGADA'}\n\n` +
           `📝 <b>Mensagem:</b> ${alert.message}\n` +
           `🕐 <b>Data/Hora:</b> ${timestamp}`;
  }

  // =======================
  // ENVIO DE ALERTAS
  // =======================
  async sendAlert(alert: AlertData): Promise<boolean> {
    if (!this.botToken || !this.chatId) {
      console.warn('🤖 Telegram não configurado - alerta não enviado');
      return false;
    }

    try {
      const message: TelegramMessage = {
        chat_id: this.chatId,
        text: this.formatMessage(alert),
        parse_mode: 'HTML'
      };

      const response = await axios.post(`${this.baseUrl}/sendMessage`, message);

      if (response.data.ok) {
        console.log(`✅ Alerta Telegram enviado: ${alert.alertType} - ${alert.message}`);
        return true;
      } else {
        console.error('❌ Erro no envio Telegram:', response.data);
        return false;
      }
    } catch (error: any) {
      console.error('❌ Erro ao conectar com Telegram:', error.message);
      return false;
    }
  }

  // =======================
  // STATUS DO SISTEMA
  // =======================
  async sendSystemStatus(status: {
    device: string;
    uptime: number;
    memory: number;
    rssi: number;
    timestamp: Date;
  }): Promise<boolean> {
    if (!this.botToken || !this.chatId) return false;

    try {
      const uptimeHours = Math.floor(status.uptime / 3600);
      const uptimeMinutes = Math.floor((status.uptime % 3600) / 60);
      const timestamp = formatInTimeZone(status.timestamp, 'America/Sao_Paulo', 'dd/MM/yyyy, HH:mm:ss');

      const message = `📊 <b>AcquaSys Status Report</b>\n\n` +
                      `📍 <b>Device:</b> ${status.device}\n` +
                      `⏰ <b>Uptime:</b> ${uptimeHours}h ${uptimeMinutes}m\n` +
                      `💾 <b>Memória Livre:</b> ${Math.round(status.memory / 1024)}KB\n` +
                      `📶 <b>WiFi:</b> ${status.rssi} dBm\n` +
                      `🕐 <b>Timestamp:</b> ${timestamp}`;

      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'HTML'
      });

      return response.data.ok;
    } catch (error: any) {
      console.error('❌ Erro ao enviar status do sistema:', error.message);
      return false;
    }
  }

  // =======================
  // TESTE DE CONEXÃO
  // =======================
  async testConnection(): Promise<boolean> {
    if (!this.botToken) return false;

    try {
      const response = await axios.get(`${this.baseUrl}/getMe`);
      console.log(`🤖 Bot conectado: ${response.data.result.first_name} (@${response.data.result.username})`);
      return response.data.ok;
    } catch (error: any) {
      console.error('❌ Erro ao testar conexão do bot:', error.message);
      return false;
    }
  }

  // =======================
  // POLLING SEGURO
  // =======================
  private async startPolling(): Promise<void> {
    if (this.pollingActive) return;
    this.pollingActive = true;
    console.log('🔄 Iniciando polling do Telegram bot...');
    this.pollUpdates();
  }

  private async pollUpdates(): Promise<void> {
    if (!this.pollingActive) return;

    try {
      const response = await axios.get(`${this.baseUrl}/getUpdates`, {
        params: { offset: this.lastUpdateId + 1, timeout: 20 }
      });

      if (response.data.ok) {
        const updates: TelegramUpdate[] = response.data.result;
        for (const update of updates) {
          this.lastUpdateId = update.update_id;
          await this.handleUpdate(update);
        }
      }

      this.retryDelay = 3000; // reset backoff em sucesso
    } catch (error: any) {
      // Tratamento refinado de erros
      if (error.response?.status === 409) {
        console.warn('⚠️ Outro processo do bot Telegram já está ativo (erro 409). Polling pausado.');
        this.pollingActive = false;
        console.warn('💤 Polling será reativado automaticamente em 30 segundos...');
        setTimeout(() => this.startPolling(), 30000);
        return;
      }

      console.error('❌ Erro no polling Telegram:', error.message);
      this.retryDelay = Math.min(this.retryDelay * 1.5, 15000); // aumento gradual até 15s
    }

    // Continua polling com delay ajustável
    setTimeout(() => this.pollUpdates(), this.retryDelay);
  }

  // =======================
  // PROCESSAMENTO DE UPDATES
  // =======================
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;

    const chatId = message.chat.id.toString();

    if (chatId !== this.chatId) {
      console.warn(`⚠️ Comando ignorado do chat_id não autorizado: ${chatId}`);
      return;
    }

    const text = message.text.trim().toLowerCase();
    const user = message.from.first_name;
    console.log(`📩 Comando recebido de ${user}: ${text}`);

    if (!text.startsWith('/')) {
      await this.sendMessage(chatId, '❓ Use /ajuda para ver os comandos disponíveis.');
      return;
    }

    await this.processCommand(chatId, text, user);
  }

  private async processCommand(chatId: string, command: string, userId: string): Promise<void> {
    try {
      switch (command) {
        case '/start':
        case '/ajuda':
        case '/help':
          await this.sendHelpMessage(chatId, userId);
          break;

        case '/status':
          this.emit('requestSystemStatus', { chatId });
          break;

        case '/manual':
          this.emit('pumpModeChange', { mode: 'manual', userId });
          await this.sendMessage(chatId, '🔧 <b>Modo Manual ativado!</b>\nUse /ligar e /desligar.', 'HTML');
          break;

        case '/auto':
        case '/automatico':
          this.emit('pumpModeChange', { mode: 'auto', userId });
          await this.sendMessage(chatId, '🤖 <b>Modo Automático ativado!</b>', 'HTML');
          break;

        case '/ligar':
          this.emit('pumpControl', { action: 'on', userId });
          await this.sendMessage(chatId, '🟢 Bomba ligada manualmente.', 'HTML');
          break;

        case '/desligar':
          this.emit('pumpControl', { action: 'off', userId });
          await this.sendMessage(chatId, '🔴 Bomba desligada manualmente.', 'HTML');
          break;

        default:
          await this.sendMessage(chatId, `❓ Comando "${command}" não reconhecido.\nUse /ajuda.`);
          break;
      }
    } catch (error: any) {
      console.error('❌ Erro ao processar comando:', error.message);
      await this.sendMessage(chatId, '❌ Erro interno ao processar comando.');
    }
  }

  private async sendHelpMessage(chatId: string, userId: string): Promise<void> {
    const helpText = `👋 <b>Olá ${userId}!</b>\n\n` +
                     `🤖 <b>Bot AcquaSys - Comandos:</b>\n` +
                     `📊 /status - Status do sistema\n` +
                     `🔧 /manual - Controle manual\n` +
                     `🤖 /auto - Controle automático\n` +
                     `🚰 /ligar e /desligar - Controle da bomba\n` +
                     `❓ /ajuda - Mostra esta mensagem`;
    await this.sendMessage(chatId, helpText, 'HTML');
  }

  private async sendMessage(chatId: string, text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, { chat_id: chatId, text, parse_mode: parseMode });
      return response.data.ok;
    } catch (error: any) {
      console.error('❌ Erro ao enviar mensagem Telegram:', error.message);
      return false;
    }
  }

  public async sendCommandResponse(message: string): Promise<boolean> {
    return this.sendMessage(this.chatId, message, 'HTML');
  }

  public stopPolling(): void {
    this.pollingActive = false;
    console.log('⏹️ Telegram polling parado');
  }
}

export const telegramBot = new TelegramBotService();
