import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Normalizes a nickname by trimming whitespace, stripping leading '@', and lowercasing.
 */
export function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Formats a normalized alias with a leading '@'.
 */
export function formatAlias(alias) {
  const norm = normalizeAlias(alias);
  return norm ? `@${norm}` : '';
}

/**
 * File-backed store for peers, aliases, and direct messages.
 */
export class MeshStore {
  constructor(dataFilePath = null) {
    this.dataFilePath = dataFilePath;
    this.state = {
      peers: {}, // agentId -> { agentId, owner, aliases: string[], lastSeen: number }
      messages: [], // { id, fromAgentId, fromAlias, toAliases, toAgentIds, threadId, intent, body, contextRefs, createdAt, readBy: string[] }
    };
    if (this.dataFilePath) {
      this._load();
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.dataFilePath)) {
        const raw = fs.readFileSync(this.dataFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.state.peers = parsed.peers || {};
          this.state.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        }
      }
    } catch (err) {
      console.error(`[store] Failed to load state from ${this.dataFilePath}:`, err.message);
    }
  }

  _save() {
    if (!this.dataFilePath) return;
    const dir = path.dirname(this.dataFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.dataFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.dataFilePath);
  }

  /**
   * Registers or updates a peer and validates that none of its aliases are held by another peer.
   */
  registerPeer({ agentId, owner, aliases = [] }) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required');
    }
    const cleanAliases = [...new Set(aliases.map(normalizeAlias).filter(Boolean))];

    // Check alias collisions against other peers
    for (const alias of cleanAliases) {
      const holder = this.findPeerByAlias(alias);
      if (holder && holder.agentId !== agentId) {
        const err = new Error(`Apelido "@${alias}" já está em uso por ${holder.owner} (${holder.agentId}).`);
        err.statusCode = 409;
        throw err;
      }
    }

    const existing = this.state.peers[agentId];
    const peer = {
      agentId,
      owner: owner || existing?.owner || 'unknown',
      aliases: cleanAliases.length > 0 ? cleanAliases : (existing?.aliases || []),
      lastSeen: Date.now(),
    };
    this.state.peers[agentId] = peer;
    this._save();
    return peer;
  }

  /**
   * Sets (replaces or adds) nicknames for an existing or new peer.
   */
  setNickname({ agentId, owner, alias, append = false }) {
    const norm = normalizeAlias(alias);
    if (!norm) {
      const err = new Error('Apelido inválido.');
      err.statusCode = 400;
      throw err;
    }

    const existing = this.state.peers[agentId];
    const nextAliases = append && existing
      ? [...new Set([...existing.aliases, norm])]
      : [norm];

    return this.registerPeer({
      agentId,
      owner: owner || existing?.owner || 'unknown',
      aliases: nextAliases,
    });
  }

  touchPeer(agentId) {
    if (this.state.peers[agentId]) {
      this.state.peers[agentId].lastSeen = Date.now();
      this._save();
    }
  }

  findPeerByAlias(alias) {
    const norm = normalizeAlias(alias);
    if (!norm) return null;
    return Object.values(this.state.peers).find((p) => p.aliases.includes(norm)) || null;
  }

  resolveRecipient(target) {
    if (!target || typeof target !== 'string') return null;
    const trimmed = target.trim();
    if (this.state.peers[trimmed]) {
      return this.state.peers[trimmed];
    }
    return this.findPeerByAlias(trimmed);
  }

  listPeers(onlineThresholdMs = 5 * 60 * 1000) {
    const now = Date.now();
    return Object.values(this.state.peers).map((p) => ({
      ...p,
      formattedAliases: p.aliases.map(formatAlias),
      online: now - p.lastSeen <= onlineThresholdMs,
    }));
  }

  /**
   * Stores a direct message addressed to one or more recipients (aliases or agentIds).
   */
  sendMessage({ fromAgentId, to, body, threadId = null, intent = 'message', contextRefs = [] }) {
    const sender = this.state.peers[fromAgentId];
    if (!sender) {
      const err = new Error(`Remetente "${fromAgentId}" não registrado. Registre o peer antes de enviar.`);
      err.statusCode = 400;
      throw err;
    }

    const targets = Array.isArray(to) ? to : [to];
    if (targets.length === 0 || !body || typeof body !== 'string') {
      const err = new Error('Campos "to" e "body" são obrigatórios.');
      err.statusCode = 400;
      throw err;
    }

    const resolvedPeers = [];
    const unresolved = [];
    for (const t of targets) {
      const peer = this.resolveRecipient(t);
      if (peer) {
        resolvedPeers.push(peer);
      } else {
        unresolved.push(t);
      }
    }

    if (unresolved.length > 0) {
      const err = new Error(`Destinatário(s) não encontrado(s): ${unresolved.join(', ')}`);
      err.statusCode = 404;
      throw err;
    }

    const toAgentIds = [...new Set(resolvedPeers.map((p) => p.agentId))];
    const toAliases = resolvedPeers.map((p) =>
      p.aliases[0] ? formatAlias(p.aliases[0]) : p.agentId
    );

    const msg = {
      id: `msg_${crypto.randomUUID().slice(0, 8)}`,
      fromAgentId: sender.agentId,
      fromOwner: sender.owner,
      fromAlias: sender.aliases[0] ? formatAlias(sender.aliases[0]) : sender.agentId,
      toAgentIds,
      toAliases,
      threadId: threadId || `thr_${crypto.randomUUID().slice(0, 8)}`,
      intent,
      body,
      contextRefs: Array.isArray(contextRefs) ? contextRefs : [],
      createdAt: new Date().toISOString(),
      readBy: [],
    };

    this.state.messages.push(msg);
    sender.lastSeen = Date.now();
    this._save();
    return msg;
  }

  getInbox(agentId, { unreadOnly = false, markAsRead = false, limit = 50 } = {}) {
    this.touchPeer(agentId);
    let list = this.state.messages.filter((m) => m.toAgentIds.includes(agentId));
    if (unreadOnly) {
      list = list.filter((m) => !m.readBy.includes(agentId));
    }
    const sliced = list.slice(-limit);
    if (markAsRead && sliced.length > 0) {
      for (const m of sliced) {
        if (!m.readBy.includes(agentId)) {
          m.readBy.push(agentId);
        }
      }
      this._save();
    }
    return sliced;
  }

  ackMessages(agentId, messageIds = []) {
    let count = 0;
    for (const m of this.state.messages) {
      if (messageIds.includes(m.id) && m.toAgentIds.includes(agentId) && !m.readBy.includes(agentId)) {
        m.readBy.push(agentId);
        count++;
      }
    }
    if (count > 0) {
      this._save();
    }
    return count;
  }
}
