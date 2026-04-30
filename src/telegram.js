import { createServer } from 'node:http';
import { splitIntoTelegramMessages } from './utils.js';

const DEFAULT_WEBHOOK_PATH = '/telegram/webhook';
const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'];

function normalizeWebhookUrl(rawUrl) {
  if (!rawUrl) {
    throw new Error('TELEGRAM_WEBHOOK_URL wajib diisi saat TELEGRAM_WEBHOOK_MODE=true.');
  }

  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('TELEGRAM_WEBHOOK_URL harus memakai https:// agar diterima Telegram.');
  }

  if (!url.pathname || url.pathname === '/') {
    url.pathname = DEFAULT_WEBHOOK_PATH;
  }

  return url.toString();
}

function readJsonBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('Webhook payload terlalu besar.'));
        request.destroy();
      }
    });

    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Webhook payload bukan JSON valid.'));
      }
    });
  });
}

export class TelegramBot {
  constructor(token) {
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN belum diisi.');
    }

    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async request(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'mlb-alert-telegram-agent/0.1'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const description = data?.description || response.statusText;
      throw new Error(`Telegram ${method} gagal: ${description}`);
    }

    return data.result;
  }

  getUpdates({ offset, timeout = 30 }) {
    return this.request('getUpdates', {
      offset,
      timeout,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES
    });
  }

  setWebhook(options) {
    return this.request('setWebhook', options);
  }

  deleteWebhook(options = {}) {
    return this.request('deleteWebhook', options);
  }

  getWebhookInfo() {
    return this.request('getWebhookInfo');
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitIntoTelegramMessages(text);

    for (const chunk of chunks) {
      await this.request('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...options
      });
    }
  }
}

export async function setupWebhook(
  bot,
  { webhookUrl, port = 8443, secret = '', onUpdate } = {}
) {
  if (typeof onUpdate !== 'function') {
    throw new Error('setupWebhook membutuhkan onUpdate handler.');
  }

  const publicWebhookUrl = normalizeWebhookUrl(webhookUrl);
  const webhookPath = new URL(publicWebhookUrl).pathname || DEFAULT_WEBHOOK_PATH;

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, mode: 'telegram-webhook' }));
      return;
    }

    const requestUrl = new URL(request.url || '/', 'http://localhost');
    if (request.method !== 'POST' || requestUrl.pathname !== webhookPath) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    if (secret) {
      const token = request.headers['x-telegram-bot-api-secret-token'];
      if (token !== secret) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'invalid_secret_token' }));
        return;
      }
    }

    let update;
    try {
      update = await readJsonBody(request);
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));

    Promise.resolve(onUpdate(update)).catch((error) => {
      console.error('Webhook update error:', error);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  await bot.setWebhook({
    url: publicWebhookUrl,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    secret_token: secret || undefined,
    drop_pending_updates: false
  });

  console.log(`Telegram webhook aktif: ${publicWebhookUrl}`);
  console.log(`Webhook server listening on 0.0.0.0:${port}${webhookPath}`);

  return {
    server,
    webhookUrl: publicWebhookUrl,
    close: async ({ deleteWebhook = true } = {}) => {
      if (deleteWebhook) {
        await bot.deleteWebhook({ drop_pending_updates: false }).catch((error) => {
          console.error('deleteWebhook gagal:', error.message);
        });
      }

      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
