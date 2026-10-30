// Discord の REST API と、Interactions の署名検証

const DEFAULT_API_BASE = 'https://discord.com/api/v10';

export class DiscordApi {
  constructor(token, { base = DEFAULT_API_BASE, fetch = (...args) => globalThis.fetch(...args) } = {}) {
    this.token = token;
    this.base = base;
    this.fetch = fetch;
  }

  request(method, path, body) {
    return this.fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://github.com/gawasa29/timecard-bot, 1.0)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // いま入っているボイスチャンネルの ID。どこにも入っていなければ null
  async getVoiceChannel(guildId, userId) {
    const res = await this.request('GET', `/guilds/${guildId}/voice-states/${userId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ボイスの状態を取得できませんでした (${res.status}): ${await res.text()}`);
    return (await res.json()).channel_id ?? null;
  }

  async sendMessage(channelId, content) {
    const res = await this.request('POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } });
    if (!res.ok) throw new Error(`メッセージを送れませんでした (${res.status}): ${await res.text()}`);
  }
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('invalid hex');
  return Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
}

// 正しく署名されたリクエストなら本文を、そうでなければ null を返す
export async function verifyRequest(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!signature || !timestamp) return null;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
    return valid ? body : null;
  } catch {
    return null;
  }
}
