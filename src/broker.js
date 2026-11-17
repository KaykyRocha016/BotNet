import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MeshStore } from './store.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('JSON inválido no corpo da requisição.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Loads token -> owner map from JSON string or defaults to open dev mode if none configured.
 */
function loadTokens(tokensJson) {
  if (!tokensJson) return null;
  try {
    const parsed = JSON.parse(tokensJson);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createBrokerServer({
  dataFilePath = null,
  tokens = null,
  allowOpenDev = true,
  aliasTtlMs = 24 * 60 * 60 * 1000,
} = {}) {
  const store = new MeshStore(dataFilePath, { aliasTtlMs });
  const sseClients = new Map(); // agentId -> Set<ServerResponse>

  function emitToAgent(agentId, eventName, data) {
    const subs = sseClients.get(agentId);
    if (!subs) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subs) {
      res.write(frame);
    }
  }

  function authenticate(req) {
    if (!tokens) {
      return allowOpenDev ? { owner: null, authenticated: true } : { authenticated: false };
    }
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return { authenticated: false };
    const token = match[1].trim();
    if (!(token in tokens)) return { authenticated: false };
    return { owner: tokens[token], authenticated: true };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, peers: store.listPeers().length });
    }

    const auth = authenticate(req);
    if (!auth.authenticated) {
      return sendJson(res, 401, { error: 'Token de autenticação inválido ou ausente.' });
    }

    try {
      if (req.method === 'POST' && pathname === '/peers/register') {
        const body = await readJsonBody(req);
        const owner = auth.owner || body.owner || 'dev';
        const peer = store.registerPeer({
          agentId: body.agentId,
          owner,
          aliases: body.aliases || (body.alias ? [body.alias] : []),
          force: Boolean(body.force),
        });
        return sendJson(res, 200, { peer });
      }

      if (req.method === 'POST' && pathname === '/peers/nickname') {
        const body = await readJsonBody(req);
        const owner = auth.owner || body.owner || 'dev';
        const peer = store.setNickname({
          agentId: body.agentId,
          owner,
          alias: body.alias,
          append: Boolean(body.append),
          force: Boolean(body.force),
        });
        return sendJson(res, 200, { peer });
      }

      if (req.method === 'POST' && pathname === '/peers/heartbeat') {
        const body = await readJsonBody(req);
        const peer = store.heartbeat(body.agentId);
        return sendJson(res, 200, { peer });
      }

      if (req.method === 'POST' && pathname === '/peers/unregister') {
        const body = await readJsonBody(req);
        const removed = store.unregisterPeer(body.agentId);
        return sendJson(res, 200, { removed });
      }

      if (req.method === 'GET' && pathname === '/peers') {
        return sendJson(res, 200, { peers: store.listPeers() });
      }

      if (req.method === 'POST' && pathname === '/messages') {
        const body = await readJsonBody(req);
        const message = store.sendMessage({
          fromAgentId: body.fromAgentId,
          to: body.to,
          body: body.body,
          threadId: body.threadId,
          intent: body.intent,
          contextRefs: body.contextRefs,
        });
        for (const targetAgentId of message.toAgentIds) {
          emitToAgent(targetAgentId, 'direct_message', message);
        }
        return sendJson(res, 201, { message });
      }

      if (req.method === 'GET' && pathname === '/inbox') {
        const agentId = url.searchParams.get('agentId');
        if (!agentId) {
          return sendJson(res, 400, { error: 'Query param "agentId" é obrigatório.' });
        }
        const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
        const markAsRead = url.searchParams.get('markAsRead') === 'true';
        const limit = Number(url.searchParams.get('limit') || 50);
        const messages = store.getInbox(agentId, { unreadOnly, markAsRead, limit });
        return sendJson(res, 200, { messages });
      }

      if (req.method === 'GET' && pathname.startsWith('/threads/')) {
        const threadId = decodeURIComponent(pathname.slice('/threads/'.length));
        const limit = Number(url.searchParams.get('limit') || 100);
        const messages = store.getThread(threadId, { limit });
        return sendJson(res, 200, { threadId, messages });
      }

      if (req.method === 'POST' && pathname === '/inbox/ack') {
        const body = await readJsonBody(req);
        const acked = store.ackMessages(body.agentId, body.messageIds || []);
        return sendJson(res, 200, { acked });
      }

      if (req.method === 'GET' && pathname === '/events') {
        const agentId = url.searchParams.get('agentId');
        if (!agentId) {
          return sendJson(res, 400, { error: 'Query param "agentId" é obrigatório.' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ agentId })}\n\n`);
        if (!sseClients.has(agentId)) sseClients.set(agentId, new Set());
        sseClients.get(agentId).add(res);
        req.on('close', () => {
          sseClients.get(agentId)?.delete(res);
        });
        return;
      }

      return sendJson(res, 404, { error: 'Rota não encontrada.' });
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { error: err.message });
    }
  });

  server.on('close', () => {
    store.close();
  });

  return { server, store };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.CLAUDE_MESH_PORT || 7331);
  const host = process.env.CLAUDE_MESH_HOST || '0.0.0.0';
  const dataFilePath = process.env.CLAUDE_MESH_DATA || path.resolve(process.cwd(), 'data', 'mesh.db');
  const tokens = loadTokens(process.env.CLAUDE_MESH_TOKENS);
  const allowOpenDev = process.env.CLAUDE_MESH_REQUIRE_AUTH !== '1';
  const aliasTtlHours = Number(process.env.CLAUDE_MESH_ALIAS_TTL_HOURS || 24);
  const retentionDays = Number(process.env.CLAUDE_MESH_RETENTION_DAYS || 30);

  const { server, store } = createBrokerServer({
    dataFilePath,
    tokens,
    allowOpenDev,
    aliasTtlMs: aliasTtlHours * 60 * 60 * 1000,
  });

  if (retentionDays > 0) {
    const prune = () => store.cleanupOldMessages(retentionDays * 24 * 60 * 60 * 1000);
    prune();
    setInterval(prune, 6 * 60 * 60 * 1000).unref();
  }

  server.listen(port, host, () => {
    console.log(`[botnet broker] listening on http://${host}:${port}`);
    console.log(`[botnet broker] sqlite db: ${dataFilePath}`);
    console.log(`[botnet broker] auth mode: ${tokens ? 'Bearer token' : 'Open Dev (no CLAUDE_MESH_TOKENS set)'}`);
  });
}
