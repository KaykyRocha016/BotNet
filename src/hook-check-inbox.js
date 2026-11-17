import os from 'node:os';

const BROKER_URL = (process.env.CLAUDE_MESH_URL || 'http://127.0.0.1:7331').replace(/\/+$/, '');
const TOKEN = process.env.CLAUDE_MESH_TOKEN || '';
const OWNER = process.env.CLAUDE_MESH_OWNER || os.userInfo().username || 'dev';
const AGENT_ID = process.env.CLAUDE_MESH_AGENT_ID || `${OWNER}-${os.hostname()}`;

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);

  try {
    const headers = {};
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const res = await fetch(
      `${BROKER_URL}/inbox?agentId=${encodeURIComponent(AGENT_ID)}&unreadOnly=true&markAsRead=false`,
      { headers, signal: controller.signal }
    );
    if (!res.ok) return;

    const { messages = [] } = await res.json();
    if (messages.length === 0) return;

    const preview = messages
      .slice(-3)
      .map((m) => `- ${m.fromAlias}: ${m.body.slice(0, 120)}`)
      .join('\n');

    console.log(
      `[botnet] Você tem ${messages.length} mensagem(ns) direta(s) não lida(s). Use a tool read_inbox para ler e marcar como lida:\n${preview}`
    );
  } catch {
    // Fail silently so the hook never blocks Claude Code if the broker is unreachable
  } finally {
    clearTimeout(timer);
  }
}

main();
