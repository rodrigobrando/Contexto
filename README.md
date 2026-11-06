# Contexto

Agregador de notícias para desktop. Você cadastra sites, o Contexto baixa as matérias, limpa anúncios e
ruído, guarda tudo em SQLite e usa um LLM (via [OpenRouter](https://openrouter.ai)) para **traduzir para
português** e **resumir** o que importa, por matéria e por grupo de fontes.

Feito com Electron e SQLite. Roda localmente: seus dados ficam no seu computador.

## Recursos

- **Cadastro por site ou feed:** informe o endereço de um site e o app procura o RSS/Atom. Se não houver,
  varre a página inicial atrás de manchetes. Também aceita a URL de um feed diretamente.
- **Limpeza sem LLM:** scripts, menus, rodapés, anúncios, newsletters e "leia também" são removidos por
  código (Readability e filtros), antes de qualquer chamada ao modelo. O LLM só recebe texto já limpo.
- **Tradução e resumo por matéria:** título, resumo e texto em português, sob demanda ou automático.
- **Grupos de fontes:** organize as fontes em grupos recolhíveis (arrastar e soltar, ou menu "Mover para").
- **Início em formato de feed:** um cartão-índice no topo e um cartão por grupo, com manchete, resumo,
  capa, tópicos e um popover com as matérias citadas (cada título abre a matéria).
- **Resumo de grupo na lista:** ao clicar num grupo, o painel de leitura mostra o resumo conforme os filtros.
- **Filtros:** não lidas, hoje, esta semana, este mês, traduzidas, não traduzidas e busca.
- **Atualização ao abrir:** busca notícias novas em todas as fontes sempre que o app inicia.
- **Datas de publicação:** extraídas do feed ou da própria página, com data de coleta como reserva.

## Requisitos

- Node.js recente e npm (testado com Node 22 e 24).
- Uma chave da OpenRouter (para traduzir e resumir). Ler e coletar notícias funciona sem ela.
- Para compilar o módulo nativo `better-sqlite3` pode ser necessário um compilador instalado
  (no macOS, as Xcode Command Line Tools: `xcode-select --install`).

Desenvolvido e testado no macOS. Windows e Linux devem funcionar, mas não foram testados.

## Como rodar

```bash
npm install     # instala as dependências e recompila o better-sqlite3 para o Electron
npm start       # abre o app
```

Se o app reclamar do `better-sqlite3` (por exemplo depois de atualizar o Electron), recompile:

```bash
npm run rebuild
```

## Configuração

Abra **Configurações** na barra lateral:

| Opção | O que faz |
| --- | --- |
| Chave da OpenRouter | Necessária para traduzir e resumir. Fica criptografada (Keychain no macOS). |
| Modelo | Qualquer modelo da OpenRouter. Padrão: `google/gemini-2.5-flash`. Modelos "flash" ou "mini" são baratos e bons para isso. |
| Traduzir automaticamente | Ao atualizar, traduz as notícias novas. Só vale para matérias publicadas nas últimas 24 horas. |
| Gerar resumos automaticamente | Gera resumos de grupo só para grupos com notícias **não lidas**. Ligado por padrão. |

## Como usar

1. **Adicione fontes:** cole o endereço de um site (ou de um feed RSS) no campo da barra lateral e clique em `+`.
2. **Agrupe:** use o ícone de pasta ao lado de **Fontes** para criar grupos. Arraste as fontes para eles,
   ou use o `⋯` / botão direito na fonte. A setinha recolhe e expande cada grupo.
3. **Leia:** escolha uma fonte, um grupo ou "Todas as fontes". Use os filtros acima da lista.
4. **Traduza:** abra uma matéria e clique em **Resumir e traduzir**, ou use o ícone de tradução no topo da lista
   para traduzir as pendentes de uma vez.
5. **Acompanhe pela Início:** veja o resumo de cada grupo no período escolhido. O botão **Gerar** cria os
   resumos que faltam, e **Atualizar** em um cartão refaz aquele grupo.

### Quando o LLM é chamado

O app só chama o modelo nestes casos:

| Ação | O que é enviado |
| --- | --- |
| Traduzir uma matéria | O texto limpo da matéria (até cerca de 14 mil caracteres). |
| Resumo de grupo (Início ou lista) | Título e resumo (ou um trecho) de até 80 notícias do período. |

Resumos de grupo ficam guardados no banco, um por combinação de grupo, período e filtros, e só são refeitos
quando você pede ou quando chegam notícias novas e há não lidas.

## Como funciona

```
site ──> feed RSS ou varredura da home ──> download da página (com espera entre pedidos)
      ──> limpeza (Readability + filtros) ──> SQLite
      ──> [LLM] tradução e resumo ──> interface
```

- **Respeito aos sites:** há espera de cerca de 1,2 s entre pedidos ao mesmo site e novas tentativas
  em 429/503 respeitando o `Retry-After`. Se o site responde 401, 403 ou 429, o app para de baixar páginas
  e usa só o que veio no RSS.
- **Paywalls:** o app não faz login nem contorna bloqueios. Em sites pagos, cadastre o feed RSS público
  do site: o texto costuma vir resumido, mas o resumo e a tradução funcionam.
- **Artigos incompletos:** textos ou datas que faltaram são buscados de novo, no máximo duas vezes por artigo.
- **Exclusão:** artigos excluídos não voltam na próxima coleta.

## Dados e privacidade

- **Banco:** `news.db` na pasta de dados do app. No macOS: `~/Library/Application Support/Contexto/`.
- **Chave da API:** guardada com o `safeStorage` do Electron (Keychain no macOS). Se a criptografia do
  sistema não estiver disponível, ela é guardada sem criptografia.
- **O que sai do computador:** requisições aos sites que você cadastrou e, quando você traduz ou resume,
  o texto descrito acima para a OpenRouter.
- **Segurança da janela:** `contextIsolation` ligado, sandbox ativo, sem Node no renderer e CSP restritiva.

Para recomeçar do zero, feche o app e apague a pasta de dados.

## Estrutura do projeto

```
main.js            processo principal: janela, IPC, atualização, geração de resumos
preload.js         ponte segura entre a interface e o processo principal
src/
  db.js            esquema SQLite e consultas
  fetcher.js       descoberta de feed, coleta e reprocessamento de artigos
  cleaner.js       limpeza do HTML e extração de data de publicação
  llm.js           chamadas à OpenRouter (tradução e resumos)
renderer/
  index.html       estrutura da interface
  app.js           barra lateral, lista, leitor, filtros, grupos, configurações
  home.js          Início (feed de resumos por grupo)
  style.css        estilos
  fonts/           Unbounded e Schibsted Grotesk (embutidas, com licenças)
build/             ícones do app (png e icns)
```

## Limitações conhecidas

- O app ainda não tem empacotamento (instalador). O ícone `build/icon.icns` está pronto para isso.
- Há apenas o tema escuro.
- Sites sem RSS dependem de uma heurística para achar manchetes e podem trazer páginas de listagem.
- Matérias sem data de publicação não entram na tradução automática, só na manual.
- Bancos criados em versões anteriores podem conter tabelas de "assuntos" que não são mais usadas.
  Elas não atrapalham e podem ser apagadas.

## Licenças

As fontes Unbounded e Schibsted Grotesk estão em `renderer/fonts/` junto com suas licenças.
