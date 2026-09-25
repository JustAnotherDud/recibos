// Projeto Supabase "Income". A publishable key é pública por desenho:
// o RLS só deixa ler ao utilizador autenticado; anon não tem acesso.
const SUPABASE_URL = 'https://ofjletuwsemgxhlpwhmn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EEOi4mSkkpd-NcilTL1FMA_G6-JlS2l';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

let RAW = [];
let appStarted = false;
let sortState = { key: "periodo", dir: -1 };
let trendChart, stackChart, stackMode = 'bruto';

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function periodoKey(r) { return r.ano * 100 + r.mes_num; }

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
  RAW = [];
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (stackChart) { stackChart.destroy(); stackChart = null; }
  ['kpiRow', 'kpiRates', 'ledgerBody', 'conta', 'statusLine'].forEach(id => {
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
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "€" + Math.abs(n).toFixed(2).replace(".", ",");
}
function fmtRate(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(2).replace(".", ",") + "€";
}
function numOrNull(v) { return (v === null || v === undefined) ? null : Number(v); }

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
    populateYearFilter();
    renderAll();

    const when = new Date();
    stamp.textContent = "atualizado " + when.toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
    stamp.classList.remove('stale'); stamp.classList.add('ok');
    loadingMsg.classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');

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

function filteredRows() {
  const yearSel = document.getElementById('yearFilter').value;
  const includeIncomplete = document.getElementById('includeIncomplete').checked;
  const q = document.getElementById('searchBox').value.trim().toLowerCase();
  return RAW.filter(r => {
    if (yearSel !== "all" && String(r.ano) !== yearSel) return false;
    if (!includeIncomplete && r.mes_incompleto) return false;
    if (q && !`${r.mes} ${r.ano}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderAll() {
  const rows = filteredRows();
  renderKPIs(rows);
  renderTrendChart(rows);
  renderStackChart(rows);
  renderTable(rows);
  document.getElementById('conta').textContent = rows.length + " mes(es)";
}

function renderKPIs(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (numOrNull(r[k]) || 0), 0);
  const bruto = sum('total_bruto_mes');
  const liquido = sum('total_liquido_mes');
  const completos = rows.filter(r => !r.mes_incompleto);
  const mediaLiq = completos.length ? completos.reduce((a, r) => a + (numOrNull(r.total_liquido_mes) || 0), 0) / completos.length : 0;

  const sorted = [...rows].sort((a, b) => periodoKey(a) - periodoKey(b));
  const latest = sorted.slice(-1)[0] || null;
  const taxaAtual = latest ? numOrNull(latest.taxa_horaria_base) : null;

  document.getElementById('kpiRow').innerHTML = `
    <div class="msc"><div class="lab">Total bruto</div><div class="val">${fmtEUR(bruto)}</div></div>
    <div class="msc accent"><div class="lab">Total líquido</div><div class="val">${fmtEUR(liquido)}</div></div>
    <div class="msc"><div class="lab">Média líquido / mês</div><div class="val">${fmtEUR(mediaLiq)}</div></div>
    <div class="msc"><div class="lab">€/hora atual</div><div class="val">${fmtRate(taxaAtual)}</div></div>
  `;

  if (taxaAtual === null || !latest) { document.getElementById('kpiRates').innerHTML = ''; return; }

  const t = taxaAtual;
  const latestComplete = completos.length
    ? [...completos].sort((a, b) => periodoKey(a) - periodoKey(b)).slice(-1)[0]
    : latest;
  const mesRef = escHtml((latestComplete.mes || '') + ' ' + (latestComplete.ano || ''));

  const almocoDia = numOrNull(latestComplete.sub_almoco_taxa_dia);

  const ef = (key) => numOrNull(latestComplete[key]);
  const rates = [
    ['Base', t, '/hora'],
    ef('tsd_taxa_efetiva')            !== null ? ['TSD', ef('tsd_taxa_efetiva'), '/hora'] : null,
    ef('tsn_taxa_efetiva')            !== null ? ['TSN', ef('tsn_taxa_efetiva'), '/hora'] : null,
    ef('acrescimotsn_taxa_efetiva')   !== null ? ['Acrés. TSN', ef('acrescimotsn_taxa_efetiva'), '/hora'] : null,
    ef('subnoturno_taxa_efetiva')     !== null ? ['Sub. Noturno', ef('subnoturno_taxa_efetiva'), '/hora'] : null,
    ef('subdomingo_taxa_efetiva')     !== null ? ['Sub. Domingo', ef('subdomingo_taxa_efetiva'), '/hora'] : null,
    ef('subferiado_taxa_efetiva')     !== null ? ['Sub. Feriado', ef('subferiado_taxa_efetiva'), '/hora'] : null,
    almocoDia !== null                ? ['Sub. Almoço', almocoDia, '/dia'] : null,
  ].filter(Boolean);

  document.getElementById('kpiRates').innerHTML =
    `<div class="rates-label">Taxas em vigor — ${mesRef}</div>` +
    rates.map(([lab, val, unit, badge]) => `
      <div class="msc rate-card">
        <div class="lab">${lab}</div>
        <div class="val rate-val">${fmtRate(val)}<span class="rate-unit">${unit}</span></div>
        ${badge ? `<div class="rate-badge">${badge}</div>` : ''}
      </div>
    `).join('');
}

function labelFor(r) { return (r.mes || "").slice(0, 3) + "/" + String(r.ano).slice(2); }

function renderTrendChart(rows) {
  const sorted = [...rows].sort((a, b) => a.ano - b.ano || a.mes_num - b.mes_num);
  const ctx = document.getElementById('trendChart');
  const labels = sorted.map(labelFor);
  const bruto = sorted.map(r => numOrNull(r.total_bruto_mes));
  const liquido = sorted.map(r => numOrNull(r.total_liquido_mes));

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels, datasets: [
        { label: 'Bruto', data: bruto, borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.10)', fill: true, tension: 0.25, pointRadius: 2 },
        { label: 'Líquido', data: liquido, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.12)', fill: true, tension: 0.25, pointRadius: 2 },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { color: '#bbb', font: { family: "IBM Plex Mono", size: 11 } } } },
      scales: {
        x: { grid: { color: '#2e2e2e' }, ticks: { color: '#9a9a9a', font: { family: "IBM Plex Mono", size: 10 } } },
        y: { grid: { color: '#2e2e2e' }, ticks: { color: '#9a9a9a', font: { family: "IBM Plex Mono", size: 10 }, callback: (v) => "€" + v } }
      }
    }
  });
}

function toggleStackMode() {
  stackMode = stackMode === 'bruto' ? 'liquido' : 'bruto';
  document.getElementById('stackToggle').textContent = stackMode === 'bruto' ? 'Ver líquido' : 'Ver bruto';
  document.getElementById('stackTitle').textContent = stackMode === 'bruto' ? 'Composição do bruto, por mês' : 'Composição do líquido, por mês (descontos proporcionais)';
  renderStackChart(filteredRows());
}

function renderStackChart(rows) {
  const sorted = [...rows].sort((a, b) => a.ano - b.ano || a.mes_num - b.mes_num);
  const ctx = document.getElementById('stackChart');
  const labels = sorted.map(labelFor);
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
    label,
    data: sorted.map(r => {
      const v = numOrNull(r[key]) || 0;
      if (stackMode === 'liquido') {
        const bruto = numOrNull(r.total_bruto_mes) || 0;
        const liquido = numOrNull(r.total_liquido_mes) || 0;
        const ratio = bruto !== 0 ? liquido / bruto : 1;
        return parseFloat((v * ratio).toFixed(2));
      }
      return v;
    }),
    backgroundColor: color
  }));

  if (stackChart) stackChart.destroy();
  stackChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { color: '#bbb', font: { family: "IBM Plex Mono", size: 10 } } } },
      scales: {
        x: { stacked: true, grid: { color: '#2e2e2e' }, ticks: { color: '#9a9a9a', font: { family: "IBM Plex Mono", size: 10 } } },
        y: { stacked: true, grid: { color: '#2e2e2e' }, ticks: { color: '#9a9a9a', font: { family: "IBM Plex Mono", size: 10 }, callback: (v) => "€" + v } }
      }
    }
  });
}

function fmtHoras(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(1).replace(".", ",") + "h";
}

const TABLE_COLS = [
  { key: 'vencimento_base',        fmt: fmtEUR,   neg: false },
  { key: 'vencimento_mesatual_eur',fmt: fmtEUR,   neg: false },
  { key: 'taxa_horaria_base',      fmt: fmtRate,  neg: false },
  { key: 'horas_trabalhadas',      fmt: fmtHoras, neg: false },
  { key: 'tsd_eur',                fmt: fmtEUR,   neg: false },
  { key: 'tsn_eur',                fmt: fmtEUR,   neg: false },
  { key: 'sub_domingo_eur',        fmt: fmtEUR,   neg: false },
  { key: 'sub_feriado_eur',        fmt: fmtEUR,   neg: false },
  { key: 'sub_noturno_eur',        fmt: fmtEUR,   neg: false },
  { key: 'outros_eur',             fmt: fmtEUR,   neg: false },
  { key: 'sub_ferias_eur',         fmt: fmtEUR,   neg: false },
  { key: 'sub_natal_eur',          fmt: fmtEUR,   neg: false },
  { key: 'ss_eur',                 fmt: fmtEUR,   invert: true },
  { key: 'irs_eur',                fmt: fmtEUR,   invert: true },
  { key: 'valor_mes',              fmt: fmtEUR,   neg: false },
  { key: 'total_bruto_mes',        fmt: fmtEUR,   neg: false },
  { key: 'total_liquido_mes',      fmt: fmtEUR,   neg: false },
];

function renderTable(rows) {
  const sorted = [...rows].sort((a, b) => {
    let av, bv;
    if (sortState.key === "periodo") { av = periodoKey(a); bv = periodoKey(b); }
    else { av = numOrNull(a[sortState.key]) || 0; bv = numOrNull(b[sortState.key]) || 0; }
    return (av - bv) * sortState.dir;
  });

  document.querySelectorAll('#ledgerTable thead th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === sortState.key) th.classList.add(sortState.dir === 1 ? 'sorted-asc' : 'sorted-desc');
  });

  const colspan = TABLE_COLS.length + 1;
  document.getElementById('ledgerBody').innerHTML = sorted.map(r => `
    <tr class="${r.mes_incompleto ? 'incomplete' : ''}">
      <td>${escHtml(r.mes)} ${escHtml(r.ano)}${r.mes_incompleto ? '<span class="pill">provisório</span>' : ''}</td>
      ${TABLE_COLS.map(c => {
        const raw = numOrNull(r[c.key]);
        const v = (c.invert && raw !== null) ? -raw : raw;
        const isNeg = (v || 0) < 0;
        return `<td class="${isNeg ? 'neg' : ''}">${c.fmt(v)}</td>`;
      }).join('')}
    </tr>
  `).join('') || `<tr><td colspan="${colspan}" class="empty">Sem meses para os filtros escolhidos.</td></tr>`;
}

document.querySelectorAll('#ledgerTable thead th').forEach(th => {
  th.tabIndex = 0;
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    sortState.dir = (sortState.key === key) ? -sortState.dir : 1;
    sortState.key = key;
    renderAll();
  });
  th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); } });
});

init();
