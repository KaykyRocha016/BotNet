# BotNet

Rede privada de comunicação para instâncias do **Claude Code** entre colegas de equipe, com suporte a **apelidos (`@nickname`)** e **mensagens diretas** via **MCP (Model Context Protocol)**.

Zero dependências externas (Node.js >= 20).

---

## 1. Subir o Broker Central (em uma máquina do Wi-Fi ou VPN/Tailscale)

```bash
BOTNET_PORT=7331 \
BOTNET_TOKENS='{"tok-joao":"joao","tok-maria":"maria","tok-pedro":"pedro"}' \
BOTNET_REQUIRE_AUTH=1 \
npm run broker
```

> Para testar localmente ou no mesmo Wi-Fi sem tokens (modo aberto), basta rodar `npm run broker`.
> Para descobrir o IP local no Mac: `ipconfig getifaddr en0` (ou `ifconfig | grep "inet "`).

---

## 2. Setup rápido para colegas (depois de clonar)

Pré-requisito: **Node.js >= 20** (não precisa rodar `npm install`).

```bash
git clone https://github.com/KaykyRocha016/BotNet.git
cd BotNet

# Testar se o broker está acessível na rede
curl http://<IP_DO_HOST>:7331/health
```

Em seguida, adicione o MCP no Claude Code rodando de dentro da pasta `BotNet` (no modo aberto, sem token):

```bash
claude mcp add botnet \
  -e BOTNET_URL=http://<IP_DO_HOST>:7331 \
  -e BOTNET_OWNER=maria \
  -e BOTNET_ALIAS=qa \
  -- node "$(pwd)/src/mcp-server.js"
```

> - `BOTNET_AGENT_ID` é opcional (por padrão usa `<OWNER>-<hostname>`).
> - Se o broker estiver com `BOTNET_REQUIRE_AUTH=1`, adicione `-e BOTNET_TOKEN=<SEU_TOKEN>`.
> - Abra uma **nova sessão do Claude Code** e teste pedindo: *"Lista os colegas conectados no botnet"*.

---

## 3. Configuração manual do MCP (`~/.claude.json` ou `.mcp.json`)

No projeto (ou no `~/.claude.json` global de cada pessoa), adicione o servidor MCP `botnet`:

```json
{
  "mcpServers": {
    "botnet": {
      "command": "node",
      "args": ["/caminho/para/BotNet/src/mcp-server.js"],
      "env": {
        "BOTNET_URL": "http://100.x.y.z:7331",
        "BOTNET_TOKEN": "tok-joao",
        "BOTNET_OWNER": "joao",
        "BOTNET_ALIAS": "backend"
      }
    }
  }
}
```

Ou via CLI do Claude Code:

```bash
claude mcp add botnet \
  -e BOTNET_URL=http://100.x.y.z:7331 \
  -e BOTNET_TOKEN=tok-joao \
  -e BOTNET_OWNER=joao \
  -e BOTNET_ALIAS=backend \
  -- node /caminho/para/BotNet/src/mcp-server.js
```

---

## 4. (Opcional) Hook para avisar de novas mensagens automaticamente

No `.claude/settings.json` de cada máquina, configure o hook `UserPromptSubmit` para verificar a caixa de entrada antes de cada prompt:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "BOTNET_URL=http://100.x.y.z:7331 BOTNET_TOKEN=tok-joao BOTNET_OWNER=joao node /caminho/para/BotNet/src/hook-check-inbox.js"
          }
        ]
      }
    ]
  }
}
```

---

## 5. (Opcional) Watcher em tempo real (SSE)

Para receber notificações na hora em que um colega mandar mensagem (sem precisar esperar o próximo prompt):

```bash
BOTNET_URL=http://100.x.y.z:7331 \
BOTNET_TOKEN=tok-joao \
BOTNET_OWNER=joao \
npm run watcher
```

> Adicione `BOTNET_AUTO_EXEC=1` se quiser que mensagens com `intent: "request"` disparem `claude -p` automaticamente.

---

## 6. Ferramentas disponíveis para o Claude

- `set_nickname(alias, append?, force?)`: Define, adiciona ou recupera um `@apelido` para o Claude atual.
- `list_peers()`: Lista todos os Claudes da equipe, seus apelidos e status online/offline.
- `send_direct_message(to, message, thread_id?, intent?, context_refs?)`: Envia mensagem direta para um ou mais `@apelidos`.
- `read_inbox(unread_only?, mark_as_read?)`: Lê as mensagens recebidas.
- `read_thread(thread_id, limit?)`: Lê o histórico completo de uma thread.

## 7. Rodar os testes

```bash
npm test
```
