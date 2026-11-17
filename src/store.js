import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

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

function rowToPeer(row) {
  if (!row) return null;
  return {
    agentId: row.agent_id,
    owner: row.owner,
    aliases: JSON.parse(row.aliases),
    lastSeen: row.last_seen,
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    fromOwner: row.from_owner,
    fromAlias: row.from_alias,
    toAgentIds: JSON.parse(row.to_agent_ids),
    toAliases: JSON.parse(row.to_aliases),
    threadId: row.thread_id,
    intent: row.intent,
    body: row.body,
    contextRefs: JSON.parse(row.context_refs),
    createdAt: row.created_at,
    readBy: JSON.parse(row.read_by),
  };
}

/**
 * SQLite-backed store (via node:sqlite) for peers, aliases, and direct messages.
 */
export class MeshStore {
  constructor(dataFilePath = null, { aliasTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.dataFilePath = dataFilePath;
    this.aliasTtlMs = aliasTtlMs;

    if (dataFilePath && dataFilePath !== ':memory:') {
      fs.mkdirSync(path.dirname(dataFilePath), { recursive: true });
    }

    this.db = new DatabaseSync(dataFilePath || ':memory:');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS peers (
        agent_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        aliases TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_agent_id TEXT NOT NULL,
        from_owner TEXT NOT NULL,
        from_alias TEXT NOT NULL,
        to_agent_ids TEXT NOT NULL,
        to_aliases TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        intent TEXT NOT NULL,
        body TEXT NOT NULL,
        context_refs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        read_by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at_ms);
    `);
  }

  close() {
    this.db.close();
  }

  _getPeerRow(agentId) {
    return this.db.prepare('SELECT * FROM peers WHERE agent_id = ?').get(agentId);
  }

  /**
   * Registers or updates a peer and validates that none of its aliases are held by another active peer.
   * Expired aliases (lastSeen older than aliasTtlMs) or same-owner aliases with force=true can be reclaimed.
   */
  registerPeer({ agentId, owner, aliases = [], force = false }) {
    if (!agentId || typeof agentId !== 'string') {
      const err = new Error('agentId is required');
      err.statusCode = 400;
      throw err;
    }

    const cleanAliases = [...new Set(aliases.map(normalizeAlias).filter(Boolean))];
    const now = Date.now();
    const existing = rowToPeer(this._getPeerRow(agentId));
    const resolvedOwner = owner || existing?.owner || 'unknown';

    // Check alias collisions against other peers
    for (const alias of cleanAliases) {
      const holder = this.findPeerByAlias(alias);
      if (holder && holder.agentId !== agentId) {
        const isExpired = now - holder.lastSeen > this.aliasTtlMs;
        const canReclaim = isExpired || (force && holder.owner === resolvedOwner);
        if (!canReclaim) {
          const err = new Error(`Apelido "@${alias}" já está em uso por ${holder.owner} (${holder.agentId}).`);
          err.statusCode = 409;
          throw err;
        }
        // Release alias from stale/reclaimed holder
        const remaining = holder.aliases.filter((a) => a !== alias);
        this.db.prepare('UPDATE peers SET aliases = ? WHERE agent_id = ?').run(
          JSON.stringify(remaining),
          holder.agentId
        );
      }
    }

    const finalAliases = cleanAliases.length > 0 ? cleanAliases : (existing?.aliases || []);
    this.db.prepare(`
      INSERT INTO peers (agent_id, owner, aliases, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        owner = excluded.owner,
        aliases = excluded.aliases,
        last_seen = excluded.last_seen
    `).run(agentId, resolvedOwner, JSON.stringify(finalAliases), now);

    return rowToPeer(this._getPeerRow(agentId));
  }

  /**
   * Sets (replaces or adds) nicknames for an existing or new peer.
   */
  setNickname({ agentId, owner, alias, append = false, force = false }) {
    const norm = normalizeAlias(alias);
    if (!norm) {
      const err = new Error('Apelido inválido.');
      err.statusCode = 400;
      throw err;
    }

    const existing = rowToPeer(this._getPeerRow(agentId));
    const nextAliases = append && existing
      ? [...new Set([...existing.aliases, norm])]
      : [norm];

    return this.registerPeer({
      agentId,
      owner: owner || existing?.owner || 'unknown',
      aliases: nextAliases,
      force,
    });
  }

  touchPeer(agentId) {
    const info = this.db.prepare('UPDATE peers SET last_seen = ? WHERE agent_id = ?').run(
      Date.now(),
      agentId
    );
    return info.changes > 0;
  }

  heartbeat(agentId) {
    const updated = this.touchPeer(agentId);
    if (!updated) {
      const err = new Error(`Peer "${agentId}" não encontrado para heartbeat.`);
      err.statusCode = 404;
      throw err;
    }
    return rowToPeer(this._getPeerRow(agentId));
  }

  unregisterPeer(agentId) {
    const info = this.db.prepare('DELETE FROM peers WHERE agent_id = ?').run(agentId);
    return info.changes > 0;
  }

  findPeerByAlias(alias) {
    const norm = normalizeAlias(alias);
    if (!norm) return null;
    const rows = this.db.prepare('SELECT * FROM peers').all();
    for (const row of rows) {
      const peer = rowToPeer(row);
      if (peer.aliases.includes(norm)) {
        return peer;
      }
    }
    return null;
  }

  resolveRecipient(target) {
    if (!target || typeof target !== 'string') return null;
    const trimmed = target.trim();
    const byId = rowToPeer(this._getPeerRow(trimmed));
    if (byId) return byId;
    return this.findPeerByAlias(trimmed);
  }

  listPeers(onlineThresholdMs = 5 * 60 * 1000) {
    const now = Date.now();
    const rows = this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all();
    return rows.map((row) => {
      const p = rowToPeer(row);
      return {
        ...p,
        formattedAliases: p.aliases.map(formatAlias),
        online: now - p.lastSeen <= onlineThresholdMs,
      };
    });
  }

  /**
   * Stores a direct message addressed to one or more recipients (aliases or agentIds).
   */
  sendMessage({ fromAgentId, to, body, threadId = null, intent = 'message', contextRefs = [] }) {
    const sender = rowToPeer(this._getPeerRow(fromAgentId));
    if (!sender) {
      const err = new Error(`Remetente "${fromAgentId}" não registrado. Registre o peer antes de enviar.`);
      err.statusCode = 400;
      throw err;
    }

    const targets = (Array.isArray(to) ? to : [to]).filter(Boolean);
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
    const toAliases = [...new Set(
      resolvedPeers.map((p) => (p.aliases[0] ? formatAlias(p.aliases[0]) : p.agentId))
    )];

    const nowMs = Date.now();
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
      createdAt: new Date(nowMs).toISOString(),
      readBy: [],
    };

    this.db.prepare(`
      INSERT INTO messages (
        id, from_agent_id, from_owner, from_alias, to_agent_ids, to_aliases,
        thread_id, intent, body, context_refs, created_at, created_at_ms, read_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.fromAgentId,
      msg.fromOwner,
      msg.fromAlias,
      JSON.stringify(msg.toAgentIds),
      JSON.stringify(msg.toAliases),
      msg.threadId,
      msg.intent,
      msg.body,
      JSON.stringify(msg.contextRefs),
      msg.createdAt,
      nowMs,
      JSON.stringify(msg.readBy)
    );

    this.touchPeer(fromAgentId);
    return msg;
  }

  getInbox(agentId, { unreadOnly = false, markAsRead = false, limit = 50 } = {}) {
    this.touchPeer(agentId);
    const rows = this.db.prepare('SELECT * FROM messages ORDER BY rowid ASC').all();
    let list = rows.map(rowToMessage).filter((m) => m.toAgentIds.includes(agentId));

    if (unreadOnly) {
      list = list.filter((m) => !m.readBy.includes(agentId));
    }
    const sliced = list.slice(-limit);

    if (markAsRead && sliced.length > 0) {
      const updateStmt = this.db.prepare('UPDATE messages SET read_by = ? WHERE id = ?');
      for (const m of sliced) {
        if (!m.readBy.includes(agentId)) {
          m.readBy.push(agentId);
          updateStmt.run(JSON.stringify(m.readBy), m.id);
        }
      }
    }
    return sliced;
  }

  getThread(threadId, { limit = 100 } = {}) {
    if (!threadId || typeof threadId !== 'string') {
      const err = new Error('threadId é obrigatório.');
      err.statusCode = 400;
      throw err;
    }
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid ASC LIMIT ?')
      .all(threadId, limit);
    return rows.map(rowToMessage);
  }

  ackMessages(agentId, messageIds = []) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
    const selectStmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const updateStmt = this.db.prepare('UPDATE messages SET read_by = ? WHERE id = ?');
    let count = 0;

    for (const id of messageIds) {
      const row = selectStmt.get(id);
      if (!row) continue;
      const m = rowToMessage(row);
      if (m.toAgentIds.includes(agentId) && !m.readBy.includes(agentId)) {
        m.readBy.push(agentId);
        updateStmt.run(JSON.stringify(m.readBy), m.id);
        count++;
      }
    }
    return count;
  }

  cleanupOldMessages(maxAgeMs) {
    if (!maxAgeMs || maxAgeMs <= 0) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db.prepare('DELETE FROM messages WHERE created_at_ms < ?').run(cutoff);
    return info.changes;
  }
}
