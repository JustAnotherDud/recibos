// Projeto Supabase "Income". A publishable key é pública por desenho:
// o RLS só deixa ler ao utilizador autenticado; anon não tem acesso.
const SUPABASE_URL = 'https://ofjletuwsemgxhlpwhmn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EEOi4mSkkpd-NcilTL1FMA_G6-JlS2l';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

let RAW = [];
let CLOSED = [];
let appStarted = false;
let trendChart, stackChart;

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sessão Supabase Auth: sem sessão a UI fica bloqueada no ecrã de login.
// supabase-js persiste a sessão em localStorage e renova o token sozinho.
async function init() {
  db.auth.onAuthStateChange((event, session) => {
    if (!session) showLogin();
  });
  const { data: { session } } = await db.auth.getSession();
  if (session) startApp();
  else showLogin();
}

function clearData() {
  RAW = []; CLOSED = [];
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (stackChart) { stackChart.destroy(); stackChart = null; }
  ['kpiRow', 'kpiRates', 'yearBody', 'ledger', 'conta', 'statusLine'].forEach(id => {
    document.getElementById(id).innerHTML = '';
  });
  document.getElementById('content').classList.add('hidden');
}

function showLogin() {
  appStarted = false;
  clearData();
  document.getElementById('setup-password').value = '';
  document.getElementById('app').classList.add('hidden');
  document.getElementById('setup-screen').classList.remove('hidden');
}

function startApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  if (appStarted) return;
  appStarted = true;
  loadData();
}

async function login() {
  const email = document.getElementById('setup-email').value.trim();
  const password = document.getElementById('setup-password').value;
  const errEl = document.getElementById('setup-error');
  const btn = document.getElementById('setup-submit');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Preenche email e password.'; return; }
  btn.disabled = true;
  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) { errEl.textContent = 'Login falhou: ' + error.message; return; }
    startApp();
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  if (!confirm('Terminar sessão?')) return;
  await db.auth.signOut();
  showLogin();
}

function fmtEUR(v) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "€" + Math.abs(n).toFixed(2).replace(".", ",");
}
function fmtEUR0(v) { return "€" + Math.round(v).toLocaleString('pt-PT'); }
function fmtRate(v) {
  if (v === null || v === undefined) return "-";
  return Number(v).toFixed(2).replace(".", ",") + "€";
}
function fmtHoras(v) {
  if (v === null || v === undefined) return "-";
  return Number(v).toFixed(1).replace(".", ",") + "h";
}
function fmtPct(v) { return (v >= 0 ? "+" : "-") + Math.abs(v * 100).toFixed(1).replace(".", ",") + "%"; }
function numOrNull(v) { return (v === null || v === undefined) ? null : Number(v); }
const num = (v) => numOrNull(v) || 0;
const sum = (rows, k) => rows.reduce((a, r) => a + num(r[k]), 0);
const avg = (rows, k) => rows.length ? sum(rows, k) / rows.length : 0;

async function loadData() {
  const btn = document.getElementById('refreshBtn');
  const statusLine = document.getElementById('statusLine');
  const loadingMsg = document.getElementById('loadingMsg');
  const stamp = document.getElementById('syncStamp');
  btn.disabled = true;
  statusLine.textContent = "";

  if (RAW.length === 0) {
    loadingMsg.textContent = "A carregar…";
    loadingMsg.classList.remove('hidden');
    document.getElementById('content').classList.add('hidden');
  }

  try {
    const { data, error } = await db
      .from('mensal_consolidado')
      .select('*')
      .order('ano', { ascending: true })
      .order('mes_num', { ascending: true });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error('Resposta inesperada.');

    RAW = data;
    CLOSED = RAW.filter(r => !r.mes_incompleto);
    populateYearFilter();
    // Mostrar antes de desenhar: o Chart.js mede o canvas e com display:none sai com tamanho 0.
    loadingMsg.classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');
    renderAll();

    const when = new Date();
    stamp.textContent = "atualizado " + when.toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
    stamp.classList.remove('stale'); stamp.classList.add('ok');

  } catch (err) {
    statusLine.textContent = "Falha ao atualizar: " + err.message;
    stamp.classList.add('stale'); stamp.classList.remove('ok');
    if (RAW.length === 0) {
      loadingMsg.textContent = "Não foi possível carregar dados. Verifica a ligação ou tenta novamente.";
    } else {
      loadingMsg.classList.add('hidden');
      document.getElementById('content').classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
  }
}

function populateYearFilter() {
  const sel = document.getElementById('yearFilter');
  const years = [...new Set(RAW.map(r => r.ano))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="all">Todos os anos</option>' + years.map(y => `<option value="${escHtml(y)}">${escHtml(y)}</option>`).join('');
  if (years.includes(Number(current))) sel.value = current;
}

// Tudo menos o ledger usa só meses fechados (CLOSED) e ignora os filtros do ledger.
function renderAll() {
  renderKPIs();
  renderYears();
  renderTrendChart();
  renderStackChart();
  renderLedger();
}

// Estimativa do ano corrente: líquido até ao último mês fechado + meses em falta.
// Cada mês em falta = líquido do mesmo mês em Y-1 (e Y-2) x base atual / base desse mês.
// Dá uma estimativa anual por ano de referência; mostra-se o intervalo [min, max].
function forecastYear() {
  const Y = RAW[RAW.length - 1].ano;
  const done = CLOSED.filter(r => r.ano === Y);
  const have = new Set(done.map(r => r.mes_num));
  const missing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter(m => !have.has(m));
  const baseNow = numOrNull(CLOSED[CLOSED.length - 1].taxa_horaria_base);
  const ytd = sum(done, 'total_liquido_mes');
  const ests = [Y - 1, Y - 2].map(y => {
    let tot = ytd;
    for (const m of missing) {
      const r = CLOSED.find(x => x.ano === y && x.mes_num === m);
      const b = r && numOrNull(r.taxa_horaria_base);
      if (!b || !baseNow) return null;
      tot += num(r.total_liquido_mes) * baseNow / b;
    }
    return tot;
  }).filter(v => v !== null);
  return { Y, ests };
}

function renderKPIs() {
  if (!CLOSED.length) {
    document.getElementById('kpiRow').innerHTML = '';
    document.getElementById('kpiRates').innerHTML = '';
    return;
  }
  const last12 = CLOSED.slice(-12);
  const prev12 = CLOSED.slice(-24, -12);
  const media = avg(last12, 'total_liquido_mes');
  const varPct = prev12.length === 12 ? media / avg(prev12, 'total_liquido_mes') - 1 : null;
  const horas = sum(last12, 'horas_trabalhadas');
  const porHora = horas ? sum(last12, 'total_liquido_mes') / horas : null;

  const { Y, ests } = forecastYear();
  const lo = Math.min(...ests), hi = Math.max(...ests);
  const prev = ests.length === 0 ? '' : `
    <div class="msc" title="Líquido do ano até ao último mês fechado, mais os meses em falta. Cada mês em falta vale o líquido do mesmo mês nos 2 anos anteriores, corrigido pelo rácio entre a base atual e a base desse mês. Dá 2 estimativas anuais: mostra-se o mínimo e o máximo.">
      <div class="lab">Previsão ${Y} <span class="tag">estimativa</span></div>
      <div class="val">${Math.round(lo) === Math.round(hi) ? fmtEUR0(lo) : fmtEUR0(lo) + ' - ' + fmtEUR0(hi)}</div>
      <div class="subv">líquido do ano, mês a mês pelo histórico</div>
    </div>`;

  document.getElementById('kpiRow').innerHTML = `
    <div class="msc accent">
      <div class="lab">Líquido médio / mês, 12 meses</div>
      <div class="val">${fmtEUR(media)}</div>
      <div class="subv">${varPct === null ? '' : fmtPct(varPct) + ' face aos 12 meses anteriores'}</div>
    </div>
    <div class="msc">
      <div class="lab">Líquido / hora, 12 meses</div>
      <div class="val">${porHora === null ? '-' : fmtRate(porHora)}</div>
      <div class="subv">efetivo, com subsídios e extras</div>
    </div>` + prev;

  // Taxas: último mês fechado. O provisório não tem taxas efetivas (vêm das horas fechadas).
  const ref = CLOSED[CLOSED.length - 1];
  const ef = (key) => numOrNull(ref[key]);
  const rates = [
    ['Base', ef('taxa_horaria_base'), '/hora'],
    ['TSD', ef('tsd_taxa_efetiva'), '/hora'],
    ['TSN', ef('tsn_taxa_efetiva'), '/hora'],
    ['Acrés. TSN', ef('acrescimotsn_taxa_efetiva'), '/hora'],
    ['Sub. Noturno', ef('subnoturno_taxa_efetiva'), '/hora'],
    ['Sub. Domingo', ef('subdomingo_taxa_efetiva'), '/hora'],
    ['Sub. Feriado', ef('subferiado_taxa_efetiva'), '/hora'],
    ['Sub. Almoço', ef('sub_almoco_taxa_dia'), '/dia'],
  ].filter(r => r[1] !== null);

  document.getElementById('kpiRates').innerHTML =
    `<div class="rates-label">Taxas em vigor - ${escHtml(ref.mes + ' ' + ref.ano)}</div>` +
    rates.map(([lab, val, unit]) => `
      <div class="msc rate-card">
        <div class="lab">${lab}</div>
        <div class="val rate-val">${fmtRate(val)}<span class="rate-unit">${unit}</span></div>
      </div>
    `).join('');
}

function yearStats() {
  const years = [...new Set(CLOSED.map(r => r.ano))];
  return years.map(y => {
    const rows = CLOSED.filter(r => r.ano === y);
    const liq = sum(rows, 'total_liquido_mes'), h = sum(rows, 'horas_trabalhadas');
    return {
      ano: y, rows, n: rows.length, incompleto: rows.length < 12,
      liqMes: liq / rows.length, horasMes: h / rows.length,
      base: numOrNull(rows[rows.length - 1].taxa_horaria_base),
      liqHora: h ? liq / h : null,
    };
  });
}

function renderYears() {
  const ys = yearStats();
  document.getElementById('yearBody').innerHTML = ys.map((y, i) => {
    const p = ys[i - 1];
    const v = p ? y.liqMes / p.liqMes - 1 : null;
    const inc = y.incompleto || (p && p.incompleto);
    return `<tr>
      <td>${y.ano}${y.incompleto ? `<span class="pill">incompleto, ${y.n} meses</span>` : ''}</td>
      <td>${fmtEUR(y.liqMes)}</td>
      <td>${fmtHoras(y.horasMes)}</td>
      <td>${fmtRate(y.base)}</td>
      <td>${y.liqHora === null ? '-' : fmtRate(y.liqHora)}</td>
      <td class="${v === null || inc ? 'dim' : (v < 0 ? 'neg' : 'pos')}">${v === null ? '-' : fmtPct(v)}</td>
    </tr>`;
  }).reverse().join('');
}

const CHART_FONT = { family: "IBM Plex Mono", size: 10 };
const CHART_SCALE = { grid: { color: '#2e2e2e' }, ticks: { color: '#9a9a9a', font: CHART_FONT } };
const chartEur = (extra) => ({ ...CHART_SCALE, ...extra, ticks: { ...CHART_SCALE.ticks, callback: (v) => "€" + v } });

function labelFor(r) { return (r.mes || "").slice(0, 3) + "/" + String(r.ano).slice(2); }

function renderTrendChart() {
  const liquido = CLOSED.map(r => numOrNull(r.total_liquido_mes));
  const mm12 = liquido.map((_, i) => i < 11 ? null : liquido.slice(i - 11, i + 1).reduce((a, b) => a + b, 0) / 12);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: {
      labels: CLOSED.map(labelFor), datasets: [
        { label: 'Líquido', data: liquido, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.12)', fill: true, tension: 0.25, pointRadius: 2 },
        { label: 'Média móvel 12 meses', data: mm12, borderColor: '#fbbf24', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { color: '#bbb', font: { family: "IBM Plex Mono", size: 11 } } } },
      scales: { x: CHART_SCALE, y: chartEur() }
    }
  });
}

function renderStackChart() {
  const ys = yearStats();
  const series = [
    ['Base', 'vencimento_base', '#a78bfa'],
    ['TSD', 'tsd_eur', '#4ade80'],
    ['TSN', 'tsn_eur', '#22c55e'],
    ['Domingo', 'sub_domingo_eur', '#60a5fa'],
    ['Feriado', 'sub_feriado_eur', '#3b82f6'],
    ['Noturno', 'sub_noturno_eur', '#1d4ed8'],
    ['Sub. Almoço', 'sub_almoco_eur', '#34d399'],
    ['Outros', 'outros_eur', '#f87171'],
    ['Férias', 'sub_ferias_eur', '#fbbf24'],
    ['Natal', 'sub_natal_eur', '#fb923c'],
  ];
  const datasets = series.map(([label, key, color]) => ({
    label, backgroundColor: color,
    data: ys.map(y => parseFloat(avg(y.rows, key).toFixed(2))),
  }));

  if (stackChart) stackChart.destroy();
  stackChart = new Chart(document.getElementById('stackChart'), {
    type: 'bar',
    data: { labels: ys.map(y => y.ano + (y.incompleto ? '*' : '')), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#bbb', font: CHART_FONT } } },
      scales: { x: { ...CHART_SCALE, stacked: true }, y: chartEur({ stacked: true }) }
    }
  });
}

// Detalhe do mês: só campos diferentes de zero. [rótulo, campo, inverter sinal]
const DETAIL = [
  ['Base €/h', 'taxa_horaria_base'], ['Base', 'vencimento_base'], ['Vencimento', 'vencimento_mesatual_eur'],
  ['TSD', 'tsd_eur'], ['TSN', 'tsn_eur'], ['Domingo', 'sub_domingo_eur'], ['Feriado', 'sub_feriado_eur'],
  ['Noturno', 'sub_noturno_eur'], ['Almoço', 'sub_almoco_eur'], ['Outros', 'outros_eur'],
  ['Férias', 'sub_ferias_eur'], ['Natal', 'sub_natal_eur'], ['SS', 'ss_eur', true], ['IRS', 'irs_eur', true],
  ['Valor mês', 'valor_mes'],
];

function monthRows(r, id) {
  const h = numOrNull(r.horas_trabalhadas), liq = numOrNull(r.total_liquido_mes);
  const det = DETAIL.map(([lab, k, inv]) => {
    const raw = numOrNull(r[k]);
    if (!raw) return '';
    const v = inv ? -raw : raw;
    return `<div><span>${lab}</span><b class="${v < 0 ? 'neg' : ''}">${k === 'taxa_horaria_base' ? fmtRate(v) : fmtEUR(v)}</b></div>`;
  }).join('');
  return `
    <tr class="mrow ${r.mes_incompleto ? 'incomplete' : ''}" data-id="${id}" tabindex="0" aria-expanded="false">
      <td>${escHtml(r.mes)}${r.mes_incompleto ? '<span class="pill">provisório</span>' : ''}</td>
      <td>${fmtHoras(h)}</td>
      <td>${fmtEUR(r.total_bruto_mes)}</td>
      <td>${fmtEUR(liq)}</td>
      <td>${h && liq !== null ? fmtRate(liq / h) : '-'}</td>
    </tr>
    <tr class="det hidden" id="${id}"><td colspan="5"><div class="det-grid">${det}</div></td></tr>`;
}

function renderLedger() {
  const yearSel = document.getElementById('yearFilter').value;
  const includeIncomplete = document.getElementById('includeIncomplete').checked;
  const q = document.getElementById('searchBox').value.trim().toLowerCase();
  const rows = RAW.filter(r =>
    (yearSel === "all" || String(r.ano) === yearSel) &&
    (includeIncomplete || !r.mes_incompleto) &&
    (!q || `${r.mes} ${r.ano}`.toLowerCase().includes(q)));
  document.getElementById('conta').textContent = rows.length + " mes(es)";
  if (!RAW.length) return;

  const anoAtual = RAW[RAW.length - 1].ano;
  const filtrado = yearSel !== "all" || q;
  const years = [...new Set(rows.map(r => r.ano))].reverse();
  document.getElementById('ledger').innerHTML = years.map(y => {
    const yr = rows.filter(r => r.ano === y).reverse();
    const closed = yr.filter(r => !r.mes_incompleto);
    const h = sum(closed, 'horas_trabalhadas'), liq = sum(closed, 'total_liquido_mes');
    return `<details class="year" ${y === anoAtual || filtrado ? 'open' : ''}>
      <summary>
        <span class="y">${y}</span>
        <span>${closed.length} meses</span>
        <span>bruto ${fmtEUR(avg(closed, 'total_bruto_mes'))}/mês</span>
        <span>líquido ${fmtEUR(avg(closed, 'total_liquido_mes'))}/mês</span>
        <span>${h ? fmtRate(liq / h) + '/h' : '-'}</span>
      </summary>
      <div class="table-wrap"><table class="plain"><thead><tr>
        <th>Mês</th><th class="num">Horas</th><th class="num">Bruto</th><th class="num">Líquido</th><th class="num">€/h</th>
      </tr></thead><tbody>${yr.map(r => monthRows(r, `m${r.ano}-${r.mes_num}`)).join('')}</tbody></table></div>
    </details>`;
  }).join('') || '<p class="empty">Sem meses para os filtros escolhidos.</p>';
}

function toggleMonth(tr) {
  const open = tr.getAttribute('aria-expanded') !== 'true';
  tr.setAttribute('aria-expanded', open);
  document.getElementById(tr.dataset.id).classList.toggle('hidden', !open);
}
const ledgerEl = document.getElementById('ledger');
ledgerEl.addEventListener('click', e => { const tr = e.target.closest('.mrow'); if (tr) toggleMonth(tr); });
ledgerEl.addEventListener('keydown', e => {
  const tr = e.target.closest('.mrow');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleMonth(tr); }
});

init();
