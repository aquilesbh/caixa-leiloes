/*
 * Baixa os resultados de leilões da Caixa de uma vez, filtra BH e Contagem e organiza por ano/data.
 *
 * COMO USAR (leva 1 minuto):
 *  1. Abra https://venda-imoveis.caixa.gov.br/sistema/resultado-licitacoes.asp?sltTipoBusca=resultados
 *  2. Aperte F12 -> aba "Console" (se o Chrome pedir, digite: permitir colagem  e Enter)
 *  3. Cole TODO este arquivo e aperte Enter. Deixe a aba aberta até aparecer "PRONTO".
 *  Ao final baixa 2 arquivos: resultados_BH_Contagem.csv (abre no Excel) e resultados_BH_Contagem.html
 *  (agrupado por ano e data). Se a aba fechar no meio, abra de novo e cole: ele continua de onde parou.
 *
 * Por que no navegador? O site bloqueia robôs (CAPTCHA) quando o pedido vem de scripts/servidores;
 * dentro do seu Chrome ele funciona.
 */
(async () => {
  const CFG = {
    anos: ['2026', '2025'],                       // altere se quiser outros anos
    modalidades: ['14', '4', '5', '1', '2', '3', '21', '22', '33', '34'],
    cidades: ['BELO HORIZONTE', 'CONTAGEM'],
    uf: 'MG',
    paralelo: 4,                                  // downloads simultâneos (não aumente muito)
    maxDocs: Infinity,                            // use um número pequeno (ex: 5) para testar
    baixarAoFinal: true,
  };
  Object.assign(CFG, window.CAIXA_CFG || {});     // permite sobrescrever as opções antes de colar
  const MOD_NOME = { 1: 'Leilão', 14: 'Leilão SFI - Edital Único', 2: 'Concorrência Pública', 3: 'Venda Direta',
    4: '1º Leilão SFI', 5: '2º Leilão SFI', 21: 'Licitação Aberta', 22: 'Licitação Fechada',
    33: 'Venda Online', 34: 'Venda Direta Online' };
  const ULTIMA_DATA = new Set(['2', '21', '22']);
  const LS = 'caixa_bh_v1';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const txt = el => (el.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const painel = document.createElement('div');
  painel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#0b3d91;color:#fff;padding:12px 16px;font:14px Arial;border-radius:8px;max-width:380px;box-shadow:0 2px 10px #0006';
  document.body.appendChild(painel);
  const status = m => { painel.textContent = m; console.log(m); };

  let estado = { feitos: {} };
  try { estado = JSON.parse(localStorage.getItem(LS)) || estado; } catch (e) { /* ignora */ }
  const salvar = () => { try { localStorage.setItem(LS, JSON.stringify(estado)); } catch (e) { /* cheio */ } };

  async function comRetry(fn, tentativas = 6) {
    for (let i = 0; i < tentativas; i++) {
      try { return await fn(); } catch (e) {
        if (i === tentativas - 1) throw e;
        await sleep(2000 * (i + 1) * (e.bloqueio ? 5 : 1));
      }
    }
  }

  async function listar(mod, ano) {
    const h = await comRetry(async () => {
      const r = await fetch('carregaListaResultados.asp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: `cmb_estado=${CFG.uf}&cmb_modalidade=${mod}&cmb_ano_referencia=${ano}`,
        credentials: 'same-origin',
      });
      const t = await r.text();
      if (/Radware|Bot Manager/i.test(t)) { const e = new Error('CAPTCHA na lista'); e.bloqueio = true; throw e; }
      return t;
    });
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const out = [];
    doc.querySelectorAll('tr').forEach(tr => {
      const inp = tr.querySelector('input[value]');
      if (!inp) return;
      const v = inp.value.split('||');
      if (v.length < 9) return;
      const cels = [...tr.querySelectorAll('td')].map(txt);
      const datas = [];
      cels.slice(1).forEach(c => (c.match(/\d{2}\/\d{2}\/\d{4}/g) || []).forEach(d => {
        const [dd, mm, yy] = d.split('/');
        if (+yy >= 2000) datas.push(`${yy}-${mm}-${dd}`);
      }));
      out.push({
        licitacao: v[0], comissao: v[1], uf: v[2], tipo: v[4], unidade: v[5], natural: v[6],
        mod, anoLista: ano,
        data: datas.length ? (ULTIMA_DATA.has(mod) ? datas[datas.length - 1] : datas[0]) : '',
      });
    });
    return out;
  }

  function parseResultado(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocos = [];
    let atual = null;
    doc.querySelectorAll('tr').forEach(tr => {
      const cels = [...tr.children].filter(c => /^t[dh]$/i.test(c.tagName));
      const t = cels.map(txt);
      if (cels.length === 1 && /^\d+\s*-\s*\S/.test(t[0])) {
        const i = t[0].indexOf(' - ');
        atual = { matricula: t[0].slice(0, i).trim(), endereco: t[0].slice(i + 3).trim(), item: '', propostas: [] };
        blocos.push(atual);
      } else if (atual && cels.length >= 5 && /^item/i.test(t[0])) {
        atual.item = t[0].replace(/item/i, '').trim();
      } else if (atual && cels.length >= 5 && /^\d+\s*[°ºo]?$/.test(t[0])) {
        atual.propostas.push({ ranking: t[0].replace(/\D/g, ''), proponente: t[1], valorVenda: t[2], valorOferta: t[3], valorPresente: t[4] });
      }
    });
    return blocos;
  }

  const cidadeUF = end => { const m = norm(end).match(/([^,]+?)\s*\/\s*([A-Z]{2})\s*$/); return m ? [m[1].trim(), m[2]] : ['', '']; };

  async function baixar(l) {
    const url = `carregaResultadoGeral.asp?NU_UNIDADE=${l.unidade}&NU_NATURAL=${l.natural}&NU_LICITACAO=${l.licitacao}` +
      `&SG_COMISSAO=${encodeURIComponent(l.comissao)}&SG_UF=${l.uf}&NU_TIPO_VENDA=${l.tipo}`;
    const html = await comRetry(async () => {
      const r = await fetch(url, { credentials: 'same-origin' });
      const buf = await r.arrayBuffer();
      let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { t = new TextDecoder('latin1').decode(buf); }
      if (/Radware|Bot Manager/i.test(t)) { const e = new Error('CAPTCHA'); e.bloqueio = true; throw e; }
      return t;
    });
    const todos = parseResultado(html);
    const alvo = new Set(CFG.cidades.map(norm));
    const blocos = todos.filter(b => { const [c, u] = cidadeUF(b.endereco); b.cidade = c; return alvo.has(c) && (!CFG.uf || u === CFG.uf); });
    return { total: todos.length, blocos };
  }

  // 1) listas
  status('Listando licitações...');
  let lics = [];
  for (const ano of CFG.anos) for (const mod of CFG.modalidades) {
    const itens = await listar(mod, ano);
    if (itens.length) status(`Lista: ${MOD_NOME[mod] || mod} ${ano} -> ${itens.length}`);
    lics.push(...itens);
  }
  const uniq = new Map(); lics.forEach(l => uniq.set(`${l.mod}|${l.licitacao}|${l.comissao}`, l));
  lics = [...uniq.values()];
  const pend = lics.filter(l => !estado.feitos[`${l.mod}|${l.licitacao}|${l.comissao}`]).slice(0, CFG.maxDocs);
  status(`${lics.length} licitações; ${pend.length} a baixar.`);

  // 2) downloads em paralelo
  let i = 0, ok = 0, falhas = [];
  async function worker() {
    while (i < pend.length) {
      const l = pend[i++];
      const k = `${l.mod}|${l.licitacao}|${l.comissao}`;
      try {
        const r = await baixar(l);
        estado.feitos[k] = { l, total: r.total, blocos: r.blocos };
        ok++;
        if (ok % 3 === 0) salvar();
      } catch (e) { falhas.push(`${k}: ${e.message}`); }
      status(`Baixando ${ok + falhas.length}/${pend.length} (falhas: ${falhas.length}). Não feche esta aba.`);
    }
  }
  await Promise.all(Array.from({ length: CFG.paralelo }, worker));
  salvar();

  // 3) saída
  const linhas = [];
  Object.values(estado.feitos).forEach(({ l, blocos }) => blocos.forEach(b => {
    const base = { ano: (l.data || l.anoLista).slice(0, 4), data: l.data, modalidade: MOD_NOME[l.mod] || l.mod, licitacao: l.licitacao, comissao: l.comissao,
      cidade: b.cidade, matricula: b.matricula, endereco: b.endereco, item: b.item };
    if (!b.propostas.length) linhas.push({ ...base, ranking: '', proponente: '(sem propostas)', valorVenda: '', valorOferta: '', valorPresente: '' });
    b.propostas.forEach(p => linhas.push({ ...base, ...p }));
  }));
  linhas.sort((a, b) => (b.data || '0').localeCompare(a.data || '0') || a.licitacao.localeCompare(b.licitacao) || a.matricula.localeCompare(b.matricula) || (+a.ranking - +b.ranking));
  const campos = ['ano', 'data', 'modalidade', 'licitacao', 'comissao', 'cidade', 'matricula', 'endereco', 'item', 'ranking', 'proponente', 'valorVenda', 'valorOferta', 'valorPresente'];
  const csv = '﻿' + campos.join(';') + '\n' + linhas.map(l => campos.map(c => `"${String(l[c] ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');

  let html = '<html><head><meta charset="utf-8"><title>Resultados BH e Contagem</title><style>body{font-family:Arial;margin:20px}table{border-collapse:collapse;margin:6px 0 18px}td,th{border:1px solid #999;padding:3px 8px;font-size:13px}h2{background:#0b3d91;color:#fff;padding:6px}h3{margin:14px 0 2px}</style></head><body><h1>Resultados de leilões da Caixa - BH e Contagem</h1>';
  let anoAt = '', dataAt = '', imovelAt = '';
  linhas.forEach(l => {
    if (l.ano !== anoAt) { anoAt = l.ano; dataAt = ''; html += `<h2>${esc(l.ano)}</h2>`; }
    const d = l.data ? l.data.split('-').reverse().join('/') : 'sem data';
    if (d !== dataAt) { dataAt = d; imovelAt = ''; html += `<h3>${esc(d)}</h3>`; }
    const im = l.licitacao + l.comissao + l.matricula;
    if (im !== imovelAt) {
      imovelAt = im;
      html += `${html.endsWith('</table>') ? '' : ''}<p><b>${esc(l.modalidade)}</b> ${esc(l.licitacao)}-${esc(l.comissao)} | item ${esc(l.item)} | ${esc(l.matricula)} - ${esc(l.endereco)}</p>` +
        '<table><tr><th>#</th><th>Proponente</th><th>Valor venda</th><th>Valor oferta</th><th>Valor presente</th></tr>';
    }
    html += `<tr><td>${esc(l.ranking)}</td><td>${esc(l.proponente)}</td><td>${esc(l.valorVenda)}</td><td>${esc(l.valorOferta)}</td><td>${esc(l.valorPresente)}</td></tr>`;
  });
  html += '</table></body></html>';

  const baixarArq = (nome, conteudo, tipo) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  };
  window.caixaResultado = { linhas, csv, html, falhas, feitos: estado.feitos };
  window.caixaBaixar = () => { baixarArq('resultados_BH_Contagem.csv', csv, 'text/csv'); setTimeout(() => baixarArq('resultados_BH_Contagem.html', html, 'text/html'), 600); };
  if (CFG.baixarAoFinal) window.caixaBaixar();
  status(`PRONTO. ${linhas.length} linhas, ${new Set(linhas.map(l => l.licitacao + l.comissao + l.matricula)).size} imóveis em BH/Contagem. Falhas: ${falhas.length}.` +
    (CFG.baixarAoFinal ? ' Arquivos baixados.' : ' Rode caixaBaixar() para salvar.'));
  if (falhas.length) console.warn('Falhas (rode o script de novo para tentar outra vez):', falhas);
})();
