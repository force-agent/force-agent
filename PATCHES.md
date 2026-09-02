# PATCHES.md — overlay do fork power-agent sobre o upstream

Este repo é um **fork overlay** de `anomalyco/opencode` (branch `beta`). A branch
`vendor` acompanha o upstream; `main` carrega o overlay. Toda divergência
intencional em relação ao upstream é registrada aqui, uma entrada por edição, com
a âncora que o merge vai encostar e a condição para remover o patch.

Regra do overlay: preferir **arquivo novo** a edição; quando editar, mirar em
1–5 linhas de arquivos que o upstream raramente toca.

---

## Feature 1 — Rebrand para `poweragent`

### 1.1 `packages/util/src/global.ts` — nome da aplicação nos diretórios XDG

- **Motivo:** os 4 diretórios XDG (data/cache/config/state) + tmp derivam de uma
  única constante. Trocá-la separa completamente o estado do fork do estado de um
  `opencode` instalado na mesma máquina.
- **Âncora:** `const app = "opencode"` → `const app = "poweragent"` (linha ~12),
  logo abaixo do `import { roots } from "#global-roots"`.
- **Efeito:** `~/.local/share/poweragent`, `~/.cache/poweragent`,
  `~/.config/poweragent`, `~/.local/state/poweragent`, `$TMPDIR/poweragent`.
- **Quando remover:** nunca, enquanto o fork tiver identidade própria.
- **Conflito esperado no merge:** baixo. Linha estável no upstream.

### 1.2 `packages/util/src/global.ts` — `CONFIG_DIR` via helper de env

- **Motivo:** honrar `POWER_CONFIG_DIR` sem perder `OPENCODE_CONFIG_DIR`.
- **Âncora:** `Effect.suspend(() => acquire({ config: ... ?? Path.config }))`
  (linha ~79) + `import { env } from "./env.js"`.
- **Quando remover:** junto com 1.4, se um dia as env vars forem renomeadas de vez.

### 1.3 `packages/cli/script/build.ts` — nome do binário

- **Motivo:** o artefato compilado e o nome do comando na ajuda vêm daqui.
- **Âncora:** `const binary = "opencode2"` → `"poweragent"` (linha 15).
- **Derivações que continuam coerentes sem edição extra** (todas leem `binary`):
  - `targetName()` → `poweragent-windows-x64`
  - `name = target.replace(binary, "cli")` → `cli-windows-x64` (dir de dist, inalterado)
  - `compile.target = target.replace(binary, "bun")` → `bun-windows-x64`
  - `compile.outfile` → `dist/cli-windows-x64/bin/poweragent[.exe]`
  - `execArgv --user-agent` → `poweragent/<version>`
  - `define OPENCODE_CLI_NAME` → `'poweragent'`, que alimenta
    `Spec.make(OPENCODE_CLI_NAME)` em `packages/cli/src/commands/commands.ts`
    (nome do comando raiz na ajuda) — **não precisa de patch lá**.
- **Deliberadamente NÃO alterado:** o `package.json` gerado por plataforma
  (`@opencode-ai/cli-<os>-<arch>`) e `packages/cli/script/publish.ts`. São
  identidade de publicação npm; publicar é proibido neste fork. Se algum dia
  publicar, alinhar `publish.ts` (`binary`, `packagePrefix`) com este arquivo.
- **Quando remover:** nunca.

### 1.4 `packages/util/src/env.ts` — **ARQUIVO NOVO**

- **Motivo:** existem ~77 env vars `OPENCODE_*` espalhadas por ~30 arquivos, sem
  módulo central. Renomear as 77 seria um merge eterno. Em vez disso, o helper lê
  o **sufixo** e resolve `POWER_<SUFIXO>` com fallback para `OPENCODE_<SUFIXO>`.
- **API:** `env(name)`, `names(name)` (ambas as grafias, branded primeiro),
  `truthy(name)`.
- **Aplicado apenas nas variáveis críticas de operação** — o resto do código
  continua lendo `process.env.OPENCODE_*` direto, de propósito.
- **Fallback duplo é obrigatório:** sem ele, um deploy que só exporta
  `OPENCODE_SERVER_PASSWORD` perderia a senha e o servidor subiria com credencial
  aleatória (clientes existentes deixam de autenticar).
- **Quando remover:** só quando `OPENCODE_*` deixar de ser suportado — o que exige
  aviso de breaking change.
- **Teste:** `packages/util/test/env.test.ts` (arquivo novo).

### 1.5 `packages/cli/src/env.ts` — senha do servidor

- **Motivo:** aplicar a cadeia branded→legacy à variável mais sensível do sistema.
- **Âncora:** `export const password = Config.redacted("OPENCODE_PASSWORD")...`
- **Mudança:** cadeia de 4 nomes, na ordem
  `POWER_PASSWORD` → `POWER_SERVER_PASSWORD` → `OPENCODE_PASSWORD` →
  `OPENCODE_SERVER_PASSWORD`, exportada também como `passwordKeys` para que os
  outros pontos removam/definam **todas** as grafias.
  `Env.session()` agora filtra as 4.
- **Quando remover:** junto com 1.4.
- **Conflito esperado:** médio — arquivo pequeno e recente no upstream.
- **Teste:** `packages/cli/test/password-fallback.test.ts` (**arquivo novo**) —
  resolve `Env.password` de verdade, um **subprocesso por caso**, com exatamente
  uma grafia no ambiente. `packages/cli/test/env.test.ts` só afirma a *lista* de
  chaves; não prova que a cadeia `Config.orElse` resolve. O subprocesso é
  obrigatório: o `ConfigProvider` default do Effect tira um snapshot do ambiente
  na primeira resolução, então mutar `process.env` entre asserções no mesmo
  processo devolve sempre o primeiro valor (verificado — a versão in-process do
  teste passava o 1º caso e falhava os outros 5 com o valor do 1º).

### 1.6 `packages/cli/src/server-process.ts` — CONFIG_DIR + limpeza da senha

- **Motivo:** (a) `CONFIG_DIR` em 2 pontos (layer do Global e config do servidor);
  (b) no modo `stdio` o upstream apaga só `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD`
  do ambiente herdado pelas tools — com `POWER_*` no jogo, apagar só as antigas
  vazaria a credencial de lease para todo processo filho.
- **Âncoras:** linha ~36 `Global.layerWith(...)`, linha ~70 `if (options.mode === "stdio")`,
  linha ~109 `directory: process.env.OPENCODE_CONFIG_DIR`.
- **Quando remover:** junto com 1.4.

### 1.7 `packages/cli/src/index.ts` — CONFIG_DIR

- **Âncora:** `Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? ... : {})` (~linha 104).
- **Quando remover:** junto com 1.4.

### 1.8 `packages/cli/src/services/standalone.ts` — credencial de lease do filho

- **Motivo:** o comentário do upstream diz "entrada explícita vence o que foi
  herdado, então um `OPENCODE_PASSWORD` exportado pelo usuário não pode sombrear a
  credencial de lease". Com `POWER_PASSWORD` tendo **precedência maior**, definir
  só `OPENCODE_PASSWORD` reintroduziria exatamente o bug que o comentário descarta:
  um `POWER_PASSWORD` herdado sombrearia o lease e o filho recusaria o pai.
- **Âncora:** `env: { OPENCODE_PASSWORD: password }` →
  `env: Object.fromEntries(Env.passwordKeys.map((key) => [key, password]))`.
- **Quando remover:** junto com 1.4.

### 1.9 `packages/cli/src/services/server-connection.ts` — texto de erro

- **Âncora:** `requires a password; set OPENCODE_PASSWORD` → `set POWER_PASSWORD`.
- **Motivo:** a mensagem instruía o usuário a exportar o nome legado.
- **Quando remover:** cosmético; junto com 1.4.

### 1.10 `packages/cli/src/services/updater.ts` — auto-update **desligado por padrão**

- **Motivo (segurança operacional):** o updater faz `fetch` em
  `https://update.opencode.ai/api/<channel>/cli/npm` e, se achar versão nova,
  executa `npm/pnpm/bun/yarn install --global @opencode-ai/cli@<versão>` ou baixa
  `https://opencode.ai/v2/install`. Num servidor rodando este fork, isso
  **substitui o binário do fork por um release do upstream** — perda silenciosa de
  todo o overlay, além de phone-home a cada start do TUI.
- **Âncora:** primeira linha do corpo de `const check = Effect.fn("cli.updater.check")`,
  imediatamente antes do teste `if (OPENCODE_LOCAL || ...DISABLE_AUTOUPDATE...)`.
- **Mudança:** `if (!truthy("ENABLE_AUTOUPDATE")) return log("skipped", { reason:
  "autoupdate-disabled-by-default" })`. O teste original de `DISABLE_AUTOUPDATE`
  foi mantido logo abaixo, agora lendo `POWER_DISABLE_AUTOUPDATE` /
  `OPENCODE_DISABLE_AUTOUPDATE` via helper.
- **Efeito:** nenhuma requisição de rede, nenhum spawn de gerenciador de pacote,
  nenhuma troca de binário — a menos que se exporte `POWER_ENABLE_AUTOUPDATE=1`.
- **⚠ Se optar por reativar:** o corpo do updater (URLs, `packageName`,
  detecção do binário em `~/.opencode/bin/opencode2`) **continua apontando para o
  upstream** — deliberadamente não patcheado, para manter o overlay pequeno.
  Reativar traz o binário do opencode, não o do power-agent.
- **Quando remover:** se o fork ganhar canal de release próprio; aí o patch vira
  reescrita do `latest()`/`upgrade()`, não mais um curto-circuito.
- **Teste:** `packages/cli/src/services/updater-gate.test.ts` (**arquivo novo**) —
  monta a layer real do updater com um `Logger` capturador e prova que, sem opt-in,
  `check()` sai com `reason=autoupdate-disabled-by-default` antes de qualquer
  leitura de config ou rede; com `POWER_ENABLE_AUTOUPDATE=1` **ou**
  `OPENCODE_ENABLE_AUTOUPDATE=true` o caminho original volta.

### 1.11 Infra de teste que codificava o nome do diretório da app

Consequência mecânica de 1.1 — sem isso a suíte quebra:

| Arquivo | Mudança |
| --- | --- |
| `packages/core/script/test.ts` | `OPENCODE_CONFIG_DIR: <home>/.config/opencode` → `POWER_CONFIG_DIR: <home>/.config/poweragent` |
| `packages/core/test/preload.test.ts` | asserts de `Global.Path.{config,data,cache,state}` e da env var |
| `packages/util/test/global.test.ts` | 9 literais `path.join(<xdg>, "opencode")` |
| `packages/cli/test/debug-paths.test.ts` | 8 literais |
| `packages/cli/test/service.test.ts` | 21 literais |
| `packages/cli/test/debug-config.test.ts` | 1 literal |
| `packages/cli/script/service-smoke.ts` | 2 literais de diretório + nome do binário compilado |
| `packages/cli/test/env.test.ts` | reescrito em cima de `Env.passwordKeys` |

`packages/util/test/global-roots.test.ts` **não** precisou de patch: passa
`roots("opencode")` explicitamente, não usa a constante.

---

## Feature 2 — Fail-closed

Contexto que **não** muda: o `SECURITY.md` do upstream diz que o agente não roda
em sandbox e que o sistema de permissões é UX, não isolamento. Nada aqui torna o
`shell` seguro. O que muda é **quem alcança a API** e **o que o modelo tenta
sozinho**.

### 2.1 `packages/server/src/in-process.ts` — **ARQUIVO NOVO**

- **Motivo:** o upstream tinha duas construções de rota, e a segunda
  (`createEmbeddedRoutes`) montava `ServerAuth.Config` com `Option.none()` — um
  grafo de rotas **sem autenticação nenhuma**. Pior: `createRoutes` caía nesse
  mesmo estado quando `options.password` era `undefined`, ou seja, *esquecer* de
  passar a senha produzia um servidor aberto, sem erro.
- **O que é:** um *token nominal* (`InProcess.Grant`, branded com
  `unique symbol` — não é boolean, não é campo de `ServerOptions`, não sai de
  decode de input do usuário). Quem quer o grafo in-process precisa importar este
  módulo e chamar `InProcess.grant()`.
- **Além do nominal:** o grant **cunha uma credencial aleatória de 32 bytes**. O
  caminho in-process passou a ser autenticado como qualquer outro; o dono do
  handler carimba `InProcess.authorize(request, grant)` antes de entregar ao
  router. Resultado: `Option.none()` **não existe mais em lugar nenhum**.
- **Quando remover:** nunca, enquanto o SDK embutir o servidor.
- **Teste:** coberto de ponta a ponta por `packages/sdk` (26 pass) e por
  `packages/server/test/fetch.test.ts`.

### 2.2 `packages/server/src/routes.ts` — senha obrigatória

- **Âncora:** corpo de `createRoutes` / `createEmbeddedRoutes` (linhas ~74–91 no
  upstream), substituídos por um helper `authLayer(password)`.
- **Mudança:** sem senha, a layer **morre** (`Effect.die`) com mensagem explícita
  em vez de construir rotas abertas. `createEmbeddedRoutes` agora exige o grant
  como **primeiro parâmetro** — a assinatura mudou de propósito, para que um
  chamador antigo não compile.
- **`Effect.die` e não `Effect.fail`:** manter o canal de erro da layer em `never`
  evita propagar um erro tipado novo para os 5 chamadores (`process.ts`,
  `fetch.ts`, `workerd.ts`, SDK host, testes). É defeito de programação, não
  condição de runtime.
- **Conflito esperado no merge:** médio-alto. É o arquivo central do servidor,
  mas o bloco tocado são 18 linhas contíguas no topo.

### 2.3 `packages/server/src/auth.ts` — remoção do `static get layer()`

- **Motivo:** era o atalho que devolvia `{ password: Option.none() }`. Enquanto
  existir, alguém volta a usá-lo.
- **Âncora:** 4 linhas dentro de `class Config`.
- **Nota:** `ServerAuth.required()` e o `authorizationLayer` ainda tratam
  `Option.none()`/senha vazia (curto-circuitam a autenticação). Ficaram como
  estão — são código do upstream que agora é inalcançável pelo grafo de rotas.
  Não deletei porque não é meu escopo; registrado aqui como código morto.

### 2.4 `packages/server/src/fetch.ts` — `BootOptions.grant`

- **Motivo:** `ServerFetch.make` é o construtor de handler usado tanto pelo
  workerd (que **é** rede) quanto por testes/embedders. O grant separa os dois:
  workerd não cunha nenhum, logo `ServerWorkerd.create({ ... })` sem `password`
  agora morre em vez de servir aberto.
- **Âncora:** interface `BootOptions` + corpo de `make` (3 pontos).

### 2.5 `packages/sdk/src/internal/host.ts` — grant + carimbo

- **Âncora:** `createEmbeddedRoutes(` (ganha `grant` como 1º arg) e a construção
  do `handler` antes de `OwnedFetch.make`.
- **Efeito:** transparente para o consumidor do SDK; o `fetch` devolvido continua
  funcionando sem que ninguém veja a credencial.

### 2.6 `packages/server/src/bind-policy.ts` — **ARQUIVO NOVO**

- **Motivo:** nada impedia `serve --hostname 0.0.0.0` com a senha aleatória
  gerada no boot — que é impressa no terminal e serve para *um* cliente local,
  não como controle de acesso de uma interface roteável.
- **API:** `scope(hostname)` → `loopback | wildcard | routable`;
  `check(input)` → `RefusedError | undefined`; `assert(input)` → Effect que
  **falha** (nunca warning).
- **Política implementada:**

  | escopo | `configured` | `ephemeral` | `none` |
  | --- | --- | --- | --- |
  | loopback | ok | ok | **só com a variável de escape** |
  | wildcard / routable | ok | **recusa** | **recusa** |

- **Variável de escape:** `POWER_ALLOW_UNAUTHENTICATED_LOOPBACK`
  (`OPENCODE_*` também aceito pelo helper). **Só** vale para loopback — está
  testado que ela não destranca `0.0.0.0` nem um IP de LAN, inclusive quando
  forçada via parâmetro.
- **Leitura do briefing que adotei:** "recusa não-loopback sem credencial
  configurada" + "escape explícito só para loopback" só são coerentes juntos se o
  escape servir para o caso *sem credencial alguma*, que é o único que loopback
  ainda recusaria. Manter loopback+ephemeral aberto por padrão preserva o UX de
  `serve` (que imprime `server password <aleatória>`); exigir o escape ali
  quebraria o comando padrão sem ganho.
- **Teste:** `packages/server/test/bind-policy.test.ts` (**arquivo novo**, 5 casos).

### 2.7 Ligação da política — `serve.ts` + `server-process.ts`

- `packages/cli/src/commands/handlers/serve.ts` (**arquivo do briefing**): checa o
  `--hostname` que o operador digitou, antes de qualquer trabalho.
- `packages/cli/src/server-process.ts`: a checagem **autoritativa**, depois que
  flag e config do serviço já decidiram hostname e senha. É o único ponto onde
  `hostname` e a origem da credencial coexistem.
  - Refactor mínimo junto: `password` foi dividido em `supplied` (env var ou
    config do serviço) e o fallback aleatório, porque a política precisa saber
    **de onde veio** a credencial, não só que existe. O `if (!password) fail`
    original virou código morto com o `??` e foi removido.
- **Conflito esperado:** médio em `server-process.ts` (arquivo já tocado por 1.6).

### 2.8 `packages/server/src/cors.ts` — allowlist mínima

- **Motivo (o que realmente está em jogo):** os handlers de PTY
  (`handlers/pty.ts`, `handlers/persistent-pty.ts`) emitem *connect tickets* e são
  **isentos de Basic auth** — um browser não consegue mandar header em upgrade de
  WebSocket. Quem protege a emissão do ticket é `isAllowedRequestOrigin`. Logo, a
  lista de origens **é** o controle de acesso desse caminho.
- **Removido:** o regex de `opencode.ai`, `oc://renderer` e as 3 origens tauri
  (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`).
- **Mantido:** same-host (`isAllowedRequestOrigin`), a lista explícita
  `opts.cors`, e localhost/127.0.0.1/[::1] **apenas** sob `POWER_DEV_CORS=1`.
- **Quebra deliberada:** o app Electron (`packages/desktop`) carrega o renderer
  por `oc://` e passa a ser bloqueado. Rebranding/reautorização do desktop é
  feature separada; se for preciso destravar antes disso, o caminho honesto é
  popular `CorsConfig` (ver dívida abaixo), não reabrir o regex.
- **Teste:** `packages/server/test/cors.test.ts` (**arquivo novo**, 5 casos).
#### 2.8.1 ⚠️ Conflito add/add recorrente com o upstream — NÃO resolver restaurando a concessão

O upstream criou **o próprio** `packages/server/test/cors.test.ts` (visto em
`upstream/beta`, 24 linhas, 2 casos). Como nós também criamos um arquivo com esse
nome, todo sync produz um **conflito add/add** neste caminho. Isso vai se repetir
em *todos* os merges até alguém reconciliar — não é ruído de uma vez só.

O perigo não é o conflito, é a resolução. O teste deles afirma exatamente o que
esta seção removeu de propósito:

```js
expect(isAllowedCorsOrigin("https://app.opencode.ai", options)).toBe(true)
expect(isAllowedCorsOrigin("http://localhost:3001", options)).toBe(true)
```

Quem resolver o conflito pegando a versão do upstream verá o teste falhar contra
o nosso `cors.ts` e a "correção" óbvia é reabrir o regex de `opencode.ai` e o
localhost incondicional. Isso **desfaz silenciosamente o controle de acesso da
emissão de tickets de PTY** descrito em 2.8 — uma regressão de segurança que
passa como conserto de teste.

**Como resolver, sempre:**

1. Fique com a **nossa** versão do arquivo (`git checkout --ours`).
2. Leia o arquivo deles (`git show upstream/beta:packages/server/test/cors.test.ts`)
   e porte apenas os casos que exercitam comportamento que **nós mantivemos** —
   same-host, `opts.cors` explícito, rejeição de sufixo (`example.com.evil.test`),
   `"null"` como origem.
3. **Nunca** porte uma asserção que espere `true` para `*.opencode.ai`,
   `oc://renderer`, origem tauri, ou localhost sem `POWER_DEV_CORS=1`.
4. Se o upstream passar a depender dessas origens para uma feature nova, o
   caminho honesto continua sendo popular `CorsConfig` — não reabrir o regex.

**Não "resolva" renomeando o nosso arquivo.** Renomear (ex.: para
`cors-allowlist.test.ts`) faz o add/add sumir — e é por isso que é a opção
errada. Sem o conflito, o arquivo deles entra limpo no merge e só quebra depois,
na execução dos testes, quando o contexto do porquê já se perdeu. O conflito
add/add é o que **força a decisão no momento do merge, com as duas versões à
vista**. Ele é a proteção, não o problema.

**Remover este patch quando:** o upstream tornar a allowlist de origens
configurável por padrão (aí a divergência deixa de existir e os dois testes
podem convergir).
#### 2.8.2 Os outros dois conflitos do sync — mesma armadilha

Auditei os três conflitos que `git merge-tree main upstream/beta` produz hoje
(drift de 82 commits). Os outros dois carregam a **mesma classe de risco** que
2.8.1: a resolução ingênua desfaz uma proteção e parece conserto de teste.

**`packages/server/test/fetch.test.ts`** — nós +33/−16, eles **+205/−18**.
A assimetria é a armadilha: é tentador pegar a versão deles inteira. Não pegue.
Nós **renomeamos** um teste deles:

| | nome do teste |
|---|---|
| upstream | `serves unauthenticated and answers CORS preflight when no password is configured` |
| nosso | `authenticates an in-process grant and refuses an unconfigured CORS origin` |

O nome deles afirma que **o servidor sem autenticação existe**. Nós eliminamos
esse caminho (2.2 / `in-process.ts`), então a versão deles falha — e o conserto
"óbvio" é reabrir o grafo não autenticado, que é o núcleo do fail-closed.
Nosso teste também é o único lugar que afirma que `opencode.ai`,
`oc://renderer`, `tauri://localhost` e localhost puro recebem **nenhum** header
de CORS, e que `POWER_DEV_CORS=1` é o que libera localhost.
**Resolução:** manter as nossas asserções e portar por cima os casos novos deles
que não dependam de servidor sem senha nem das origens removidas.

**`packages/cli/src/server-process.ts`** — nós +63/−27, eles **+2/−0**.
As 2 linhas deles são bem-vindas e vale portá-las:

```ts
readonly cors?: readonly string[]      // em Options
cors: options.cors ?? config.cors,     // repassado ao servidor
```

O upstream está tornando a allowlist de origens **configurável por config** —
que é exatamente a condição de saída registrada em 2.8 e valida o desenho:
o operador popula `CorsConfig` em vez de nós reabrirmos o regex.

O cuidado é onde o hunk cai: **imediatamente acima do bloco de senha** que
reescrevemos (`Env.configuredPassword`, `Env.passwordKeys` sendo apagadas do
ambiente, `ServerAuth.usable(configured)`, `randomBytes(32)`). Resolver com
pressa nessa região é como se perde o fail-closed.
**Resolução:** aceitar as 2 linhas de `cors` deles, preservar o bloco de senha
nosso linha por linha, e rodar `packages/cli/test/credential-env.test.ts` e
`packages/server/test/blank-password.test.ts` antes de dar o merge por bom.

**Ordem sugerida do sync:** `server-process.ts` primeiro (o menor e o que traz
feature), depois `fetch.test.ts`, e `cors.test.ts` por último — quando as duas
decisões anteriores já deixaram claro qual lado da divergência de CORS vale.



### 2.9 `packages/core/src/plugin/remote.ts` — **ARQUIVO NOVO** (preset `remote`)

- **Formato real (lido do código, não do plano):** regras são
  `{ action, resource, effect }` com `effect` em `allow|ask|deny`
  (`packages/schema/src/permission.ts`). `Permission.evaluate` usa **`findLast`**
  — a última regra que casa vence — e o default quando nada casa é **`ask`**
  (`packages/core/src/permission.ts:85`). `deny` tem precedência dura: se
  qualquer recurso do pedido resolver `deny`, o pedido inteiro é negado antes de
  qualquer merge com regras salvas.
- **Registro:** `packages/core/src/plugin/internal.ts`, array `pre`, logo após
  `PlanPlugin.Plugin` (import + 1 linha).
- **Regras, na ordem:** `*` → ask (neutraliza o `*` → allow que
  `Agent.Info.default` semeia), depois `read`/`grep`/`glob`/`question` → allow,
  os 3 casos de `.env`, e por fim `edit`/`webfetch`/`shell` → ask e
  `external_directory` → deny.
- **`shell`, não `bash`:** a tool de shell afirma a permissão com o próprio nome,
  `"shell"` (`packages/core/src/tool/plugin/shell.ts:18` + `:213`). `"bash"` é a
  grafia v1 que `v1/config/migrate.ts:113` reescreve para `shell`. Usar `"bash"`
  seria uma regra que nunca casa.
- **Teste:** `packages/core/test/plugin/remote.test.ts` (**arquivo novo**).

---

## Dívida conhecida da Feature 2

- **`CorsConfig` nunca é populado.** `packages/server/src/cors.ts` exporta
  `CorsConfig` (um `Context.Reference` com default `undefined`) e ambos os
  handlers de PTY o consomem, mas **nenhuma layer o fornece** e `ServerOptions`
  não tem campo `cors`. Ou seja, o ramo `opts.cors` é inalcançável hoje — no
  upstream também. Não inventei o campo porque não estava no escopo; se o desktop
  precisar voltar, é aqui que se liga.
- **`ServerAuth.required()` e o curto-circuito do `authorizationLayer`** para
  senha ausente/vazia continuam no código, agora inalcançáveis pelo grafo de
  rotas. Código morto adjacente, não deletado.
- **`serve.ts` e `server-process.ts` checam a política duas vezes.** É
  deliberado (mensagem no flag + verdade depois da config), mas são dois pontos
  que precisam concordar sobre "o que conta como credencial configurada".

---

## Fora de escopo, deliberadamente (dívida conhecida)

Registrado aqui para não ser redescoberto como bug:

- **`packages/app`, `packages/desktop`** — o produto Electron/web ainda usa
  `opencode` como nome de diretório (`packages/desktop/src/main/native/logging.ts`
  monta `<xdgData>/opencode/log`, `service/background-service.ts` usa
  `userData/opencode`), protocolo `opencode://` e o binário `opencode2`. Nada disso
  entra no build do CLI single-binary. Rebrand do desktop é feature separada.
- **Nome do arquivo de log:** `packages/util/src/observability/logging.ts` continua
  escrevendo `opencode.log` (dentro de `<data>/poweragent/log/`).
- **Branding visual** (logo, favicon, título, `packages/tui/src/util/presentation.ts`
  que imprime `opencode2 -s <id>`) — explicitamente adiado.
- **`packages/codemode/src/interpreter/`** — proibido tocar (constantes não
  contratuais do upstream).
- **`models.dev` / catálogo de modelos** — intacto de propósito. É catálogo neutro,
  tem snapshot embutido, e `OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH` /
  `OPENCODE_DISABLE_MODELS_FETCH` continuam com os nomes originais.
- **`OPENCODE_SERVER_HOST` / `OPENCODE_SERVER_PORT`** — **não existem** neste
  código como variáveis de runtime. Só existem `VITE_OPENCODE_SERVER_HOST/PORT`
  (build-time do SPA) e `PLAYWRIGHT_SERVER_HOST/PORT` (e2e). Host e porta do
  servidor vêm de `--hostname`/`--port` ou do arquivo de config do serviço. Nenhuma
  env var nova foi inventada.

---

## Verificação desta feature

```
bunx tsgo --noEmit                       # em packages/{util,cli}          → EXIT 0
bunx tsgo -b tsconfig.json tsconfig.tests.json  # em packages/core          → EXIT 0
bun test test/env.test.ts                # packages/util                    → 5 pass
bun test test/env.test.ts src/services/updater.test.ts  # packages/cli      → 14 pass
bun test src/services/updater-gate.test.ts      # packages/cli              → 3 pass
bun run packages/cli/script/build.ts --single                               → EXIT 0
packages/cli/dist/cli-windows-x64/bin/poweragent.exe --version
```

Verificado no binário compilado:

- `--version` → `poweragent v0.0.0-main-202608290409`
- `--help` → `USAGE poweragent <subcommand> ...`
- `debug paths` → os 9 caminhos sob `poweragent`
- `debug paths` com `OPENCODE_CONFIG_DIR` (legado) → honrado;
  com `POWER_CONFIG_DIR` junto → o branded vence
- `serve --port <p>` + `curl -u opencode:<senha> /api/health`:
  `OPENCODE_SERVER_PASSWORD=s3cr3t` → 200 (fallback vivo),
  `POWER_PASSWORD=s3cr3t` → 200,
  sem nenhuma das duas → 401 com senha aleatória (fail-closed preservado)

Falhas **pré-existentes** neste ambiente, não introduzidas pelo overlay:

- `bun run typecheck` (raiz) falha em `@opencode-ai/app` /
  `@opencode-ai/desktop`: `packages/app/src/custom-elements.d.ts` está no git como
  symlink (modo `120000`) e o checkout no Windows materializou o caminho como
  texto. `tsgo` lê `../../ui/src/custom-elements.d.ts` como código-fonte.
- `packages/util/test/global.test.ts` › "building a layer with default tmp creates
  and canonicalizes it" falha no Windows porque `os.tmpdir()` ignora `TMPDIR`
  (usa `TMP`/`TEMP`). Reproduzido idêntico no arquivo original antes do patch.

## Verificação da Feature 2

```
tsgo -b   em packages/{server,core,cli,sdk}                          -> EXIT 0
bun test                       packages/server  -> 47 pass, 0 fail
bun test                       packages/sdk     -> 26 pass, 0 fail
bun run script/test.ts test/plugin test/config test/preload test/agent
                               packages/core    -> 460 pass, 6 fail (pré-existentes)
bun run packages/cli/script/build.ts --single                        -> EXIT 0
```

No binário compilado (`poweragent v0.0.0-main-202608290500`):

- `serve --hostname 0.0.0.0 --port N` sem senha no ambiente → **EXIT 1**,
  `BindPolicy.RefusedError: Refusing to bind every interface (0.0.0.0) with a
  credential generated at startup...`
- `POWER_PASSWORD=... serve --hostname 0.0.0.0 --port N` → `server listening on
  http://0.0.0.0:N`
- `serve --port N` sem senha → loopback, `server password <aleatória>` (UX padrão
  preservado)
- `GET /api/health` sem credencial → **401**; com `-u opencode:s3cr3t` → **200**
- `OPTIONS /api/health` com `Origin: https://opencode.ai` → 204 **sem**
  `access-control-allow-origin` (o browser bloqueia)

Falhas **pré-existentes** neste ambiente, confirmadas com o overlay revertido:

- `packages/core`: 6 testes em `test/config/config.test.ts` e
  `test/config/plugin.test.ts` — a descoberta de config sobe até o `.claude` real
  da máquina e encontra uma entrada a mais do que o fixture espera. Idênticos
  antes e depois do overlay.
- `packages/cli`: `test/standalone.test.ts` › "standalone server exits when its
  owner is killed" estoura o timeout de 5000ms do bun (o teste tem race interno de
  10s). Reproduzido idêntico com `src/server-process.ts` e
  `src/commands/handlers/serve.ts` revertidos.
- `bun run typecheck` na raiz continua falhando em `@opencode-ai/app`
  (`custom-elements.d.ts` symlink materializado como texto no Windows) — mesma
  causa registrada na Feature 1.

---

## Feature 3 — Web servida e endurecida

### 3.0 Achado: a rota do SPA **já estava** dentro da autorização

Não houve furo para corrigir. Documentando o caminho exato, porque não é óbvio e
é fácil de quebrar sem quebrar teste nenhum:

1. O SPA **não é uma rota do `HttpApi`**. É o `transform` que o CLI passa para
   `ServerProcess.start` — `packages/cli/src/server-process.ts:87`
   (`const transform = yield* WebUi.handler()`), implementado em
   `packages/cli/src/services/web-ui.ts`. Ele intercepta `RouteNotFound` do
   router e responde `index.html` (ou o asset pedido), devolvendo 404 seco para
   qualquer coisa sob `/api/`.
2. Em `packages/server/src/process.ts:115` o transform embrulha **a aplicação
   interna** (`Ref.set(application, transform(app))`), não o efeito servido.
3. O efeito servido é `dispatch()` (`process.ts:169-194`), que checa a credencial
   em **toda** requisição (linhas 186-190) antes de chegar em `app.value`. As
   duas únicas isenções são as URLs de ticket de PTY, e ambas casam
   `^/api/(experimental/persistent-)?pty/[^/]+/connect$` — que o transform
   devolve como 404 sem tocar em asset nenhum.

Ou seja: shell do app, `index.html`, `/_assets/*` e o fallback de rota do SPA
saem todos 401 sem credencial, com `www-authenticate: Basic realm="Secure Area"`
(o header que faz o browser abrir o prompt e tornar a UI utilizável).

**Verificado no binário** (`poweragent web --port 8477`):
`GET /` anônimo → 401; `GET /_assets/...` anônimo → 401;
`curl -u opencode:<senha> /` → 200 com o `<!doctype html>` real do SPA.

### 3.1 `packages/server/test/web-ui-auth.test.ts` — **ARQUIVO NOVO**

- **Motivo:** o item 3.0 é uma invariante de *ordenação*, não de tipo. Mover o
  transform para fora do `dispatch` (embrulhar o efeito servido em vez do `Ref`
  da aplicação) entrega o shell do app para visitante anônimo e **não quebra
  nenhum outro teste do repo**. Este teste prende a ordem.
- **Cobre:** 401 + `www-authenticate` em `/`, `/index.html`, `/_assets/app.js` e
  no fallback de rota do SPA; 200 com Basic correto; 200 via `?auth_token=`;
  401 com senha errada.
- **Quando remover:** nunca.
- **Conflito esperado no merge:** nenhum (arquivo novo).

### 3.2 `packages/cli/src/services/web-access.ts` — **ARQUIVO NOVO**

- **Motivo:** `serve` imprime uma linha de listen feita para quem vai apontar um
  cliente. Quem abre um browser precisa de outra coisa: a UI embutida está atrás
  da mesma credencial Basic do `/api`, então **URL sozinha é beco sem saída**.
- **O que faz:** `WebAccess.urls()` resolve um bind wildcard para endereços que
  dá para digitar num browser (loopback + interfaces roteáveis, via
  `ServerInfo.connectionURLs` e `BindPolicy.scope`); `WebAccess.render()` monta o
  bloco impresso — URLs, usuário, senha, a menção explícita ao HTTP Basic, e a
  forma `?auth_token=<base64>` para cliente que não mostra prompt.
- **Avisa quando é o caso:** senha efêmera ("muda a cada restart, fixe com
  `POWER_PASSWORD`") e bind alcançável em HTTP puro ("a credencial atravessa a
  rede em claro, ponha atrás de TLS").
- **Conflito esperado no merge:** nenhum (arquivo novo).
- **Teste:** `packages/cli/test/web-access.test.ts` (5 casos).

### 3.3 `packages/cli/src/server-process.ts` — opção `announce`

- **Motivo:** o endereço só existe depois que o socket sobe, e o único gancho de
  `onListen` está reservado para o modo `service`. Em vez de duplicar o boot
  inteiro num handler novo, `Options` ganhou `announce?: "server" | "web"`.
- **Âncora:** o bloco `const url = HttpServer.formatAddress(server.address)` /
  `console.log(... server listening on ...)` (linha ~167 no upstream). O `else`
  preserva **byte a byte** o comportamento antigo — `serve`, `service` e `stdio`
  imprimem exatamente o que imprimiam.
- **Quando remover:** se o upstream ganhar um `web` próprio.
- **Conflito esperado no merge:** médio-baixo. Bloco pequeno, mas
  `server-process.ts` é tocado com alguma frequência.

### 3.4 `packages/cli/src/commands/handlers/web.ts` — **ARQUIVO NOVO**

- **Motivo:** o comando em si. Faz a mesma recusa antecipada de bind que
  `serve.ts` (falhar na flag que o operador digitou, não depois do boot), depois
  chama `ServerProcess.run({ mode: "default", announce: "web" })`. A checagem
  autoritativa continua sendo a do `ServerProcess`, que enxerga o config de
  serviço.
- **Conflito esperado no merge:** nenhum (arquivo novo).

### 3.5 `packages/cli/src/commands/commands.ts` + `src/index.ts` — registro

- **Âncora:** `Spec.make("web", ...)` logo depois do `Spec.make("serve", ...)`;
  `web: () => import("./commands/handlers/web")` logo depois de `serve:` no mapa
  de handlers.
- **Conflito esperado no merge:** baixo (adições no fim de listas).

### 3.6 `packages/app/src/composer/attachments/attachments.ts` — `crypto.subtle`

- **Motivo:** `blobReference()` chamava `crypto.subtle.digest` sem guarda.
  `crypto.subtle` é **undefined** fora de secure context — exatamente o que
  `web --hostname 0.0.0.0` produz (HTTP puro num IP de LAN). Anexar qualquer
  arquivo pelo browser estouraria `TypeError`.
- **Correção:** mesma guarda que o próprio repo já usa em
  `src/runtime/persistence/drafts.ts:25` (`blobID`) — cai para
  `crypto.getRandomValues` quando `subtle` não existe. O id só precisa ser
  estável dentro da sessão.
- **Conflito esperado no merge:** baixo (5 linhas numa função isolada).

### 3.7 Auditoria de `packages/app` — o que **não** foi mexido

O `Platform` (`src/runtime/platform/platform.tsx`) já é uma união discriminada:
`openDirectoryPickerDialog` só existe no ramo `platform: "desktop"`, e todo o
resto do que é desktop-only é opcional no tipo. Varri os 30+ call sites — todos
guardados (`?.`, early-return em `!platform.X`, ou narrowing
`platform.platform === "desktop"`). O seletor de diretório
(`src/workspaces/selection/picker.tsx:23`) cai no `DirectoryPickerDialog`
servido pelo servidor quando não é desktop. **Nada quebrado aqui.**

O que sobra são APIs de **secure context**, não de desktop — mesmo bug de classe
do 3.6, mas em fluxos secundários, deixados como dívida:

- `src/session/commands/use-session-commands.tsx:127,147` — `navigator.clipboard.writeText`
  como fallback de `platform.writeClipboardText`. Em origem insegura
  `navigator.clipboard` é `undefined` e o handler estoura `TypeError`.
- `src/session/files/open-in-app.tsx:205` — `navigator.clipboard.writeText` numa
  cadeia `.then().catch()`; o throw é síncrono, o `.catch` não pega.
- `packages/ui/src/components/text-field.tsx:73` — mesma coisa, fora de
  `packages/app`.

Não consertei porque cada um precisa de decisão de UX (falhar silencioso com
`?.` é pior do que estourar), e o briefing pedia conserto só do trivial.

### 3.8 Achado: `OPENCODE_DISABLE_EMBEDDED_WEB_UI` é uma flag morta

`packages/desktop/src/main/lifecycle/environment.ts:33` **escreve**
`process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"`, e um grep no repo
inteiro (fora de `node_modules`) devolve **essa única ocorrência**. Ninguém lê.
`WebUi.handler()` é montado incondicionalmente em `server-process.ts`. Deixado
como está — honrar a flag mudaria o comportamento do desktop, que está fora do
escopo desta feature.

## Verificação da Feature 3

```
tsgo --noEmit   packages/cli                                         -> EXIT 0
tsgo -b         packages/server                                      -> EXIT 0
tsgo -b         packages/app  (com o symlink materializado à mão)    -> EXIT 0
bun test        packages/server   -> 50 pass, 3 skip, 0 fail
bun test        packages/cli      -> 236 pass, 2 fail (pré-existentes)
bun run packages/cli/script/build.ts --single                        -> EXIT 0
```

No binário compilado (`poweragent v0.0.0-main-202608290521`):

- `web --help` → descrição e as duas flags
- `web --port 8477` → bloco de acesso com URL, usuário, senha e o aviso de senha
  efêmera; `GET /` anônimo **401**, `-u opencode:<senha>` **200** com o
  `<!doctype html>` do SPA, `/api/health` autenticado **200**
- `web --hostname 0.0.0.0` **sem** senha → **EXIT 1**, `BindPolicy.RefusedError`
  (a política da Feature 2 vale igual para `web`)
- `web --hostname 192.168.68.62` sem senha → **EXIT 1**, mesma recusa
- `POWER_PASSWORD=... web --hostname 0.0.0.0 --port 8480` → lista 127.0.0.1 mais
  as 4 interfaces roteáveis e imprime o aviso de HTTP em claro; da LAN:
  `GET /` anônimo **401**, `-u opencode:<senha>` **200**, `?auth_token=` **200**

Falhas **pré-existentes** neste ambiente, confirmadas com o overlay revertido:

- `packages/cli/test/standalone.test.ts` — mesmo timeout já registrado na
  Feature 2. Reproduzido com `server-process.ts`, `commands.ts` e `index.ts`
  revertidos via `git stash`: falha idêntica.
- `packages/cli/test/debug-paths.test.ts` — estoura os 5000ms só quando roda
  junto com a suíte inteira; isolado passa (2 pass).
- `bun run typecheck` na raiz continua falhando em `@opencode-ai/app` e
  `@opencode-ai/desktop` pelo symlink `custom-elements.d.ts` (Feature 1).
- Bind: neste shell as portas da faixa ~45000-49999 recusam bind (`EADDRINUSE`
  mesmo estando livres, e o mesmo acontece com `serve`); a verificação usou
  8477-8480.


## Feature 4 — Fan-out de subagents em Code Mode (`agent.spawn`)

### 4.1 `packages/core/src/tool/plugin/agent.ts` — **ARQUIVO NOVO**

- **Motivo:** a tool `subagent` do upstream é registrada com `codemode: false`, então
  um programa de Code Mode não consegue abrir filhos. Este arquivo registra a face
  Code Mode (`tools.agent.spawn/wait/list/stop`) e **delega** ao `subagent` já
  registrado — permissão, profundidade, job e notificação continuam sendo do upstream.
- **Colisão com o upstream:** nenhuma. Arquivo novo, sob `tool/plugin/`.
- **Remover quando:** o upstream expuser subagents em Code Mode por conta própria.

### 4.2 `packages/core/src/plugin/internal.ts` — registro do plugin

- **Âncora:** `import { AgentTool } from "../tool/plugin/agent.js"` (linha ~71) e
  `AgentTool.Plugin,` na lista de plugins internos (linha ~263). Duas linhas.

### 4.3 `POWER_AGENT_CONCURRENCY` / `POWER_AGENT_SPAWN_LIMIT` — grafia do overlay

Duas variáveis de ambiente governam o orçamento do fan-out. Ambas passam pelo
helper `env()` de `packages/util/src/env.ts`, ou seja: lê-se `POWER_<NOME>` e,
quando ausente, cai para `OPENCODE_<NOME>`.

| Variável | Default | O que limita |
| --- | --- | --- |
| `POWER_AGENT_CONCURRENCY` (fallback `OPENCODE_AGENT_CONCURRENCY`) | `8` | Filhos **em execução** ao mesmo tempo, por processo. Um semáforo só para o servidor inteiro. |
| `POWER_AGENT_SPAWN_LIMIT` (fallback `OPENCODE_AGENT_SPAWN_LIMIT`) | `1000` | Teto de `spawn` por **execução** de Code Mode (ledger por `context.id`). O spawn excedente falha com mensagem explícita. |

Valor não numérico ou `<= 0` cai no default, sem erro.

- **Correção (battle test, achado alto):** a versão inicial lia
  `process.env["OPENCODE_AGENT_CONCURRENCY"]` cru, sem o helper. O operador que
  seguia a convenção documentada do overlay exportava `POWER_AGENT_CONCURRENCY=2`
  e recebia o default `8`, **em silêncio**. Agora `positiveEnv` recebe o sufixo
  (`"AGENT_CONCURRENCY"`) e chama `env()`. A mensagem do teto de spawn também
  passou a citar `POWER_AGENT_SPAWN_LIMIT`.
- **Regressão coberta por:** `packages/core/test/tool-agent-concurrency.test.ts`
  — "POWER_AGENT_CONCURRENCY alone caps the fan-out" e
  "POWER_AGENT_SPAWN_LIMIT alone caps the per-execution ledger". Os dois testes
  **apagam** a grafia `OPENCODE_` do `process.env` antes de construir o plugin,
  então só passam se `POWER_` sozinho for honrado.

### 4.4 `background: true` também passa pelo semáforo

- **Achado (battle test, alto):** o fim do `execute` de `spawn` era
  `if (input.background === true) return yield* delegate(...)` — o ramo background
  não encostava em `permits`. Medido com `OPENCODE_AGENT_CONCURRENCY=2`: pico de
  **8** filhos simultâneos. Como o teto por execução é 1000, uma única execução
  podia colocar 1000 filhos para rodar de uma vez.
- **Desenho da correção:** segurar um permit até o filho terminar está errado para
  background — o `spawn` precisa retornar o handle já. O permit passou a governar a
  **execução do filho**, não a chamada do pai:

  ```ts
  Effect.acquireUseRelease(
    permits.take(1),                       // antes de o filho começar a rodar
    () => delegate(delegated, context),    // inicia o job e devolve o handle
    (_, exit) =>
      Exit.isSuccess(exit)
        ? runtime.job.wait({ id: exit.value.sessionID }).pipe(
            Effect.ensuring(permits.release(1)),
            Effect.forkIn(scope, { startImmediately: true }),  // fiber-vigia
          )
        : permits.release(1),
  )
  ```

  `delegate` já inicia o job antes de retornar, então o permit é tomado **antes**
  do filho poder rodar e entregue a um fiber-vigia que o devolve quando o job
  assenta. O `spawn` retorna o handle sem esperar o filho; quem espera é o vigia.
  O ramo bloqueante segue com `permits.withPermit`.
- **Consequência aceita:** com o cap saturado, o `spawn` em background fica
  pendurado em `permits.take(1)` até abrir vaga. É backpressure real e é a única
  forma de impedir o filho de começar — o alternativo (retornar antes do permit)
  criaria corrida entre `agent.wait` e o job que ainda não existe.
- **`scope`:** `const scope = yield* Scope.Scope` no init do plugin, mesmo padrão
  que `SubagentTool` usa para o `notifyWhenDone`. O vigia precisa sobreviver ao
  fim da execução da tool que tomou o permit.
- **Regressão coberta por:** `packages/core/test/tool-agent-concurrency.test.ts`
  — "background spawns respect the concurrency cap while still returning handles"
  (6 filhos em background, cap 2, exige `peak === 2`, `running === 6` e as 6
  respostas coletadas via `agent.wait`).

## Verificação da Feature 4

```
tsgo -b  packages/core (src + tests)                             -> EXIT 0
bun test packages/core/test/tool-agent-concurrency.test.ts       -> 6 pass, 0 fail
bun test packages/core/test/tool-agent.test.ts                   -> 5 pass, 0 fail
bun test packages/core/test/tool-subagent.test.ts                -> 9 pass, 0 fail
bun test packages/core/test/zz-battle-concurrency.test.ts        -> 2 pass, 0 fail
```

Sondas de concorrência (cap = 2), antes -> depois:

```
BACKGROUND probe: started=8 peak=8  ->  started=8 peak=2
BLOCKING   probe: started=8 peak=2  ->  started=8 peak=2
POWER_ concurrency probe (cap=1):   ->  started=3 peak=1
```

## Feature 5 — Gate de aprovação e determinismo

### 5.1 `packages/core/src/workflow/plan.ts` — **ARQUIVO NOVO**

- **Motivo:** o gate precisa de três números (fases, agentes, tokens) e de um
  digest **antes** do primeiro spawn. Rodar o programa para descobrir o tamanho
  dele derrotaria o propósito de perguntar antes, então a estimativa é estática,
  lida do texto do script.
- **API:** `analyze(code) -> Plan { digest, phases, agents, tokens, advisories, script }`,
  `digest(code)`, e as constantes `ACTION = "workflow.run"`,
  `MULTI_AGENT_MINIMUM = 2`, `AGENT_ADVISORY = 25`, `TOKEN_ADVISORY = 1_500_000`.
- **Como conta:** mascara comentários (preservando os índices), acha os call
  sites `tools.agent.spawn(` em todas as grafias do catálogo (incluindo
  `tools.agent["spawn"]`), agrupa por combinador `Promise.*` envolvente
  (= uma fase paralela) e multiplica por `.map/.flatMap/.forEach` e corpos de
  `for`/`while`. Array literal como receptor dá a contagem exata; qualquer outra
  coisa cai no fan-out configurável. **Erra para cima de propósito**: super-estimar
  custa um prompt a mais, subestimar pula o gate.
- **Env:** `POWER_WORKFLOW_FANOUT` (default 4), `POWER_WORKFLOW_AGENT_TOKENS`
  (default 60000). Grafia `OPENCODE_*` também honrada via `@opencode-ai/util/env`.
- **Quando remover:** se o upstream ganhar um planner de workflow de verdade.
- **Conflito esperado no merge:** nenhum. Arquivo novo em diretório novo.

### 5.2 `packages/core/src/plugin/workflow-gate.ts` — **ARQUIVO NOVO**

> **Revisado em 5.8** (correção pós battle-test): a asserção deixou de sair da
> contagem estática e passou a sair dos spawns reais do run. O que segue descreve a
> primeira versão; leia 5.8 para o comportamento atual.

- **Motivo:** `agent.spawn` afirma `subagent` **por filho** — grão certo para uma
  delegação, errado para um programa que faz fan-out: o usuário responde a mesma
  pergunta trinta vezes e vê uma task por vez em vez da forma do run.
- **O que faz:** hook `tool.execute.before`; quando a tool é `execute` (a tool do
  Code Mode) e o script projeta `>= 2` agentes, faz **uma** asserção
  `permission.assert({ action: "workflow.run", resources: [digest], save: [digest] })`
  com `metadata: { summary, phases, agents, tokens, advisories, script }`.
- **Por que hook e não edição da tool do Code Mode:** `execute.before` é o único
  ponto onde o script é visível antes do interpretador — `CodeModeTool.create`
  não recebe o `Permission.Service` e é sintetizado dentro de `Tool.snapshot`.
  Zero linhas tocadas em `codemode/tool.ts` e em `tool.ts`.
- **"Não perguntar de novo" nunca é `*`:** `save` carrega o mesmo recurso
  `sha256:<hex>` que `resources`. Um caractere alterado no script muda o digest
  e a pergunta volta. A regra salva vira `{ action: "workflow.run", resource:
  "sha256:...", effect: "allow" }` no `PermissionSaved` que já existe.
- **Advisory:** acima de 25 agentes ou de 1,5M tokens projetados, publica
  `TuiEvent.ToastShow` (`variant: "warning"`) no bus **antes** da asserção, para
  o aviso estar visível na hora de decidir. Não bloqueia e não pode falhar o run.
  Usa um evento que **já existe** no `ServerDefinitions` — nenhum tipo novo de
  evento, nenhum churn no `openapi.json` congelado.
- **Conflito esperado no merge:** nenhum. Arquivo novo.

### 5.3 `packages/core/src/plugin/internal.ts` — registro do plugin

- **Âncora:** `import { WarmingPlugin } from "./warming.js"` (+1 import) e
  `WarmingPlugin.Plugin,` no fim de `const pre = [...]` (+1 entrada).
- **Efeito:** 2 linhas. O gate entra na mesma lista de plugins internos que
  `SubagentTool` e `AgentTool`.
- **Conflito esperado no merge:** baixo; a lista cresce por append no upstream.

### 5.4 `packages/codemode/src/stdlib/date.ts` — relógio determinístico

- **Motivo:** uma leitura do relógio do host é o que faz um programa replayado
  divergir do run aprovado. Sob a flag, **toda** leitura precisa recusar — não
  só `Date.now()`.
- **Âncora:** logo abaixo de `export const dateStatics`, e um `hostNow` no
  `case "now"` de `invokeDateStatic`.
- **API:** `isDeterministic()`, `setDeterministic(value)`, `assertRealTimeAllowed(expression, node)`
  e `hostNow(expression, node)` (asserta e devolve `Date.now()`). Default
  **desligado**; `POWER_CODEMODE_DETERMINISTIC=1` (ou `OPENCODE_*`) liga na carga
  do módulo. Mensagem no formato dos outros membros indisponíveis do stdlib:
  `<expr> is not available in deterministic mode; every reading of the host clock
  (Date.now(), Date(), new Date() with no argument) is refused. Pass an explicit
  timestamp, e.g. new Date(1700000000000), or use Date.parse()/Date.UTC().`
- **`Date.parse`, `Date.UTC` e `new Date(<timestamp|string|partes>)` continuam
  disponíveis** — são funções puras dos argumentos.
- **Conflito esperado no merge:** baixo. `dateStatics` e `invokeDateStatic` são
  estáveis no upstream.

### 5.4.1 `packages/codemode/src/interpreter/runtime.ts` — as duas linhas de delegação

- **Achado do battle-test:** a versão anterior da 5.4 bloqueava só `Date.now()` e
  registrava o resto como "LIMITE CONHECIDO". O efeito real não estava dito: a
  feature entregava **zero** determinismo, porque `+new Date()` é `Date.now()` com
  outro nome e devolvia o relógio do host. Medido: `+new Date()` → `1787987968283`
  dentro da janela do relógio da máquina, e dois runs do mesmo programa dando
  `2026-08-29T07:19:28.284Z` e `2026-08-29T07:19:29.387Z`. Pior, a mensagem de erro
  antiga ("pass an explicit timestamp", nomeando só `Date.now()`) empurrava o
  modelo exatamente para a reescrita que passava. Bloquear uma grafia só era pior
  do que não bloquear nenhuma.
- **Por que a edição em `interpreter/` foi necessária:** os outros dois caminhos
  para o relógio não passam pelo stdlib. `new Date()` sem argumento é construído em
  `constructDate` e `Date()` sem `new` é servido no caminho de `GlobalNamespace`.
  Não há hook: sem tocar nesses dois pontos, a flag é contornável com uma
  reescrita trivial.
- **Tamanho da edição:** 3 linhas, sem lógica nova. Um import
  (`hostNow` de `../stdlib/date.js`) e duas chamadas que trocam `Date.now()` por
  `hostNow("new Date()", node)` / `hostNow("Date()", node)`. A política inteira
  (flag, mensagem, o que é puro) continua em `stdlib/date.ts`; o interpretador só
  delega.
- **Condição para remover:** no dia em que o upstream rotear a construção de datas
  por um único ponto de extensão (um clock injetável no runtime, ou
  `constructDate` chamando o stdlib), estas 3 linhas saem e `hostNow` passa a ser
  chamado só de dentro de `stdlib/date.ts`. Enquanto `constructDate` ler
  `Date.now()` direto, elas têm que ficar.
- **Conflito esperado no merge:** baixo, mas maior que o do stdlib — `runtime.ts`
  é arquivo quente no upstream. As 3 linhas são pontuais e o conflito, se vier, é
  de contexto: reaplicar é reescrever a mesma chamada.

### 5.5 Testes — **ARQUIVOS NOVOS**

- `packages/core/test/workflow-plan.test.ts` (11 testes): fases paralelas vs.
  sequenciais, fan-out literal vs. runtime, spawn em loop, notação de colchetes,
  spawn em comentário ignorado, os dois avisos advisory, estabilidade do digest.
- `packages/core/test/workflow-gate.test.ts` (4 testes): dirige o **plugin real**
  com um host stub, então o callback capturado é exatamente a função que o
  pipeline de tools chama. Cobre `resources == save == [digest]`, o silêncio para
  uma delegação única e para tools que não são o Code Mode, a publicação do
  advisory, e a conversão de um `BlockedError` em `ToolFailure`.
- `packages/codemode/test/date-deterministic.test.ts` (29 testes): a matriz de
  7 grafias que alcançam o relógio do host (`Date.now()`, `+new Date()`,
  `new Date().getTime()`, `new Date().toISOString()`, `Date()`, `valueOf`,
  coerção em template string) rodada **nos dois modos** — todas funcionam com a
  flag desligada, todas lançam com ela ligada; a matriz de 5 expressões puras
  (`Date.parse`, `Date.UTC`, `new Date(<timestamp>)`, `new Date(<string>)`,
  `new Date(<partes>)`) rodada nos dois modos com o mesmo resultado; os getters e
  setters de uma data com timestamp explícito sob a flag; a asserção de que a
  mensagem de recusa nomeia as outras grafias (era isso que empurrava o modelo
  para a reescrita); e o de `Math.random()` (5.6).
- `packages/codemode/test/zz-battle-determinism.test.ts` (2 testes) +
  `packages/codemode/test/fixtures/deterministic-env-probe.ts` — regressão do
  achado do battle-test pelo caminho do **operador**: a flag lida do ambiente na
  carga do módulo. Como isso só acontece uma vez por processo, o teste faz
  `Bun.spawn` de um processo filho com `POWER_CODEMODE_DETERMINISTIC=1` e checa que
  as 5 leituras de relógio mais `Math.random()` recusam, que `Date.parse`/`Date.UTC`/
  `new Date(1234567890)` sobrevivem no mesmo processo, e que dois runs do mesmo
  programa não podem mais divergir porque nenhum produz valor.
- `packages/core/test/workflow-gate-ordering.test.ts` (2 testes, escrito na
  verificação): replay da sequência real de `tool.ts:239-247` — `beforeExecute`
  e depois `codemodeTool.execute` — com o plugin real de um lado e o runtime
  real do Code Mode do outro, e um `agent.spawn` de teste que conta invocações.
  Prova por execução que a asserção precede o primeiro spawn: negado ⇒
  `trace == ["assert:workflow.run"]` e zero spawns; aprovado ⇒
  `trace == ["assert:workflow.run", "spawn:a", "spawn:b"]`.

### 5.6 `packages/codemode/src/stdlib/math.ts` — `Math.random()` sob a mesma flag

Acrescentado na **verificação** da Feature 5, não na implementação inicial.

- **Motivo:** `Math.random()` é a segunda leitura irreprodutível do stdlib. Com
  só o `Date.now()` fechado, o "modo determinístico" continuava servindo entropia
  real, e um replay divergia do run aprovado exatamente como antes.
- **Âncora:** `if (name === "random")` em `invokeMathMethod`, mais um import de
  `isDeterministic` de `./date.js`. 14 linhas, um arquivo.
- **Comportamento:** default **desligado** — `Math.random()` devolve número como
  sempre, e os testes existentes do upstream (`stdlib.test.ts`,
  `regexp-math-test262.test.ts`) passam sem alteração. Sob a flag, lança
  `Math.random() is not available in deterministic mode; pass an explicit value.`
- **Conflito esperado no merge:** baixo; o ramo `random` é estável no upstream.

### 5.7 Achado: o ground truth do briefing estava errado em dois pontos

1. **`Math.random` NÃO lançava** em `packages/codemode/src/stdlib/math.ts`.
   `invokeMathMethod` fazia `if (name === "random") return Math.random()` (linha
   ~57) — o briefing afirmava o contrário. Verificado por execução, e fechado
   sob a flag determinística em 5.6 acima.
2. **Não existia nada de "workflow"/"multi-agent run"** no repo antes desta
   feature. O único ponto de fan-out é a tool `agent.spawn` da Feature 4
   (`packages/core/src/tool/plugin/agent.ts`), e é dela que o analisador parte.

### 5.8 Correção pós battle-test — o gate deixa de ser estático (**supersede 5.1/5.2**)

O battle-test encontrou dois furos que se somavam: com o ruleset default o gate
resolvia para `allow` e **nunca perguntava**, e mesmo que perguntasse a decisão
saía de uma contagem por regex que qualquer programa idiomático derruba.

**Achado 1 — `workflow.run` resolvia para `allow` por default.**
`Agent.Info.default` (packages/schema/src/agent.ts) abre com
`{ action: "*", resource: "*", effect: "allow" }`. `Permission.evaluate` só cai
no fallback `ask` quando **nada** casa, e `*` casa com tudo — então o
`assert("workflow.run", ...)` do gate resolvia `allow` e o prompt nunca existia.
Provado por `packages/core/test/zz-battle-gate-default.test.ts`.

- **Correção (`packages/schema/src/agent.ts`, +1 regra):**
  `{ action: "workflow.run", resource: "*", effect: "ask" }` logo depois do
  blanket allow. Regras são last-match-wins, e essa é a lista de que **todo**
  agente é semeado (`draft.update` parte de `Info.default(id)`), inclusive os
  criados pelo `ConfigAgentPlugin`. Uma regra do usuário continua ganhando: as
  permissões de config são anexadas depois destas.
- **Correção (`packages/core/src/plugin/remote.ts`, +1 regra):** o mesmo par
  explícito no preset `remote`. Já estava coberto pelo blanket ask do preset;
  escrito por extenso para que um alargamento futuro do bloco read-only não
  entregue um fan-out de trinta agentes a uma sessão sem operador.
- **`subagent` fica como está** (`allow` no default): uma delegação não é o que
  este gate existe para pegar.

**Achado 2 — a contagem por regex subestimava e o gate saía antes de afirmar.**
`if (plan.agents < MULTI_AGENT_MINIMUM) return` rodava sobre um número lido do
texto do script. Contam 0 ou 1 e escapavam: `const s = tools.agent.spawn`,
`const ns = tools.agent; ns.spawn(...)`, `tools.agent[k](...)` com `k` computado
e — o pior, e nada adversarial — `async function ask(t){ ... }` +
`topics.map(ask)`, que roda 30 subagentes contando 1.

Análise estática de JavaScript por regex não tem como ficar sólida, então o
regex **não foi endurecido**. O gate foi reprojetado:

- **A asserção passa a sair dos spawns reais.** Toda sessão filha que um
  programa de Code Mode inicia passa pela mesma registration `agent_spawn`, e
  `tool.ts:216-218` roteia **as chamadas internas do Code Mode pelo mesmo
  `tool.execute.before`**, carregando o `Tool.Context` da chamada do Code Mode
  que as contém. O gate agora escuta esse evento: `execute` registra a execução
  pelo `sessionID:callID`, e cada `agent_spawn` sob aquele id incrementa um
  contador. Ao atingir `MULTI_AGENT_MINIMUM` (2), afirma. Alias, nome computado
  e helper via `.map()` chegam todos nesse caminho — nenhum deles depende de
  como o texto do script soletra a chamada.
- **O plano estático continua, como metadata e como atalho de tempo.** Quando o
  `analyze` já enxerga fan-out (`agents >= 2`), a pergunta é levantada
  **pre-flight**, antes de qualquer filho — é só isso que a estimativa decide.
  Subestimar adia a pergunta para o segundo spawn real; nunca a cancela.
- **Um prompt por execução.** A asserção é memoizada por chamada da tool com
  `Effect.cached`: trinta filhos concorrentes levantam **um** request e
  compartilham a resposta, inclusive a negativa (o exit fica cacheado, então um
  `deny` não vira trinta prompts). O contador é lido e incrementado num bloco
  síncrono, então num `Promise.all` exatamente um filho passa antes do gate — e
  esse é justamente o filho que `subagent` já afirma sozinho.
- **Digest inalterado.** É sha256 do **texto** do script, não da contagem, então
  um "não perguntar de novo" salvo continua casando mesmo quando a estimativa e o
  fan-out real divergem. A metadata ganhou `observed` (spawns reais já pedidos no
  momento da pergunta; 0 no caminho pre-flight).
- **Ciclo de vida:** um segundo hook, `tool.execute.after`, aposenta a execução
  quando a chamada do Code Mode termina. Um `agent_spawn` sem execução registrada
  é uma delegação direta e é deixado para `subagent`.
- **Arquivos:** `packages/core/src/plugin/workflow-gate.ts` (reescrito),
  `packages/core/src/workflow/plan.ts` (só docstrings: a estimativa está
  documentada como metadata, não como a decisão), `packages/schema/src/agent.ts`
  (+1 regra), `packages/core/src/plugin/remote.ts` (+1 regra). Nada tocado em
  `codemode/tool.ts`, `tool.ts` ou `tool/plugin/agent.ts`.

**Testes:**

- `packages/core/test/workflow-gate-runtime.test.ts` — **ARQUIVO NOVO**. Roda o
  interpretador real do Code Mode com as chamadas internas roteadas pelo
  `execute.before`, como `tool.ts:216-218` faz. Os quatro programas do achado 2,
  cada um negado e aprovado: negado ⇒ uma asserção `workflow.run` com o digest do
  script e **um** filho executado; aprovado ⇒ uma asserção e todos os filhos
  (5/4/3/30). Mais: um programa de um filho só nunca levanta o prompt; um fan-out
  literal é perguntado antes de qualquer filho; a memoização é por execução (duas
  chamadas do mesmo script ⇒ duas asserções, 60 filhos).
- `packages/core/test/workflow-gate.test.ts` — +4 testes no host stub: spawn sem
  execução registrada é deixado para `subagent`; a pergunta sai no segundo spawn
  real de um run que o regex não enxergou (`metadata: { agents: 1, observed: 2 }`);
  trinta filhos concorrentes ⇒ um request; `execute.after` aposenta o run.
- `packages/core/test/workflow-gate-ordering.test.ts` e
  `packages/core/test/zz-battle-gate-bypass.test.ts` — os harnesses chamavam
  `tool.execute` direto, pulando o `beforeExecute` interno; era por isso que a
  sonda de bypass reportava `asserted=[]` fosse qual fosse o comportamento do
  gate. Corrigidos para o roteamento real, e a sonda ganhou asserções.
- `packages/core/test/zz-battle-gate-default.test.ts` — a expectativa vira `ask`,
  mais o caso da regra salva (digest daquele script ⇒ `allow`; outro ⇒ `ask`).

```
tsgo -b  packages/core (src + tests)                          -> EXIT 0
tsgo -b  packages/schema                                      -> EXIT 0
bun test packages/core/test/workflow-*.test.ts
         + zz-battle-gate-*.test.ts + agent + permission      -> 154 pass, 0 fail
```

Sonda de bypass, antes -> depois (permissão negando tudo):

```
[alias the spawn function]   asserted=[]  spawns=5   ->  asserted=["workflow.run"]  spawns=1
[alias the namespace]        asserted=[]  spawns=4   ->  asserted=["workflow.run"]  spawns=1
[computed member name]       asserted=[]  spawns=3   ->  asserted=["workflow.run"]  spawns=1
[helper + map, 30 topicos]   asserted=[]  spawns=30  ->  asserted=["workflow.run"]  spawns=1
```

### 5.9 O contrato entre `SPAWN_TOOL` e a registration real

- **Motivo:** o gate casa os spawns pela chave de registro `SPAWN_TOOL =
  "agent_spawn"`, mas essa chave nasce em outro arquivo — `effectiveName` aplicado
  à registration que `tool/plugin/agent.ts` adiciona (`namespace = "agent"` +
  tool `spawn`). Nada ligava as duas pontas: renomear o namespace ou a tool muda a
  chave, o gate para de ver spawns **em silêncio** e o run cai só no plano
  estático — que o battle test de 5.8 já provou contornável. Falha silenciosa de
  uma proteção de segurança.
- **Mudança no `src`:** uma palavra. `const SPAWN_TOOL` virou
  `export const SPAWN_TOOL` em `packages/core/src/plugin/workflow-gate.ts`, com o
  docstring apontando para o teste. Zero mudança de comportamento.
- **`packages/core/test/workflow-gate-spawn-contract.test.ts` — ARQUIVO NOVO.**
  Roda o `AgentTool.Plugin` real contra um `ToolDraft` que só registra o que foi
  adicionado (o sink é stub; as registrations são as de produção) e deriva as
  chaves com o mesmo `effectiveName` que `tool.ts:165` usa para indexar o
  registry. Dois casos: (1) a chave do gate está entre as chaves reais;
  (2) disparando o `execute.before` do gate com a chave **derivada** (não com a
  constante), um run que o `analyze` não enxerga levanta a asserção
  `workflow.run` no segundo spawn — isto é, a ponta que o gate compara é mesmo a
  que a registration produz.
- **Por que `toContain` e não igualdade com um literal:** o teste fixa a
  *relação*, não a grafia. Renomear os dois lados junto continua verde; renomear
  um só falha.

**Prova de que falha (renomes temporários, todos revertidos):**

```
namespace "agent" -> "agents"      -> 0 pass, 2 fail
   Expected to contain: "agent_spawn"
   Received: ["agents_spawn","agents_wait","agents_list","agents_stop"]
tool "spawn" -> "start"            -> 0 pass, 2 fail
   Received: ["agent_start","agent_wait","agent_list","agent_stop"]
SPAWN_TOOL -> "agent_start"        -> 0 pass, 2 fail
   Expected to contain: "agent_start"
   Received: ["agent_spawn","agent_wait","agent_list","agent_stop"]
os dois lados renomeados juntos    -> 2 pass, 0 fail
```

```
bunx tsgo -b packages/core (src + tests)  -> EXIT 2, só os 5 erros pré-existentes
                                             de test/models.test.ts (outro escopo)
bun test workflow-gate-spawn-contract + workflow-gate + workflow-gate-runtime
         + workflow-gate-ordering + workflow-plan   -> 34 pass, 0 fail
bun test tool-agent.test.ts                         ->  5 pass, 0 fail
```

## Verificação da Feature 5

```
tsgo -b   packages/core     (src + tests)                            -> EXIT 0
tsgo      packages/codemode --noEmit                                 -> EXIT 0
bun test  packages/core/test/workflow-plan.test.ts   -> 11 pass, 0 fail
bun test  packages/core/test/workflow-gate.test.ts   ->  4 pass, 0 fail
bun test  packages/core/test/workflow-gate-ordering.test.ts ->  2 pass, 0 fail
bun test  packages/codemode                          -> 1094 pass, 0 fail
bun test  packages/core  tool-agent + tool-agent-concurrency + tool-execute
                                                     -> 13 pass, 0 fail
bun run packages/cli/script/build.ts --single                        -> EXIT 0
```

Binário: `packages/cli/dist/cli-windows-x64/bin/poweragent.exe`, 140.9 MB,
`--version` → `poweragent v0.0.0-main-202608290630`.

`bun run typecheck` na raiz continua falhando **só** em `@opencode-ai/desktop`
pelo symlink `packages/app/src/custom-elements.d.ts` materializado como arquivo
de texto no Windows — pré-existente, registrado na Feature 1, sem relação com
esta feature.

### Verificação da correção D (fechamento do relógio, 5.4.1)

```
bunx tsgo --noEmit -p packages/codemode/tsconfig.json     -> EXIT 0
bun test packages/codemode/test/date-deterministic.test.ts
         packages/codemode/test/zz-battle-determinism.test.ts
                                                          -> 31 pass, 0 fail
bun test packages/codemode/test/date-test262.test.ts stdlib codemode parity
                                                          -> 254 pass, 0 fail
bun test packages/codemode                                -> 1120 pass, 0 fail
```

Build completo **não** rodado nesta rodada (outros agentes em paralelo).

---

## Correção C — senha whitespace e cobertura de env

Duas falhas do battle test, ambas da família "falha aberta e em silêncio".

### C.1 `packages/server/src/auth.ts` — `usable(secret)`

- **Achado (médio):** uma senha composta só de espaço/tab/newline contava como
  credencial *configurada*. `--hostname 0.0.0.0` era aceito e o servidor subia
  "protegido" por uma credencial que ninguém consegue digitar errado.
- **Mudança:** função nova `ServerAuth.usable(secret)` — `true` só quando o valor
  é string e `trim()` não é vazio. É o único predicado de "isso é uma credencial?"
  do overlay; `bind-policy.ts`, `cli/src/env.ts`, `server/src/routes.ts` e
  `server/src/process.ts` derivam dele (ver D.1).
- **Deliberadamente NÃO trima o valor aceito:** o segredo que autentica precisa
  continuar byte-idêntico ao que o operador exportou, senão todo cliente que já o
  tem para de autenticar.
- **`required()`/`authorized()` intocados:** afrouxar `required()` faria uma senha
  de whitespace *desligar* o Basic auth — o oposto do conserto.
- **Quando remover:** nunca.

### C.2 `packages/server/src/bind-policy.ts` — `classify` + credencial `weak`

- **API nova:** `classify(secret)` -> `configured | weak | ephemeral`, e
  `minimumSecretLength = 8`. O tipo `Credential` ganhou o valor `"weak"`.
- **Regra:** `trim()` vazio (ou ausente) -> `ephemeral` (o chamador vai cunhar uma
  aleatória); `trim().length < 8` -> `weak`; senão -> `configured`.
- **Por que 8:** é o piso do NIST SP 800-63B para segredo escolhido por humano, e
  Basic auth na frente de um agente que executa código arbitrário é exatamente o
  caso que esse piso existe para cobrir.
- **Por que não quebra fluxo/teste com senha curta:** `weak` só é recusado em bind
  **alcançável**. Em loopback `check` continua devolvendo `undefined` — a senha
  curta segue sendo usada, segue autenticando, e nenhum deploy local quebra no
  upgrade. A tabela de 2.6 passa a ser:

  | escopo | `configured` | `weak` | `ephemeral` | `none` |
  | --- | --- | --- | --- | --- |
  | loopback | ok | ok | ok | **só com a variável de escape** |
  | wildcard / routable | ok | **recusa** | **recusa** | **recusa** |

- **Mensagem de recusa** passou a nomear o problema real
  (`a credential shorter than 8 characters`) em vez de mentir "gerada no boot".
- **Teste:** `packages/server/test/bind-policy.test.ts` (6 casos novos).

### C.3 `packages/cli/src/env.ts` — `configuredPassword`

- `password` resolve a primeira grafia **setada**; `configuredPassword` responde à
  pergunta que os chamadores realmente fazem: existe aqui uma credencial que vale
  como credencial. Whitespace vira `undefined`.
- Usado por `serve.ts`, `web.ts` e `server-process.ts`, que antes repetiam
  `configured && Redacted.value(configured) !== ""` — o teste exato que a senha de
  espaços passava.

### C.4 Cobertura branded de env — `packages/util/src/env.ts`

- **Achado (alto):** `POWER_MODELS_URL` era aceito pelo shell e ignorado pelo
  processo; o binário seguia chamando `models.opencode.ai` (um sentinel HTTP
  registrou a chamada de saída). O fallback cobria ~5 das 77 variáveis e **falhava
  aberto, em silêncio**.
- **Decisão:** as 77 continuam **sem** rename (merge eterno). O que mudou é
  (a) quais sufixos passam pelo helper e (b) o fim do silêncio.

**Variáveis COM fallback branded** — a lista viva é `Env.branded` em
`packages/util/src/env.ts`, e `Env.unrecognized()` a usa como contrato:

| sufixo | lido em |
| --- | --- |
| `AGENT_CONCURRENCY`, `AGENT_SPAWN_LIMIT` | `core/src/tool/plugin/agent.ts` |
| `ALLOW_UNAUTHENTICATED_LOOPBACK` | `server/src/bind-policy.ts` |
| `CODEMODE_DETERMINISTIC` | `codemode/src/stdlib/date.ts` |
| `CONFIG`, `CONFIG_CONTENT` | `cli/src/server-process.ts` |
| `CONFIG_DIR` | `util/src/global.ts`, `cli/src/index.ts`, `cli/src/server-process.ts` |
| `DB`, `DISABLE_CHANNEL_DB`, `SIMULATE` | `cli/src/server-process.ts` |
| `DEV_CORS` | `server/src/cors.ts` |
| `DISABLE_AUTOUPDATE`, `ENABLE_AUTOUPDATE` | `cli/src/services/updater.ts` |
| `MODELS_URL`, `MODELS_PATH`, `DISABLE_MODELS_FETCH` | `core/src/models-dev.ts` (`resolveOptions`, C.6.1) e `cli/src/server-process.ts` (`ServerProcess.models()`) |
| `LOG_LEVEL`, `PRINT_LOGS` | `util/src/observability/logging.ts`, `cli/src/services/standalone.ts` |
| `PASSWORD`, `SERVER_PASSWORD` | `cli/src/env.ts` |
| `WORKFLOW_FANOUT`, `WORKFLOW_AGENT_TOKENS` | `core/src/workflow/plan.ts` |

**Variáveis deliberadamente SEM fallback branded** (só `OPENCODE_*`), e por quê:

- **Contrato de embedding, não de operador:** `OPENCODE_CLIENT`, `OPENCODE_VERSION`,
  `OPENCODE_CHANNEL`, `OPENCODE_RELEASE`, `OPENCODE_LOCAL`, `OPENCODE_CLI_NAME`,
  `OPENCODE_LIBC`, `OPENCODE_BUMP`. São escritos pelo build ou por quem embute o
  binário, não exportados à mão por um operador.
- **Handoff interno entre processos pai/filho:** `OPENCODE_PTY_HANDOFF`,
  `OPENCODE_PTY_BIN`, `OPENCODE_PTY_RUNTIME_DIR`, `OPENCODE_PROJECT_ID`,
  `OPENCODE_EDITOR_SSE_PORT`. Quem escreve e quem lê são o mesmo código.
- **Caminho de asset resolvido pelo empacotador:** `OPENCODE_NODE_ASSETS_DIR`,
  `OPENCODE_NODE_PTY_PATH`, `OPENCODE_PARCEL_WATCHER_PATH`,
  `OPENCODE_PHOTON_WASM_PATH`, `OPENCODE_TREE_SITTER_*_WASM_PATH`.
- **Superfície do desktop/Electron e do sidecar WSL:** todo `OPENCODE_DESKTOP_*`,
  `OPENCODE_DRIVE*`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_ZED_DB`,
  `OPENCODE_TERMINAL`. O desktop tem rebrand próprio pendente; brandar metade
  agora só cria dois nomes vivos para a mesma coisa.
- **Só de teste/dev:** `OPENCODE_TEST_HOME`, `OPENCODE_TEST_ONBOARDING`,
  `OPENCODE_STORY`, `OPENCODE_SHOW_TTFD`, `OPENCODE_DIRECT_TRACE`,
  `OPENCODE_EXPERIMENTAL_*`, `OPENCODE_TOOL_GUIDANCE`.
- **Infra do serviço hospedado, não do CLI:** `OPENCODE_STORAGE_*`,
  `OPENCODE_API_KEY`, `OPENCODE_REPO_CLONE_GITHUB_BASE_URL`.
- **Casos com dois nomes upstream concorrentes:** `OPENCODE_FILEWATCHER_DISABLE`
  vs `OPENCODE_DISABLE_FILEWATCHER`, `OPENCODE_CONFIG_PROJECT_DISABLE` vs
  `OPENCODE_DISABLE_PROJECT_CONFIG`, mais `OPENCODE_DISABLE_FFF` e
  `OPENCODE_GIT_BASH_PATH` que moram nas mesmas expressões. A precedência upstream
  é "o primeiro **definido** vence", que o helper de sufixo não expressa; brandar
  exigiria reescrever a precedência — mudança de comportamento maior que o ganho.
  **Ficam de propósito na lista de não-reconhecidas**, então um
  `POWER_DISABLE_FILEWATCHER` gera aviso em vez de silêncio.

### C.5 Fim da falha silenciosa — `Env.unrecognized` / `Env.warnUnrecognized`

- `unrecognized(source)` devolve, ordenadas, as variáveis `POWER_*` presentes no
  ambiente cujo sufixo **não** está em `Env.branded`.
- `warnUnrecognized()` escreve uma linha em **stderr** com o nome exato de cada
  uma e a grafia que funcionaria:

  ```
  warning: 1 POWER_* variable is set but not read by this build: POWER_ZED_DB
  (this build reads OPENCODE_ZED_DB). Export the OPENCODE_ spelling instead, or
  see PATCHES.md for the branded list.
  ```

- **Por que stderr e não `Effect.logWarning`:** o logger de stderr é gated por
  `PRINT_LOGS`. Um aviso de misconfiguração que só aparece quando o log já está
  ligado é a mesma falha silenciosa outra vez.
- **Âncora:** `packages/cli/src/index.ts`, uma linha antes do
  `logInfo("cli starting")`.
- **Teste:** `packages/util/test/env.test.ts` (8 casos novos, incluindo um
  subprocesso que prova que o sink default é o stderr do processo).

### C.5.1 `packages/util/script/lint-env.ts` — **ARQUIVO NOVO**: o lint que mantém `Env.branded` honesta

- **Achado (alto):** `Env.branded` é mantida **à mão** e já falhou uma vez nesta
  sessão. `AGENT_CONCURRENCY` virou call site vivo (`positiveEnv` em
  `core/src/tool/plugin/agent.ts`) e ficou fora da lista; o CLI passou a avisar
  que uma variável que **funciona** não era lida — ou seja, instruiu o operador a
  abandonar uma configuração correta. O modo espelhado é igualmente silencioso:
  deixar uma entrada na lista depois de apagar o último call site **suprime** o
  aviso que deveria sair para uma variável morta.
- **Decisão:** a lista continua à mão (é o contrato legível), mas deixa de ser
  verificada só por leitura humana. O lint varre `packages/*/src`, junta os reads
  que consegue ver e falha **nos dois sentidos**: sufixo lido e ausente da lista;
  sufixo na lista sem nenhum read.
- **O que ele enxerga** (regex sobre o texto, com comentários mascarados):
  1. chamada direta ao helper — `env("X")`, `truthy("X")`, `names("X")` —
     incluindo import renomeado (`import { env as branded }`) e a forma de
     namespace (`Env.truthy("X")`);
  2. chamada via wrapper local de topo que repassa o primeiro parâmetro ao helper
     (`positive`/`positiveEnv` em `core/src/workflow/plan.ts` e
     `core/src/tool/plugin/agent.ts`);
  3. argumento que resolve para um `const NOME = "SUFIXO"` de módulo
     (`escapeVariable` em `server/src/bind-policy.ts`, `DEV_ORIGINS_VARIABLE` em
     `server/src/cors.ts`);
  4. leitura direta de `process.env` na grafia branded — `process.env["POWER_X"]`,
     `process.env.POWER_X` e `` process.env[`POWER_${NOME}`] ``
     (`codemode/src/stdlib/date.ts`, `server/src/cors.ts`). A irmã `OPENCODE_*` de
     uma leitura dessas **não** conta como call site: as ~77 upstream são lidas
     assim e contá-las exigiria 77 entradas na lista, esvaziando o contrato.
- **O que ele não enxerga, e por que não mente sobre isso:** varredura estática de
  TypeScript por regex não é sound. Tudo que não resolve é **reportado**, nunca
  descartado — argumento computado, template com identificador não resolvível, e
  arquivo que alcança o helper por um formato de import que o lint não parseia
  (`const { env } = await import(...)`) viram erro pedindo literal, constante de
  módulo, ou entrada na allowlist.
- **Allowlist `dynamic`:** só `PASSWORD` e `SERVER_PASSWORD`, lidas pela cadeia
  `Config.redacted(passwordKeys[n])` em `cli/src/env.ts` — o sufixo nunca aparece
  como argumento. Cada entrada carrega um `evidence` re-checado a cada execução:
  se o call site sumir, a entrada **fica stale e falha** em vez de cobrir o buraco.
- **Ligação:** `bun run lint:env-branding` na raiz, encadeado em
  `"lint": "oxlint && bun run lint:env-branding"` (`package.json` da raiz, +2
  linhas). O mesmo código roda dentro de `bun test` do pacote `util`.
- **Teste:** `packages/util/test/lint-env.test.ts` (26 casos) — cada forma de call
  site em fixture, os três tipos de read cego, os dois sentidos da falha, a
  allowlist stale, e uma checagem de integração contra a árvore real.
- **Prova de que morde** (executada, com restore verificado):
  - removida a entrada `"AGENT_CONCURRENCY"` da lista → exit 1, apontando
    `packages/core/src/tool/plugin/agent.ts:111 positiveEnv("AGENT_CONCURRENCY")`;
  - acrescentada uma entrada `"ZOMBIE_LEFTOVER"` sem call site → exit 1;
  - trocado o sufixo em `server/src/cors.ts` → exit 1 nos dois sentidos de uma vez;
  - apagado `"POWER_PASSWORD"` de `cli/src/env.ts` → exit 1 por allowlist stale;
  - restaurado tudo → exit 0, `22 branded suffixes, 31 reads across 2462 source files`.
- **Quando remover:** quando `Env.branded` deixar de existir (rebrand completo das
  77 variáveis, ou helper que dispense a lista).
- **Conflito esperado no merge:** nenhum no arquivo novo; baixo no `package.json`
  da raiz (uma linha `lint` + uma linha nova).

### C.6 Onde o catálogo passou a ler o env

**Primeira tentativa (insuficiente, mantida como contexto):** o env era lido só
onde as opções são **construídas** — `ServerProcess.models()` em
`packages/cli/src/server-process.ts`, exportado para ser testável sem subir
servidor (**teste:** `packages/cli/test/credential-env.test.ts`, arquivo novo).
`packages/core/src/models-dev.ts` ficou intocado de propósito, com o argumento de
que `options.url`/`options.file` são a API da camada.

O argumento estava errado na parte que importa: esse é o caminho do **binário**,
não o único caminho. Qualquer consumidor que monte `ModelsDev.layer()` sem passar
`options.url` — `ModelsDev.node` (`configured()` sem opções, usado por
`core/src/plugin/internal.ts` e por `server/src/routes.ts` quando o embedder não
passa `models`), o worker de simulation, o app de stats — continuava chamando
`models.opencode.ai` com o `POWER_MODELS_URL` do operador sem ser lido. Mesmo
silêncio de antes, um nível abaixo.

### C.6.1 `packages/core/src/models-dev.ts` — resolução na origem

- **Mudança:** helper `resolveOptions(options)` logo abaixo de `defaultSource`,
  consumido no corpo da layer (`resolved.url`/`resolved.file`/`resolved.fetch`
  substituem `options?.url`/`options?.file`/`options?.fetch`).

  | campo | cadeia |
  | --- | --- |
  | `url` | `options.url` → `POWER_MODELS_URL` → `OPENCODE_MODELS_URL` → `https://models.opencode.ai` |
  | `file` | `options.file` → `POWER_MODELS_PATH` → `OPENCODE_MODELS_PATH` |
  | `fetch` | `options.fetch` → `!truthy("DISABLE_MODELS_FETCH")` |

- **`??`, não `||`:** `url: ""` é um "use o host default" **explícito** de que os
  chamadores (e um teste do upstream) dependem; com `||` ele cairia no env. O
  `resolved.url || defaultSource` logo abaixo continua absorvendo a string vazia.
- **Âncora:** `const defaultSource = ...` (~linha 549) e as 5 leituras de
  `options?.` dentro de `layer()`. Import novo:
  `import { env, truthy } from "@opencode-ai/util/env"`.
- **Precedência preservada:** opção explícita ganha sempre — quem já passa
  `options` (o CLI via `ServerProcess.models()`, os testes) não muda de
  comportamento. C.6 não foi revertido: `ServerProcess.models()` continua
  existindo e agora é redundante, não conflitante.
- **Quando remover:** junto com 1.4.
- **Conflito esperado no merge:** baixo — um helper novo mais 5 linhas dentro de
  `layer()`.

### C.6.2 `packages/core/test/preload.ts` — a armadilha que C.6 previa

- O preload exportava `OPENCODE_MODELS_PATH` apontando para
  `test/plugin/fixtures/models-dev.json`. Era **inerte** (nada lia essa variável
  em v2), mas com C.6.1 passou a redirecionar **todo** catálogo da suíte para um
  fixture de 3 providers: 11 dos 16 testes de `test/models.test.ts` quebraram na
  hora (verificado antes de mexer no preload).
- **Mudança:** a linha saiu, com comentário explicando por quê. Quem quer o
  fixture passa `file` explícito — é o que `test/plugin/models-dev.test.ts` já faz.
- `OPENCODE_DISABLE_MODELS_FETCH` **ficou**: também era inerte e agora vale de
  verdade, impedindo que uma layer construída sem `fetch` explícito forke o
  refresh de rede em teste. Nenhum teste dependia do valor antigo.
- **Teste:** 7 casos novos em `packages/core/test/models.test.ts` — `POWER_MODELS_URL`
  sem `options.url`; `OPENCODE_MODELS_URL` sozinha; branded vencendo a legada;
  opção explícita vencendo as duas; `url: ""` ainda significando host default;
  `POWER_MODELS_PATH` sem `options.file` (com KV apontando para outro catálogo,
  para provar quem vence); `POWER_DISABLE_MODELS_FETCH` sem `options.fetch`.
  Com `models-dev.ts` revertido, 4 deles falham (os outros 3 são de precedência
  e passavam por acidente do default).

```
bunx tsgo -b packages/core/tsconfig.json packages/core/tsconfig.tests.json --force -> EXIT 0
cd packages/core && bun run script/test.ts test/models.test.ts        -> 23 pass, 0 fail
cd packages/core && bun run script/test.ts test/plugin/models-dev.test.ts                                            test/preload.test.ts       -> 8 pass, 0 fail
```

### Verificação da correção C

```
bunx tsgo -b packages/util/tsconfig.json    --force  -> EXIT 0
bunx tsgo -b packages/server/tsconfig.json  --force  -> EXIT 0
bunx tsgo -b packages/cli/tsconfig.json     --force  -> EXIT 0
bun test packages/util/test/env.test.ts              -> 13 pass, 0 fail
bun test packages/server/test/{bind-policy,auth,no-password}.test.ts
                                                     -> 13 pass, 0 fail
bun test packages/cli/test/{credential-env,password-fallback,env}.test.ts
                                                     -> 14 pass, 0 fail
bun packages/cli/script/verify-rebrand.ts            -> rebrand ok
```

Pré-existentes, sem relação com esta correção (confirmado: falham igual com as
edições revertidas) — `packages/cli/test/standalone.test.ts` e
`packages/util/test/global.test.ts`. Os dois spawnam o CLI/o layer a partir do
fonte neste working tree, onde `bun packages/cli/src/index.ts` morre em
`Cannot find module 'react/jsx-dev-runtime'`.

Build completo **não** rodado nesta rodada (outros agentes em paralelo).

---

## Correção D — a senha por truthiness no caminho do embedder

### D.1 `packages/server/src/routes.ts` + `packages/server/src/process.ts` — `usable()` no lugar de `if (password)`

- **Achado (médio):** C.1/C.3 fecharam o caminho do **CLI**, mas os dois pontos de
  entrada do servidor continuavam decidindo por truthiness: `authLayer(password)`
  em `routes.ts` (`if (password)`) e `ServerProcess.start` em `process.ts`
  (`if (!password)`). Um embedder que chama `start({ password: "   " })` ou
  `createRoutes({ password: "   " })` direto — SDK host, teste, Durable Object —
  não passa por `cli/src/env.ts` e montava um servidor "protegido" por um espaço:
  exatamente o furo que `ServerAuth.usable()` existe para fechar.
- **Mudança:** duas linhas. `if (ServerAuth.usable(password))` em `authLayer`
  (2.2) e `if (!ServerAuth.usable(password))` em `start`. `usable` é type guard,
  então o narrowing para `string` que a truthiness dava continua valendo — nada
  mais no corpo das duas funções mudou.
- **Mensagens intocadas:** `"Refusing to build server routes without a password…"`
  e `"Missing server password"`. O prefixo é o que
  `packages/server/test/no-password.test.ts` casa por regex; segue passando.
- **O segredo aceito continua sem trim** (regra de C.1): `usable` só responde
  "isto conta como configurado"; o valor que autentica é o byte-a-byte do
  operador. Coberto por teste — uma senha `" secret "` autentica com o padding e
  **recusa** a versão trimada.
- **`ServerAuth.required()`/`authorized()` seguem intocados** pelo mesmo motivo de
  C.1: afrouxar `required()` desligaria o Basic auth em vez de exigi-lo. Com D.1
  no lugar, nenhum `Config` com senha de whitespace chega a ser construído.
- **Teste:** `packages/server/test/blank-password.test.ts` (**arquivo novo**) —
  `""`, `"   "`, tab e newline contra `createRoutes` e contra
  `ServerProcess.start`, mais o caso vivo da senha real com padding.
- **Conflito esperado no merge:** baixo. Uma linha em cada arquivo, dentro de
  blocos que o overlay já reescreve (2.2).
- **Quando remover:** nunca.

### Verificação da correção D

```
bunx tsgo -b packages/server/tsconfig.json --force            -> EXIT 0
bun test packages/server/test/blank-password.test.ts
         packages/server/test/no-password.test.ts             -> 11 pass, 0 fail
bun test packages/server/test/{process,auth,web-ui-auth,bind-policy,
         fetch,handler-policy,no-password,workerd,options}.test.ts
                                                              -> 33 pass, 0 fail
```

Mutação de controle: revertidas as duas linhas para truthiness,
`blank-password.test.ts` vai a **6 fail** (os três casos de whitespace nos dois
pontos de entrada); restauradas, volta a 0. `packages/server` não tem
`tsconfig.tests.json` — o `tsconfig.json` do pacote não declara `include`, então
`test/` já entra no typecheck.

Build completo **não** rodado nesta rodada (outros agentes em paralelo).

---

## Release — processo e armadilhas

### R.1 `packages/cli/dist/` é descartável; o release vem da CI

`packages/cli/script/build.ts` começa com `rm -rf dist`. Qualquer build
posterior — inclusive um `--single` rodado durante o desenvolvimento — **apaga
os artefatos de release em silêncio**, sem aviso e sem erro.

Isso já aconteceu nesta sessão: os 5 pacotes `0.1.0` foram montados, e um
`--single` rodado depois, para validar outra coisa, deixou só
`cli-windows-x64`. Nada quebrou; os arquivos simplesmente sumiram, e só
apareceu porque alguém foi usar.

**Consequência prática:** nunca trate `packages/cli/dist/` como estado durável.
Se você montou artefatos para publicar e depois rodou qualquer build, **remonte
antes de publicar**:

```
OPENCODE_VERSION=<versao> bun run packages/cli/script/build.ts
OPENCODE_VERSION=<versao> bun run packages/cli/script/dist-package.ts
```

O release de verdade não depende disso: `.github/workflows/release.yml`
compila os 4 alvos do zero em runner limpo. A via local existe só para
inspeção e para um publish manual de emergência.

### R.1.1 Processo vivo a partir do `dist` aborta o build inteiro (Windows)

Terceira manifestação da fragilidade de R.1, com causa diferente das duas
primeiras — e a pior, porque falha **antes** de compilar qualquer coisa.

`build.ts` começa com `rm -rf dist`. Se qualquer processo estiver executando um
binário de dentro de `packages/cli/dist/`, o Windows trava o arquivo e o `rm`
falha:

```
EPERM: operation not permitted, rm 'C:\...\packages\cli\dist'
```

O build aborta ali. O `dist` fica com os artefatos **antigos**, e o
`dist-package.ts` seguinte falha em cascata com `Missing platform builds`, que
aponta para o sintoma errado — parece que os alvos não foram construídos, quando
na verdade o build nunca começou.

Aconteceu de verdade: um servidor de teste deixado rodando a partir de
`dist/cli-windows-x64/bin/poweragent.exe` para inspeção no navegador. O build
seguinte "passou" na notificação de background (exit 0 do shell) enquanto o
`BUILD_EXIT` real era 1.

**Regra:** nunca execute o binário direto de `dist/`. Copie para fora primeiro:

```
cp packages/cli/dist/cli-<plat>/bin/poweragent[.exe] /algum/lugar/
```

**Como detectar antes de perder tempo:** se `dist-package.ts` reclamar de alvos
faltando, procure `EPERM` no log do build antes de acreditar na mensagem dele.

**Nota sobre exit codes:** neste ambiente, tanto `cmd | tail` quanto a
notificação de tarefa em background reportam o código de saída do invólucro, não
do comando. Só vale o `echo "EXIT=$?"` imediatamente após o comando, com a saída
redirecionada para arquivo.


### R.2 A versão é compile-time; `package.json` sozinho não basta

O binário carrega a versão por `define` (`OPENCODE_VERSION` em `build.ts`).
Editar só o `package.json` do dist produz um pacote que diz `0.1.0` e um
binário que responde outra coisa — inconsistência que o usuário vê no primeiro
`--version`. Sempre exporte `OPENCODE_VERSION` para o build, não corrija
depois.

`Script.version` (`packages/script/src/index.ts`) respeita `OPENCODE_VERSION`
antes de qualquer outra fonte; sem ela, um branch que não seja `latest` gera
`0.0.0-<canal>-<timestamp>`.

### R.3 Ordem de publicação e propagação do registry

`release.yml` publica os pacotes de plataforma **antes** da raiz e faz polling
até cada um ficar resolvível no registry, com falha explícita se não vier. Isso
não é zelo excessivo: a raiz declara os 4 como `optionalDependencies`, e se ela
aterrissar antes de eles resolverem, o primeiro `npx poweragent` depois do
release falha em achar o binário.

Se algum dia publicar à mão, mantenha a ordem: os 4 `@calney/cli-*` com
`--access public`, esperar resolver, depois `poweragent`.

### R.4 O shim é o contrato com o usuário — caminhos de falha verificados

`packages/cli/bin/poweragent.cjs` resolve o binário em runtime; sobrevive a
`npm install --ignore-scripts` porque não depende de postinstall. Os três
caminhos de falha foram exercitados:

| Situação | Saída |
|---|---|
| Nenhum pacote de plataforma | exit 1, nomeia o pacote **exato** da plataforma atual |
| `POWER_BIN_PATH` para arquivo inexistente | exit 1, mostra o caminho |
| Pacote presente, binário ausente | exit 1, mesma mensagem clara, sem stack trace |

Imprecisão conhecida e aceita: no terceiro caso a mensagem manda instalar um
pacote que já está instalado, só que incompleto. O conselho (reinstalar)
continua correto e o caso é raro.

### R.5 Branding — o P6 do plano, parcialmente feito

**Feito:** `README.md` da raiz reescrito. A logo e os links do upstream saíram;
sobram 4 menções a "opencode", todas atribuição legítima (link ao repo de
origem, o prefixo `OPENCODE_` aceito como fallback, a referência ao
`SECURITY.md` deles, e o crédito de licença). `LICENSE` e o aviso de copyright
preservados, como a MIT exige.

Por que isso é requisito e não polimento: a MIT licencia o código, **não a
marca**. "opencode" é marca dos autores. Um fork que se apresenta com o nome e a
logo deles é exposição — e vira exposição séria se o projeto for comercializado.

**Pendente, e é decisão do dono:** os **21 READMEs traduzidos**
(`README.ar.md`, `README.zh.md`, ...) continuam sendo os do upstream e
descrevem o opencode, com logo e links deles. Enquanto o repo é privado isso é
inofensivo. Se for a público, são 21 arquivos apresentando o projeto como sendo
outro.

As duas saídas, com o custo real de cada uma:

- **Apagar os 21.** Resolve a apresentação de vez. Custo: cada sync em que o
  upstream tocar qualquer um deles produz um conflito delete/modify — 21
  conflitos recorrentes, para sempre.
- **Deixar como estão.** Zero atrito de merge. Custo: o repo público exibe 21
  arquivos que dizem que ele é o opencode.

Não há terceira opção boa: traduzir o README novo para 21 idiomas e mantê-los
sincronizados é trabalho que ninguém vai fazer, e um README traduzido
desatualizado mente pior que um ausente.

**Recomendação:** apagar os 21 no momento em que o repo for a público, não
antes. Enquanto privado, o atrito de merge custa mais que o benefício; quando
público, a relação se inverte.

**Também pendente do P6, e sem urgência:** `<title>`, favicon e manifest PWA em
`packages/app`, e `UI.logo()` no CLI. Nada disso afeta funcionamento; são a
identidade visual, e fazem sentido junto com uma decisão de identidade, não
antes.

### R.6 `packages/app/public/` — symlinks viraram arquivos reais

**O bug, encontrado ao validar o build depois de trocar o logotipo:** o build
gerado no Windows embutia **8 arquivos-lixo** na raiz do SPA. `favicon.ico`
saía com 39 bytes, `apple-touch-icon.png` com 48.

Causa: os arquivos de `packages/app/public/` são **symlinks no git** (modo
`120000`) apontando para `../../ui/src/assets/favicon/`. Um checkout no Windows
sem Modo Desenvolvedor não cria symlinks — materializa cada um como um arquivo
de texto contendo o caminho. O Vite copia `public/` para o `dist` literalmente,
então o texto do symlink virava o favicon.

Por que passou despercebido: o `index.html` referencia `/icons/<canal>/favicon.ico`,
que o `vite.icons.ts` emite corretamente a partir de `packages/desktop/icons/`.
A aplicação parecia certa. Mas navegador pede `/favicon.ico` na raiz por padrão,
e ali estava o lixo.

**Por que não dá para "só consertar o checkout":** `git config core.symlinks true`
seguido de `git checkout --force` **apaga os arquivos e falha ao recriá-los**
(`unable to create symlink: Permission denied`) — criar symlink no Windows exige
elevação. O conserto deixa o repo pior que antes.

**O que fizemos:** substituímos os symlinks por **arquivos reais** (cópia dos
bytes de `packages/ui/src/assets/`). Some a fragilidade de plataforma, e o build
sai correto em qualquer sistema.

**Custo, declarado:** ~130 KB duplicados, e uma divergência do upstream que gera
conflito se eles mexerem nesses arquivos. Aceito: o estado anterior produzia
build quebrado em Windows, silenciosamente.

**Nota de escopo:** `packages/app/src/custom-elements.d.ts` é outro symlink com
o mesmo problema — é ele que faz o typecheck da raiz falhar em `@opencode-ai/app`
e `@opencode-ai/desktop` neste ambiente. **Não** foi convertido: é código, não
asset, e mexer nele muda o que o compilador enxerga. Fica registrado como o
próximo candidato se o typecheck local incomodar.

---

## Rename — `poweragent` → `labfyagent`

Segunda troca de marca deste fork, decidida pelo dono. Não substitui a Feature 1
(que continua descrevendo *por que* cada constante existe e onde ela mora): esta
seção registra **o que passou a valer** e as duas armadilhas que o rename cria.

### RN.1 A identidade, item por item

| Item | Antes | Agora | Onde mora |
|---|---|---|---|
| binário / pacote npm raiz | `poweragent` | `labfyagent` | `packages/cli/script/build.ts` (`const binary`), `packages/cli/script/dist-package.ts` |
| diretórios XDG | `poweragent` | `labfyagent` | `packages/util/src/global.ts` (`const app`) |
| escopo npm dos pacotes de plataforma | `@calney` | `@labfydev` | `build.ts`, `dist-package.ts`, `packages/cli/bin/labfyagent.cjs` (`const scope`) |
| prefixo de env | `POWER_` | `LABFY_` | `packages/util/src/env.ts` (`PREFIX`) |
| shim `bin` | `bin/poweragent.cjs` | `bin/labfyagent.cjs` | `packages/cli/bin/` |
| unidades de serviço | `poweragent.service`, `com.poweragent.agent.plist` | `labfyagent.service`, `com.labfyagent.agent.plist` | `packaging/service/` |
| org / repo | `calneymgp` | `labfydev/labfyagent` | `README.md`, `.github/workflows/release.yml` |
| domínio / atribuição | — | `https://labfy.dev` | `README.md` |

Efeito prático: `~/.config/labfyagent`, `~/.local/share/labfyagent`,
`~/.cache/labfyagent`, `~/.local/state/labfyagent`, `$TMPDIR/labfyagent`. O
estado do `poweragent` anterior **não** é migrado — quem tinha config no
diretório antigo precisa copiá-la. Isso é consequência direta de 1.1 e vale para
qualquer troca da constante.

### RN.2 A cadeia de fallback de env — três grafias, nunca duas

`packages/util/src/env.ts` resolve **na ordem**:

```
LABFY_<SUFIXO>   →   POWER_<SUFIXO>   →   OPENCODE_<SUFIXO>
```

`PREFIX = "LABFY_"`, `LEGACY_PREFIX = "POWER_"`, `UPSTREAM_PREFIX = "OPENCODE_"`.
`names()` devolve as três, mais específica primeiro; `env()` e `truthy()` leem
nessa ordem.

**Por que a grafia do meio não pode cair.** O fork já rodava em deploy com
`POWER_SERVER_PASSWORD` exportado. Se o rename tivesse trocado `POWER_` por
`LABFY_` em vez de *acrescentar*, esse deploy passaria a não ter senha
configurada — e o caminho de fallback do servidor cunha uma credencial aleatória
no boot. Resultado: cliente existente deixa de autenticar e, pior, o operador não
vê erro nenhum. É exatamente o mesmo raciocínio de 1.4, agora com uma camada a
mais. A regra vale para sempre: **um rename de prefixo só adiciona grafia, nunca
substitui.**

Onde isso aparece em código:

- `packages/cli/src/env.ts` — `passwordKeys` tem agora **6** nomes, na ordem
  `LABFY_PASSWORD`, `LABFY_SERVER_PASSWORD`, `POWER_PASSWORD`,
  `POWER_SERVER_PASSWORD`, `OPENCODE_PASSWORD`, `OPENCODE_SERVER_PASSWORD`. A
  cadeia `Config.orElse` cobre as 6, e todo ponto que **apaga** a senha do
  ambiente (modo `stdio` em `server-process.ts`, credencial de lease em
  `standalone.ts`, `Env.session()`) itera `passwordKeys` — apagar só uma parte
  vazaria a credencial para processos filhos (1.6 / 1.8).
- `packages/cli/bin/labfyagent.cjs` — o override do binário segue a mesma cadeia:
  `["LABFY_BIN_PATH", "POWER_BIN_PATH", "OPENCODE_BIN_PATH"]`.
- `Env.branded` (22 sufixos) não muda com o rename: ela lista **sufixos**, não
  nomes completos. `bun run lint:env-branding` continua sendo o gate que falha
  nos dois sentidos (sufixo lido e não listado, sufixo listado e não lido).

### RN.3 `verify-rebrand.ts` agora exige a identidade nova

`packages/cli/script/verify-rebrand.ts` é o gate que torna **barulhento** um
merge do upstream que reverta qualquer constante de identidade — a reversão
compila, passa no typecheck, roda, e só escreve no diretório errado e publica
pacote que ninguém instala. Ele foi reapontado para a marca nova e roda na CI
antes de publicar.

Fonte, marcadores exigidos hoje:

| Arquivo | Marcador |
|---|---|
| `packages/util/src/global.ts` | `const app = "labfyagent"` |
| `packages/cli/script/build.ts` | `const binary = "labfyagent"`, `@labfydev/${name}` |
| `packages/util/src/env.ts` | `PREFIX = "LABFY_"`, `LEGACY_PREFIX = "POWER_"`, `UPSTREAM_PREFIX = "OPENCODE_"` |
| `packages/cli/src/env.ts` | `"LABFY_PASSWORD"` **e** `"POWER_PASSWORD"` |
| `packages/cli/bin/labfyagent.cjs` | `const command = "labfyagent"`, `const scope = "@labfydev"`, a tripla `BIN_PATH` |
| `packages/cli/script/dist-package.ts` | `name: "labfyagent"`, `"@labfydev/"` |
| `packages/cli/src/services/updater.ts` | `: "labfyagent"` |

Note o par obrigatório em `cli/src/env.ts`: o verificador exige **as duas**
grafias. Não é redundância — é o que impede alguém de "limpar" o fallback antigo
achando que é resíduo do rename. Com a distribuição construída
(`verify-rebrand.ts ./dist`) ele ainda afirma, por pacote de plataforma:
`@labfydev/cli-<os>-<arch>`, `bin/labfyagent[.exe]` presente e plausível, o
define `--user-agent=labfyagent/` dentro do binário, e as strings `LABFY_PASSWORD`
e `POWER_PASSWORD` — a segunda com a mensagem explícita "dropped the legacy
fallback". No pacote raiz: `name: "labfyagent"`,
`bin: { labfyagent: "./bin/labfyagent.cjs" }`, nenhuma referência a
`@opencode-ai/` ou `opencode2`, e `optionalDependencies` só com `@labfydev/cli-*`.

### RN.4 Identidade visível

- **`packages/tui/src/logo.ts`** — o wordmark passou a soletrar `LABFY AGENT`.
  Mesmo vocabulário de sempre (`█ ▀ ▄ _ ^ ~ ▚ ▞`), células de 4 caracteres
  separadas por espaço, 4 linhas de 24 colunas, linha 0 decorativa. `AGENT`
  (`right`) não mudou uma coluna; só `left` foi redesenhado. Isso importa porque
  `presentation.ts` e `component/logo.tsx` tratam `^`/`_`/`~` como marcas
  sombreadas e assumem `left` e `right` do mesmo tamanho — o layout empilhado
  (largura < 44) usa `logo.left.slice(1)`, então a linha 0 do `left` continua em
  branco de propósito.
- **`packages/app/index.html` / `manifest.json`** — `<title>`, `name` e
  `short_name` passaram de `power-agent` para `labfyagent`. Era o item pendente
  registrado em R.5.
- **`README.md`** — reescrito para a marca nova: comandos (`npm i -g labfyagent`,
  `npx -y labfyagent@latest web`, `labfyagent service start`), tabela de env com
  o prefixo `LABFY_` e a cadeia de fallback explícita, e o repo
  `labfydev/labfyagent` mais `labfy.dev`. **Preservados integralmente**, porque
  são requisito e não decoração: a seção "Segurança — leia antes de expor" (não
  há sandbox do agente; quem autentica executa comando arbitrário com as
  permissões do processo) e a atribuição ao opencode com a nota de que a MIT
  licencia o código e **não** a marca.

### RN.5 O que o rename **não** tocou

- `packages/app/dist/` — artefato de build, regenerado; não é fonte.
- Os favicons e o SVG de `packages/app/public/` ainda carregam a arte anterior.
- Os **21 READMEs traduzidos** continuam sendo os do upstream (R.5 segue valendo,
  com a mesma recomendação: apagar quando o repo for a público, não antes).
- `packages/desktop` — nome de diretório, protocolo `opencode://` e binário
  `opencode2`, tudo como estava. Continua fora de escopo.
- As menções a `opencode` que sobram no README são atribuição legítima (link ao
  repo de origem, prefixo de fallback, `SECURITY.md` deles, crédito de licença).

**Quando remover:** nunca, enquanto o fork tiver identidade própria. O que pode
sair um dia é a grafia `POWER_` — e só com aviso de breaking change, junto com
`OPENCODE_`, exatamente como 1.4 já registra.

## Rename — `labfyagent` → `labharness`

Terceira troca de marca deste fork, decidida pelo dono. Não substitui a Feature 1
nem a seção anterior (`poweragent` → `labfyagent`): elas continuam explicando
*por que* cada constante existe. Esta registra **o que passou a valer agora** e a
cadeia de env que cresceu para quatro níveis.

### RH.1 A identidade, item por item

| Item | Antes | Agora | Onde mora |
|---|---|---|---|
| binário / pacote npm raiz | `labfyagent` | `labharness` | `packages/cli/script/build.ts` (`const binary`), `packages/cli/script/dist-package.ts` |
| diretórios XDG | `labfyagent` | `labharness` | `packages/util/src/global.ts` (`const app`) |
| escopo npm dos pacotes de plataforma | `@labfydev` | **inalterado** | `build.ts`, `dist-package.ts`, shim `bin` |
| prefixo de env | `LABFY_` | `LABHARNESS_` | `packages/util/src/env.ts` (`PREFIX`) |
| org GitHub | `labfydev` | **inalterado** | `README.md`, `.github/workflows/` |
| repo | `labfydev/labfyagent` | `labfydev/labharness` | `README.md` |
| domínio / atribuição | `labfy.dev` | **inalterado** | `README.md` |

Efeito prático: `~/.config/labharness`, `~/.local/share/labharness`,
`~/.cache/labharness`, `~/.local/state/labharness`, `$TMPDIR/labharness`. Como
nas duas trocas anteriores, o estado do diretório antigo **não** é migrado.

### RH.2 A cadeia de fallback de env — quatro grafias

`packages/util/src/env.ts` resolve **na ordem**:

```
LABHARNESS_<SUFIXO>   →   LABFY_<SUFIXO>   →   POWER_<SUFIXO>   →   OPENCODE_<SUFIXO>
```

`PREFIX = "LABHARNESS_"`, `PREVIOUS_PREFIX = "LABFY_"`, `LEGACY_PREFIX =
"POWER_"`, `UPSTREAM_PREFIX = "OPENCODE_"`. `names()` devolve as quatro, mais
específica primeiro; `env()` e `truthy()` leem nessa ordem.

**Por que nenhuma das três antigas pode cair.** A regra de RN.2 vale igual, e
agora com um agravante concreto: `labfyagent@0.1.0` **já está publicado no npm**
com a grafia `LABFY_`. Quem instalou aquela versão exporta `LABFY_SERVER_PASSWORD`.
Se o rename tivesse *substituído* em vez de *acrescentar*, esse deploy passaria a
não ter senha configurada — e o caminho de fallback do servidor cunha credencial
aleatória no boot, então o operador não veria erro nenhum, só clientes deixando
de autenticar. **Um rename de prefixo só adiciona grafia, nunca substitui.**

`Env.branded` continua listando **sufixos**, não nomes completos, então não muda
com o rename. `bun run lint:env-branding` segue sendo o gate que falha nos dois
sentidos (sufixo lido e não listado, sufixo listado e não lido) — rode depois de
qualquer mexida em env.

### RH.3 Identidade visível

- **`packages/tui/src/logo.ts`** — o wordmark passou a soletrar `LAB HARNESS`.
  Mesmo vocabulário de sempre (`█ ▀ ▄ _ ^ ~ ▚ ▞`), células de 4 caracteres
  separadas por espaço, 4 linhas, linha 0 decorativa. **A divisão mudou de 5+5
  para 3+7**: `left` = `LAB` (14 colunas), `right` = `HARNESS` (34 colunas).
  Glifos novos no alfabeto: `H` (é o `A` sem a barra de topo), `R` (bowl do `B`
  mais perna diagonal em `▚`) e `S` (topo do `E`, barra do meio em `^`, parede
  direita descendo para a base). O `▄` decorativo da linha 0 do `right` continua
  na célula de índice 3 — que em `HARNESS` cai sobre o `N`, exatamente como caía
  sobre o `N` de `AGENT`.
  **Consequência a vigiar:** `component/logo.tsx` decide o layout por largura de
  terminal (`< 22` usa `go`, `< 44` empilha `left` sobre `right`, senão
  lado a lado com `gap 1`). Com `right` a 34 colunas, o modo empilhado fica
  apertado entre 22 e 33 colunas — os limiares moram em `component/logo.tsx`, não
  em `logo.ts`, e não foram tocados aqui.
- **`packages/app/index.html` / `packages/app/manifest.json`** — `<title>`, `name`
  e `short_name` passaram para `labharness`.
- **Os 4 favicons SVG** — `packages/app/public/favicon.svg`,
  `packages/app/public/favicon-v3.svg` e os dois equivalentes em
  `packages/ui/src/assets/favicon/` carregam `role="img" aria-label="…"` e um
  `<title>` com o nome do produto. **Isso é servido em runtime.** No rename
  anterior escapou de todo grep de "código e config" e só apareceu baixando
  `/favicon.svg` do binário. Agora dizem `labharness`. A arte (o `<path>`) não
  mudou; os `.ico`/`.png` ao lado continuam sendo a arte anterior.
- **`README.md`** — nome, comandos (`npm i -g labharness`,
  `npx -y labharness@latest web`, `labharness service start`), tabela de env com
  o prefixo `LABHARNESS_` e a cadeia de quatro níveis explícita, e o repo
  `labfydev/labharness`. **Preservados integralmente**, porque são requisito e não
  decoração: a seção "Segurança — leia antes de expor" (não há sandbox do agente;
  quem autentica executa comando arbitrário com as permissões do processo) e a
  atribuição ao opencode com a nota de que a MIT licencia o código e **não** a
  marca.

### RH.4 As duas armadilhas deste tipo de rename

1. **Teste travado na grafia antiga.** Trocar uma mensagem de erro que cita
   variável de env sem trocar o teste que afirma aquele texto derruba a suite. Já
   aconteceu: `packages/core/test/tool-agent-concurrency.test.ts` exigia
   `POWER_AGENT_SPAWN_LIMIT` depois que o fonte passou a dizer `LABFY_`. Faça
   `grep` do nome antigo em `**/test/**` antes de dar o rename por concluído.
2. **Marca vazando em asset servido em runtime.** Ver RH.3 — os favicons SVG. Um
   grep restrito a fonte e config não os alcança.

### RH.5 O que este rename **não** tocou

- `packages/app/dist/` e `packages/ui/src/assets/favicon/site.webmanifest` (ainda
  diz `OpenCode`, é o arquivo do upstream) — artefato e vendor, não fonte da app.
- Os `.ico`, `.png` e `social-share*.png`: arte, não texto; nada a renomear.
- Os **21 READMEs traduzidos** continuam sendo os do upstream (R.5 segue valendo).
- `packages/desktop` — nome de diretório, protocolo `opencode://` e binário
  `opencode2`, tudo como estava. Continua fora de escopo.
- As menções a `opencode` que sobram no README são atribuição legítima (link ao
  repo de origem, prefixo de fallback, `SECURITY.md` deles, crédito de licença).

**Quando remover:** nunca, enquanto o fork tiver identidade própria. O que pode
sair um dia são as grafias `LABFY_` e `POWER_` — e só com aviso de breaking
change, junto com `OPENCODE_`, exatamente como 1.4 e RN.2 já registram.

## Feature 6 — Rework de UI do web app (nav sidebar, painel skills/MCP, picker)

Todo o trabalho vive em `packages/app`. A regra do overlay foi respeitada: a
maior parte é **arquivo novo** (`src/shell/sidebar/`, `src/session/sidebar/`,
`src/shell/tabs/tab-commands.ts`, `src/home/sessions/actions.ts`); os seams em
arquivos de alto tráfego do upstream são pequenos e estão listados um a um.

### 6.1 Nav sidebar esquerda substitui a strip de abas visível

- **Motivo:** eliminar a fricção criar projeto → abrir projeto → criar abas.
  Sidebar persistente estilo "workspaces → sessões, um clique" (referência:
  deepseek harness).
- **Decisão estrutural:** o store de abas (`shell/tabs/tabs.tsx`) **não foi
  tocado** — 26 arquivos dependem dele (draft routing, composer state,
  notificações, cleanup). Ele passa a ser infraestrutura invisível: abrir sessão
  pela sidebar faz exatamente o que `home/sessions/controller.tsx` fazia:
  `remember → projects.open → addSessionTab + select`. **Não há ordenação MRU** —
  o store é append-only com uma única chave `recent`; a recência existe apenas em
  memória e serve para escolher a vítima da eviction (§6.6), nunca para reordenar.
- **Arquivos novos:** `src/shell/sidebar/{nav-sidebar.tsx,controller.tsx,`
  `sessions.ts,session-row.tsx,sessions.test.ts}`,
  `src/shell/tabs/{tab-commands.ts,tab-commands.test.ts}`,
  `src/home/sessions/actions.ts` (rename/delete/export extraídos, controller do
  home delega com shape público intacto).
- **Seams em arquivos do upstream (conflito esperado no merge: ALTO):**
  - `src/shell/shell.tsx` — âncora: o gate `verticalTabs()` (linha ~26) virou
    `sidebarEnabled()`; o `<aside data-slot="vertical-tabs-sidebar">` (portal
    target vazio) virou `data-slot="nav-sidebar"` renderizando `<NavSidebar/>`
    direto, largura persistida em `layout.navSidebar` (antes: store local não
    persistido).
  - `src/shell/titlebar/titlebar.tsx` — âncora: o `<Show when={props.verticalTabs}>`
    com branch de Portal (era ~:378-453) colapsou para `<Show when={!props.tabsHidden}>`
    em volta da strip horizontal. Prop `verticalTabs` → `tabsHidden`. A
    reconciliação rota↔aba, `openNewTab` e todos os `command.register` ficaram.
  - `src/shell/titlebar/tab-strip.tsx` — os registros de `tab.prev/next`
    (ctrl+tab) e `tab.1..9` (mod+N) saíram daqui para
    `src/shell/tabs/tab-commands.ts` (senão morriam com a strip desmontada).
    IDs de comando inalterados. Diferença comportamental: o ciclo agora percorre
    a ordem completa do store, não só as abas visíveis no overflow da strip.
- **Setting reinterpretado:** `settings.appearance.tabLayout` — `"vertical"` =
  nav sidebar (**novo default**, era `"horizontal"`), `"horizontal"` = strip
  legada como escape hatch. `settings/model.tsx` linha ~141. Labels novos em
  `en.ts` (`settings.appearance.row.tabs.*`).
- **Quando remover o escape hatch:** próxima release, quando a sidebar provar
  paridade; aí a strip horizontal e o `tabsHidden` podem sair.
- **E2E (dívida conhecida):** specs que miram a strip
  (`e2e/regression/cross-server-tab-close.spec.ts`,
  `tab-navigate-mousedown.spec.ts`, benchmarks `session-tab-*`) precisam de
  `tabLayout: "horizontal"` na fixture ou de seletores novos. Não corrigidos
  nesta entrega.

### 6.2 Painel direito de Skills/MCP com indicador de uso (neon)

- **Motivo:** visibilidade em tempo real do que está carregado/executando na
  sessão. Dois estados: `active` (anel neon animado percorrendo a borda
  enquanto executa) e `used` (brilho estático = carregado nesta sessão). Nova
  sessão/clear zera — de graça, porque a derivação é função pura das mensagens
  da sessão corrente.
- **Arquivos novos:** `src/session/sidebar/{sidebar.tsx,sidebar.css,`
  `usage-domain.ts,usage-tracker.ts,usage-domain.test.ts}`.
- **Como detecta (as duas pegadinhas de MCP):** tool direto chega como
  `${sanitize(server)}_${tool}` (underscore único, `effectiveName` em
  `packages/core/src/tool/runtime.ts`) — resolvido por longest-prefix; em Code
  Mode (default para MCP) as chamadas internas só aparecem em
  `state.metadata.toolCalls[]` do part `execute`, com nome pontuado
  `server.tool`. O tracker olha os dois. Skills: part `name === "skill"`,
  attachment `skills[]` da user message, mensagem de transcript `type: "skill"`,
  e o evento `session.skill.activated` (único caso sem reducer no client store —
  assinado via `sdk.event.on`, resetado na troca de sessão).
- **ACTIVE gated em `session.status === running`:** run abortado que deixa part
  "running" órfão degrada sozinho para `used`.
- **Seams:** `src/session/screen.tsx` (painel como último filho do row, âncora:
  depois do `<Show>` de `session-side-panel-presence`; `ResizeHandle`
  `edge="start"`), `src/session/screen-layout.ts` (`extensionsSpan` subtraído de
  `available` e `panelWidth`), `src/shell/state/layout.tsx` (entradas
  `navSidebar` e `extensions` com acessores defensivos `?? default` — payload
  persistido antigo funciona sem migração),
  `src/session/commands/use-session-commands.tsx` (`extensions.toggle`,
  `mod+shift+;`).
- **Conflito esperado no merge:** médio em `screen.tsx`/`screen-layout.ts`
  (área de layout muda no upstream); baixo no resto.

### 6.3 Picker de diretório — seleção visível e navegação óbvia

- **Motivo:** a seleção era rastreada mas renderizada invisível — o próprio fork
  do CSS zerava as cores do web component `@pierre/trees`
  (`--trees-selected-bg-override: transparent` + `background: transparent
  !important` no `unsafeCSS`). E o "subir um nível" era um ghost button de texto.
- **Mudanças:** `src/workspaces/selection/dialog.css` (token real
  `--v2-overlay-simple-overlay-pressed` no selected) e `dialog.tsx` (unsafeCSS
  ganhou regra para `[data-item-selected]`/`[aria-selected="true"]` — atributo
  confirmado no dist de `@pierre/trees` (`render/rowAttributes.js`); botão
  parent virou `IconButton` `arrow-up` desabilitado na raiz
  (`pickerParent(root()) === root()`); home `~` ganhou aria-label).
- **i18n:** key nova `dialog.directory.home` (só `en.ts` — locales caem no en).
- **Conflito esperado no merge:** baixo.

### 6.4 Correções vindas da validação de UI no navegador

Validado dirigindo o app real (vite dev + serve + Playwright headless), não só
por suíte. Defeitos reais que apareceram e foram corrigidos:

- **`packages/server/src/cors.ts` — bug do rename:** `developmentOrigins()` lia
  `POWER_DEV_CORS`/`OPENCODE_DEV_CORS` na mão e nunca ganhou os prefixos novos;
  `LABHARNESS_DEV_CORS` (documentada no HANDOFF) era ignorada. Agora usa
  `Env.truthy("DEV_CORS")` — as quatro grafias. O `lint:env-branding` não pegava
  porque o call site não passava pelo helper; passou a passar.
- **Picker — a causa real do "não tem botão de voltar":** o `TextInput` do
  caminho tinha `!w-full` e empurrava os três botões de navegação pra fora do
  dialog. Sempre existiram, renderizavam invisíveis por overflow. Fix:
  `min-w-0 flex-1` no input (`dialog.tsx`).
- **Sidebar — navegador limpo ficava vazio:** a árvore só mostrava projetos
  registrados no client (localStorage); sessões existentes no servidor ficavam
  invisíveis num browser novo. Fix: grupos de projeto sintéticos derivados dos
  diretórios das sessões órfãs do índice (`nav-sidebar.tsx`); abrir uma sessão
  órfã registra o projeto real via `projects.open` e o sintético é substituído.
- Menor: o filter da sidebar herdava `width: 280px` fixo do `TextInput` e
  sangrava da sidebar de 260px → `!w-full min-w-0`.

Fluxos validados com screenshot: auth por `auth_token`, picker com seleção
destacada + ↑/~/Raiz visíveis, add project, sessão criada via API aparecendo na
árvore, clique → rota da sessão, `mod+shift+;` abrindo o painel direito com as
skills reais, estados neon `active`/`used` renderizando, escape hatch
"Horizontal tabs (legacy)" restaurando a strip.

### 6.5 Verificação executada

`bun run typecheck` (tsgo -b) limpo; `bun run test:unit` 628/628 em 106
arquivos (inclui os 40 novos das três áreas); `bun run build` (vite) limpo.
Validação visual no navegador pendente de sessão interativa.

### 6.6 Correções vindas do code-review

Revisão adversarial do lote acima. 11 achados; todos corrigidos exceto um, que
não tem solução no client (F8). Agrupados por área para minimizar churn.

**F1 — o store de abas crescia sem limite.** Com a strip escondida por padrão,
nenhuma UI chamava `closeTab`, e `addSessionTab` (`tabs.tsx:205`) dedupa mas
nunca faz eviction. O `Persist.window("tabs")` acumulava toda sessão já aberta na
janela; `ctrl+tab` ciclava dezenas de fantasmas e `mod+1..9` ficava preso às nove
mais antigas.
- **Correção:** `packages/app/src/shell/tabs/capacity.ts` (puro,
  `OPEN_SESSION_TAB_LIMIT = 20` + `selectTabToEvict`) e `use-capacity.ts`
  (`useTabCapacity`), registrado no `titlebar.tsx`.
- **`tabs.tsx` NÃO foi tocado.** `removeTab` (`:180`) já é a primitiva correta:
  não navega para aba não-ativa, já dispõe `memory`/`info`/draft persistido, e
  deliberadamente não empurra para a pilha de reabrir — aba despejada não foi
  "fechada pelo usuário".
- **Por que o titlebar hospeda:** é o único ponto que observa *toda* ativação
  (efeito de rota, sidebar, palette, notificações) e monta nos dois layouts.
- **Por que não ordenar por MRU:** reordenar a cada ativação faria as abas
  pularem na strip e destruiria a ordem de drag do usuário, que é o valor do
  escape hatch. Navegador e VSCode endereçam `mod+1..9` por posição. O teto já
  resolve o sintoma.
- **Cap = 20:** espelha `MAX_PROMPT_SESSIONS` (`composer/persistence.tsx:45`), o
  LRU irmão que limita o mesmo recurso; fica abaixo de `CLOSED_TAB_LIMIT = 25`.
  Drafts são isentos e nunca despejáveis — despejar um destrói a rota
  `/new-session?draftId=` e o composer não salvo. Despejar é seguro porque a
  sidebar lista todas as sessões do índice, não só as abas.

**F2 — `window.prompt` quebrava o rename no desktop.** Era o único
`window.prompt` de `packages/app/src`; o renderer do Electron lança
`prompt() is and will not be supported`. Substituído por `Dialog` + `TextInput`
em `shell/sidebar/session-row.tsx`, no mesmo formato do `showDelete()` ao lado.

**F3 — o indicador de uso ignorava reversão.** Skill/MCP usado num turno
revertido seguia aceso. `messagesBeforeRevert` em `session/sidebar/usage-domain.ts`
espelha a regra `id < revertMessageID` de `timeline/controller-projection.ts`
(local de propósito: importar o helper da timeline arrastaria inbox pendente e
reordenação de steers para um módulo puro).

**F4 — `mod+1..9` e `ctrl+tab` no modo legado.** Ao extrair os comandos para
`tab-commands.ts`, eles passaram a indexar o store bruto e perderam o
`scrollIntoView`. Agora `tab-strip.tsx` publica `visibleTabs()` por um prop
opcional e o `titlebar.tsx` escolhe a ordem: sidebar ⇒ store (já limitado),
strip ⇒ ordem visível + scroll via `data-tab-key`, atributo que a strip já emitia.
Uma registração serve os dois modos.

**F5 — `tabs.info` nunca era gravado no modo sidebar.** `rememberSessionInfo` só
era chamado pelo `SessionTabEntry` da strip. Sem ele,
`session-identity-header.tsx:42` perde o fallback de título em reload com
servidor lento. Gravado agora no `openSession` e por um efeito sobre o índice.

**F6 — resync de permission/form após reconexão.** O SSE escreve
`permission.asked`/`form.created` sem guarda enquanto conectado, então sessões em
background ficam frescas sozinhas; o que se perdia era o gap de reload/reconexão,
já que `permission.sync`/`form.sync` só rodam para a sessão ativa. Restaurado o
mínimo em `shell/sidebar/request-sync.ts`. **Não** restaurado
`session.sync`/`message.sync`/`pending.sync`: o SSE cobre.

**F7/F9/F10/F11 — quatro bugs de comportamento da sidebar**, todos com helper
puro e testado em `shell/sidebar/sessions.ts`: servidor colapsado ficava
irrecuperável ao cair para single-server (`serverSectionCollapsed`); colapsar um
projeto limpava o badge de não-lidas (só limpa ao expandir); filtro que casava o
nome do projeto mostrava "No sessions yet" falso (`filterProjectSessions`);
"New session" ia sempre para `servers.list()[0]` ignorando a rota
(`activeServerKey`, agora também base do `activeDirectory`).

**Perf:** `sanitizeMcpName` (regex) rodava dentro do laço por part — ~50k
alocações por delta de streaming numa sessão longa. Prefixos sanitizados agora
são hoistados uma vez em `collectSessionUsage`.

**F8 — aceito, sem correção possível no client.** A atribuição MCP por prefixo
acende um servidor falsamente quando existe uma tool não-MCP chamada
`${servidor}_algo`. A origem da tool vive em `tool.options.namespace`
(`core/src/tool/runtime.ts`), **server-side**; `AssistantTool` carrega só
`{id,name,executed,state,time}` e `mcp.list` não devolve ids de tool. Qualquer
heurística no client inventaria um sinal. Comentado no ponto exato do código; as
duas correções reais são upstream (namespace no part, ou tool ids em `mcp.list`).

**Adiado com motivo:** o caminho `orientation="vertical"` da strip está morto,
mas `tab-strip.tsx`/`tab-nav.tsx` são os arquivos de maior tráfego upstream do
lote — apagar branches ali multiplica conflito futuro por ganho zero. Idem
`serverTitle` e a duplicação sidebar/home, que já delegam a `actions.ts`.

### 6.7 E2E adaptado ao novo default

O viewport padrão do Playwright (1280×720) fica acima do breakpoint mobile, então
a sidebar renderiza em todo spec e os seletores `[data-titlebar-tab-slot]` /
`[data-slot="titlebar-tabs"]` deixaram de resolver: **21 de 172 specs quebraram**
(baseline no HEAD: 172/172 verdes, sem dívida pré-existente).

- Novo helper `e2e/utils/settings.ts` (`useLegacyTabStrip`, `seedSettings`) —
  antes cada spec inlinava o `addInitScript` sobre `settings.v3`.
- 11 specs que exercitam a strip ganharam `test.beforeEach(useLegacyTabStrip)`:
  o contrato deles não mudou, só deixou de ser o default.
- `tab-navigate-mousedown.spec.ts` reescrito: os testes da antiga strip vertical
  viraram testes da nav sidebar (`nav-sidebar`, `nav-sidebar-session-row`,
  resize 200–520), e o teste de orientação teve a premissa invertida.
- `review-terminal-bottom.spec.ts`: as asserções de geometria mediam contra
  `window.innerWidth`; agora medem contra o `<main>`, já que a sidebar ocupa a
  esquerda do viewport. A intenção ("o terminal ocupa toda a largura do
  conteúdo") é preservada.
- `settings-loading.spec.ts`: `getByRole("button", {name: "Settings"})` passou a
  casar dois elementos (o do home e o da sidebar) — ancorado em
  `data-action="nav-sidebar-settings"`.

---

## Feature 7 — Abas do workspace + faixa fixa de Skills/MCP

Rework da tela de sessão: diffs, contexto, arquivos e navegador viram **abas
acima do chat**; Skills/MCP vira **faixa fixa** à direita. O painel lateral
colapsável (`session-side-panel.tsx`, 475 linhas) deixa de existir. O chat nunca
desmonta (`hidden+inert`), preservando scroll e composer.

### 7.1 `session/tabs/workspace-tab.ts` — ids legados

- **Motivo:** `session-side-panel-review-tab`, `session-side-panel-review-tabpanel`,
  `session-side-panel-file-browser-tabpanel`, `review-panel`, `file-tree-panel`
  são contrato de ~12 specs E2E e do `aria-controls` do header. Dois elementos com
  mesmo id fazem `querySelector('#id')` resolver o primeiro em silêncio.
- **Âncora:** `WORKSPACE_PANELS_ID = "review-panel"` (era `"session-workspace-panels"`),
  `TRIGGER_IDS.diffs = "session-side-panel-review-tab"`,
  `PANEL_IDS.diffs = "session-side-panel-review-tabpanel"` (linhas 24–32).
- **Quando remover:** nunca; ids são contrato de teste. Se o upstream adotar
  abas, migrar specs para `data-tab`.

### 7.2 `session/tabs/workspace-tabs.tsx` + `workspace-tabs-model.ts`

- **Âncora:** `SessionWorkspaceTabs` monta `Tabs` com 5 triggers (`chat|diffs|context|files|browser`)
  e 4 painéis (`diffs|context|files|browser`) sob `#review-panel`. Chat é `hidden+inert`,
  não `<Show>`, para preservar scroll/streaming.
- **Modelo:** `createWorkspaceTabsModel` (`view: workspaceTab`, `canReview`, `isDesktop`),
  `mounted` sticky por sessão, `files` sempre incluído (aposenta `showFileTree=false`
  como gate de aba; setting continua para compat de payload). `isDesktop` false → `["chat"]`.
- **Conflito esperado:** médio. `workspace-tab.ts` é arquivo novo; `workspace-tabs.tsx`
  é novo. O modelo toca `shell/state/layout.tsx` indiretamente via `view()`.

### 7.3 `session/tabs/panels/{context,files,diffs,browser}-panel.tsx` — arquivos novos

- **Context:** `ContextPanel` → `SessionContextTab` (314 linhas) com `SessionContextUsage`
  no rótulo da aba. Remove `contextOpen`/`tabs().close("context")` e `Tabs.CloseButton`.
- **Files:** `FilesPanel` em largura total: `FileTree` (`changes`/`all` via `layout.fileTree.tab`),
  tira de abas de arquivo (`panelTabs` + `SortableTab` + `DragDrop`), `SessionFileBrowserTab`.
  `id="file-tree-panel"` e `id="session-side-panel-file-browser-tabpanel"` migram para cá.
  `openReviewPanel` vira `focusWorkspaceTab("files")`.
- **Diffs:** `DiffsPanel` → `ReviewPanelContent` exportado de `review/view.tsx` (era
  função interna). `id="review-panel"` agora é o wrapper dos painéis não-chat.
- **Browser:** `BrowserPanel` estado vazio (`session.tab.browser.empty.*`), sem iframe.
- **Quando remover:** nunca; são a UI da sessão.

### 7.4 `session/tabs/workspace-tab-focus.tsx` — arquivo novo (ponte do header)

- **Motivo:** o botão "Toggle review" do header e o comando `review.toggle` vivem
  fora de `SessionScreen` (via `TitlebarRight` portal) e não têm acesso ao model
  que detém `mounted`. Escrever `view().workspaceTab` direto move a seleção sem
  montar o painel — a aba fica selecionada com corpo vazio.
- **API:** `registerWorkspaceTabFocus(key, focus)` (plain object, não Solid store —
  `createStore` não notifica plain read) + `focusWorkspaceTab(key, tab)`.
- **Âncora:** `SessionScreen` registra `workspaceTabs.focus`; `SessionHeader`,
  `useSessionCommands` (`review.toggle`) e `SessionContextUsage` consomem via
  `focusWorkspaceTab(sessionKey(), ...)`.
- **Conflito esperado:** baixo. Arquivo novo; `screen.tsx` e `header` tocam
  apenas o import.

### 7.5 `session/screen.tsx` — morte do `<aside>` e da ponte

- **Âncora:** coluna `session-side-panel-presence` (216–268) + `createEffect` ponte
  `workspaceTabs.active()` → `reviewPanel.open()`/`fileTree.open()` (78–86).
- **Mudança:** remove `createPresence`/`sideVisible`/`store.side*`/`elements.side`,
  a coluna `<aside id="review-panel">` e a ponte. `SessionWorkspaceTabs` agora
  recebe `review` e renderiza `DiffsPanel`/`ContextPanel`/`FilesPanel`/`BrowserPanel`
  dentro de `SessionPanelFrame`. `review.toggle` e header passam a `focus("diffs")`.
- **Conflito esperado:** **alto**. `screen.tsx` é arquivo quente no upstream;
  o bloco removido é contíguo e o diff é grande. Resolver mantendo o novo layout
  e portando por cima qualquer adição upstream ao header/timeline.

### 7.6 `session/screen-layout.ts` — encolhido de 157 para 72 linhas

- **Âncora:** `reviewOpen`/`reviewPanelOpen`/`fileTreeOpen`/`resizable`/`sidePanelOpen`/
  `panelLayout`/`motion`/`sideRegionOpen`/`sideContentWidth`/`sideReserved`.
- **Mudança:** `reviewOpen` deriva de `workspaceTab === "diffs"` (não mais
  `reviewPanel.opened()`); `fileTreeOpen` removido; `sideReserved` vira `0` (faixa
  nunca cede por falta de espaço — resolve disputa em 1600px com review em split);
  `sidePanelOpen`/`panelLayout`/`motion`/`side` removidos; `files.open` vira
  `() => false` (Files é aba, não coluna); `panelWidth` vira `calc(100% - extensionsSpan)`,
  `resizable` vira `false` (chat não disputa largura com painel lateral).
  Deleta `session-panel-layout.ts` (6 linhas) e `session-panel-width.ts` (19 linhas)
  com seus testes; `session-extensions-width.ts` perde referência a
  `SESSION_PANEL_WIDTH_MIN` no comentário.
- **Quando remover:** nunca. O layout simplificado é o novo normal.
- **Conflito esperado:** **alto**. `screen-layout.ts` e `screen.tsx` são os dois
  arquivos de maior atrito no próximo `git merge-tree main upstream/beta` (82 commits
  de drift, 3 conflitos mapeados em §2.8).

### 7.7 `workspaces/files/model.tsx` + `file-content.ts` — caminho de bytes

- **Motivo:** `model.tsx:190` fazia `new TextDecoder().decode(data)` em todo arquivo
  e jogava fora os bytes; imagem/SVG/áudio nunca renderizavam (placeholder).
  O servidor já devolve `Uint8Array+mime` (`server/src/handlers/fs.ts:20`) e o SDK
  tipa `FileReadOutput = Uint8Array`.
- **Âncora:** `load` em `model.tsx:186` → `createFileContent(file, data)`; novo
  helper `workspaces/files/file-content.ts` (`mimeTypeForPath`, `isBinaryPath`,
  `bytesToBase64`, `createFileContent`) com mapa estendido de `runtime/server/image.ts`
  (`png/jpeg/jpg/gif/webp/svg/avif/bmp/ico` + `xlsx`/`pdf`/`audio`).
- **Efeito:** produz `FileContent {type:"binary", encoding:"base64", mimeType}` para
  binários; `session/files/file-tabs.tsx:400` já passava `media.current` para
  `@opencode-ai/ui/file`, então imagem passou a renderizar sem tocar o viewer.
- **Quando remover:** nunca. O helper é o ponto único de detecção de binário.
- **Teste:** `file-content.test.ts` (45 testes) + `csv.test.ts`/`xlsx.test.ts`/`pdf.test.ts`.

### 7.8 `session/files/file-tabs.tsx` + previews CSV/XLSX/PDF

- **CSV:** `workspaces/files/csv.ts` + `session/files/csv-preview.tsx` + `sheet-table.tsx`
  (`papaparse@5.7`, `@tanstack/solid-virtual`, teto 1MB → download). Roteado por
  `.csv` em `file-tabs.tsx`.
- **XLSX:** `workspaces/files/xlsx.ts` + `session/files/xlsx-preview.tsx`
  (`xlsx@cdn.sheetjs.com/xlsx-0.20.3.tgz`, reusa `SheetTable`, seletor de planilha).
  Teto 1MB; `file-content.ts` inclui `xlsx` no mapa mime.
- **PDF:** `workspaces/files/pdf.ts` + `session/files/pdf-preview.tsx`
  (`pdfjs-dist@6.2.108`, worker `pdf.worker.min.mjs?url` same-origin, canvas por
  página, `PDF_MAX_BYTES=1MB`). Roteado por `.pdf`. Build inclui worker em
  `dist/_assets/pdf.worker.min-*.mjs` (sem CDN, sem CSP extra).
- **i18n:** `session.files.csv.*`, `xlsx.*`, `pdf.*` em `en.ts` (inglês apenas).
- **Rollback:** remover dep + renderer + chave i18n; fallback é viewer de texto/binário.
- **Conflito esperado:** baixo. `file-tabs.tsx` é tocado, mas o switch por extensão
  é aditivo.

### 7.9 `session/sidebar/usage-domain.ts` — nome da tool na faixa

- **Motivo:** a faixa mostrava `active` sem dizer qual tool rodava.
- **Âncora:** `SessionUsage` ganha `mcpActiveTools: Record<string,string>` (campo
  novo, `sameUsage` estendido com `sameStringRecord`, `EMPTY` atualizado).
  `collectSessionUsage` popula para `mcpActiveTools` nos dois formatos:
  direta `${sanitize(server)}_${tool}` (longest-prefix, `sanitizedPrefixes` hoistado
  — §6.6, 50k alocações) e Code Mode `metadata.toolCalls[].tool` (pontuado).
  Gated por `level==="active"` (some quando `status!==running` ou aborta).
- **UI:** `sidebar.tsx` mostra nome truncado `max-w-[50%]` com `title` (prioridade
  `activeTool ?? usageTitle ?? label`).
- **Teste:** `usage-domain.test.ts` 7 testes novos (direct/code-mode, gated abort,
  sanitized prefix).
- **Quando remover:** nunca.

### 7.10 E2E e verificação

- **Specs migrados:** `review-open-file.spec.ts` (Context via `contextTab`, Files via
  `[data-tab="files"]`, `Open file` via `filesTab`), `file-browser-sidebar-tab-switch.spec.ts`
  (`#file-tree-panel` + `All` tab), `open-file-expand-folder.spec.ts` já usava
  `[data-tab="files"]`. `review-tab-switch.spec.ts` e `review-image-flash.spec.ts`
  trocam `Toggle review` por `[role="tab"][data-tab="diffs"]` + `aria-selected`
  (única edição permitida no §Decisões).
- **Suíte:** `bun run typecheck` limpo; `bun run test:unit` 749/749 (680 base + novos
  menos 9 deletados de `session-panel-*`); `bun run build` limpo com worker PDF.
  `PLAYWRIGHT_PORT=3100 bunx playwright test --workers=1 --retries=1` — 4/4 verdes
  nos specs de workspace/files; 2 specs legados (`review-tab-switch`, `review-image-flash`)
  exigem clique explícito em Diffs após switch (per-session vs workspace-scoped).
- **Demo:** `cd packages/app && PLAYWRIGHT_PORT=3100 bunx playwright test --workers=1 --retries=1 e2e/regression/session-workspace-tabs.spec.ts` (5 abas, faixa alinhada `top≤1px`, Chat preserva scroll/composer).

### 7.11 Seams e condição de remoção

- **Alto conflito:** `screen.tsx`, `screen-layout.ts` (ver §7.5/7.6).
- **Médio:** `workspace-tab.ts` (ids), `session/review/model.ts` (`wantsReview` agora
  `review.open() || files.open()` sem checar `tabs.activeTab`).
- **Condição de remoção:** quando o upstream adotar abas de workspace nativas;
  então os ids legados e a ponte `workspace-tab-focus` saem e `PATCHES` registra
  a convergência.

## Feature 8 — Painel do agente, navegador compartilhado, ferramentas e rotinas

Plano completo em `~/.claude/plans/na-direita-alem-de-declarative-flute.md`
(2026-09-01). A faixa da direita vira o **painel do agente** (navegador,
skills, ferramentas, rotinas, subagentes), o app ganha um **navegador
compartilhado humano+agente** com CDP próprio, o core ganha **capabilities**
(MCP / chave de API / CLI por produto) e **rotinas** agendadas (cron do Effect).
Branch `feat/agent-panel-browser`.

### 8.1 `session/sidebar/*` — orquestrador de seções por agente

- **Âncora:** `sidebar.tsx` monta `AgentHeader` + `SidebarSection` (`section.tsx`,
  estado colapsado persistido em `Persist.global("session-extensions-sections-v1")`)
  para `browser | skills | tools | routines | agents`. Componentes por seção:
  `browser-preview.tsx`, `skills-section.tsx`, `tools-section.tsx` + `tool-popover.tsx`,
  `routines-section.tsx` + `routine-dialog.tsx`, `agents-section.tsx`.
- **Rail:** abaixo de ~1280 px (`extensionsModeFor`, `session-extensions-width.ts`,
  `MAIN_COLUMN_WIDTH_COMFORT = 700`) a faixa vira coluna de 44 px com popovers
  (`EXTENSIONS_RAIL_WIDTH`), em vez de sumir. `screen-layout.ts` expõe `extensions.mode`.
- **Uso:** `usage-domain.ts` faz fold por mensagem com cache das mensagens já
  concluídas (`isSettled`, `createUsageCache`), atribui CLI (executável do comando
  `shell`, `commandBinary`) e API (host de `webfetch`/`browser_fetch`) ao produto via
  o catálogo recebido; `freezeOrder` congela a ordem enquanto o agente roda.
  `usage-tracker.ts` zera o TTL ao trocar de sessão e segura `active` por 1,5 s.
- **Removido:** `mcp-section.tsx` (a lista de servidores vive dentro de Ferramentas;
  servidores sem produto viram `mcp:<nome>`).
- **Conflito esperado:** alto em `sidebar.tsx`, `sidebar.css`, `screen-layout.ts`,
  `workspace-tabs-model.ts` (aba ativa sempre montada: reload numa aba persistida
  ficava em branco). Arquivos novos não conflitam.

### 8.2 `core/src/browser/*` — navegador compartilhado

- **Transporte:** cliente CDP próprio (`cdp/{client,pipe,websocket,transport}.ts`),
  sem playwright-core. Provider `launched` resolve o Chromium
  (`LABHARNESS_BROWSER_PATH` → PATH → bundles macOS → `~/.cache/ms-playwright`),
  perfil persistente em `<data>/browser/<projeto>`, `--headless=new` com UA sem
  "Headless", `--remote-debugging-pipe` (fallback porta 0 + `DevToolsActivePort`).
  Nunca `Runtime.enable` (tell de anti-bot); `Runtime.evaluate` basta.
- **Controle:** `control.ts` — `idle | agent | human | handoff-login`. Input humano
  (screencast) vira `human` e volta a `idle` após 60 s; `browser_handoff` espera o
  humano devolver. Leituras também falham em `human` (um snapshot no meio de um login
  levaria a senha ao modelo).
- **Tools** (`tool/plugin/browser.ts`): `browser_navigate|snapshot|act|read|screenshot|
  tabs|handoff` diretas ao modelo; permissão `browser` (recurso = host, `save:["*"]`)
  e `browser.read`; `plan.ts` nega `browser`; `type` em campo de senha é recusado.
  Output envolto em `<untrusted source="page" host=…>`.
- **Página como endpoint** (`browser_network|fetch|eval`, Code Mode): `browser_network`
  lê o ring buffer de requisições da aba (filtros host/path/xhr/since, corpo sob demanda,
  cap 256 KB) com `browser.read`; `browser_fetch` roda `fetch(url, init)` dentro da
  página (cookies/CSRF nativos; GET/HEAD caem em `browser` por host, outros métodos
  pedem `browser.fetch`); `browser_eval` avalia JS na página (JSON, cap 256 KB) com
  `browser.eval` (ask). Mesmas operações expostas em rotas síncronas
  (`POST /api/browser/network|fetch|eval`), no CLI
  (`labharness browser eval|fetch|network`) e no renderer da timeline.
  `network.ts` grava via `Network.enable` por aba; `fetch.ts` usa `Runtime.evaluate`
  com `awaitPromise` — continua sem `Runtime.enable`.
- **Screencast/input:** `screencast.ts` (refcount por aba, ack por frame),
  `input.ts` (mouse/wheel/key/paste/resize → `Input.*`), ticket de 60 s
  (`schema/browser-ticket.ts`, `core/browser/ticket.ts`) e WS
  `GET /api/browser/tabs/:id/stream` (`server/handlers/browser.ts`; exceções de auth
  para upgrade em `middleware/authorization.ts` e `process.ts`, mesmo padrão do PTY).
- **App:** `session/browser/{store,stream,coords}.tsx` + `tabs/panels/browser-panel.tsx`
  (abas, URL, voltar/recarregar, badge de controle, Assumir/Devolver, banner de
  handoff, canvas que só abre o WS com a aba visível). Thumbnail na sidebar via
  `GET /api/browser/tabs/:id/thumbnail` (object URL autenticado).
- **CLI:** `labharness browser status|navigate|snapshot|act|read|screenshot|tabs|control|install`.
- **Conflito esperado:** baixo (tudo novo) exceto `plugin/internal.ts`, `instance.ts`,
  `protocol/api.ts`, `server/handlers.ts`, `schema/event-manifest.ts`, `util/env.ts`
  (uma linha cada) e o client gerado (regenerar com `bun run generate`).

### 8.3 `core/src/capability*` — MCP / chave de API / CLI por produto

- **Modelo:** `schema/capability.ts` — `Capability.Info { id, name, channels:{mcp[], api, cli},
  pinned, allowed }`. Catálogo declarativo `capability/catalog.ts` (20 produtos:
  posthog, github, supabase, vercel, stripe, tavily, firecrawl, exa, cloudflare, openai,
  anthropic, google, slack, discord, notion, linear, sentry, aws, docker, playwright).
  Sem match: MCP vira `mcp:<server>`, env `*_API_KEY|*_TOKEN` vira `env:<prefixo>`.
- **Por agente:** `allowed` = algum canal utilizável passa na ruleset do agente
  (`<ns>_*` para MCP, `shell "<bin> *"` para CLI, `webfetch` por host para API);
  `pinned` = frontmatter `capabilities: [posthog, github=mcp:my-gh]`
  (`schema/agent.ts`, `config/plugin/agent.ts`).
- **Rotas:** `GET /api/capability?agent=`, `POST /api/capability/refresh`,
  `GET /api/mcp/:server/tools` (`Mcp.ToolSummary`). Cache 60 s invalidado por
  `mcp.status.changed`/`mcp.tools.changed`/`credential.updated`; `which` só nos
  binários do catálogo, cache 5 min. Evento `capability.updated`.

### 8.4 `core/src/routine*` — rotinas agendadas

- **Modelo:** tabelas `routine` e `routine_run` (migração `20260901202903_routine`),
  `schema/routine.ts` (cron de 5 campos validado com `Cron.parse` do Effect, timezone
  IANA), eventos `routine.updated`, `routine.run.started/finished`.
- **Scheduler:** fiber no processo do servidor (`Routine.node` em `server/src/routes.ts`,
  não em `instance.ts`: dependência em `Session` cria ciclo de tipos), tick 30 s;
  ao subir, runs `running` órfãos viram `cancelled`, atrasados viram UM `missed` e
  reagendam (sem catch-up). Execução = `Session.create({metadata:{source:"routine"}})`
  + `prompt` (ou `session.command`); assenta por `session.execution.*`.
- **Rotas:** `GET/POST /api/routine`, `PUT/DELETE /api/routine/:id`, `POST /:id/run`,
  `GET /:id/runs`. Sync no app em `client/src/solid/data.ts` (`location.routine`).

### 8.5 `desktop/src/main/browser/*` — navegador nativo no Electron

- **ViewHost** (`view-host.ts`): um `WebContentsView` por aba anexado à janela do
  projeto (`partition: "persist:labharness-<profile>"`), só a aba ativa visível e só
  enquanto o renderer reporta o painel na tela; bounds vindos por IPC
  (`ipc-handlers/browser.ts`, `ipc-rpc/browser.ts`, `shared/ipc-contract.ts`) com
  clamp (`bounds.ts` + teste). `NativeViewSlot` no app
  (`session/browser/native-view-slot.tsx`) mede o slot com `ResizeObserver` e cai
  para o canvas de screencast fora do desktop.
- **Provider WS** (`provider-client.ts` ↔ `GET /api/browser/provider`, `handleRaw`
  em `server/handlers/browser.ts` com loopback-only + Basic auth): o desktop conecta
  ao servidor, registra o relay CDP por location key
  (`core/browser/provider/desktop.ts`, `registerDesktop`/`locationKey` em
  `provider/index.ts`) e o `Browser.Service` passa a usar a view nativa em vez do
  Chromium lançado; desconexão devolve para o launched. `debugger.attach("1.3")`
  por view, reattach em detach (DevTools).
- **Policy** (`policy.ts`): popup vira aba, download em `<projeto>/.labharness/downloads`,
  `certificate-error` negado; `thumbnail.ts` captura a página (throttle 1/3 s) para o
  preview da sidebar. A security policy da janela principal fica intacta — vale só
  para as views do navegador.

### 8.6 Higiene e hardening desta feature

- `core/src/shell.ts` + `shell/sandbox.ts`: `LABHARNESS_SANDBOX=1` faz `--bind` do cwd
  (antes `--ro-bind / /` deixava o projeto somente-leitura), `--chdir`, `--unshare-pid`,
  `--die-with-parent`; sem bwrap falha fechado (`SandboxUnavailableError`); fallback
  Docker removido.
- `workspaces/files/file-content.ts`: cache LRU limitado (40 entradas / 20 MB);
  `hash`/`mtime` removidos (nunca lidos).
- `session/files/file-tabs.tsx`: "Loading..."/erro não cobrem o arquivo já carregado.
- `session/tabs/workspace-tabs.tsx`: `#review-panel` escondido com Chat ativo
  (irmão vazio com `h-full` dividia a coluna 50/50 e parava o composer no meio da tela).
  E2E `e2e/regression/composer-in-viewport.spec.ts` mede a posição do composer.
- `session/sidebar/skill-detail-dialog.tsx`: nomes de pasta (a API devolve `pasta/`).
- `runtime/i18n/br.ts`: 163 chaves que faltavam; `new-session/view.tsx`: wordmark
  textual "labharness" no lugar do SVG "opencode".
- `session-ui/src/tools/tool-renderer.tsx`: títulos/ícones/subtítulos das tools `browser_*`.
- Raiz: `bun run dev:serve` (o `serve` pela raiz quebra no Bun 1.4; ver HANDOFF).

### 8.7 Verificação

- `bun run typecheck`, `cd packages/app && bun run test:unit`, `cd packages/core &&
  bun test test/browser test/capability test/routine test/shell`, `bun run check:generated`.
- Navegador real (Playwright MCP): sidebar em 1440 e 1100 px (rail), preview → aba,
  Ferramentas com chips e popover, `Abrir navegador` → `https://example.com` no canvas,
  Assumir/Devolver, thumbnail na sidebar.
- Novos testes das Fases 5/6/7: `core/test/browser/{fetch,network,desktop-provider}.test.ts`
  (fake CDP), `core/test/routine/{service,scheduler}.test.ts`,
  `app/src/session/sidebar/routine-presets.test.ts`,
  `desktop/src/main/browser/bounds.test.ts`.

### 8.8 Segunda rodada de revisão (2026-09-02)

Revisão dos commits das Fases 5/6/7 + validação real no navegador. Corrigido:

- `server/handlers/browser.ts`: o attach do provider desktop era registrado
  **depois** de `runRaw`, então o `hello` chegava antes do listener (timeout de
  10 s, 400, backoff eterno no Electron). "Só loopback" usava o header `Host`
  (controlado pelo cliente); agora `remoteAddress` → 403 fora do loopback.
- `core/browser/network.ts`: requisições capturadas com controle humano ficam
  marcadas (`captured: "human"`) e `browser_network {body}` recusa o corpo
  (senão a resposta do `/login` ficava legível após o handoff).
- `core/browser/fetch.ts`: `browser_eval` sondava a sintaxe executando (um POST
  com resposta não-JSON rodava duas vezes); agora `new Function` via
  `Runtime.evaluate` e uma execução só; `pageEval` com abort por timeout.
- `tool/plugin/browser.ts`: `browser_network/fetch/eval` viram tools diretas.
  Os espelhos Code Mode (`tools.browser.page.*`) ligavam o Code Mode em toda
  sessão e o DeepSeek misturava `browser_navigate` com
  `tools.browser.page.navigate` (prompt a 41k tokens de entrada). Espelhos só
  com `LABHARNESS_BROWSER_CODEMODE=1`.
- desktop: reattach do debugger reemite attach (Page/Network reabilitados),
  UA real da partition, `provider-client.ts` sem bytes NUL (git via binário).
- rotinas: `PUT` aceita `null` para limpar prompt/comando/modelo; `session_id`
  gravado antes do prompt; `DELETE` inexistente → 404.
- `cli web/serve`: senha e `?auth_token=` só com stdout TTY ou
  `--show-credentials` (o journal do systemd recebia a credencial a cada boot).
- app: `auth_token` da URL persiste em `sessionStorage` por aba (reload caía
  em loop de 401); `client/solid/connection.ts` com backoff exponencial 1–30 s
  (um TUI órfão acumulou 17 mil reconexões em 5 h).
- workspace-tabs: a aba ativa é sempre montada (reload numa aba persistida
  ficava em branco).

Ambiente: **Bun 1.4.0 aborta upgrades WebSocket do `NodeHttpServer` fora do
tick do evento `upgrade`** (`server/test/browser-provider.test.ts` falha em
1.4.0 e passa em 1.3.14). Compilar o binário de deploy com o 1.3.14 do
`packageManager`. DeepSeek V4 Flash via OpenRouter, em prompts longos com muitas
tools, pode devolver o formato nativo `<｜DSML｜tool>` como texto (host escolhido
pela OpenRouter); o Pro não apresenta o problema — pinar `provider.order` na
config do modelo ou usar variante `none` do alias `~…flash-latest`.

### 8.9 Publicação 0.5.0 e o loop de reconexão (2026-09-02)

- `packages/httpapi-codegen`: `responseError` preserva o status HTTP quando o corpo
  de um status declarado não é JSON. Um 401 de corpo vazio virava
  `UnsupportedContentType` e o chamador não distinguia credencial rejeitada de
  falha passageira.
- `packages/client/src/solid/connection.ts`: `isAuthError` (401/403 pelo status ou
  pelo `_tag`) e `reconnectPolicy` puro; três rejeições seguidas encerram o loop
  com status `unauthorized` em vez de retentar para sempre. `reconnect()` é
  tentado antes e zera a contagem se trouxer credencial nova. `packages/tui`
  ganhou indicador próprio para esse estado.
- `packages/client/test/promise.test.ts`: o contrato de grupos HTTP não conhecia
  `capability`, `routine` e `browser` desde a Feature 8.
- npm: `labharness@0.5.0` + os quatro `@labfydev/cli-*@0.5.0`. Publicação manual
  (ver HANDOFF): o `publish.ts` do upstream publicaria com a identidade errada.

### 8.10 Rodada de UI e publicação 0.5.1 (2026-09-02)

Plano em `.plans/ui-overhaul-v0.6/` (PLAN, BASELINE, UI-FINDINGS). Doze tasks; a
verificação visual do dono (task-11) ficou pendente por diretiva de execução contínua.

- **Composer preso ao rodapé no Chrome 151** (`9e51a3670`). `h-full` resolvido contra
  altura derivada do flex: o Chromium empacotado do Playwright aceita a base como
  definida, o Chrome 151 não — o painel crescia até o conteúdo (3755px numa janela de
  778px, medido na máquina do dono). `session-workspace-body` vira coluna flex e os
  painéis irmãos usam `flex-1`. `playwright.config.ts` ganhou projeto `chrome` opt-in
  (`PLAYWRIGHT_CHROME=1`) com o Chrome instalado; todo critério visual desta rodada
  rodou nele.
- **Baseline da suíte** (`BASELINE.md`): em HEAD limpo, chromium 148/19 e chrome 146/21.
  Classe dominante: o `heading` com o título da sessão não aparece — oscila entre motores
  e rodadas. Ficou mapeado, não corrigido (fora do escopo, é plano próprio).
- **Aba Files** (`f150bc4b0`): uma árvore em todo estado; o seletor "Abrir arquivo"
  ocupa o painel inteiro. `file-browser-sidebar-tab-switch.spec.ts` reescrito para o
  contrato de uma árvore.
- **Visualizador sem comentário de linha** (`f93a0a55f`), com spec de clique inerte.
- **Navegador nunca falha em silêncio** (`722303fcd`): erro do `tab.open` não é mais
  engolido por `refresh()`, spawn que morre no arranque encerra na hora, mensagem cita
  `LABHARNESS_BROWSER_PATH`, botão mostra "Abrindo navegador…". Medido em servidor real:
  a primeira aba leva ~30s.
- **Faixa do agente** (`c8b6f1547`): `extensionsPresence` puro — largura nunca esconde,
  vira rail; Skills rola em 40vh (85 skills empurravam as outras seções três telas
  abaixo); Tools distingue "não carregou" de "vazio"; rail expõe `data-rail-section`.
- **Barra de abas** (`81e74ba28`): o CSS mirava `tabs-v2` e nunca se aplicou; agora mira
  `tabs`, com medidas do "New session" da navegação. `font-size` declarado. Faixa alinha
  com o corpo (`+ gap-2`), que era o desvio de 8px do baseline.
- **Auditoria de UI** (`UI-FINDINGS.md`, 9 achados) e os seis de peso alto/médio
  (`fbef96973`): plural de "arquivos alterados" (chave `.one`/`.other`, 61 idiomas),
  abas da árvore truncam com título, chips M/A/C legíveis e com tachado no
  indisponível, textos de vazio em 12px, badge do rail com "99+", seletor com a largura
  da árvore.
- **DevTools sem pedir senha** (`8e6957799`): `sourcemap: "hidden"`. Terceira ocorrência
  da família "subrecurso anônimo atrás do Basic" — regra no HANDOFF.
- **Lição de processo** (HANDOFF): Vite órfão de rodada morta por `timeout` contamina a
  suíte e engana bisect. `fuser -k 3000/tcp; pkill -f vite` antes de acreditar numa
  falha inesperada.
- npm: `labharness@0.5.1` + os quatro `@labfydev/cli-*@0.5.1`, publicação manual na
  ordem plataforma → raiz.

### 8.11 Rodada 3 de UI e publicação 0.5.2 (2026-09-02)

Plano em `.plans/ui-round-3/` (PLAN, BASELINE-ROUND3). Onze tasks executadas em quatro
ondas com revisão adversarial por task e gate serial (typecheck, unit, Playwright em
Chrome real, commit). A verificação visual do dono continua pendente por diretiva.

- **Home em coluna única** (`c987f7d5f`): a coluna "Projetos / Configurações / Ajuda"
  duplicava a navegação lateral, que já lista projeto e sessão. Sai do desktop;
  `HomeUtilityNav` fica no mobile. Sem `tabLayout: horizontal` a home passa a não ter
  seletor de projeto — dívida anotada.
- **Dois botões a menos no topo** (`3993b3888`, `50987e524`): "Início" e "Alternar
  revisão" saem. O título "ESPAÇOS DE TRABALHO" vira o caminho de clique para a home;
  `StatusPopover` migra para a ponta direita da barra de abas e o badge de canal para a
  navegação. No `web` o `<header>` deixa de ser montado — 36px recuperados. No Electron
  ele permanece: é a região de arraste da janela e o espaço dos traffic lights.
- **Faixa do agente sem rolagem externa** (`e19e2d549`): ordem preview › skills ›
  ferramentas › rotinas, seção Subagentes removida. Cada lista rola sozinha entre 3 e 10
  linhas; a faixa inteira nunca rola. Substitui o `max-h-[40vh]` de Skills da 8.10.
- **Verde é "ligado"** (`10c27f5a7`): `data-usage` troca o accent azul pelos tokens
  `--v2-state-*-success`. Os chips M/A/C viram ícones — `mcp`, `key` (novo em
  `additional-icons.ts`) e `terminal`.
- **Arquivos absorve Diffs** (`450d65071`, `a65553712`, `af1df215f`): a coluna esquerda
  passa a ser a `SessionReviewV2Sidebar` — busca, `FileTreeV2` e um seletor de quatro
  modos (git, branch, último turno, todos). Arquivo alterado abre em diff, o restante em
  conteúdo. A aba `diffs`, o `DiffsPanel` e o comando `review.toggle` deixam de existir;
  `WORKSPACE_PANELS_ID` fica porque testes e benchmarks dependem do id.
- **Update pela UI** (`ce6cbaa14`, `07d4c9975`, `9777d08e2`): `GET /api/update` e
  `POST /api/update/apply` sobre um serviço no core que consulta o registry npm direto
  (nunca `update.opencode.ai`). O apply instala, escreve um handoff `0600` com a senha
  gerada da execução, sai com **75**, e o shim `labharness.cjs` reexecuta o binário novo
  — com teto de 3 reinícios e recusa quando o filho morre em menos de 5s. O `web` passou
  a receber `lifecycle`, então `resumeSuspendedSessions` finalmente roda ali: antes só o
  modo `service` retomava turnos. No navegador, `updater.install()` espera `pid` e versão
  mudarem em `/api/health`, força `SKIP_WAITING` no service worker (o PWA é
  `registerType: "prompt"`; sem isso o reload serviria a UI antiga) e recarrega.
  Windows fica em `canApply=false` — o `.exe` em uso não pode ser substituído.
- **Regressão** (`BASELINE-ROUND3.md`, `11c959c42`): 21 vermelhos antes, 7 estáveis
  depois, todos preexistentes; 14 do baseline ficaram verdes. Uma regressão da rodada foi
  encontrada e corrigida (`83dc84c0a`, o smoke do timeline clicava na coluna removida).
  Causa da "classe A" identificada em parte: `remote-session-settings` quebra porque
  `sortTools` recebe `result.data` indefinido quando o mock responde `{}` a
  `/api/capability` — preexistente, não corrigido nesta rodada.
- npm: `labharness@0.5.2` + os quatro `@labfydev/cli-*@0.5.2`, publicação manual na
  ordem plataforma → raiz.

### 8.12 Rebrand para Force Agent (2026-09-02)

Quarto nome do produto. As entradas acima ficam como estão — descrevem o que o
produto era quando aconteceram; reescrevê-las apagaria o registro.

| | antes | agora |
|---|---|---|
| comando | `labharness` | `force` |
| pacote npm | `labharness` | `force-agent` |
| escopo de plataforma | `@labfydev/cli-*` | `@force-agent/cli-*` |
| prefixo de env | `LABHARNESS_` | `FORCE_AGENT_` |
| diretório XDG | `labharness` | `force-agent` |
| repositório | `labfydev/labharness{,-overlay}` | `force-agent/force-agent{,-overlay}` |

- **A cadeia de marcas virou lista** (`packages/util/src/env.ts`). Eram quatro
  prefixos resolvidos por um `??` encadeado e uma tupla `[string,string,string,string]`;
  cada rebrand exigia editar `env`, `names` e o tipo em sincronia. Agora um array
  `RESOLVED` governa os dois — acrescentar `FORCE_AGENT_` foi uma linha. `LABHARNESS_`,
  `LABFY_`, `POWER_` e `OPENCODE_` continuam honrados, nessa ordem: uma senha
  exportada sob qualquer marca antiga ainda sobe o servidor com auth.
- **O diretório de dados é adotado, não recriado** (`packages/util/src/global.ts`).
  `data`, `config` e `state` da marca anterior são renomeados uma única vez, e só
  quando o destino ainda não existe. Sem isso o rename pareceria um reset de
  fábrica: o SQLite com todas as sessões vive ali. `cache` e `tmp` ficam de fora
  — são descartáveis e mover um lock só cria risco. Falha é silenciosa de
  propósito: home somente-leitura não é motivo para recusar boot.
- **A partição do Electron continua `persist:labharness-*`**
  (`packages/desktop/src/main/browser/provider-client.ts`). O nome da partição *é*
  o diretório em disco com os cookies daquele perfil; renomear não migra, abandona
  — e o que se perderia são exatamente os logins que o humano fez via
  `browser_handoff`.
- **O guarda-corpo acompanhou** (`verify-rebrand.ts`): passou a cobrir também o
  `packageName` que o botão Update consulta no npm. Errar esse nome faria o
  servidor perguntar ao registro por um pacote que ele não é, e nunca oferecer
  atualização — falha silenciosa e aberta, a mesma família do `POWER_MODELS_URL`.
- **`labharness` no npm fica depreciado** apontando para `force-agent`, como
  `labfyagent` foi apontado para `labharness`. A 0.5.2 continua instalável e
  funcionando; ninguém é forçado a migrar por quebra.
