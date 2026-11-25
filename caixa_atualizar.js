/*
 * ATUALIZAÇÃO INCREMENTAL: baixa só o que ainda não está na planilha (aba "Controle").
 *
 * 1. Abra https://venda-imoveis.caixa.gov.br/sistema/resultado-licitacoes.asp?sltTipoBusca=resultados
 * 2. Defina window.CAIXA_JA = [lista de chaves já verificadas, exceto as que devem ser reverificadas]
 *    (as chaves são a coluna "Chave" da aba Controle: "modalidade|licitacao|comissao")
 * 3. Cole este arquivo. Ao final: window.CAIXA_NOVO = { arremates: [...], controle: [...] }
 *    - arremates: linhas na ordem das colunas da aba "Arremates" (Endereço..Licitação), só ranking 1
 *    - controle : linhas na ordem da aba "Controle" (Chave, Modalidade, Licitação, Comissão, Data, Imóveis, Com arremate, Verificado em)
 */
(async () => {
  const CFG = { anos: [String(new Date().getFullYear())], modalidades: ['14','4','5','1','2','3','21','22','33','34'],
    cidades: ['BELO HORIZONTE','CONTAGEM'], uf: 'MG', paralelo: 4, maxDocs: Infinity };
  Object.assign(CFG, window.CAIXA_CFG || {});
  const JA = new Set(window.CAIXA_JA || []);
  const MOD_NOME = { 1:'Leilão',14:'Leilão SFI - Edital Único',2:'Concorrência Pública',3:'Venda Direta',4:'1º Leilão SFI',5:'2º Leilão SFI',21:'Licitação Aberta',22:'Licitação Fechada',33:'Venda Online',34:'Venda Direta Online' };
  const ULTIMA_DATA = new Set(['2','21','22']);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  const txt = el => (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const status = m => console.log(m);
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


  const num = s => +String(s).replace(/\./g, '').replace(',', '.');
  const hoje = new Date().toISOString().slice(0, 10);
  window.CAIXA_PRONTO = false;
  window.CAIXA_NOVO = null;
  window.__rodando = (async () => {
    let lics = [];
    for (const ano of CFG.anos) for (const mod of CFG.modalidades) lics.push(...await listar(mod, ano));
    const uniq = new Map(); lics.forEach(l => uniq.set(`${l.mod}|${l.licitacao}|${l.comissao}`, l));
    const pend = [...uniq.entries()].filter(([k]) => !JA.has(k)).slice(0, CFG.maxDocs);
    status(`${uniq.size} licitações no site; ${pend.length} novas/reverificar.`);
    const out = { arremates: [], controle: [], falhas: [], total: uniq.size, novas: pend.length };
    let i = 0;
    async function worker() {
      while (i < pend.length) {
        const [k, l] = pend[i++];
        try {
          const r = await baixar(l);
          let nArr = 0;
          r.blocos.forEach(b => {
            const p1 = b.propostas.find(p => p.ranking === '1');
            if (!p1) return;
            nArr++;
            const partes = b.endereco.split(',').map(s => s.trim());
            const iCid = partes.length - 1;               // "CIDADE/UF"
            const bairro = partes[iCid - 1] || '';
            const end = partes.slice(0, iCid - 1).join(', ');
            out.arremates.push([end, bairro, b.cidade, CFG.uf, num(p1.valorOferta), l.data, num(p1.valorVenda), MOD_NOME[l.mod] || l.mod, `${l.licitacao}-${l.comissao}`]);
          });
          out.controle.push([k, MOD_NOME[l.mod] || l.mod, l.licitacao, l.comissao, l.data, r.blocos.length, nArr, hoje]);
        } catch (e) { out.falhas.push(`${k}: ${e.message}`); }
      }
    }
    await Promise.all(Array.from({ length: CFG.paralelo }, worker));
    window.CAIXA_NOVO = out; window.CAIXA_PRONTO = true;
    status(`PRONTO: ${out.arremates.length} arremates, ${out.controle.length} licitações, ${out.falhas.length} falhas.`);
  })();
})();
