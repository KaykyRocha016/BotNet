import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Incremental SSE parser that invokes onEvent({ event, data }) for each complete frame.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let currentEvent = 'message';
  let dataLines = [];

  return function pushChunk(chunk) {
    buffer += chunk.replace(/\r\n/g, '\n');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line === '') {
        if (dataLines.length > 0) {
          const rawData = dataLines.join('\n');
          let parsed = rawData;
          try {
            parsed = JSON.parse(rawData);
          } catch {
            // Keep raw text if not JSON
          }
          onEvent({ event: currentEvent, data: parsed });
        }
        currentEvent = 'message';
        dataLines = [];
        continue;
      }

      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
  };
}

function sendDesktopNotification(title, body) {
  const platform = os.platform();
  if (platform === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    spawn('osascript', ['-e', script], { stdio: 'ignore' }).unref();
  } else if (platform === 'linux') {
    spawn('notify-send', [title, body], { stdio: 'ignore' }).unref();
  }
}

function runHeadlessClaude(msg) {
  const prompt = [
    `Você recebeu uma mensagem direta via claude-mesh de ${msg.fromAlias} (${msg.fromOwner}).`,
    `Thread: ${msg.threadId} | Intent: ${msg.intent}`,
    `Mensagem: ${msg.body}`,
    msg.contextRefs?.length ? `Referências: ${msg.contextRefs.join(', ')}` : '',
    'Analise e responda usando send_direct_message na mesma thread se necessário.',
  ]
    .filter(Boolean)
    .join('\n');

  const child = spawn('claude', ['-p', prompt], { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`[claude-mesh watcher] falha ao executar claude -p: ${err.message}`);
  });
}

/**
 * Connects to the Broker SSE endpoint and invokes onMessage for each direct_message event.
 */
export async function startWatcher({
  brokerUrl,
  token = '',
  agentId,
  onMessage,
  onConnected,
  reconnectMs = 3000,
  signal,
}) {
  const baseUrl = brokerUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/events?agentId=${encodeURIComponent(agentId)}`;

  while (!signal?.aborted) {
    try {
      const headers = { Accept: 'text/event-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(url, { headers, signal });
      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      const parser = createSseParser((evt) => {
        if (evt.event === 'connected') {
          onConnected?.(evt.data);
        } else if (evt.event === 'direct_message') {
          onMessage?.(evt.data);
        }
      });

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (signal?.aborted) break;
      console.error(`[claude-mesh watcher] conexão SSE encerrada (${err.message}). Reconectando em ${reconnectMs}ms...`);
    }

    if (signal?.aborted) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, reconnectMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const brokerUrl = process.env.CLAUDE_MESH_URL || 'http://127.0.0.1:7331';
  const token = process.env.CLAUDE_MESH_TOKEN || '';
  const owner = process.env.CLAUDE_MESH_OWNER || os.userInfo().username || 'dev';
  const agentId = process.env.CLAUDE_MESH_AGENT_ID || `${owner}-${os.hostname()}`;
  const autoExec = process.env.CLAUDE_MESH_AUTO_EXEC === '1';

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  console.log(`[claude-mesh watcher] escutando eventos para ${agentId} em ${brokerUrl}...`);
  startWatcher({
    brokerUrl,
    token,
    agentId,
    signal: controller.signal,
    onConnected: () => {
      console.log(`[claude-mesh watcher] conectado!`);
    },
    onMessage: (msg) => {
      console.log(`\n[NOVA MENSAGEM] De ${msg.fromAlias} (${msg.fromOwner}) | thread: ${msg.threadId} | intent: ${msg.intent}`);
      console.log(`  ${msg.body}`);
      sendDesktopNotification(`Claude Mesh: ${msg.fromAlias}`, msg.body.slice(0, 140));
      if (autoExec && msg.intent === 'request') {
        runHeadlessClaude(msg);
      }
    },
  });
}
