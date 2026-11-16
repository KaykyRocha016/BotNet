import os from 'node:os';
import readline from 'node:readline';

const BROKER_URL = (process.env.CLAUDE_MESH_URL || 'http://127.0.0.1:7331').replace(/\/+$/, '');
const TOKEN = process.env.CLAUDE_MESH_TOKEN || '';
const OWNER = process.env.CLAUDE_MESH_OWNER || os.userInfo().username || 'dev';
const AGENT_ID = process.env.CLAUDE_MESH_AGENT_ID || `${OWNER}-${os.hostname()}`;
const INITIAL_ALIAS = process.env.CLAUDE_MESH_ALIAS || OWNER;

async function brokerRequest(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${BROKER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Broker HTTP ${res.status}`);
  }
  return data;
}

let isRegistered = false;

async function ensureRegistered() {
  if (isRegistered) return;
  try {
    await brokerRequest('POST', '/peers/register', {
      agentId: AGENT_ID,
      owner: OWNER,
      aliases: INITIAL_ALIAS ? [INITIAL_ALIAS] : [],
    });
    isRegistered = true;
  } catch (err) {
    // Non-fatal on startup if broker is temporarily offline or alias conflicts
    console.error(`[claude-mesh mcp] startup register warning: ${err.message}`);
  }
}

const TOOLS = [
  {
    name: 'set_nickname',
    description:
      'Define ou altera o apelido (@nickname) deste Claude Code na rede privada da equipe para que colegas possam enviar mensagens diretas.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Novo apelido (ex.: "backend", "@joao-revisor").',
        },
        append: {
          type: 'boolean',
          description: 'Se true, adiciona este apelido aos existentes em vez de substituir.',
          default: false,
        },
      },
      required: ['alias'],
    },
  },
  {
    name: 'list_peers',
    description:
      'Lista todos os Claudes da rede privada, mostrando dono, apelidos (@nickname) e status online/offline.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'send_direct_message',
    description:
      'Envia uma mensagem direta para um colega/Claude específico usando seu @apelido (ou agentId).',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Apelido do destinatário (ex.: "@maria" ou "qa-maria").',
        },
        message: {
          type: 'string',
          description: 'Conteúdo da mensagem direta.',
        },
        thread_id: {
          type: 'string',
          description: 'ID opcional da thread para continuar uma conversa existente.',
        },
        intent: {
          type: 'string',
          enum: ['message', 'request', 'question', 'info'],
          description: 'Intenção da mensagem (ajuda o Claude receptor a priorizar).',
          default: 'message',
        },
        context_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arquivos, PRs ou referências relacionadas à mensagem.',
        },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'read_inbox',
    description:
      'Lê mensagens diretas recebidas por este Claude Code na rede privada.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: {
          type: 'boolean',
          description: 'Se true, retorna apenas mensagens não lidas.',
          default: true,
        },
        mark_as_read: {
          type: 'boolean',
          description: 'Se true, marca as mensagens retornadas como lidas.',
          default: true,
        },
      },
    },
  },
];

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'set_nickname': {
      const { peer } = await brokerRequest('POST', '/peers/nickname', {
        agentId: AGENT_ID,
        owner: OWNER,
        alias: args.alias,
        append: Boolean(args.append),
      });
      isRegistered = true;
      return {
        content: [
          {
            type: 'text',
            text: `Apelido atualizado! Este Claude (${peer.agentId}) agora responde por: ${peer.aliases.map((a) => `@${a}`).join(', ')}`,
          },
        ],
      };
    }

    case 'list_peers': {
      const { peers } = await brokerRequest('GET', '/peers');
      if (peers.length === 0) {
        return { content: [{ type: 'text', text: 'Nenhum Claude registrado na rede ainda.' }] };
      }
      const lines = peers.map((p) => {
        const status = p.online ? 'ONLINE' : 'offline';
        const aliases = p.formattedAliases?.join(', ') || '(sem apelido)';
        const me = p.agentId === AGENT_ID ? ' [VOCÊ]' : '';
        return `- ${aliases} | dono: ${p.owner} | status: ${status} | id: ${p.agentId}${me}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'send_direct_message': {
      // Ensure sender is registered before sending
      await ensureRegistered();
      const { message } = await brokerRequest('POST', '/messages', {
        fromAgentId: AGENT_ID,
        to: args.to,
        body: args.message,
        threadId: args.thread_id || null,
        intent: args.intent || 'message',
        contextRefs: args.context_refs || [],
      });
      return {
        content: [
          {
            type: 'text',
            text: `Mensagem enviada para ${message.toAliases.join(', ')} (id: ${message.id}, thread: ${message.threadId}).`,
          },
        ],
      };
    }

    case 'read_inbox': {
      const unreadOnly = args.unread_only !== false;
      const markAsRead = args.mark_as_read !== false;
      const { messages } = await brokerRequest(
        'GET',
        `/inbox?agentId=${encodeURIComponent(AGENT_ID)}&unreadOnly=${unreadOnly}&markAsRead=${markAsRead}`
      );
      if (messages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: unreadOnly ? 'Nenhuma mensagem não lida na caixa de entrada.' : 'Caixa de entrada vazia.',
            },
          ],
        };
      }
      const formatted = messages
        .map((m) => {
          const refs = m.contextRefs?.length ? `\n  Refs: ${m.contextRefs.join(', ')}` : '';
          return `[${m.createdAt}] De ${m.fromAlias} (${m.fromOwner}) | thread: ${m.threadId} | intent: ${m.intent}\n  ${m.body}${refs}`;
        })
        .join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }

    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

function sendRpc(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleRpcMessage(msg) {
  const { id, method, params } = msg;
  if (!method) return;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      await ensureRegistered();
      return sendRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-mesh', version: '0.1.0' },
        },
      });
    }

    if (method === 'ping') {
      return sendRpc({ jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      return sendRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }

    if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      return sendRpc({ jsonrpc: '2.0', id, result });
    }

    return sendRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    return sendRpc({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Erro: ${err.message}` }],
        isError: true,
      },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleRpcMessage(msg);
  } catch (err) {
    console.error('[claude-mesh mcp] invalid JSON-RPC line:', err.message);
  }
});
