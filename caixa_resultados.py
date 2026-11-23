#!/usr/bin/env python3
"""
Baixa TODOS os resultados de licitações/leilões da Caixa
(https://venda-imoveis.caixa.gov.br/sistema/resultado-licitacoes.asp)
de uma vez, filtra só os imóveis de Belo Horizonte e Contagem (configurável)
e organiza por ano e data.

Uso básico:
    pip install requests            # (openpyxl é opcional, gera o .xlsx)
    python caixa_resultados.py

Saída (pasta ./resultados_caixa):
    2025/2025-03-14/Leilao-SFI-Edital-Unico_00010325_CPA-RE.html   <- só os imóveis de BH/Contagem
    indice_BH_Contagem.csv        <- uma linha por proposta (abre no Excel)
    indice_BH_Contagem.xlsx       <- idem, uma aba por ano (se openpyxl instalado)
    _cache/                       <- progresso; se interromper, é só rodar de novo

Como o servidor da Caixa é lento (~30 s por resultado), o script baixa vários
em paralelo e nunca repete o que já foi baixado.
"""
import argparse
import csv
import html
import json
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import requests

BASE = "https://venda-imoveis.caixa.gov.br/sistema/"
PAGINA = BASE + "resultado-licitacoes.asp?sltTipoBusca=resultados"

MODALIDADES = {
    "1": "Leilao",
    "14": "Leilao SFI - Edital Unico",
    "2": "Concorrencia Publica",
    "3": "Venda Direta",
    "4": "1o Leilao SFI",
    "5": "2o Leilao SFI",
    "21": "Licitacao Aberta",
    "22": "Licitacao Fechada",
    "33": "Venda Online",
    "34": "Venda Direta Online",
}
# nessas modalidades a data que interessa é a última (abertura das propostas)
USA_ULTIMA_DATA = {"2", "21", "22"}

lock = threading.Lock()


# ----------------------------------------------------------------- utilidades
def sem_acento(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    ).upper().strip()


def slug(s: str) -> str:
    s = sem_acento(s).title()
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")


def texto(fragmento: str) -> str:
    t = re.sub(r"<[^>]+>", "", fragmento)
    t = html.unescape(t).replace("\xa0", " ")
    return re.sub(r"\s+", " ", t).strip()


def decodificar(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("latin-1")


def nova_sessao(verificar_ssl: bool) -> requests.Session:
    s = requests.Session()
    s.verify = verificar_ssl
    s.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124 Safari/537.36",
            "Referer": PAGINA,
        }
    )
    return s


def com_retry(fn, tentativas=5):
    for i in range(tentativas):
        try:
            return fn()
        except requests.RequestException as e:
            if i == tentativas - 1:
                raise
            time.sleep(3 * (i + 1))
            print(f"  (nova tentativa {i + 2}/{tentativas}: {type(e).__name__})", file=sys.stderr)


# --------------------------------------------------------------------- listas
def listar(sess, base, uf, modalidade, ano):
    """Devolve as licitações (dict) de uma modalidade/ano."""
    r = com_retry(
        lambda: sess.post(
            base + "carregaListaResultados.asp",
            data={"cmb_estado": uf, "cmb_modalidade": modalidade, "cmb_ano_referencia": ano},
            timeout=180,
        )
    )
    h = decodificar(r.content)
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S | re.I):
        m = re.search(r"value=['\"]([^'\"]+)['\"]", tr)
        if not m:
            continue
        v = m.group(1).split("||")
        if len(v) < 9:
            continue
        celulas = [texto(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        datas = []
        for c in celulas[1:]:
            for d in re.findall(r"\d{2}/\d{2}/\d{4}", c):
                try:
                    dt = datetime.strptime(d, "%d/%m/%Y")
                except ValueError:
                    continue
                if dt.year >= 2000:  # ignora o "01/01/1900" da venda direta
                    datas.append(dt)
        data_ref = None
        if datas:
            data_ref = datas[-1] if modalidade in USA_ULTIMA_DATA else datas[0]
        out.append(
            {
                "licitacao": v[0],
                "comissao": v[1],
                "uf": v[2],
                "tipo_venda": v[4],
                "unidade": v[5],
                "natural": v[6],
                "edital": v[8],
                "modalidade": modalidade,
                "ano_lista": ano,
                "data_ref": data_ref.strftime("%Y-%m-%d") if data_ref else None,
                "linha_lista": " | ".join(celulas),
            }
        )
    return out


# -------------------------------------------------------------------- parsing
def parse_resultado(doc: str):
    """Quebra o HTML do resultado em blocos, um por imóvel."""
    linhas = re.findall(r"<tr[^>]*>.*?</tr>", doc, re.S | re.I)
    blocos, atual = [], None
    for tr in linhas:
        cel = [c for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        tx = [texto(c) for c in cel]
        if len(cel) == 1 and re.match(r"^\d+\s*-\s*\S", tx[0]):
            mat, _, end = tx[0].partition(" - ")
            atual = {"matricula": mat.strip(), "endereco": end.strip(), "item": "", "propostas": [], "html": [tr]}
            blocos.append(atual)
            continue
        if atual is None:
            continue
        atual["html"].append(tr)
        if len(cel) >= 5 and tx[0].lower().startswith("item"):
            atual["item"] = tx[0].replace("Item", "").strip()
        elif len(cel) >= 5 and re.match(r"^\d+\s*[°ºo]?$", tx[0]):
            atual["propostas"].append(
                {
                    "ranking": re.sub(r"\D", "", tx[0]),
                    "proponente": tx[1],
                    "valor_venda": tx[2],
                    "valor_oferta": tx[3],
                    "valor_presente": tx[4],
                }
            )
    return blocos


def cidade_uf(endereco: str):
    m = re.search(r"([^,]+?)\s*/\s*([A-Z]{2})\s*$", sem_acento(endereco))
    return (m.group(1).strip(), m.group(2)) if m else ("", "")


def filtrar(blocos, cidades, uf):
    alvo = {sem_acento(c) for c in cidades}
    out = []
    for b in blocos:
        cid, u = cidade_uf(b["endereco"])
        if cid in alvo and (not uf or u == uf):
            b["cidade"] = cid.title()
            out.append(b)
    return out


# ------------------------------------------------------------------- download
def processar(sess, base, lic, cache_dir: Path, bruto_dir, cidades, uf):
    chave = f"{lic['modalidade']}_{lic['licitacao']}_{slug(lic['comissao'])}"
    arq_cache = cache_dir / f"{chave}.json"
    if arq_cache.exists():
        antigo = json.loads(arq_cache.read_text(encoding="utf-8"))
        if antigo.get("total_imoveis_no_arquivo", 0) > 0:  # resultado vazio não conta como feito
            return antigo, True

    def baixar():
        r = sess.get(
            base + "carregaResultadoGeral.asp",
            params={
                "NU_UNIDADE": lic["unidade"],
                "NU_NATURAL": lic["natural"],
                "NU_LICITACAO": lic["licitacao"],
                "SG_COMISSAO": lic["comissao"],
                "SG_UF": lic["uf"],
                "NU_TIPO_VENDA": lic["tipo_venda"],
            },
            timeout=300,
        )
        r.raise_for_status()
        return r.content

    conteudo = com_retry(baixar)
    doc = decodificar(conteudo)
    if bruto_dir:
        (bruto_dir / f"{chave}.html").write_bytes(conteudo)

    blocos = filtrar(parse_resultado(doc), cidades, uf)
    res = {
        "lic": lic,
        "total_imoveis_no_arquivo": len(parse_resultado(doc)),
        "blocos": blocos,
        "vazio": len(doc.strip()) < 200 or "Não foram encontrad" in doc,
        "diag": {"bytes": len(conteudo), "inicio": re.sub(r"\s+", " ", doc[:300])},
    }
    arq_cache.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    return res, False


def salvar_html(res, saida: Path):
    lic, blocos = res["lic"], res["blocos"]
    ano = (lic["data_ref"] or lic["ano_lista"])[:4]
    dia = lic["data_ref"] or f"{lic['ano_lista']}-sem-data"
    pasta = saida / ano / dia
    pasta.mkdir(parents=True, exist_ok=True)
    nome = f"{slug(MODALIDADES.get(lic['modalidade'], lic['modalidade']))}_{lic['licitacao']}_{slug(lic['comissao'])}.html"
    corpo = []
    for b in blocos:
        corpo.extend(b["html"])
    conteudo = (
        "<html><head><meta charset='utf-8'><title>Resultado</title></head><body>"
        f"<h2>Resultado da Licitação {lic['licitacao']} - {html.escape(lic['comissao'])}</h2>"
        f"<p>{html.escape(MODALIDADES.get(lic['modalidade'], ''))} | data: {dia} | "
        f"imóveis filtrados: {len(blocos)} de {res['total_imoveis_no_arquivo']}</p>"
        "<table border='1' cellspacing='0' cellpadding='5'>" + "".join(corpo) + "</table></body></html>"
    )
    (pasta / nome).write_text(conteudo, encoding="utf-8")


CAMPOS = [
    "ano", "data", "modalidade", "licitacao", "comissao", "cidade", "matricula",
    "endereco", "item", "ranking", "proponente", "valor_venda", "valor_oferta", "valor_presente",
]


def linhas_indice(res):
    lic = res["lic"]
    ano = (lic["data_ref"] or lic["ano_lista"])[:4]
    for b in res["blocos"]:
        base = {
            "ano": ano,
            "data": lic["data_ref"] or "",
            "modalidade": MODALIDADES.get(lic["modalidade"], lic["modalidade"]),
            "licitacao": lic["licitacao"],
            "comissao": lic["comissao"],
            "cidade": b["cidade"],
            "matricula": b["matricula"],
            "endereco": b["endereco"],
            "item": b["item"],
        }
        if not b["propostas"]:
            yield {**base, "ranking": "", "proponente": "(sem propostas)", "valor_venda": "", "valor_oferta": "", "valor_presente": ""}
        for p in b["propostas"]:
            yield {**base, **p}


def gerar_indices(todos, saida: Path):
    linhas = []
    for res in todos:
        linhas.extend(linhas_indice(res))
    linhas.sort(key=lambda x: (x["data"] or "9999", x["licitacao"], x["matricula"], x["ranking"].zfill(3)))
    with open(saida / "indice_BH_Contagem.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, CAMPOS, delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    try:
        from openpyxl import Workbook
    except ImportError:
        print("(openpyxl não instalado: gerei só o CSV. 'pip install openpyxl' para gerar o .xlsx)")
        return len(linhas)
    wb = Workbook()
    wb.remove(wb.active)
    por_ano = {}
    for l in linhas:
        por_ano.setdefault(l["ano"], []).append(l)
    for ano in sorted(por_ano, reverse=True):
        ws = wb.create_sheet(ano)
        ws.append(CAMPOS)
        for l in por_ano[ano]:
            ws.append([l[c] for c in CAMPOS])
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
    if not wb.sheetnames:
        wb.create_sheet("vazio").append(CAMPOS)
    wb.save(saida / "indice_BH_Contagem.xlsx")
    return len(linhas)


# ------------------------------------------------------------------------ main
def parse_anos(s):
    if "-" in s:
        a, b = s.split("-")
        return [str(x) for x in range(int(b), int(a) - 1, -1)]
    return [x.strip() for x in s.split(",")]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--saida", default="resultados_caixa", help="pasta de saída")
    ap.add_argument("--cidades", default="Belo Horizonte,Contagem", help="cidades separadas por vírgula")
    ap.add_argument("--uf", default="MG", help="UF das cidades (vazio = qualquer)")
    ap.add_argument("--anos", default="2022-2026", help="ex: 2022-2026 ou 2024,2025")
    ap.add_argument("--modalidades", default="all", help="códigos separados por vírgula (ex: 14,4,5,33,34) ou all")
    ap.add_argument("--workers", type=int, default=4, help="downloads em paralelo (padrão 4; não exagere)")
    ap.add_argument("--salvar-bruto", action="store_true", help="guarda também o HTML completo de cada licitação")
    ap.add_argument("--sem-verificar-ssl", action="store_true", help="use se der erro de certificado SSL")
    ap.add_argument("--base", default=BASE, help=argparse.SUPPRESS)  # para testes
    a = ap.parse_args()

    base = a.base
    cidades = [c.strip() for c in a.cidades.split(",") if c.strip()]
    anos = parse_anos(a.anos)
    mods = list(MODALIDADES) if a.modalidades == "all" else [m.strip() for m in a.modalidades.split(",")]

    saida = Path(a.saida)
    cache = saida / "_cache"
    cache.mkdir(parents=True, exist_ok=True)
    bruto = None
    if a.salvar_bruto:
        bruto = saida / "_bruto"
        bruto.mkdir(exist_ok=True)

    sess = nova_sessao(not a.sem_verificar_ssl)
    if a.sem_verificar_ssl:
        requests.packages.urllib3.disable_warnings()
    try:
        sess.get(base + "resultado-licitacoes.asp?sltTipoBusca=resultados", timeout=60)  # cookies
    except requests.RequestException as e:
        print(f"Aviso: não consegui abrir a página inicial ({e}); tentando mesmo assim.")

    # 1) listas (a lista é nacional; qualquer UF devolve o mesmo, usamos MG)
    print("Listando licitações...")
    lics = []
    for m in mods:
        for ano in anos:
            arq = cache / f"lista_{m}_{ano}.json"
            if arq.exists() and ano != str(datetime.now().year):
                itens = json.loads(arq.read_text(encoding="utf-8"))
            else:
                itens = listar(sess, base, "MG", m, ano)
                arq.write_text(json.dumps(itens, ensure_ascii=False), encoding="utf-8")
            if itens:
                print(f"  {MODALIDADES.get(m, m)} {ano}: {len(itens)} licitações")
            lics.extend(itens)
    # remove duplicatas
    unicos = {(l["modalidade"], l["licitacao"], l["comissao"]): l for l in lics}
    lics = list(unicos.values())
    print(f"Total: {len(lics)} licitações para verificar (já baixadas são puladas).\n")

    # 2) baixa e filtra
    todos, falhas, feitos, achados = [], [], 0, 0
    diag_n = [0]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {}
        for lic in lics:
            s = nova_sessao(not a.sem_verificar_ssl)
            s.cookies.update(sess.cookies)
            futs[ex.submit(processar, s, base, lic, cache, bruto, cidades, a.uf)] = lic
        try:
            for f in as_completed(futs):
                lic = futs[f]
                feitos += 1
                try:
                    res, do_cache = f.result()
                except Exception as e:  # noqa: BLE001
                    falhas.append((lic["licitacao"], lic["comissao"], str(e)))
                    print(f"[{feitos}/{len(lics)}] FALHOU {lic['licitacao']} {lic['comissao']}: {e}")
                    continue
                todos.append(res)
                if res["blocos"]:
                    achados += 1
                    with lock:
                        salvar_html(res, saida)
                    print(f"[{feitos}/{len(lics)}] {lic['data_ref'] or lic['ano_lista']} {lic['licitacao']} {lic['comissao']}: "
                          f"{len(res['blocos'])} imóvel(is) em {', '.join(sorted({b['cidade'] for b in res['blocos']}))}")
                elif res["total_imoveis_no_arquivo"] == 0 and diag_n[0] < 5:
                    diag_n[0] += 1
                    d = res.get("diag", {})
                    print(f"[DIAG] {lic['licitacao']} {lic['comissao']} -> {d.get('bytes')} bytes; início: {d.get('inicio')!r}")
                elif feitos % 25 == 0:
                    dec = time.time() - t0
                    print(f"[{feitos}/{len(lics)}] ... {dec/60:.1f} min")
        except KeyboardInterrupt:
            print("\nInterrompido. Rode de novo para continuar de onde parou.")
            ex.shutdown(wait=False, cancel_futures=True)

    n = gerar_indices(todos, saida)
    print(f"\nPronto. {achados} licitações com imóveis de {', '.join(cidades)}; {n} linhas no índice.")
    print(f"Saída em: {saida.resolve()}")
    if falhas:
        print(f"\n{len(falhas)} falharam (rode de novo para tentar outra vez):")
        for x in falhas[:20]:
            print("  ", x)


if __name__ == "__main__":
    main()
