import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MeshStore } from '../src/store.js';
import { createBrokerServer } from '../src/broker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

test('MeshStore: nicknames, collision detection, direct messaging and inbox ack', () => {
  const store = new MeshStore();

  const joao = store.registerPeer({ agentId: 'joao-mac', owner: 'joao', aliases: ['@Backend'] });
  assert.deepEqual(joao.aliases, ['backend']);

  const maria = store.registerPeer({ agentId: 'maria-linux', owner: 'maria', aliases: ['qa'] });
  assert.deepEqual(maria.aliases, ['qa']);

  // Collision check
  assert.throws(
    () => store.setNickname({ agentId: 'maria-linux', owner: 'maria', alias: 'backend' }),
    /já está em uso/
  );

  // Send direct message using @alias (case-insensitive)
  const msg = store.sendMessage({
    fromAgentId: 'joao-mac',
    to: '@QA',
    body: 'Pode rodar os testes de integração?',
    intent: 'request',
    contextRefs: ['src/orders.ts'],
  });
  assert.equal(msg.fromAlias, '@backend');
  assert.deepEqual(msg.toAgentIds, ['maria-linux']);

  // Maria reads unread without marking as read
  const unread = store.getInbox('maria-linux', { unreadOnly: true, markAsRead: false });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].body, 'Pode rodar os testes de integração?');

  // João's inbox should be empty
  assert.equal(store.getInbox('joao-mac', { unreadOnly: true }).length, 0);

  // Maria marks as read
  const acked = store.ackMessages('maria-linux', [msg.id]);
  assert.equal(acked, 1);
  assert.equal(store.getInbox('maria-linux', { unreadOnly: true }).length, 0);
});

test('Broker HTTP API: auth enforcement and message routing', async () => {
  const { server } = createBrokerServer({
    tokens: { 'tok-joao': 'joao', 'tok-maria': 'maria' },
    allowOpenDev: false,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Unauthorized request
    const unauth = await fetch(`${baseUrl}/peers`);
    assert.equal(unauth.status, 401);

    // Register João & Maria
    const regJoao = await fetch(`${baseUrl}/peers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-joao' },
      body: JSON.stringify({ agentId: 'joao-1', aliases: ['joao'] }),
    });
    assert.equal(regJoao.status, 200);

    const regMaria = await fetch(`${baseUrl}/peers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-maria' },
      body: JSON.stringify({ agentId: 'maria-1', aliases: ['maria'] }),
    });
    assert.equal(regMaria.status, 200);

    // Send direct message from João to @maria
    const sendRes = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-joao' },
      body: JSON.stringify({ fromAgentId: 'joao-1', to: '@maria', body: 'Oi Maria!' }),
    });
    assert.equal(sendRes.status, 201);

    // Maria reads inbox
    const inboxRes = await fetch(`${baseUrl}/inbox?agentId=maria-1&unreadOnly=true&markAsRead=true`, {
      headers: { Authorization: 'Bearer tok-maria' },
    });
    assert.equal(inboxRes.status, 200);
    const inboxData = await inboxRes.json();
    assert.equal(inboxData.messages.length, 1);
    assert.equal(inboxData.messages[0].body, 'Oi Maria!');
    assert.equal(inboxData.messages[0].fromOwner, 'joao');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('MCP Server stdio: initialize, set_nickname, send_direct_message, read_inbox', async () => {
  const { server } = createBrokerServer({ allowOpenDev: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Pre-register another colleague (@pedro) on the broker
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
    assert.equal(tools.result.tools.length, 4);

    // Change nickname to @techlead
    const nickRes = await callRpc('tools/call', {
      name: 'set_nickname',
      arguments: { alias: '@techlead' },
    });
    assert.match(nickRes.result.content[0].text, /@techlead/);

    // Send direct message to @pedro
    const sendRes = await callRpc('tools/call', {
      name: 'send_direct_message',
      arguments: { to: '@pedro', message: 'Deploy liberado!' },
    });
    assert.match(sendRes.result.content[0].text, /@pedro/);

    // Pedro sends a reply to @techlead
    await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAgentId: 'pedro-1', to: '@techlead', body: 'Valeu, subindo!' }),
    });

    // Ana reads her inbox via MCP
    const inboxRes = await callRpc('tools/call', {
      name: 'read_inbox',
      arguments: { unread_only: true, mark_as_read: true },
    });
    assert.match(inboxRes.result.content[0].text, /Valeu, subindo!/);
    assert.match(inboxRes.result.content[0].text, /@pedro/);
  } finally {
    rl.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
});
