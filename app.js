/* Expected win rates from Trainer Hill matchup data.
   Reads the committed data.json snapshot, lets the user pick a field and its
   expected meta shares, and ranks decks by win rate against that field. */

const state = {
    data: null,
    decks: [],            // snapshot deck records, ordered as stored
    bySlug: new Map(),
    grid: null,           // grid[i][j] = {wins, losses, ties} from i's side
    selected: [],         // slugs, in selection order
    shares: new Map(),    // slug -> percent as typed by the user
    k: 20,                // regression strength, in pseudo decisive games
    includeMirror: true,
    showMatrix: true,
    openDeck: null,
    search: '',
    cutoff: 0.002,
};

const THIN = 20;          // decisive games below which a matchup is flagged thin

const el = (id) => document.getElementById(id);
const fmtPct = (x, dp = 1) => `${x.toFixed(dp)}%`;

/* ---------- load ---------- */

async function load() {
    let data;
    try {
        const res = await fetch(`data.json?v=${Date.now()}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        el('snapshot').textContent = 'Could not load matchup data — try reloading.';
        el('deck-grid').innerHTML =
            `<p class="empty-note">Failed to load <code>data.json</code> (${err.message}).</p>`;
        return;
    }

    state.data = data;
    state.decks = data.decks;
    data.decks.forEach((d, i) => { d.index = i; state.bySlug.set(d.slug, d); });

    // Rebuild the full square grid from the stored triangle.
    const n = data.decks.length;
    state.grid = Array.from({ length: n }, () => new Array(n).fill(null));
    for (const [i, j, wins, losses, ties] of data.matchups) {
        state.grid[i][j] = { wins, losses, ties };
        if (i !== j) state.grid[j][i] = { wins: losses, losses: wins, ties };
    }

    describeSnapshot();
    restoreFromHash();
    renderDeckPicker();
    render();
}

function describeSnapshot() {
    const f = state.data.filter;
    const div = { JR: 'Juniors', SR: 'Seniors', MA: 'Masters' };
    const platform = { all: 'online + majors', online: 'online only', inperson: 'majors only' };
    const parts = [
        `${f.start_date} → ${f.end_date}`,
        `${f.division.map((d) => div[d] || d).join(' / ')}`,
        `${platform[f.platform] || f.platform}`,
        `events of ${f.players}+ players`,
        `${state.data.total_matches.toLocaleString()} matches`,
    ];
    el('snapshot').textContent = parts.join(' · ');
    el('footer-generated').textContent = state.data.generated_at.replace('T', ' ').replace('+00:00', ' UTC');
}

/* ---------- matchup math ---------- */

/* Shrink a matchup toward 50% with a Beta(k/2, k/2) prior: k is worth k extra
   decisive games split evenly. A pairing with no games lands on exactly 50%,
   which is also how missing matchups are handled. */
function shrunkWinRate(i, j, k) {
    const m = state.grid[i][j];
    const wins = m ? m.wins : 0;
    const losses = m ? m.losses : 0;
    const decisive = wins + losses;
    if (decisive + k === 0) return 50;
    return ((wins + k / 2) / (decisive + k)) * 100;
}

function rawWinRate(i, j) {
    const m = state.grid[i][j];
    if (!m || m.wins + m.losses === 0) return null;
    return (m.wins / (m.wins + m.losses)) * 100;
}

function decisiveGames(i, j) {
    const m = state.grid[i][j];
    return m ? m.wins + m.losses : 0;
}

/* Field the selected decks are measured against: each selected deck weighted by
   the share the user typed, normalized so the result reads as a win rate. */
function buildField() {
    const rows = state.selected
        .map((slug) => ({ slug, deck: state.bySlug.get(slug), share: Number(state.shares.get(slug)) || 0 }))
        .filter((r) => r.deck && r.share > 0);
    const total = rows.reduce((s, r) => s + r.share, 0);
    return { rows, total };
}

function computeResults() {
    const { rows, total } = buildField();
    if (!rows.length || total <= 0) return [];

    return state.selected
        .map((slug) => state.bySlug.get(slug))
        .filter(Boolean)
        .map((deck) => {
            const opponents = rows.filter(
                (r) => state.includeMirror || r.slug !== deck.slug
            );
            const weight = opponents.reduce((s, r) => s + r.share, 0);
            const breakdown = opponents.map((r) => {
                const j = r.deck.index;
                return {
                    slug: r.slug,
                    name: r.deck.name,
                    icons: r.deck.icons,
                    share: r.share,
                    weight: weight > 0 ? r.share / weight : 0,
                    wr: shrunkWinRate(deck.index, j, state.k),
                    raw: rawWinRate(deck.index, j),
                    n: decisiveGames(deck.index, j),
                    isMirror: r.slug === deck.slug,
                };
            });
            const expected = weight > 0
                ? breakdown.reduce((s, b) => s + b.weight * b.wr, 0)
                : 50;
            const games = breakdown.reduce((s, b) => s + b.n, 0);
            const thin = breakdown.filter((b) => b.n < THIN).length;
            breakdown.sort((a, b) => b.share - a.share);
            return {
                deck,
                expected,
                fieldWeight: weight,
                shareOfField: total > 0 ? (Number(state.shares.get(deck.slug)) || 0) / total : 0,
                games,
                thin,
                breakdown,
            };
        })
        .sort((a, b) => b.expected - a.expected);
}

/* ---------- color scale ---------- */

/* Diverging: red below 50%, neutral at 50%, blue above. Steps at 2.5 / 5 / 10 /
   20 points from even, so the common 45-55% range still separates. */
const SCALE = [
    { limit: -20, css: '--wr-loss-4', dark: true },
    { limit: -10, css: '--wr-loss-3', dark: true },
    { limit: -5, css: '--wr-loss-2', dark: false },
    { limit: -2.5, css: '--wr-loss-1', dark: false },
    { limit: 2.5, css: '--wr-even', dark: false },
    { limit: 5, css: '--wr-win-1', dark: false },
    { limit: 10, css: '--wr-win-2', dark: false },
    { limit: 20, css: '--wr-win-3', dark: false },
    { limit: Infinity, css: '--wr-win-4', dark: true },
];

function scaleStep(wr) {
    const delta = wr - 50;
    return SCALE.find((s) => delta < s.limit) || SCALE[SCALE.length - 1];
}

/* ---------- deck picker ---------- */

function renderDeckPicker() {
    const grid = el('deck-grid');
    const q = state.search.trim().toLowerCase();
    const visible = state.decks.filter((d) => {
        if (state.selected.includes(d.slug)) return true;   // never hide a choice
        if (d.share < state.cutoff) return false;
        if (q && !d.name.toLowerCase().includes(q) && !d.slug.includes(q)) return false;
        return true;
    });

    if (!visible.length) {
        grid.innerHTML = `<p class="empty-note">No decks match “${escapeHtml(state.search)}”.</p>`;
    } else {
        grid.innerHTML = visible.map((d) => {
            const on = state.selected.includes(d.slug);
            return `<label class="deck-chip${on ? ' is-selected' : ''}">
                <input type="checkbox" data-slug="${d.slug}"${on ? ' checked' : ''}>
                <span class="deck-icons">${iconsHtml(d.icons, true)}</span>
                <span class="deck-chip-text">
                    <span class="deck-chip-name">${escapeHtml(d.name)}</span>
                    <span class="deck-chip-share">${fmtPct(d.share * 100)} of matches · ${d.games.toLocaleString()} games</span>
                </span>
            </label>`;
        }).join('');
    }

    const hidden = state.decks.length - visible.length;
    el('selected-count').textContent = state.selected.length
        ? `${state.selected.length} selected${hidden ? ` · ${hidden} hidden` : ''}`
        : `${state.decks.length} decks available`;
}

function iconsHtml(icons, lazy = false) {
    return (icons || []).slice(0, 3)
        .map((src) => `<img src="${src}" alt=""${lazy ? ' loading="lazy"' : ''}>`).join('');
}

/* ---------- shares ---------- */

/* Prefill a newly selected deck with its observed usage, so the shares start as
   a description of the current meta and the user edits from there. */
function observedPercent(slug) {
    const d = state.bySlug.get(slug);
    if (!d) return 0;
    return Math.round(d.share * 1000) / 10;
}

function resetShares(mode) {
    if (mode === 'even' && state.selected.length) {
        const each = Math.round((100 / state.selected.length) * 10) / 10;
        state.selected.forEach((s) => state.shares.set(s, each));
    } else {
        state.selected.forEach((s) => state.shares.set(s, observedPercent(s)));
    }
}

function renderShares() {
    const wrap = el('share-list');
    wrap.innerHTML = state.selected.map((slug) => {
        const d = state.bySlug.get(slug);
        const val = state.shares.get(slug);
        return `<div class="share-row">
            <span class="deck-icons">${iconsHtml(d.icons)}</span>
            <span class="deck-chip-text">
                <span class="deck-chip-name">${escapeHtml(d.name)}</span>
                <span class="deck-chip-share">observed ${fmtPct(d.share * 100)}</span>
            </span>
            <span class="share-input-wrap">
                <input type="number" min="0" max="100" step="0.1" inputmode="decimal"
                       value="${val}" data-share="${slug}" aria-label="${escapeHtml(d.name)} expected meta share">
                <span class="pct">%</span>
            </span>
        </div>`;
    }).join('');

    const { total } = buildField();
    const totalEl = el('share-total');
    if (!state.selected.length) {
        totalEl.textContent = '';
        return;
    }
    totalEl.classList.toggle('is-warn', total <= 0);
    totalEl.innerHTML = total <= 0
        ? 'Give at least one deck a share above 0%.'
        : `Shares total <strong>${fmtPct(total)}</strong>` +
          (Math.abs(total - 100) > 0.5
              ? ` — the page normalizes this to 100%, so the result reads as a win rate against these decks.`
              : `.`);
}

/* ---------- results ---------- */

function renderResults(results) {
    const wrap = el('results');
    if (!results.length) {
        wrap.innerHTML = '<p class="empty-note">Select at least one deck, and give it a share above 0%.</p>';
        return;
    }

    const spread = Math.max(
        6,
        ...results.map((r) => Math.abs(r.expected - 50))
    );

    wrap.innerHTML = `<table class="data">
        <thead><tr>
            <th></th><th>Deck</th>
            <th class="num">Expected WR</th>
            <th class="bar-head">vs. 50%</th>
            <th class="num">Your share</th>
            <th class="num">Games</th>
        </tr></thead>
        <tbody>${results.map((r, i) => resultRowHtml(r, i, spread)).join('')}</tbody>
    </table>`;
}

function resultRowHtml(r, i, spread) {
    const open = state.openDeck === r.deck.slug;
    const delta = r.expected - 50;
    const halfWidth = 50 * Math.min(1, Math.abs(delta) / spread);
    const fill = delta >= 0
        ? `left:50%;width:${halfWidth}%`
        : `right:50%;width:${halfWidth}%`;

    const row = `<tr class="result-row${open ? ' is-open' : ''}" data-deck="${r.deck.slug}"
            tabindex="0" role="button" aria-expanded="${open}">
        <td class="result-rank">${i + 1}</td>
        <td class="result-deck">
            <span class="result-deck-inner">
                <span class="deck-icons">${iconsHtml(r.deck.icons)}</span>
                ${escapeHtml(r.deck.name)}
            </span>
        </td>
        <td class="num result-wr">${fmtPct(r.expected)}</td>
        <td class="bar-cell">
            <span class="bar-track">
                <span class="bar-baseline" style="left:50%"></span>
                <span class="bar-fill ${delta >= 0 ? 'up' : 'down'}" style="${fill}"></span>
            </span>
        </td>
        <td class="num result-share">${fmtPct(r.shareOfField * 100)}</td>
        <td class="num result-games">${r.games.toLocaleString()}${r.thin ? `<span class="thin-flag">${r.thin} thin</span>` : ''}</td>
    </tr>`;

    if (!open) return row;
    return row + `<tr><td class="breakdown-cell" colspan="6">${breakdownHtml(r)}</td></tr>`;
}

function breakdownHtml(r) {
    const rows = r.breakdown.map((b) => {
        const step = scaleStep(b.wr);
        return `<tr>
            <td>${escapeHtml(b.name)}${b.isMirror ? ' <span class="deck-chip-share">(mirror)</span>' : ''}</td>
            <td class="num">${fmtPct(b.weight * 100)}</td>
            <td class="num">
                <span class="wr-pill" style="background:var(${step.css});color:var(${step.dark ? '--ink-on-dark' : '--ink-on-light'})">
                    ${fmtPct(b.wr)}
                </span>
            </td>
            <td class="num">${b.raw === null ? '—' : fmtPct(b.raw)}</td>
            <td class="num">${b.n}${b.n < THIN ? '<span class="thin-flag">thin</span>' : ''}</td>
            <td class="num">${fmtPct(b.weight * b.wr)}</td>
        </tr>`;
    }).join('');

    return `<div class="breakdown">
        <h4>${escapeHtml(r.deck.name)} — matchup by matchup</h4>
        <table class="breakdown-table">
            <thead><tr>
                <th>Opponent</th>
                <th class="num">Weight</th>
                <th class="num">Win rate</th>
                <th class="num">Raw</th>
                <th class="num">Decisive games</th>
                <th class="num">Contribution</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr>
                <td>Expected win rate</td>
                <td class="num">100.0%</td>
                <td colspan="3"></td>
                <td class="num">${fmtPct(r.expected)}</td>
            </tr></tfoot>
        </table>
    </div>`;
}

/* ---------- matrix ---------- */

function renderMatrix(results) {
    const section = el('step-matrix');
    if (!state.showMatrix || results.length < 2) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    const order = results.map((r) => r.deck);
    const head = order.map((d) =>
        `<th><span class="col-label">${escapeHtml(d.name)}</span></th>`).join('');

    const body = order.map((row) => {
        const cells = order.map((col) => {
            const isMirror = row.slug === col.slug;
            const wr = shrunkWinRate(row.index, col.index, state.k);
            const n = decisiveGames(row.index, col.index);
            const step = scaleStep(wr);
            if (isMirror) {
                return `<td class="cell is-mirror" title="Mirror match">—</td>`;
            }
            return `<td class="cell${step.dark ? ' on-dark' : ''}${n < THIN ? ' is-thin' : ''}"
                style="background:var(${step.css})"
                data-row="${row.slug}" data-col="${col.slug}">${wr.toFixed(0)}</td>`;
        }).join('');
        return `<tr><th>${escapeHtml(row.name)}</th>${cells}</tr>`;
    }).join('');

    el('matrix').innerHTML = `<table class="matrix">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body}</tbody>
    </table>`;

    renderLegend();
}

function renderLegend() {
    const swatches = ['--wr-loss-4', '--wr-loss-3', '--wr-loss-2', '--wr-loss-1',
        '--wr-even', '--wr-win-1', '--wr-win-2', '--wr-win-3', '--wr-win-4']
        .map((c) => `<span class="legend-swatch" style="background:var(${c})"></span>`).join('');
    el('matrix-legend').innerHTML =
        `<span class="legend-label">Unfavorable</span>
         <span class="legend-scale">${swatches}</span>
         <span class="legend-label">Favorable</span>
         <span class="legend-note">dashed = under ${THIN} games</span>`;
}

/* ---------- tooltip ---------- */

const tooltip = () => el('tooltip');

function showTooltip(html, x, y) {
    const t = tooltip();
    t.innerHTML = html;
    t.hidden = false;
    const box = t.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), window.innerWidth - box.width - 8);
    const top = Math.min(Math.max(8, y + 14), window.innerHeight - box.height - 8);
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
}

function hideTooltip() { tooltip().hidden = true; }

function cellTooltip(rowSlug, colSlug) {
    const a = state.bySlug.get(rowSlug);
    const b = state.bySlug.get(colSlug);
    const m = state.grid[a.index][b.index];
    const wr = shrunkWinRate(a.index, b.index, state.k);
    const raw = rawWinRate(a.index, b.index);
    const record = m ? `${m.wins}–${m.losses}–${m.ties}` : 'no recorded games';
    const n = decisiveGames(a.index, b.index);
    return `<span class="tt-title"><strong>${escapeHtml(a.name)}</strong> vs ${escapeHtml(b.name)}</span>
        <span class="tt-num">${fmtPct(wr)} after regression</span><br>
        <span class="tt-num">${raw === null ? 'No games. Sits at 50%.' : `${fmtPct(raw)} raw · ${record} (W–L–T)`}</span>
        ${n && n < THIN ? `<br><span class="tt-num">Only ${n} decisive games. Thin.</span>` : ''}`;
}

/* ---------- CSV + link ---------- */

function downloadCsv(results) {
    const head = ['rank', 'deck', 'expected_win_rate', 'your_meta_share_pct', 'decisive_games', 'thin_matchups'];
    const lines = [head.join(',')];
    results.forEach((r, i) => {
        lines.push([
            i + 1,
            `"${r.deck.name.replace(/"/g, '""')}"`,
            r.expected.toFixed(2),
            (Number(state.shares.get(r.deck.slug)) || 0).toFixed(1),
            r.games,
            r.thin,
        ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `expected-win-rates-${state.data.filter.end_date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

/* Keep the whole configuration in the URL so a setup can be shared. */
function syncHash() {
    if (!state.selected.length) {
        history.replaceState(null, '', location.pathname);
        return;
    }
    const decks = state.selected
        .map((s) => `${s}:${Number(state.shares.get(s)) || 0}`)
        .join(',');
    const parts = [`decks=${decks}`, `k=${state.k}`];
    if (!state.includeMirror) parts.push('mirror=0');
    if (state.openDeck) parts.push(`open=${state.openDeck}`);
    history.replaceState(null, '', `${location.pathname}#${parts.join('&')}`);
}

function restoreFromHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const decks = params.get('decks');
    if (decks) {
        for (const entry of decks.split(',')) {
            const [slug, share] = entry.split(':');
            if (!state.bySlug.has(slug)) continue;
            state.selected.push(slug);
            const pct = Number(share);
            state.shares.set(slug, Number.isFinite(pct) ? pct : observedPercent(slug));
        }
    }
    const k = Number(params.get('k'));
    if (Number.isFinite(k) && k >= 0 && k <= 60) state.k = k;
    if (params.get('mirror') === '0') state.includeMirror = false;
    const open = params.get('open');
    if (open && state.bySlug.has(open)) state.openDeck = open;

    el('shrink').value = state.k;
    el('include-mirror').checked = state.includeMirror;
}

/* ---------- render ---------- */

function render() {
    const has = state.selected.length > 0;
    el('step-shares').hidden = !has;
    el('step-results').hidden = !has;
    el('step-settings').hidden = !has;

    el('shrink-label').textContent = state.k === 0 ? '· off' : `· k = ${state.k}`;
    el('shrink-hint').textContent = state.k === 0
        ? 'Raw Trainer Hill win rates. A 3–0 matchup reads as 100%.'
        : `A 3–0 matchup reads as ${fmtPct(((3 + state.k / 2) / (3 + state.k)) * 100)}. ` +
          `A 60–40 record over 100 games reads as ${fmtPct(((60 + state.k / 2) / (100 + state.k)) * 100)}.`;

    renderShares();
    const results = computeResults();
    renderResults(results);
    renderMatrix(results);
    syncHash();
    return results;
}

/* ---------- events ---------- */

function toggleDeck(slug, on) {
    if (on) {
        if (!state.selected.includes(slug)) {
            state.selected.push(slug);
            if (!state.shares.has(slug)) state.shares.set(slug, observedPercent(slug));
        }
    } else {
        state.selected = state.selected.filter((s) => s !== slug);
        if (state.openDeck === slug) state.openDeck = null;
    }
    renderDeckPicker();
    render();
}

function wire() {
    el('deck-grid').addEventListener('change', (e) => {
        const box = e.target.closest('input[data-slug]');
        if (box) toggleDeck(box.dataset.slug, box.checked);
    });

    el('deck-search').addEventListener('input', (e) => {
        state.search = e.target.value;
        renderDeckPicker();
    });

    el('deck-cutoff').addEventListener('change', (e) => {
        state.cutoff = Number(e.target.value);
        renderDeckPicker();
    });

    el('clear-decks').addEventListener('click', () => {
        state.selected = [];
        state.openDeck = null;
        renderDeckPicker();
        render();
    });

    document.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const n = Number(btn.dataset.preset);
            state.selected = [...state.decks]
                .filter((d) => d.slug !== 'other')     // a bucket, not a deck
                .sort((a, b) => b.share - a.share)
                .slice(0, n)
                .map((d) => d.slug);
            resetShares('observed');
            state.openDeck = null;
            renderDeckPicker();
            render();
        });
    });

    el('reset-shares').addEventListener('click', () => { resetShares('observed'); render(); });
    el('even-shares').addEventListener('click', () => { resetShares('even'); render(); });

    el('share-list').addEventListener('input', (e) => {
        const input = e.target.closest('input[data-share]');
        if (!input) return;
        const pct = Number(input.value);
        state.shares.set(input.dataset.share, Number.isFinite(pct) && pct >= 0 ? pct : 0);
        // Recompute without re-rendering the inputs, so focus and caret survive.
        const results = computeResults();
        renderResults(results);
        renderMatrix(results);
        updateShareTotal();
        syncHash();
    });

    el('shrink').addEventListener('input', (e) => { state.k = Number(e.target.value); render(); });
    el('include-mirror').addEventListener('change', (e) => {
        state.includeMirror = e.target.checked;
        render();
    });
    el('show-matrix').addEventListener('change', (e) => {
        state.showMatrix = e.target.checked;
        render();
    });

    el('results').addEventListener('click', (e) => {
        const row = e.target.closest('.result-row');
        if (!row) return;
        state.openDeck = state.openDeck === row.dataset.deck ? null : row.dataset.deck;
        renderResults(computeResults());
        syncHash();
    });
    el('results').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.result-row');
        if (!row) return;
        e.preventDefault();
        state.openDeck = state.openDeck === row.dataset.deck ? null : row.dataset.deck;
        renderResults(computeResults());
        syncHash();
    });

    const matrix = el('matrix');
    matrix.addEventListener('mousemove', (e) => {
        const cell = e.target.closest('.cell[data-row]');
        if (!cell) { hideTooltip(); return; }
        showTooltip(cellTooltip(cell.dataset.row, cell.dataset.col), e.clientX, e.clientY);
    });
    matrix.addEventListener('mouseleave', hideTooltip);
    window.addEventListener('scroll', hideTooltip, { passive: true });

    el('download-csv').addEventListener('click', () => downloadCsv(computeResults()));

    el('copy-link').addEventListener('click', async (e) => {
        syncHash();
        try {
            await navigator.clipboard.writeText(location.href);
            flash(e.target, 'Copied');
        } catch {
            flash(e.target, 'Copy failed');
        }
    });
}

function updateShareTotal() {
    const { total } = buildField();
    const totalEl = el('share-total');
    totalEl.classList.toggle('is-warn', total <= 0);
    totalEl.innerHTML = total <= 0
        ? 'Give at least one deck a share above 0%.'
        : `Shares total <strong>${fmtPct(total)}</strong>` +
          (Math.abs(total - 100) > 0.5
              ? ' — the page normalizes this to 100%, so the result reads as a win rate against these decks.'
              : '.');
}

function flash(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add('is-busy');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('is-busy'); }, 1400);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

wire();
load();
