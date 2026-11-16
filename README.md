# claude-mesh

Rede privada de comunicação para instâncias do **Claude Code** entre colegas de equipe, com suporte a **apelidos (`@nickname`)** e **mensagens diretas** via **MCP (Model Context Protocol)**.

Zero dependências externas (Node.js >= 20).

---

## 1. Subir o Broker Central (em uma máquina da VPN/Tailscale)

```bash
CLAUDE_MESH_PORT=7331 \
CLAUDE_MESH_TOKENS='{"tok-joao":"joao","tok-maria":"maria","tok-pedro":"pedro"}' \
CLAUDE_MESH_REQUIRE_AUTH=1 \
npm run broker
```

> Para testar localmente sem tokens, basta rodar `npm run broker`.

---

## 2. Conectar cada Claude Code via MCP

No projeto (ou no `~/.claude.json` global de cada pessoa), adicione o servidor MCP `claude-mesh`:

```json
{
  "mcpServers": {
    "claude-mesh": {
      "command": "node",
      "args": ["/caminho/para/claude-mesh/src/mcp-server.js"],
      "env": {
        "CLAUDE_MESH_URL": "http://100.x.y.z:7331",
        "CLAUDE_MESH_TOKEN": "tok-joao",
        "CLAUDE_MESH_OWNER": "joao",
        "CLAUDE_MESH_ALIAS": "backend"
      }
    }
  }
}
```

Ou via CLI do Claude Code:

```bash
claude mcp add claude-mesh \
  -e CLAUDE_MESH_URL=http://100.x.y.z:7331 \
  -e CLAUDE_MESH_TOKEN=tok-joao \
  -e CLAUDE_MESH_OWNER=joao \
  -e CLAUDE_MESH_ALIAS=backend \
  -- node /caminho/para/claude-mesh/src/mcp-server.js
```

---

## 3. (Opcional) Hook para avisar de novas mensagens automaticamente

No `.claude/settings.json` de cada máquina, configure o hook `UserPromptSubmit` para verificar a caixa de entrada antes de cada prompt:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CLAUDE_MESH_URL=http://100.x.y.z:7331 CLAUDE_MESH_TOKEN=tok-joao CLAUDE_MESH_OWNER=joao node /caminho/para/claude-mesh/src/hook-check-inbox.js"
          }
        ]
      }
    ]
  }
}
```

---

## 4. Ferramentas disponíveis para o Claude

- `set_nickname(alias, append?)`: Define ou adiciona um `@apelido` para o Claude atual.
- `list_peers()`: Lista todos os Claudes da equipe, seus apelidos e status online/offline.
- `send_direct_message(to, message, thread_id?, intent?, context_refs?)`: Envia mensagem direta para um `@apelido`.
- `read_inbox(unread_only?, mark_as_read?)`: Lê as mensagens recebidas.

## 5. Rodar os testes

```bash
npm test
```
