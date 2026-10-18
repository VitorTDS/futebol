# ⚽ Painel do Brasileirão

Dashboard do Brasileirão com classificação, jogos, previsões por partida e
chances de título, Libertadores e rebaixamento calculadas por simulação Monte Carlo.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 22.18 ou mais novo.

```bash
npm install
npm run dev
```

Abra http://localhost:3001.

Sem configurar nada, o sistema usa **dados de exemplo** (um campeonato com
resultados sorteados), para você ver tudo funcionando.

### Testes

```bash
npm test             # cálculos (modelo, simulação, copas, fontes de dados...)
npm run test:telas   # abre o Chrome sem janela e passa por todas as telas, no computador e no celular
```

O teste das telas usa o Chrome instalado (outro caminho: variável `CHROME_PATH`),
os dados reais do `.env` e a internet. Ele falha se alguma tela der erro de
JavaScript, mostrar aviso de erro, ficar vazia ou ficar mais larga que o celular.

## Usando dados reais

1. Crie uma conta grátis em https://www.football-data.org/client/register e copie o token que chega por e-mail.
2. Copie o arquivo `.env.example` para `.env` e cole o token em `FOOTBALL_DATA_TOKEN`.
3. Reinicie o servidor.

O plano grátis permite 10 requisições por minuto; o servidor guarda as respostas
por 60 segundos para não passar desse limite.

## Como funciona

| Parte | Arquivo | O que faz |
| --- | --- | --- |
| Fontes de dados | `src/data/` | `footballData.ts` busca na API; `mock.ts` gera os dados de exemplo |
| Classificação | `src/model/standings.ts` | Monta a tabela com os critérios do Brasileirão (pontos, vitórias, saldo, gols pró) |
| Previsão | `src/model/prediction.ts` | A partir dos gols esperados, monta a chance de cada placar e de vitória/empate/derrota |
| Modelo Dixon-Coles | `src/model/dixonColes.ts` | Modelo padrão (veja abaixo) |
| Modelo Poisson simples | `src/model/poisson.ts` | Ataque e defesa pela média de gols marcados e sofridos, sem considerar os adversários |
| Página do time | `src/model/teamProfile.ts` | Casa x fora, sequências, maior vitória/derrota e força de ataque/defesa segundo o modelo |
| Scout de jogadores | `src/model/scout.ts` | Métricas por 90 minutos, percentil por posição e jogadores parecidos |
| Jogadores | `src/data/players/` | `apiFootball.ts` busca na API-Football (com cache em disco); `mock.ts` gera jogadores de exemplo |
| Simulação | `src/model/simulation.ts` | Joga o resto do campeonato milhares de vezes e conta onde cada time termina |
| Histórico de acertos | `src/model/backtest.ts` | Refaz a previsão de cada jogo encerrado usando só os jogos anteriores a ele e compara com o resultado |
| API | `src/server.ts` | Rotas `/api/overview`, `/api/matches`, `/api/evolution`, `/api/teams/:id`, `/api/players`, `/api/players/:id`, `/api/history` e `/api/scorers` |
| Tela | `public/` | HTML, CSS e JavaScript, com gráficos em Chart.js |

Nos jogos ao vivo, a previsão parte do placar atual e considera só o tempo
que falta, então as probabilidades mudam a cada gol.

## Modelos de previsão

O modelo em uso é escolhido em `MODEL` no `.env` (`dixon-coles` ou `poisson`). A aba
**Acertos** sempre compara os dois no mesmo histórico.

O **Dixon-Coles** melhora o Poisson simples em três pontos:

1. **Considera a força dos adversários**: marcar 3 gols no líder vale mais que no lanterna.
   Ataque, defesa e fator casa são estimados juntos, por máxima verossimilhança.
2. **Dá mais peso aos jogos recentes**, controlado por `TIME_DECAY`
   (0,003 por dia: um jogo de ~230 dias atrás vale metade). Por padrão
   (`TIME_DECAY=auto`) esse valor é **calibrado** automaticamente (veja abaixo).
3. **Corrige os placares baixos** (0×0, 1×0, 0×1, 1×1), que o Poisson puro erra.
   O parâmetro `rho` é aprendido dos dados; no futebol real ele costuma ser
   negativo, o que deixa 0×0 e 1×1 mais prováveis.

Nos **dados de exemplo** os dois modelos empatam: os resultados de exemplo são
sorteados com um Poisson puro, então não há o que o Dixon-Coles corrigir. A
comparação só diz algo com dados reais.

### Temporadas anteriores

No começo do campeonato há poucos jogos, e qualquer modelo erra muito. Com
`PREVIOUS_SEASONS=1` (padrão), o Dixon-Coles usa também os jogos da temporada
anterior, com peso menor (controlado pelo `TIME_DECAY`: jogos de 6 a 12 meses
atrás valem cerca de metade).

- **Quem subiu da Série B** não tem jogos na elite: em vez de começar com a força
  média da liga, começa com a força média dos **4 rebaixados** da temporada
  anterior, um ponto de partida bem mais realista. Conforme joga, os próprios
  resultados assumem.
- **Temporadas encerradas não mudam**: são buscadas uma vez e guardadas em
  `data/cache/` para sempre.
- Se a sua chave da football-data.org não tiver acesso à temporada anterior, a
  tela mostra o aviso e as previsões seguem só com a temporada atual.
- O Poisson simples continua usando só a temporada atual: ele é a referência.

A aba **Acertos** compara o Dixon-Coles com e sem a temporada anterior e mostra
a diferença nas rodadas 1 a 10. Nos dados de exemplo, a nota Brier dessas rodadas
cai de 0,669 para 0,644, e a geral, de 0,629 para 0,619. Os dados de exemplo
favorecem o método, porque a força dos times muda pouco de um ano para o outro;
no Brasileirão real os elencos mudam mais, e o ganho tende a ser menor.

### Calibração do TIME_DECAY

Com `TIME_DECAY=auto`, sempre que entram resultados novos o servidor refaz, em
segundo plano, o histórico de acertos do Dixon-Coles com 11 valores de
decaimento (de "todos os jogos pesam igual" até meia-vida de 14 dias) e compara
cada um com o padrão (meia-vida de 231 dias), **jogo a jogo**.

O padrão só é trocado se algum valor for **claramente** melhor (teste pareado,
~95% de confiança). Com poucas centenas de jogos, diferenças pequenas na nota
Brier costumam ser sorte, e trocar de valor por causa delas pioraria as
previsões futuras. Com menos de 100 jogos encerrados a calibração nem roda.

A aba **Acertos** mostra a curva com todos os valores testados e qual está em uso.

Nos dados de exemplo nenhum valor ganha do padrão, como esperado: a força dos
times de exemplo não muda durante o campeonato, então não há "fase" para o
decaimento capturar.

## Scout de jogadores

A aba **Scout** lista os jogadores com filtros (posição, time, minutos, busca) e
ordenação por qualquer coluna. Na página de cada jogador:

- **Radar** com o percentil em cada métrica que importa para a posição dele;
- **Comparação** com outro jogador da mesma posição (radar sobreposto);
- **Jogadores parecidos**: mesma posição e números mais próximos.

O percentil diz quantos % dos jogadores da mesma posição (com pelo menos
`SCOUT_MIN_MINUTES` minutos) ele supera. Em "gols sofridos" a conta é invertida.

**Dados reais:** a football-data.org não tem estatísticas de jogadores, então o
scout usa a [API-Football](https://www.api-football.com). Crie uma conta grátis,
coloque a chave em `APIFOOTBALL_KEY` no `.env` e reinicie. A primeira carga
leva alguns minutos (o plano grátis permite 10 requisições por minuto e 100 por
dia) e fica salva em `data/cache/` por 24 horas. Confira no painel da API-Football
quais temporadas o seu plano libera; se a temporada não estiver disponível, a
tela mostra o erro que a API devolveu.

## Colocar na internet (e receber gol com o celular bloqueado)

Rodando no computador, o painel só abre no Wi-Fi de casa e o celular só avisa de
gol com o painel aberto. Hospedado com HTTPS, ele abre em qualquer lugar, vira
um app na tela de início e manda notificação de gol mesmo com o celular bloqueado.

O jeito mais simples é o [Render](https://render.com) (tem plano grátis):

1. Gere as chaves das notificações (uma vez só). Elas ficam em `chaves-render.txt`,
   que o git ignora (nunca vai para o GitHub):
   ```bash
   node -e "const k=require('web-push').generateVAPIDKeys();require('fs').writeFileSync('chaves-render.txt','VAPID_PUBLIC_KEY
'+k.publicKey+'

VAPID_PRIVATE_KEY
'+k.privateKey+'
')"
   ```
   (ou `npm run chaves-push`, que mostra as duas na tela)
2. Crie uma conta no Render e entre com o GitHub.
3. Em **New → Blueprint**, escolha este repositório. O Render lê o `render.yaml`
   e pede os valores secretos:
   - `FOOTBALL_DATA_TOKEN`: o mesmo token do `.env`
   - `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`: copie do `chaves-render.txt`
   - `APIFOOTBALL_KEY`: pode deixar em branco

   O `render.yaml` já vem com valores leves para o plano grátis (4.000 simulações,
   meia-vida fixa e teto de memória): o pico de memória fica em ~270 MB dos 512 MB.
4. Espere o deploy terminar e abra o endereço `https://...onrender.com`.
5. **O plano grátis "dorme" depois de 15 minutos sem visita** (e aí não vê os
   gols). Para ele ficar sempre acordado, crie um alarme grátis no
   [cron-job.org](https://cron-job.org) (ou UptimeRobot) que abre
   `https://SEU-ENDERECO.onrender.com/api/health` a cada 10 minutos.
6. No celular, abra o endereço, toque no sino, ligue os alertas e a
   **notificação do sistema**, e escolha os times.
   - **Android (Chrome):** pronto.
   - **iPhone:** primeiro toque em Compartilhar → **Adicionar à Tela de Início**,
     abra o painel pelo ícone novo e só então ligue a notificação (o iOS só
     permite notificação para sites adicionados à tela de início).

Cada novo `git push` na `main` atualiza o painel sozinho. A memória do servidor
grátis se apaga a cada atualização; o painel busca tudo de novo, e cada celular
se inscreve outra vez sozinho na próxima vez que abrir o painel.

Para outras hospedagens que rodam contêiner (Fly.io, Railway, Koyeb), use o
`Dockerfile` e as mesmas variáveis.

## Assistir aos jogos

O botão **📺 Assistir** abre o link definido em `WATCH_URL` (por padrão, o
Globoplay), onde você assiste com a sua assinatura do Premiere. O vídeo não é
exibido dentro do sistema: a transmissão tem DRM e não há API oficial para isso.

## Próximos passos

- [x] Histórico de acertos do modelo (aba "Acertos")
- [x] Página de cada time (clique no nome de qualquer time)
- [x] Modelo Dixon-Coles (com comparação contra o Poisson simples)
- [x] Ajustar `TIME_DECAY` automaticamente pelo histórico de acertos
- [x] Usar temporadas anteriores para o começo do campeonato
- [x] Scout de jogadores com gráfico de radar
