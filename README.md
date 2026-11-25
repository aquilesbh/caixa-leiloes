# Resultados de leilões da Caixa — BH e Contagem

Baixa **todos** os resultados de licitações/leilões de imóveis da Caixa de uma vez, filtra só
**Belo Horizonte** e **Contagem** e organiza por **ano e data** (CSV para Excel + HTML agrupado).

## Como usar (1 minuto, no seu Chrome)
1. Abra <https://venda-imoveis.caixa.gov.br/sistema/resultado-licitacoes.asp?sltTipoBusca=resultados>
2. `F12` → aba **Console** (se pedir, digite `permitir colagem` + Enter).
3. Cole todo o conteúdo de [`caixa_navegador.js`](caixa_navegador.js) e aperte Enter.
4. Deixe a aba aberta até aparecer **PRONTO** (pode levar de 30 min a 1 h; o servidor da Caixa é lento).
   Baixa `resultados_BH_Contagem.csv` e `resultados_BH_Contagem.html`.

Se fechar a aba, é só colar de novo: ele continua de onde parou (guarda o progresso no navegador).
Para mudar anos/cidades, edite o bloco `CFG` no início do arquivo.

## Por que no navegador e não via GitHub Actions / Python?
A Caixa protege o download dos resultados com um CAPTCHA anti-robô (Radware). Pedidos vindos de
servidores (GitHub Actions) recebem o CAPTCHA em vez do arquivo, e o índice sai vazio. Dentro do Chrome
normal o site funciona. A lista de licitações, por outro lado, não é bloqueada.

`caixa_resultados.py` (versão em Python) fica no repositório para quem rodar de uma rede/IP que a Caixa
não bloqueie; se aparecer `Radware Bot Manager CAPTCHA` nas linhas `[DIAG]`, use o script do navegador.

Modalidades: 1 Leilão · 14 Leilão SFI Edital Único · 2 Concorrência · 3 Venda Direta · 4/5 1º/2º Leilão SFI ·
21/22 Licitação Aberta/Fechada · 33 Venda Online · 34 Venda Direta Online.

## Atualização incremental

`caixa_atualizar.js` baixa só as licitações que ainda não foram verificadas (lista em `window.CAIXA_JA`,
vinda da aba "Controle" da planilha) e devolve em `window.CAIXA_NOVO` as linhas novas de "Arremates" e "Controle".
Licitações recentes (últimos ~21 dias) ou com imóveis sem arremate devem ser removidas de `CAIXA_JA` para serem reverificadas.
