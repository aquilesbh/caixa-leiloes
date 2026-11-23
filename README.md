# Resultados de leilões da Caixa — BH e Contagem

Baixa **todos** os resultados de licitações/leilões de imóveis da Caixa (2022 em diante), filtra só
**Belo Horizonte** e **Contagem** e organiza por ano e data.

## Via GitHub Actions (sem instalar nada)
1. Aba **Actions** → *Baixar resultados Caixa (BH e Contagem)* → **Run workflow**.
2. Espere (a 1ª rodada pode levar horas; cada ano roda em paralelo e retoma se estourar o limite de 6h — basta rodar de novo).
3. Os resultados são commitados em `dados/`:
   - `dados/2025/2025-03-14/<modalidade>_<licitação>_<comissão>.html`
   - `dados/indice_BH_Contagem.xlsx` e `.csv` (uma linha por proposta)

Roda sozinho toda segunda-feira para atualizar o ano corrente.

> Se o passo "Testar acesso ao site da Caixa" falhar, o site está bloqueando os IPs do GitHub; use o modo local abaixo.

## No seu computador
```
pip install -r requirements.txt
python caixa_resultados.py            # tudo
python caixa_resultados.py --anos 2025 --modalidades 14,4,5
```
Opções: `--cidades`, `--workers`, `--salvar-bruto`, `--sem-verificar-ssl`. Pode interromper (Ctrl+C) e rodar de novo.

Modalidades: 1 Leilão · 14 Leilão SFI Edital Único · 2 Concorrência · 3 Venda Direta · 4/5 1º/2º Leilão SFI ·
21/22 Licitação Aberta/Fechada · 33 Venda Online · 34 Venda Direta Online.
