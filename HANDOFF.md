# force agent — handoff

Estado em 2026-08-31. Este arquivo é o que uma sessão nova precisa ler antes de tocar em
qualquer coisa. O **PATCHES.md** (92 seções) é a referência detalhada de cada divergência
do upstream; este aqui é o mapa.

---

## O que é

Fork overlay de [`anomalyco/opencode`](https://github.com/anomalyco/opencode), branch
**`beta`** (a linha v2 — **não** `dev`, que é a v1.18.x). MIT.

Herda 75+ provedores, runtime de sessões, terminal no navegador (ghostty-web) e a UI
embutida no binário. Acrescenta quatro coisas:

1. **`rlm()`** — `tools.agent.spawn/wait/list/stop` chamável de dentro do CodeMode. Spawn
   bloqueante por padrão devolvendo a resposta como **valor do programa**; `background: true`
   como opt-in. Semáforo de concorrência governando os dois modos e teto de spawns por
   execução.
2. **Gate de aprovação multi-agente** — afirma em **runtime**, no spawn real. A análise
   estática por regex foi provada contornável com uma função auxiliar + `.map()`.
3. **Postura fail-closed** — recusa bind em interface alcançável sem credencial usável
   (recusa com erro, não aviso); senha só de espaços não conta; concessões de CORS a
   terceiros removidas.
4. **Modo determinístico** — sob flag, toda leitura do relógio do host dentro do CodeMode
   lança.

---

## Publicado

| | |
|---|---|
| npm | `force-agent` + `@force-agent/cli-{linux-x64,linux-arm64,darwin-arm64,windows-x64}` (Feature 8). `labharness@0.5.2` é o último sob o nome antigo, hoje depreciado |
| GitHub | `github.com/force-agent/force-agent-overlay` (privado, onde se trabalha) · `github.com/force-agent/force-agent` (público, vitrine) |
| Instalação | `npm i -g force-agent` · `npx -y force-agent@latest web` · o comando é `force` |
| Legado | `labfyagent@0.1.0` publicado e **depreciado** apontando para cá |

Verificado instalando do registry público com `--ignore-scripts`: o npm resolve o pacote
de plataforma sozinho e o shim acha o binário sem postinstall. Na 0.5.0 isso foi
reconfirmado com o npm 11, que agora **bloqueia postinstall por padrão** em install
global: a instalação funciona mesmo assim, que é exatamente o motivo do shim existir.

> **Publicar é manual.** `packages/cli/script/publish.ts` ainda carrega a identidade do
> upstream (`binary: "opencode2"`, `packagePrefix: "@opencode-ai/cli-"`) e publicaria com
> os nomes errados. O caminho usado: `bun run script/build.ts` (com o Bun do
> `packageManager`), `bun run script/dist-package.ts`, e então `npm publish --access public`
> em cada `dist/cli-*/` **antes** de `dist/force-agent/` — o pacote raiz declara os de
> plataforma como `optionalDependencies` e a `0.4.1` foi ao ar apontando para um
> `cli-linux-x64@0.4.1` que nunca existiu, deixando o Linux x64 sem binário.

---

## Ambiente — leia antes de rodar qualquer comando

**Bun `^1.3.14`.** O `packageManager` da raiz é `bun@1.3.14` e
`packages/script/src/index.ts` recusa versões fora do range. No PC do Calney
(Windows) havia um bun 1.3.10 antigo no PATH, daí o `export
PATH="/c/Users/usuar/.bun/bin:$PATH"` espalhado pelo histórico — isso é
específico daquela máquina. Em outra máquina basta `bun --version` estar em
1.3.14+.

**Exit code só vale assim:**

```
cmd > /tmp/x.log 2>&1; echo "EXIT=$?"
```

Pipe (`cmd | tail`) e notificação de tarefa em background devolvem o código do
**invólucro**, não do comando. Isso produziu três diagnósticos errados nesta sessão.

**Nunca execute o binário de dentro de `packages/cli/dist/`.** O build começa com
`rm -rf dist`; um processo vivo trava o diretório e o build aborta com `EPERM` — e o
`dist-package.ts` seguinte falha com *"Missing platform builds"*, que aponta o sintoma
errado. Copie para fora antes de rodar.

**`dist/` não é estado durável.** Qualquer build posterior apaga tudo em silêncio.
Remonte antes de publicar:

```
OPENCODE_VERSION=<v> bun run packages/cli/script/build.ts
OPENCODE_VERSION=<v> bun run packages/cli/script/dist-package.ts
```

**A versão é compile-time.** Editar só o `package.json` do dist produz pacote que diz uma
coisa e binário que responde outra. Sempre exporte `OPENCODE_VERSION`.

---

## Variáveis de ambiente

Cadeia de fallback de quatro níveis, nesta ordem:

```
LABHARNESS_<X>  →  LABFY_<X>  →  POWER_<X>  →  OPENCODE_<X>
```

Nunca quebre as antigas: perder a variável de senha faz o servidor subir **sem
autenticação**. As oito grafias de senha foram testadas uma a uma, com as outras sete
removidas do ambiente.

| Variável | Efeito |
|---|---|
| `LABHARNESS_SERVER_PASSWORD` | credencial do servidor |
| `LABHARNESS_BIN_PATH` | aponta o executável (também respeitado pelos instaladores) |
| `LABHARNESS_DEV_CORS` | libera localhost como origem, só em desenvolvimento |
| `LABHARNESS_CODEMODE_DETERMINISTIC` | bloqueia leitura do relógio no CodeMode |
| `LABHARNESS_AGENT_CONCURRENCY` | teto de subagentes simultâneos |

Uma `LABHARNESS_*` não reconhecida gera aviso no start com o nome exato. O contrato entre
a lista `Env.branded` e os call sites reais é verificado por `bun run lint:env-branding`,
que roda na CI. **Ele já se rompeu uma vez** — rode depois de mexer em env.

---

## Continuar em outra máquina (ex.: macOS)

O repo é **privado**: autentique antes (`gh auth login`).

```bash
git clone https://github.com/force-agent/force-agent-overlay.git
cd force-agent-overlay
git checkout feat/nav-sidebar-ui-rework   # PR #1, ainda não mergeado
bun install
```

Requisitos: **bun 1.3.14** (o `packageManager` do repo) e Node (o shim do npm é `.cjs`). Nada mais.

> **Bun 1.4.0 quebra o `serve` rodado da raiz** (`Cannot find module 'react/jsx-dev-runtime'
> from packages/tui/src/config/index.tsx`: o `jsxImportSource` do pacote não é aplicado).
> Rode a partir de `packages/cli` ou use o script `bun run dev:serve` da raiz, que faz isso.
> O 1.4.0 também aborta upgrades WebSocket fora do tick do evento (provider desktop do
> navegador; `packages/server/test/browser-provider.test.ts`). Compile o binário de deploy
> (`cd packages/cli && bun run build --single`) com o Bun 1.3.14.
>
> Sem TTY (systemd, `nohup`) o `serve`/`web` não imprime mais a senha nem o
> `?auth_token=`: passe `LABHARNESS_PASSWORD` ou use `--show-credentials` num terminal.

Para desenvolver o web app:

```bash
# terminal 1 — servidor (equivale a: cd packages/cli && LABHARNESS_DEV_CORS=1 bun run src/index.ts serve)
bun run dev:serve -- --port 4096
# terminal 2 — SPA com HMR
cd packages/app && bun run dev
```

O servidor imprime a senha no start. O SPA autentica por
`http://localhost:3000/?auth_token=<base64 de "opencode:SENHA">`; o token some da
URL depois de aplicado. **`LABHARNESS_DEV_CORS=1` é obrigatório** — sem ela o
servidor recusa a origem do vite (postura fail-closed) e o app fica em branco com
erro de CORS no console.

## Estado atual (2026-08-31)

- **Publicado:** `labharness@0.3.0` (+ 4 pacotes de plataforma). `latest` aponta
  para ele.
- **Branch `feat/nav-sidebar-ui-rework`** empurrada, **PR #1 aberto**, não
  mergeado. `main` local == `origin/main` == `fea5beed1`.
- **Feature 6** (rework de UI: nav sidebar, painel de skills/MCP, picker) está
  documentada em `PATCHES.md` §6.1–6.7, com âncoras de merge.
- **E2E agora importa.** `cd packages/app && bun run test:e2e` — Playwright, sobe
  o webServer sozinho e mocka toda a API (nenhum servidor real necessário).
  Em máquina com a porta 3000 ocupada: `PLAYWRIGHT_PORT=3100 bun run test:e2e`.

  **Rode com `--workers=1`.** Medido em 2026-08-31 numa Linux com várias sessões
  de agente concorrentes: com os workers padrão, **28 dos 172 specs falham já no
  HEAD limpo**, e a lista de falhas muda entre execuções — todas passam quando
  rodadas isoladamente. Com paralelismo o ruído é maior que o sinal, e a suíte
  deixa de servir para distinguir regressão. Requer o browser instalado
  (`bunx playwright install chromium`); o **primeiro run após instalar dá
  falso-negativo** por cold start do vite. E **nunca edite arquivo enquanto a
  suíte roda** — o vite recarrega e o resultado não vale nada.

## Verificação

```
bun run typecheck                                                  # 33/33
cd packages/app && bun run test:unit                               # 649/649 em 107 arquivos
bun run lint:env-branding
bun run packages/cli/script/verify-rebrand.ts                      # fonte
bun run packages/cli/script/verify-rebrand.ts ./packages/cli/dist  # scan nos binários
```

> `test:unit` **não existe na raiz** — ele vive em `packages/app`. Rodá-lo da raiz
> falha com *"Script not found"*, que se parece com teste vermelho e não é.

Suítes que devem estar verdes (números por arquivo, rodados isoladamente):

- **core** — `zz-battle-gate-default`(4) `zz-battle-gate-bypass`(4) `zz-battle-concurrency`(2)
  `zz-battle-env-spelling`(2) `tool-agent`(5) `tool-agent-concurrency`(6) `workflow-gate`(8)
  `workflow-gate-runtime`(11) `workflow-plan`(11) `plugin/remote`(1)
  `workflow-gate-spawn-contract`(2)
- **server** — `bind-policy`(10) `cors`(5) `no-password`(2) `blank-password`(9) `web-ui-auth`(1)
- **codemode** — `date-deterministic`(29) `zz-battle-determinism`(2)
- **core/plugin** — `provider-{openrouter,kilo,nvidia,zenmux,llmgateway}` (20 no total)

> **Atenção:** os 4 `zz-battle-*` do core **falham quando os 9 arquivos compartilham um
> processo `bun`** — dois deles limpam só as grafias antigas de env e herdam a variável
> deixada pelo teste que ordena antes. Rodados por arquivo, passam 53/53. Isso foi provado
> com `git stash` no HEAD; **não é regressão.**

Falha pré-existente conhecida (Windows): `packages/util/test/global.test.ts` >
*"building a layer with default tmp"* — `os.tmpdir()` no Windows ignora `TMPDIR`.

---

## Sync com o upstream

Branch `vendor` espelha o upstream, `main` carrega o overlay. **Merge, não rebase** —
`rerere` está ligado. Cadência semanal.

```
git checkout vendor && git fetch upstream --tags
git merge --ff-only <tag>
git checkout -b sync/AAAA-MM-DD main && git merge vendor
```

**Drift atual: ~82 commits.** `git merge-tree main upstream/beta` produz **3 conflitos**,
todos com procedimento de resolução documentado:

| Arquivo | Seção | Perigo |
|---|---|---|
| `packages/server/test/cors.test.ts` | §2.8.1 | **add/add recorrente.** O teste deles afirma as concessões de CORS que removemos. Resolver pegando a versão deles reabre o controle de acesso da emissão de tickets de PTY — e parece conserto de teste. |
| `packages/server/test/fetch.test.ts` | §2.8.2 | Nós +33/−16, eles +205/−18. A assimetria convida a pegar a deles inteira; um teste deles se chama *"serves unauthenticated…"*, que é o caminho que eliminamos. |
| `packages/cli/src/server-process.ts` | §2.8.2 | As 2 linhas deles adicionam `cors` configurável e são **bem-vindas**. O cuidado é que o hunk cai logo acima do bloco de senha. |

Ordem sugerida: `server-process.ts` → `fetch.test.ts` → `cors.test.ts`.

---

## Arquivos que importam

| Arquivo | Papel |
|---|---|
| `packages/util/src/global.ts` | `const app` — controla os 4 diretórios XDG |
| `packages/util/src/env.ts` | helper `env()`/`truthy()` + lista `Env.branded` |
| `packages/cli/script/build.ts` | `const binary`, alvos, defines, embed da SPA |
| `packages/cli/script/dist-package.ts` | monta o pacote npm raiz |
| `packages/cli/script/verify-rebrand.ts` | teste de regressão do rebrand |
| `packages/cli/bin/force.cjs` | shim que resolve o binário em runtime |
| `packages/core/src/tool/plugin/agent.ts` | o `rlm()` |
| `packages/core/src/plugin/workflow-gate.ts` | o gate; casa o spawn por `SPAWN_TOOL` |
| `packages/server/src/bind-policy.ts` | recusa bind alcançável sem credencial |
| `packages/server/src/cors.ts` | a allowlist **é** o controle de acesso do ticket de PTY |
| `PATCHES.md` | toda divergência, com motivo e condição de remoção |

---

## Segurança — o que este fork NÃO resolve

O `SECURITY.md` do upstream é explícito: **não há sandbox do agente**, e o sistema de
permissões é *"a UX feature… not designed to provide security isolation"*.

**Quem se autentica na URL consegue executar comandos arbitrários** com as permissões do
processo. As camadas construídas aqui mantêm não-autenticados fora e reduzem alcance —
autenticação obrigatória para bind alcançável, política ordenada com `ask` por padrão,
preset `remote` restritivo. **Nada disso torna o shell seguro.**

Se expor pela internet: camada de identidade na frente (Cloudflare Access ou equivalente),
credencial do servidor mantida embaixo dela, e trate a máquina como o raio de alcance real
de um comprometimento.

---

## Pendências

1. **Revogar o token npm** — cópia em texto em `~/.npmrc-labfy` (modo 600); o
   `~/.npmrc` padrão tem um token **expirado** (retorna 401). Seguro revogar
   agora: o publish do 0.3.0 já foi feito. Gerar um novo depois.
2. **Mergear o PR #1** (`feat/nav-sidebar-ui-rework`)
3. **Visibilidade do repo** — privado hoje; os binários já são públicos via npm
4. **Sync com upstream** — 82+ commits de drift, 3 conflitos mapeados acima. A
   Feature 6 aumentou o drift; §6.1 lista as âncoras nos dois arquivos de alto
   tráfego (`shell/shell.tsx`, `shell/titlebar/titlebar.tsx`).
5. **Não existe `force update`** — a linha v2 do upstream removeu o
   `upgrade` da v1; atualizar é `npm i -g force-agent@latest`, ou o botão Update
   da UI (0.5.2+). Se um comando de
   update for desejado, é feature nova (detectar o gerenciador da instalação +
   aviso de versão nova no start).
6. **21 READMEs traduzidos** ainda descrevem o opencode (§R.5) — só importa se o repo for
   a público. Apagar cria 21 conflitos delete/modify recorrentes; a recomendação é apagar
   **no momento** de abrir o repo, não antes
7. **Comando `console`** ainda existe e o provider `opencode.ts` tem
   `defaultServer = "https://opencode.ai/console"` — o `PATCHES.md` prevê remover

---

## Como verificar — o caminho que funciona

**Por fase de trabalho (~15 s).** É isto que se roda a cada mudança:

```bash
cd packages/app
bun run typecheck                                             # ~8 s
bun run test:unit                                             # ~2 s, 680 testes
PLAYWRIGHT_PORT=3100 bunx playwright test --workers=1 --retries=1 \
  e2e/regression/session-workspace-tabs.spec.ts               # ~9 s
```

Mais os specs da área tocada, se houver. **A suíte completa não entra aqui** — ela custa
20 min com `--workers=1` e não paga por mudança.

**No fechamento da feature (~20 min).** Uma vez, antes de declarar pronto:

```bash
bun run typecheck && bun run lint:env-branding && bun run build
cd packages/app && PLAYWRIGHT_PORT=3100 bunx playwright test --workers=1 --retries=1
bunx oxlint packages/app/src packages/app/e2e     # da RAIZ, nunca de dentro do pacote
```

### Quando um spec falha, nesta ordem

1. **Olhe o screenshot** — `e2e/test-results/**/test-failed-1.png`. Ele mostra o estado real da
   tela e costuma matar a investigação em um passo. Um screenshot já resolveu o que três
   rodadas de dump não tinham resolvido.
2. **Rode isolado** com `--workers=1`. Se passa, era contenção ou cold start, não código.
3. **Rode no commit base** (`git stash` + `git checkout <base>`). Só então chame de regressão.
4. **Só aí** instrumente com `page.on("pageerror")` / `console` ou meça com
   `getBoundingClientRect`.

### Escrevendo spec de UI

- O mock cobre toda a API (`e2e/utils/mock-server.ts`); nenhum spec fala com servidor real e
  **nenhum usa LLM** — trocar de modelo não muda resultado de teste.
- Navegue com `` page.goto(`/server/${base64Encode(server)}/session/${id}`) ``; `encodeURIComponent`
  não serve.
- Skills e MCP vêm de `skills: [...]` e `mcps: [...]` no config (default é lista vazia).
- **Seletores que sobrevivem:** `[role="tab"][data-tab]`, `data-slot` nos elementos próprios,
  ids. Kobalte **sobrescreve `data-slot`** nos seus componentes (`Tabs.Trigger` vira
  `tabs-trigger`) — um `data-slot` customizado ali é descartado sem erro.
- Prefira **um percurso** a vários testes com setup próprio: cada setup custa ~15 s.
- Meça geometria com `getBoundingClientRect`, e no elemento certo: um wrapper com `padding`
  tem topo diferente do card que ele empurra.

---

## Armadilhas do ciclo de verificação (2026-08-31)

Cada linha custou tempo real numa sessão. Sintoma → causa → regra.

| Sintoma | Causa | Regra |
|---|---|---|
| `bun run test:unit` na raiz "falha" | o script só existe em `packages/app` | rode `test:unit` de `packages/app`; a mensagem é *"Script not found"*, não teste vermelho |
| 7 specs vermelhos, verdes no run seguinte sem mudar nada | cold start do vite; o **primeiro spec de cada invocação** estoura o timeout | `--retries=1` local (o CI já usa `retries: 2`) |
| 28 specs falham no HEAD limpo, lista muda a cada run | contenção de CPU com workers paralelos | `--workers=1` sempre que a suíte for sinal de regressão |
| suíte inteira deu resultado sem sentido | editei arquivos **durante** o run; o vite recarregou | nunca edite `packages/app` com a suíte rodando |
| app não monta, suíte só diz "element(s) not found" | erro de runtime engolido | instrumente um spec com `page.on("pageerror")` + `console` **antes** de teorizar |
| memo do Solid nunca recomputa em teste | `bun test` não tem scheduler; nem observer resolve | teste com um harness por cenário (estado fixo); só stores propagam sob mutação |
| typecheck limpo, app quebrada | TDZ: `const` lido dentro de closure antes da declaração | ao inserir memos, confira a ordem de declaração — o compilador não vê |
| locator `#id` casa o elemento errado | dois elementos com o mesmo id; resolve para o primeiro do documento, em silêncio | um id legado só migra quando o dono antigo para de emiti-lo |
| gate de espaço deixou passar sem espaço | `sessionPanelWidthMax` faz `Math.max(min, …)`; o déficit vira exatamente o mínimo | não derive "cabe?" de helper que aplica piso; compare o que sobra com o que é exigido |
| `ERR_NETWORK_CHANGED` no meio do run | rede do host oscilou | ruído de ambiente; repita antes de investigar código |
| `oxlint` recusa a config | `options.typeAware` só vale no config raiz | rode `oxlint` **da raiz** (`bunx oxlint packages/app/src`), nunca de dentro do pacote |

**Regra que resolveu todas as dúvidas de autoria:** antes de chamar algo de regressão,
rode o mesmo alvo no commit base (`git stash` + `git checkout <base>`) e compare. Três
"regressões" desta sessão eram pré-existentes.

**Provar, não deduzir:** duas correções só apareceram depois de medir o DOM real
(`getBoundingClientRect` num spec descartável). A aritmética no papel dizia que cabia.

---

## Três armadilhas que já morderam aqui

**Symlinks quebrados no Windows.** 46 dos 58 symlinks do repo materializam como *texto*
num checkout sem Modo Desenvolvedor. Já causou build servindo favicon de 39 bytes e
typecheck falhando por horas aparentes. `packages/app/public/*` e os dois
`custom-elements.d.ts` foram convertidos para arquivos reais (§R.6). Não tente "consertar
o checkout": `core.symlinks=true` + `checkout --force` **apaga os arquivos e falha ao
recriar**.

**Marca vazando em asset servido em runtime.** Os `favicon.svg` têm `aria-label` e
`<title>` com o nome do produto. Nenhum `grep` em "código e config" pega. Verifique
baixando `/favicon.svg` do binário compilado.

**Texto cujo significado muda sem o arquivo ser editado.** No último rename,
`bind-policy.ts` não foi tocado por ninguém, mas a mensagem de segurança que ele exibe
passou a citar o prefixo antigo. Nenhum `grep` pelo nome do produto acharia — o arquivo
nunca mencionou o produto.

O padrão comum: **exercite, não inspecione.** Baixe o arquivo pelo HTTP, instale o pacote
do registry, rode o binário no container, capture a mensagem do executável. Suíte verde
significa apenas que o que você escolheu medir está são.

## O Chromium do Playwright não é o Chrome do usuário (2026-09-02)

O dono relatou que o campo de prompt descia com a conversa e sumia da tela, sem rolagem.
A suíte e2e passava em todas as medições — 18 delas, em dev, build de produção e no
`force web` real, sempre com o composer a 9 px do rodapé.

A diferença era o navegador. `packages/app/src/session/tabs/workspace-tabs.tsx` dependia de
`h-full` (`height: 100%`) resolver contra uma altura derivada pelo flex. O Chromium empacotado
do Playwright trata essa base como definida; o **Chrome 151** não. Lá o painel da sessão cresce
até o conteúdo — medido na máquina do dono: 3755 px numa janela de 778 px, com o composer
3058 px abaixo da dobra e nada para rolar.

A correção foi tirar a percentagem da cadeia: `session-workspace-body` virou coluna flex e os
painéis irmãos passaram de `h-full` para `flex-1`. Como exatamente um deles está visível por
vez, o visível recebe a altura pelo flex.

Para não repetir: `playwright.config.ts` ganhou um projeto `chrome` opt-in, que usa o Chrome
instalado na máquina em vez do Chromium empacotado.

```
PLAYWRIGHT_CHROME=1 bun run test:e2e --project=chrome e2e/regression/composer-in-viewport.spec.ts
```

Rode isso antes de publicar qualquer mudança de layout. Sem a correção esse comando falha e o
`--project=chromium` passa — foi exatamente essa diferença que deixou um produto inutilizável
chegar ao npm com a suíte verde.

## Vite órfão contamina a suíte (2026-09-02)

`playwright.config.ts` usa `reuseExistingServer` em dev: se já há um Vite de pé na porta, a
rodada reaproveita. Uma rodada morta por `timeout`/Ctrl-C deixa esse Vite **órfão**, e a
próxima rodada roda contra um grafo de módulos velho. Sintoma visto aqui: um spec que passava
em HEAD limpo "regrediu" com uma mudança que nem era renderizada naquela largura, e um bisect
por stash apontou o arquivo errado — tudo estado podre do servidor, não código.

Antes de acreditar numa falha inesperada, e sempre antes de bissectar:

```
fuser -k 3000/tcp; pkill -f vite
```

Depois disso a mesma árvore passou 3/3. O bisect por `git stash` + `git checkout stash@{0} -- <path>`
só é confiável com o Vite morto entre cada passo.

## Subrecurso anônimo atrás do Basic: a família de bugs (2026-09-02)

A UI inteira fica atrás de HTTP Basic. Qualquer requisição que o navegador faça **sem
credencial** volta 401 com `WWW-Authenticate`, e o Chrome responde abrindo o prompt de senha —
que nunca resolve, porque a próxima requisição sai anônima de novo. Já apareceu três vezes:

| Subrecurso | Por que sai anônimo | Correção |
|---|---|---|
| `<link rel="manifest">` | o fetch do manifest é `omit` por padrão | `crossorigin="use-credentials"` (`695d905d6`) |
| source maps (`.js.map`) | o DevTools busca fora do contexto da página | `build.sourcemap: "hidden"` — gera o `.map` para o Sentry, não anuncia no bundle |
| `.map` no binário | nunca são embarcados (`app-assets.ts` filtra), então o 404 vinha *depois* do 401 | idem |

Regra para subrecurso novo: se o navegador (não a página) faz a requisição — manifest, source
map, ícone de PWA, `<link rel=preload crossorigin>` — ou ele leva `use-credentials`, ou não é
anunciado. Testar abrindo o DevTools contra `force web`: nenhum prompt pode aparecer.

## Reinício em processo: o código 75 e o handoff de senha (2026-09-02)

O botão Update do `web` troca o binário debaixo de um servidor que está rodando. Três
peças sustentam isso, e cada uma existe por um motivo que não é óbvio:

**O shim é quem reinicia.** `packages/cli/bin/force.cjs` já fazia `spawn` do binário
da plataforma com `stdio: "inherit"`. Agora, quando o filho sai com **75** (EX_TEMPFAIL) e
sem sinal, ele resolve o caminho de novo — o `npm i -g` já substituiu o pacote — e executa
outra vez. Teto de 3 reinícios, e recusa se o filho morrer em menos de 5s: sem isso, um
binário novo que não sobe vira loop infinito no terminal do usuário. Consequência que vale
lembrar: **shims já instalados não conhecem o 75**. Numa instalação anterior à 0.5.2 o
processo sai e nada volta; a UI cai no timeout de 90s e mostra o comando manual.

**A senha sobrevive por arquivo, não por env.** Sem `LABHARNESS_PASSWORD` o `web` gera uma
senha por execução. Se o reinício gerasse outra, o Chrome — que cacheou o Basic — entraria
no mesmo loop de prompt da 8.9. O servidor não consegue mudar o env do pai (quem re-spawna
é o shim), então o handoff é um arquivo `0600` em `Global.Path.state`, apagado **antes** de
ser validado, com validade de 60s e checagem de `ppid`. Quando a senha veio do ambiente,
nada é escrito: o filho herda o env.

**Retomar turno era privilégio do modo `service`.** `resumeSuspendedSessions` só roda
dentro de `if (lifecycle)` em `server/src/process.ts`, e o `web` chamava `start` sem
`lifecycle` — ou seja, até a 0.5.2 o `labharness web` (hoje `force web`) **nunca** retomava um turno
interrompido, com ou sem update. Passar `lifecycle` no modo `web` é o que torna a promessa
verdadeira; o claim write-ahead no SQLite já existia e fazia a parte dele.

**O service worker serve a UI antiga.** O PWA é `registerType: "prompt"` com
`skipWaiting: false`. Um `location.reload()` depois do reinício reabre o precache anterior
e faz parecer que a atualização não pegou. Antes de recarregar: `registration.update()` e
`postMessage({type:"SKIP_WAITING"})` no waiting, com `unregister()` como escape.

## `Script` não pode depender de arquivo do upstream

`packages/script/src/index.ts` lia `.github/TEAM_MEMBERS` no topo do módulo. O arquivo saiu
com a herança de CI do upstream (`88b056916`) e **todo** script que importa `Script` passou
a morrer com ENOENT — build e publicação inclusive, sem relação aparente com CI. A leitura
agora tem `.catch(() => [])`. Regra: o que só o changelog e o robô de issues consomem não
pode ser efeito colateral de import do módulo que o build inteiro usa.

## O prefixo de env não pode ser uma palavra que o ecossistema já usa

O rebrand para Force Agent começou com `FORCE_` como prefixo — curto e óbvio. Uma
hora depois o `debug-paths.test.ts` acusou: esta máquina exporta `FORCE_HYPERLINK`,
que pertence ao pacote npm `supports-hyperlinks`, e `FORCE_COLOR` é convenção quase
universal em Node. Com `FORCE_` como marca, `unrecognized()` passa a avisar que a
variável *do usuário* foi ignorada — o aviso existe justamente para denunciar erro
de configuração nosso, e passaria a mentir em toda máquina que usa cores no
terminal. Pior: bastaria alguém brandear o sufixo `COLOR` para o build ler a
variável de terceiro como se fosse nossa.

Prefixo virou `FORCE_AGENT_`. A regra: antes de escolher, procure o prefixo no
ecossistema em que o produto roda. `FORCE_`, `APP_`, `DEV_`, `CI_` e `NODE_` já têm
dono.
