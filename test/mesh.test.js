import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MeshStore } from '../src/store.js';
import { createBrokerServer } from '../src/broker.js';
import { createSseParser, startWatcher } from '../src/watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

test('MeshStore (SQLite): nicknames, collision, threads, heartbeat, unregister & persistence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mesh-test-'));
  const dbPath = path.join(tmpDir, 'mesh.db');

  try {
    const store = new MeshStore(dbPath, { aliasTtlMs: 1000 });

    const joao = store.registerPeer({ agentId: 'joao-mac', owner: 'joao', aliases: ['@Backend'] });
    assert.deepEqual(joao.aliases, ['backend']);

    const maria = store.registerPeer({ agentId: 'maria-linux', owner: 'maria', aliases: ['qa'] });
    assert.deepEqual(maria.aliases, ['qa']);

    // Collision check
    assert.throws(
      () => store.setNickname({ agentId: 'maria-linux', owner: 'maria', alias: 'backend' }),
      /já está em uso/
    );

    // Same-owner force reclaim
    const joao2 = store.registerPeer({
      agentId: 'joao-mac-2',
      owner: 'joao',
      aliases: ['backend'],
      force: true,
    });
    assert.deepEqual(joao2.aliases, ['backend']);

    // Send direct message and reply in thread
    const msg1 = store.sendMessage({
      fromAgentId: 'joao-mac-2',
      to: '@QA',
      body: 'Pode rodar os testes de integração?',
      intent: 'request',
      contextRefs: ['src/orders.ts'],
    });
    assert.equal(msg1.fromAlias, '@backend');
    assert.deepEqual(msg1.toAgentIds, ['maria-linux']);

    const msg2 = store.sendMessage({
      fromAgentId: 'maria-linux',
      to: '@backend',
      body: 'Rodando agora!',
      threadId: msg1.threadId,
      intent: 'info',
    });

    const thread = store.getThread(msg1.threadId);
    assert.equal(thread.length, 2);
    assert.equal(thread[0].id, msg1.id);
    assert.equal(thread[1].id, msg2.id);

    // Heartbeat & unregister
    const hb = store.heartbeat('maria-linux');
    assert.equal(hb.agentId, 'maria-linux');
    assert.equal(store.unregisterPeer('joao-mac'), true);

    store.close();

    // Re-open from SQLite file to verify persistence
    const reopened = new MeshStore(dbPath);
    assert.equal(reopened.getThread(msg1.threadId).length, 2);
    assert.equal(reopened.getInbox('maria-linux', { unreadOnly: true }).length, 1);
    reopened.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Broker HTTP API: auth, heartbeat, unregister, multi-recipient & threads', async () => {
  const { server } = createBrokerServer({
    tokens: { 'tok-joao': 'joao', 'tok-maria': 'maria', 'tok-pedro': 'pedro' },
    allowOpenDev: false,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauth = await fetch(`${baseUrl}/peers`);
    assert.equal(unauth.status, 401);

    for (const [token, id, alias] of [
      ['tok-joao', 'joao-1', 'joao'],
      ['tok-maria', 'maria-1', 'maria'],
      ['tok-pedro', 'pedro-1', 'pedro'],
    ]) {
      const reg = await fetch(`${baseUrl}/peers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agentId: id, aliases: [alias] }),
      });
      assert.equal(reg.status, 200);
    }

    // Heartbeat
    const hbRes = await fetch(`${baseUrl}/peers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-joao' },
      body: JSON.stringify({ agentId: 'joao-1' }),
    });
    assert.equal(hbRes.status, 200);

    // Multi-recipient message
    const sendRes = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-joao' },
      body: JSON.stringify({
        fromAgentId: 'joao-1',
        to: ['@maria', '@pedro'],
        body: 'Reunião em 5 min!',
      }),
    });
    assert.equal(sendRes.status, 201);
    const { message } = await sendRes.json();
    assert.deepEqual(message.toAgentIds.sort(), ['maria-1', 'pedro-1']);

    // Thread endpoint
    const threadRes = await fetch(`${baseUrl}/threads/${message.threadId}`, {
      headers: { Authorization: 'Bearer tok-maria' },
    });
    assert.equal(threadRes.status, 200);
    const threadData = await threadRes.json();
    assert.equal(threadData.messages.length, 1);

    // Unregister
    const unregRes = await fetch(`${baseUrl}/peers/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-pedro' },
      body: JSON.stringify({ agentId: 'pedro-1' }),
    });
    assert.equal(unregRes.status, 200);
    assert.equal((await unregRes.json()).removed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('MCP Server stdio: 5 tools, multi-recipient send_direct_message & read_thread', async () => {
  const { server } = createBrokerServer({ allowOpenDev: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  await fetch(`${baseUrl}/peers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'pedro-1', owner: 'pedro', aliases: ['pedro'] }),
  });

  const child = spawn('node', [path.join(PROJECT_ROOT, 'src', 'mcp-server.js')], {
    env: {
      ...process.env,
      CLAUDE_MESH_URL: baseUrl,
      CLAUDE_MESH_AGENT_ID: 'ana-1',
      CLAUDE_MESH_OWNER: 'ana',
      CLAUDE_MESH_ALIAS: 'ana',
      CLAUDE_MESH_HEARTBEAT_MS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  let rpcId = 1;
  function callRpc(method, params = {}) {
    const id = rpcId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  try {
    const init = await callRpc('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'claude-mesh');

    const tools = await callRpc('tools/list');
    assert.equal(tools.result.tools.length, 5);

    const nickRes = await callRpc('tools/call', {
      name: 'set_nickname',
      arguments: { alias: '@techlead' },
    });
    assert.match(nickRes.result.content[0].text, /@techlead/);

    const sendRes = await callRpc('tools/call', {
      name: 'send_direct_message',
      arguments: { to: ['@pedro'], message: 'Deploy liberado!' },
    });
    const sendText = sendRes.result.content[0].text;
    assert.match(sendText, /@pedro/);
    const threadMatch = sendText.match(/thread: (thr_[a-z0-9]+)/);
    assert.ok(threadMatch, 'Expected thread id in response');

    const threadRes = await callRpc('tools/call', {
      name: 'read_thread',
      arguments: { thread_id: threadMatch[1] },
    });
    assert.match(threadRes.result.content[0].text, /Deploy liberado!/);
  } finally {
    rl.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Watcher SSE: createSseParser & live direct_message stream', async () => {
  const events = [];
  const push = createSseParser((evt) => events.push(evt));
  push('event: direct_message\ndata: {"id":"msg_1","body":"ola"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'direct_message');
  assert.equal(events[0].data.body, 'ola');

  const { server } = createBrokerServer({ allowOpenDev: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  await fetch(`${baseUrl}/peers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'joao-1', owner: 'joao', aliases: ['joao'] }),
  });
  await fetch(`${baseUrl}/peers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'maria-1', owner: 'maria', aliases: ['maria'] }),
  });

  const controller = new AbortController();
  const received = [];

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Watcher timeout')), 5000);
      startWatcher({
        brokerUrl: baseUrl,
        agentId: 'maria-1',
        signal: controller.signal,
        onConnected: async () => {
          await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromAgentId: 'joao-1', to: '@maria', body: 'Ping SSE!' }),
          });
        },
        onMessage: (msg) => {
          received.push(msg);
          clearTimeout(timeout);
          controller.abort();
          resolve();
        },
      });
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].body, 'Ping SSE!');
  } finally {
    controller.abort();
    await new Promise((resolve) => server.close(resolve));
  }
});
