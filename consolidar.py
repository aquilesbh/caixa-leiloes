#!/usr/bin/env python3
"""Junta os índices de cada ano (gerados em paralelo no GitHub Actions) em um só CSV/XLSX."""
import csv
import sys
from pathlib import Path

CAMPOS = ["ano", "data", "modalidade", "licitacao", "comissao", "cidade", "matricula",
          "endereco", "item", "ranking", "proponente", "valor_venda", "valor_oferta", "valor_presente"]


def main(entrada: Path, saida: Path):
    linhas, vistos = [], set()
    for arq in sorted(entrada.rglob("indice_BH_Contagem.csv")):
        with open(arq, encoding="utf-8-sig", newline="") as f:
            for l in csv.DictReader(f, delimiter=";"):
                k = tuple(l[c] for c in CAMPOS)
                if k not in vistos:  # a mesma licitação pode aparecer em mais de um ano da lista
                    vistos.add(k)
                    linhas.append(l)
    linhas.sort(key=lambda x: (x["data"] or "9999", x["licitacao"], x["matricula"], x["ranking"].zfill(3)))
    saida.mkdir(parents=True, exist_ok=True)
    with open(saida / "indice_BH_Contagem.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, CAMPOS, delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    from openpyxl import Workbook
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
    print(f"{len(linhas)} linhas consolidadas")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
