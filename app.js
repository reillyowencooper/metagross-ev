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
    /* Two independent roles. A deck is normally both ranked and part of the
       field. The Other bucket belongs in the field but cannot be played, so it
       is not ranked. A deck nobody plays yet is the reverse: rank it, keep it
       out of the field. One flag could not say both. */
    noRank: new Set(),
    noField: new Set(),
    /* One deck the user describes by hand, for a brew that has no tournament
       record yet. Null when unused. Its matchups are estimates, not counts, so
       they arrive as a win rate plus how much testing stands behind it. */
    custom: null,
    k: 20,                // regression strength, in pseudo games
    tieMode: 'ignore',    // how a tie counts: ignore | losses | half
    includeMirror: true,
    showMatrix: true,
    openDeck: null,
    search: '',
    cutoff: 0.002,
};

const THIN = 20;          // games below which a matchup is flagged thin
const CUSTOM = '__custom';  // reserved slug for the hand-entered deck

/* How much testing stands behind a hand-entered win rate, as a game count. The
   same regression applies to an estimate as to a record, so a deck cannot climb
   the ranking on assertion alone. */
const EVIDENCE = [
    { n: 10, label: 'Just a guess' },
    { n: 30, label: 'Some testing' },
    { n: 100, label: 'Well tested' },
    { n: 300, label: 'Tested it to death' },
];
/* Past this many decks the grid stops being readable long before it stops being
   possible: 130 decks is 16,900 cells and over a megabyte of markup, with
   column labels too narrow to read. Show a note instead of a wall. */
const MATRIX_MAX = 24;
const Z = 1.96;           // normal quantile for a 95% interval

/* A tie is not a fact, it is a choice. Pokémon TCG is best of three, so a tie
   often works out as a loss for whoever needed the win. The snapshot stores
   wins, losses and ties separately, so all three readings are available here. */
const TIE_MODES = {
    ignore: {
        label: 'Ignore ties',
        formula: 'W / (W + L)',
        // Prior of k pseudo games, split evenly, added to each side.
        alpha: (w, l, t, k) => w + k / 2,
        beta: (w, l, t, k) => l + k / 2,
    },
    losses: {
        label: 'Ties count as losses',
        formula: 'W / (W + L + T)',
        alpha: (w, l, t, k) => w + k / 2,
        beta: (w, l, t, k) => l + t + k / 2,
    },
    half: {
        label: 'Ties count as half a win',
        formula: '(W + T/2) / (W + L + T)',
        alpha: (w, l, t, k) => w + t / 2 + k / 2,
        beta: (w, l, t, k) => l + t / 2 + k / 2,
    },
};

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
        el('snapshot').textContent = "Couldn't load the matchup data. Try a reload?";
        el('deck-grid').innerHTML =
            `<p class="empty-note">Couldn't fetch <code>data.json</code> (${err.message}). Try a reload.</p>`;
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
    el('preset-all').textContent = `All ${data.decks.length}`;
    /* Name the two most-played decks in the placeholder, so the hint cannot go
       stale the way a hardcoded pair does. */
    const busiest = [...data.decks]
        .filter((d) => d.slug !== 'other')       // a bucket, not a deck to search for
        .sort((a, b) => b.share - a.share)
        .slice(0, 2)
        .map((d) => d.name);
    if (busiest.length === 2) {
        el('deck-search').placeholder = `${busiest[0]}, ${busiest[1]}, …`;
    }

    el('custom-copy').insertAdjacentHTML('beforeend',
        [...data.decks]
            .sort((a, b) => b.share - a.share)
            .map((d) => `<option value="${d.slug}">${escapeHtml(d.name)} `
                      + `(${fmtPct(d.share * 100)})</option>`)
            .join(''));
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

/* One matchup, read through the current tie rule and regressed toward 50%.

   The regression is a Beta(k/2, k/2) prior: k pseudo games split evenly. Its
   posterior mean is the win rate, and its posterior variance is where the
   interval further down comes from, so the two always tell the same story.
   A pair with no games lands on exactly 50% with a wide interval, which is
   also how a missing matchup is handled. */
/* The win rate the user typed for the custom deck against one opponent.
   Anything they left alone is an even matchup. */
function customRate(slug) {
    const v = state.custom?.rates.get(slug);
    return Number.isFinite(v) ? v : 50;
}

/* Turn an estimate into the counts it is worth. A 60% call backed by 30 games
   of testing enters the same arithmetic as an 18-12 record, so an estimate and
   a record are directly comparable. */
function pseudoCounts(pct, n) {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    return { w: p * n, l: (1 - p) * n, t: 0, estimated: true };
}

/* Raw counts behind one matchup, from either side. A custom deck has no record,
   so its side comes from the user's estimate, and the opposite side is the
   complement of it: if you beat a deck 60% of the time, it beats you 40%. */
function counts(aSlug, bSlug) {
    const c = state.custom;
    if (c && aSlug === CUSTOM && bSlug === CUSTOM) return null;   // mirror
    if (c && aSlug === CUSTOM) return pseudoCounts(customRate(bSlug), c.evidence);
    if (c && bSlug === CUSTOM) return pseudoCounts(100 - customRate(aSlug), c.evidence);

    const a = state.bySlug.get(aSlug);
    const b = state.bySlug.get(bSlug);
    if (!a || !b || a.index === undefined || b.index === undefined) return null;
    const m = state.grid[a.index][b.index];
    return m ? { w: m.wins, l: m.losses, t: m.ties, estimated: false }
             : { w: 0, l: 0, t: 0, estimated: false };
}

function matchup(aSlug, bSlug) {
    /* A mirror is exactly 50% by symmetry, whatever the record says, and it
       carries no uncertainty about that. Trainer Hill's own mirror rows are
       already even, so this only matters for a hand-entered deck, where a
       Beta(10, 10) mirror would otherwise widen the interval for no reason. */
    if (aSlug === bSlug) {
        const c0 = counts(aSlug, bSlug);
        return {
            wr: 50, raw: 50, variance: 0, mirror: true,
            n: c0 ? c0.w + c0.l + (state.tieMode === 'ignore' ? 0 : c0.t) : 0,
            estimated: false,
            record: c0 ? `${c0.w}–${c0.l}–${c0.t}` : null,
        };
    }

    const c = counts(aSlug, bSlug);
    const { w, l, t, estimated } = c || { w: 0, l: 0, t: 0, estimated: false };
    const mode = TIE_MODES[state.tieMode];

    const alpha = mode.alpha(w, l, t, state.k);
    const beta = mode.beta(w, l, t, state.k);
    const total = alpha + beta;

    // Games the current tie rule actually counts.
    const n = state.tieMode === 'ignore' ? w + l : w + l + t;

    // Beta(0, 0) is improper, which only happens at k = 0 with no games. Fall
    // back to the variance of a flat prior rather than report a false zero.
    const variance = total > 0
        ? (alpha * beta) / (total * total * (total + 1))
        : 1 / 12;

    const rawA = mode.alpha(w, l, t, 0);
    const rawB = mode.beta(w, l, t, 0);

    return {
        wr: total > 0 ? (alpha / total) * 100 : 50,
        raw: n > 0 ? (rawA / (rawA + rawB)) * 100 : null,
        variance,
        n,
        estimated,
        record: !c ? null
              : estimated ? 'your estimate'
              : `${w}–${l}–${t}`,
    };
}

/* The field: every selected deck the user left in it, weighted by the share
   they typed and normalized so the answer reads as a win rate. */
/* The custom deck stands in for a deck record so the rest of the page does not
   have to know it is different. It carries no index, so grid lookups skip it. */
function customDeckRecord() {
    return {
        slug: CUSTOM,
        name: state.custom.name.trim() || 'Your deck',
        icons: [],
        share: 0,
        games: 0,
        isCustom: true,
    };
}

function registerCustom() {
    if (state.custom) state.bySlug.set(CUSTOM, customDeckRecord());
    else state.bySlug.delete(CUSTOM);
}

/* Every deck that plays a part, real or hand-entered. */
function allSlugs() {
    return state.custom ? [...state.selected, CUSTOM] : [...state.selected];
}

function buildField() {
    const rows = allSlugs()
        .filter((slug) => !state.noField.has(slug))
        .map((slug) => ({ slug, deck: state.bySlug.get(slug), share: shareOf(slug) }))
        .filter((r) => r.deck && r.share > 0);
    const total = rows.reduce((s, r) => s + r.share, 0);
    return { rows, total };
}

function shareOf(slug) {
    if (slug === CUSTOM) return Number(state.custom?.share) || 0;
    return Number(state.shares.get(slug)) || 0;
}

function computeResults() {
    const { rows, total } = buildField();
    if (!rows.length || total <= 0) return [];

    const results = allSlugs()
        .filter((slug) => !state.noRank.has(slug))
        .map((slug) => state.bySlug.get(slug))
        .filter(Boolean)
        .map((deck) => {
            const opponents = rows.filter(
                (r) => state.includeMirror || r.slug !== deck.slug
            );
            const weight = opponents.reduce((s, r) => s + r.share, 0);
            const breakdown = opponents.map((r) => {
                const stats = matchup(deck.slug, r.slug);
                return {
                    slug: r.slug,
                    name: r.deck.name,
                    share: r.share,
                    weight: weight > 0 ? r.share / weight : 0,
                    isMirror: r.slug === deck.slug,
                    ...stats,
                };
            });

            const expected = weight > 0
                ? breakdown.reduce((s, b) => s + b.weight * b.wr, 0)
                : 50;

            /* Variance of a weighted mean of independent matchups. The shares
               are the user's own assumption, so they carry no uncertainty
               here. How much the ranking moves when a share is wrong is a
               separate question. */
            const variance = breakdown.reduce(
                (s, b) => s + (b.weight ** 2) * b.variance, 0
            );
            const se = Math.sqrt(variance) * 100;

            breakdown.sort((a, b) => b.share - a.share);
            return {
                deck,
                expected,
                se,
                ciLow: Math.max(0, expected - Z * se),
                ciHigh: Math.min(100, expected + Z * se),
                inField: !state.noField.has(deck.slug),
                isCustom: deck.slug === CUSTOM,
                estimated: breakdown.some((b) => b.estimated),
                shareOfField: total > 0 && !state.noField.has(deck.slug)
                    ? shareOf(deck.slug) / total : 0,
                games: breakdown.reduce((s, b) => s + b.n, 0),
                thin: breakdown.filter((b) => !b.mirror && b.n < THIN).length,
                breakdown,
            };
        })
        .sort((a, b) => b.expected - a.expected);

    assignTiers(results);
    return results;
}

/* Group decks that the data cannot tell apart. Walk down the ranking, and keep
   adding decks to the current group while their interval still reaches the
   group leader's lower bound. A new group starts at the first deck that clears
   it. Two decks in one group are not evidence of an order. */
function assignTiers(results) {
    let tier = 0;
    let floor = Infinity;
    for (const r of results) {
        if (r.ciHigh < floor) {
            tier += 1;
            floor = r.ciLow;
            r.tierStart = tier > 1;
        } else {
            r.tierStart = false;
        }
        r.tier = tier;
    }
    const sizes = results.reduce((m, r) => m.set(r.tier, (m.get(r.tier) || 0) + 1), new Map());
    results.forEach((r) => { r.tierSize = sizes.get(r.tier); });
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
        grid.innerHTML = `<p class="empty-note">Nothing matches “${escapeHtml(state.search)}”.</p>`;
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

function deckLink(deck) {
    const f = state.data.filter;
    const q = new URLSearchParams({
        game: f.game, players: f.players,
        start_date: f.start_date, end_date: f.end_date,
    });
    return `https://www.trainerhill.com/decklist/${deck.slug}?${q}`;
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
    const inField = state.selected.filter((s) => !state.noField.has(s));
    if (mode === 'even' && inField.length) {
        const each = Math.round((100 / inField.length) * 10) / 10;
        inField.forEach((s) => state.shares.set(s, each));
        return;
    }
    state.selected.forEach((s) => state.shares.set(s, observedPercent(s)));
    absorbRemainder();
}

/* Point the Other bucket at whatever share the listed decks leave over, so the
   field adds up to a whole meta rather than only its head. */
function absorbRemainder() {
    if (!state.selected.includes('other') || state.noField.has('other')) return;
    const rest = state.selected
        .filter((s) => s !== 'other' && !state.noField.has(s))
        .reduce((sum, s) => sum + (Number(state.shares.get(s)) || 0), 0);
    state.shares.set('other', Math.round(Math.max(0, 100 - rest) * 10) / 10);
}

function renderShares() {
    const wrap = el('share-list');
    wrap.innerHTML = state.selected.map((slug) => {
        const d = state.bySlug.get(slug);
        const noField = state.noField.has(slug);
        const noRank = state.noRank.has(slug);
        const val = state.shares.get(slug);
        return `<div class="share-row${noField ? ' is-out' : ''}">
            <span class="deck-icons">${iconsHtml(d.icons)}</span>
            <span class="deck-chip-text">
                <a class="deck-chip-name" href="${deckLink(d)}" target="_blank" rel="noopener"
                   title="See ${escapeHtml(d.name)} decklists on Trainer Hill">${escapeHtml(d.name)}</a>
                <span class="deck-chip-share">observed ${fmtPct(d.share * 100)}</span>
            </span>
            <span class="share-input-wrap">
                <input type="number" min="0" max="100" step="0.1" inputmode="decimal"
                       value="${val}" data-share="${slug}"${noField ? ' disabled' : ''}
                       aria-label="${escapeHtml(d.name)} expected meta share">
                <span class="pct">%</span>
            </span>
            <span class="role-pills">
                <button type="button" class="field-pill${noRank ? '' : ' is-in'}"
                        data-role="rank" data-slug="${slug}" aria-pressed="${!noRank}"
                        title="${noRank ? 'Not ranked. Click to rank it.'
                                        : 'Ranked. Click to drop it from the ranking, as with a bucket you cannot play.'}">rank</button>
                <button type="button" class="field-pill${noField ? '' : ' is-in'}"
                        data-role="field" data-slug="${slug}" aria-pressed="${!noField}"
                        title="${noField ? 'Held out of the field. Click to put it back.'
                                         : 'Part of the field. Click to hold it out, to test a deck nobody plays yet.'}">field</button>
            </span>
        </div>`;
    }).join('');

    updateShareTotal();
}

function updateShareTotal() {
    const { total } = buildField();
    const totalEl = el('share-total');
    if (!state.selected.length) { totalEl.textContent = ''; return; }

    const held = state.selected.filter((s) => state.noField.has(s)).length;
    totalEl.classList.toggle('is-warn', total <= 0);
    if (total <= 0) {
        totalEl.innerHTML = "Give at least one deck a share above 0%.";
        return;
    }

    let text = `Shares total <strong>${fmtPct(total)}</strong>`;
    // A percent of rounding dust is not worth a lecture.
    if (Math.abs(total - 100) > 1) {
        text += `. I'll scale that to 100%, which drops the missing `
             + `${fmtPct(Math.max(0, 100 - total))} of the field.`;
        // Only offer the bucket when it is not already doing the job.
        const hasOther = state.selected.includes('other') && !state.noField.has('other');
        text += hasOther
            ? ` Bump <strong>Other</strong> up to cover the rest.`
            : ` Add <strong>Other</strong> to stand in for the rest.`;
    } else {
        text += '.';
    }
    if (held) {
        text += ` ${held} deck${held > 1 ? 's are' : ' is'} ranked only, held out of the field.`;
    }
    totalEl.innerHTML = text;
}

/* ---------- your own deck ---------- */

/* Seed the hand-entered rates from a deck that already has a record. We copy the
   raw win rate rather than the regressed one: the estimate gets regressed again
   on the way in, and running it through the prior twice would drag everything
   toward 50%. A pairing with no games starts even. */
function copyRatesFrom(slug) {
    const source = state.bySlug.get(slug);
    if (!source || !state.custom) return;
    for (const target of state.selected) {
        if (target === slug) {
            state.custom.rates.set(target, 50);   // the source's own mirror
            continue;
        }
        const raw = matchup(slug, target).raw;
        state.custom.rates.set(target, Math.round(raw === null ? 50 : raw));
    }
}

function renderCustom() {
    const card = el('step-custom');
    const c = state.custom;
    el('custom-cta').hidden = !!c;
    if (!c) { card.hidden = true; return; }
    card.hidden = false;

    el('custom-name').value = c.name;
    el('custom-evidence').value = String(c.evidence);
    el('custom-share').value = c.share;
    el('custom-share').disabled = state.noField.has(CUSTOM);

    const noRank = state.noRank.has(CUSTOM);
    const noField = state.noField.has(CUSTOM);
    el('custom-roles').innerHTML = `
        <button type="button" class="field-pill${noRank ? '' : ' is-in'}"
                data-crole="rank" aria-pressed="${!noRank}"
                title="${noRank ? 'Not ranked. Click to rank it.' : 'Ranked in the results below.'}">rank</button>
        <button type="button" class="field-pill${noField ? '' : ' is-in'}"
                data-crole="field" aria-pressed="${!noField}"
                title="${noField ? 'Held out of the field. Click to put it in.'
                                 : 'The other decks face it at the complement of your numbers.'}">field</button>`;

    // One row per deck already in play, so the estimates match the field.
    const opponents = state.selected.filter((slug) => !state.noField.has(slug));
    if (!opponents.length) {
        el('custom-rates').innerHTML =
            '<p class="empty-note">Put some decks in the field first, then set a win rate into each one.</p>';
    } else {
        el('custom-rates').innerHTML = opponents.map((slug) => {
            const d = state.bySlug.get(slug);
            const typed = customRate(slug);
            const shown = matchup(CUSTOM, slug).wr;
            return `<div class="share-row">
                <span class="deck-icons">${iconsHtml(d.icons)}</span>
                <span class="deck-chip-text">
                    <span class="deck-chip-name">${escapeHtml(d.name)}</span>
                    <span class="deck-chip-share">counts as ${fmtPct(shown)}</span>
                </span>
                <span class="share-input-wrap">
                    <input type="number" min="0" max="100" step="1" inputmode="decimal"
                           value="${typed}" data-crate="${slug}"
                           aria-label="Your win rate against ${escapeHtml(d.name)}">
                    <span class="pct">%</span>
                </span>
            </div>`;
        }).join('');
    }

    const n = c.evidence;
    el('custom-hint').innerHTML =
        `Each estimate goes into the math as ${n} games, so it regresses toward 50% `
      + `just like a real record does. A 60% call reads as `
      + `<strong>${fmtPct(((0.6 * n + state.k / 2) / (n + state.k)) * 100)}</strong> at this setting. `
      + `Raise the testing level once you've played the games.`;
}

/* ---------- results ---------- */

function renderResults(results) {
    const wrap = el('results');
    if (!results.length) {
        wrap.innerHTML = '<p class="empty-note">Pick at least one deck and give it a share above 0%.</p>';
        return;
    }

    // One scale for every bar and whisker, wide enough for the widest interval.
    const spread = Math.max(6, ...results.flatMap(
        (r) => [Math.abs(r.expected - 50), Math.abs(r.ciLow - 50), Math.abs(r.ciHigh - 50)]
    ));

    const groups = new Set(results.map((r) => r.tier)).size;
    const caption = groups > 1
        ? `A rule separates groups the games can tell apart. Inside a group the order is noise.`
        : `Every deck here sits inside every other deck's interval, so the games can't rank them.`;

    wrap.innerHTML = `<p class="table-caption">${caption}</p>
    <table class="data">
        <thead><tr>
            <th></th><th>Deck</th>
            <th class="num">Expected WR</th>
            <th class="num result-ci-head">95% interval</th>
            <th class="bar-head">vs. 50%</th>
            <th class="num">Your share</th>
            <th class="num">Games</th>
        </tr></thead>
        <tbody>${results.map((r, i) => resultRowHtml(r, i, spread)).join('')}</tbody>
    </table>`;
}

function resultRowHtml(r, i, spread) {
    const open = state.openDeck === r.deck.slug;
    const x = (v) => Math.max(0, Math.min(100, 50 + 50 * (v - 50) / spread));
    const delta = r.expected - 50;
    const fill = delta >= 0
        ? `left:50%;width:${x(r.expected) - 50}%`
        : `left:${x(r.expected)}%;width:${50 - x(r.expected)}%`;
    const whisker = `left:${x(r.ciLow)}%;width:${Math.max(1, x(r.ciHigh) - x(r.ciLow))}%`;

    const row = `<tr class="result-row${open ? ' is-open' : ''}${r.tierStart ? ' tier-start' : ''}"
            data-deck="${r.deck.slug}" tabindex="0" role="button" aria-expanded="${open}">
        <td class="result-rank">${i + 1}</td>
        <td class="result-deck">
            <span class="result-deck-inner">
                <span class="deck-icons">${iconsHtml(r.deck.icons)}</span>
                ${escapeHtml(r.deck.name)}
                ${r.isCustom ? '<span class="held-flag is-custom" title="Your own numbers, entered by hand">estimate</span>' : ''}
                ${r.inField ? '' : '<span class="held-flag" title="Ranked, and held out of the field">rank only</span>'}
            </span>
        </td>
        <td class="num result-wr">${fmtPct(r.expected)}</td>
        <td class="num result-ci">${fmtPct(r.ciLow)} – ${fmtPct(r.ciHigh)}</td>
        <td class="bar-cell">
            <span class="bar-track">
                <span class="bar-baseline" style="left:50%"></span>
                <span class="bar-whisker" style="${whisker}"></span>
                <span class="bar-fill ${delta >= 0 ? 'up' : 'down'}" style="${fill}"></span>
            </span>
        </td>
        <td class="num result-share">${r.inField ? fmtPct(r.shareOfField * 100) : '—'}</td>
        <td class="num result-games">${r.games.toLocaleString()}${r.thin ? `<span class="thin-flag">${r.thin} thin</span>` : ''}</td>
    </tr>`;

    if (!open) return row;
    return row + `<tr><td class="breakdown-cell" colspan="7">${breakdownHtml(r)}</td></tr>`;
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
            <td class="num">${b.record || '—'}</td>
            <td class="num">${b.n}${!b.mirror && b.n < THIN ? '<span class="thin-flag">thin</span>' : ''}</td>
            <td class="num">${fmtPct(b.weight * b.wr)}</td>
        </tr>`;
    }).join('');

    return `<div class="breakdown">
        <h4>${escapeHtml(r.deck.name)}: matchup by matchup</h4>
        <table class="breakdown-table">
            <thead><tr>
                <th>Opponent</th>
                <th class="num">Weight</th>
                <th class="num">Win rate</th>
                <th class="num">Raw</th>
                <th class="num">W–L–T</th>
                <th class="num">Games</th>
                <th class="num">Contribution</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr>
                <td>Expected win rate</td>
                <td class="num">100.0%</td>
                <td colspan="4"></td>
                <td class="num">${fmtPct(r.expected)} ± ${(Z * r.se).toFixed(1)}</td>
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

    if (results.length > MATRIX_MAX) {
        el('matrix').innerHTML =
            `<p class="empty-note">${results.length} decks makes
             ${(results.length ** 2).toLocaleString()} cells, which is more grid than anyone can
             read. Narrow it down to ${MATRIX_MAX} or fewer, or click any row above for that
             deck's breakdown.</p>`;
        el('matrix-legend').innerHTML = '';
        return;
    }

    const order = results.map((r) => r.deck);
    const head = order.map((d) =>
        `<th><span class="col-label">${escapeHtml(d.name)}</span></th>`).join('');

    const body = order.map((row) => {
        const cells = order.map((col) => {
            if (row.slug === col.slug) {
                return `<td class="cell is-mirror" title="Mirror match">—</td>`;
            }
            const m = matchup(row.slug, col.slug);
            const step = scaleStep(m.wr);
            return `<td class="cell${step.dark ? ' on-dark' : ''}${m.n < THIN ? ' is-thin' : ''}"
                style="background:var(${step.css})"
                data-row="${row.slug}" data-col="${col.slug}">${m.wr.toFixed(0)}</td>`;
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
         <span class="legend-note">dashed = fewer than ${THIN} games</span>`;
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
    const m = matchup(rowSlug, colSlug);
    return `<span class="tt-title"><strong>${escapeHtml(a.name)}</strong> vs ${escapeHtml(b.name)}</span>
        <span class="tt-num">${fmtPct(m.wr)} after regression</span><br>
        <span class="tt-num">${m.raw === null
            ? "No games yet, so it sits at 50%."
            : `${fmtPct(m.raw)} raw · ${m.record} (W–L–T)`}</span>
        ${m.n && m.n < THIN ? `<br><span class="tt-num">Only ${m.n} games behind this one, so it's thin.</span>` : ''}`;
}

/* ---------- CSV + link ---------- */

function downloadCsv(results) {
    const head = ['rank', 'deck', 'expected_win_rate', 'ci_low', 'ci_high', 'group',
        'source', 'in_field', 'your_meta_share_pct', 'games', 'thin_matchups'];
    const lines = [
        `# tie rule: ${TIE_MODES[state.tieMode].formula} · regression k = ${state.k}`,
        head.join(','),
    ];
    results.forEach((r, i) => {
        lines.push([
            i + 1,
            `"${r.deck.name.replace(/"/g, '""')}"`,
            r.expected.toFixed(2),
            r.ciLow.toFixed(2),
            r.ciHigh.toFixed(2),
            r.tier,
            r.isCustom ? 'estimate' : 'record',
            r.inField ? 'yes' : 'no',
            r.inField ? (Number(state.shares.get(r.deck.slug)) || 0).toFixed(1) : '',
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
    if (state.tieMode !== 'ignore') parts.push(`ties=${state.tieMode}`);
    if (state.noRank.size) parts.push(`norank=${[...state.noRank].join(',')}`);
    if (state.noField.size) parts.push(`nofield=${[...state.noField].join(',')}`);
    if (!state.includeMirror) parts.push('mirror=0');
    if (state.openDeck) parts.push(`open=${state.openDeck}`);
    const c = state.custom;
    if (c) {
        parts.push(`cname=${encodeURIComponent(c.name)}`);
        parts.push(`cevid=${c.evidence}`);
        if (c.share) parts.push(`cshare=${c.share}`);
        const rates = [...c.rates].filter(([slug]) => state.selected.includes(slug));
        if (rates.length) parts.push(`crates=${rates.map(([k2, v]) => `${k2}:${v}`).join(',')}`);
    }
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
    if (params.has('cname') || params.has('crates')) {
        const evid = Number(params.get('cevid'));
        state.custom = {
            name: params.get('cname') || '',
            evidence: EVIDENCE.some((e) => e.n === evid) ? evid : 30,
            share: Math.max(0, Number(params.get('cshare')) || 0),
            rates: new Map(),
        };
        for (const entry of (params.get('crates') || '').split(',').filter(Boolean)) {
            const [slug, rate] = entry.split(':');
            const v = Number(rate);
            if (state.bySlug.has(slug) && Number.isFinite(v)) {
                state.custom.rates.set(slug, Math.min(100, Math.max(0, v)));
            }
        }
        registerCustom();
        if (!state.custom.share) state.noField.add(CUSTOM);
    }

    const k = Number(params.get('k'));
    if (Number.isFinite(k) && k >= 0 && k <= 60) state.k = k;
    const ties = params.get('ties');
    if (ties && TIE_MODES[ties]) state.tieMode = ties;
    for (const [key, set] of [['norank', state.noRank], ['nofield', state.noField]]) {
        const v = params.get(key);
        if (v) v.split(',').filter((s) => state.bySlug.has(s) || s === CUSTOM).forEach((s) => set.add(s));
    }
    if (params.get('mirror') === '0') state.includeMirror = false;
    const open = params.get('open');
    if (open && state.bySlug.has(open)) state.openDeck = open;

    el('shrink').value = state.k;
    el('tie-mode').value = state.tieMode;
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
        ? "Trainer Hill's raw numbers, so a 3–0 matchup reads as 100%."
        : `A 3–0 reads as ${fmtPct(((3 + state.k / 2) / (3 + state.k)) * 100)} at this setting. ` +
          `Over 100 games, a 60–40 comes out at ${fmtPct(((60 + state.k / 2) / (100 + state.k)) * 100)}.`;
    el('tie-hint').textContent = `Win rate = ${TIE_MODES[state.tieMode].formula}.`;
    el('settings-summary').textContent =
        `${TIE_MODES[state.tieMode].label} · regression k = ${state.k}`;

    renderShares();
    renderCustom();
    const results = computeResults();
    renderResults(results);
    renderMatrix(results);
    syncHash();
    return results;
}

/* Recompute without rebuilding any input, so focus and caret survive. */
function renderLive() {
    const results = computeResults();
    renderResults(results);
    renderMatrix(results);
    updateShareTotal();
    syncHash();
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
        state.noRank.delete(slug);
        state.noField.delete(slug);
        state.custom?.rates.delete(slug);
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
        state.noRank.clear();
        state.noField.clear();
        state.custom = null;
        registerCustom();
        state.openDeck = null;
        renderDeckPicker();
        render();
    });

    document.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const all = btn.dataset.preset === 'all';
            const ranked = [...state.decks]
                .filter((d) => d.slug !== 'other')     // a bucket, not a deck
                .sort((a, b) => b.share - a.share);
            const top = (all ? ranked : ranked.slice(0, Number(btn.dataset.preset)))
                .map((d) => d.slug);

            /* Other joins the field so the shares describe a whole meta, but it
               is not ranked, because nobody can register "Other". Every deck at
               its observed share already totals 100%, so the whole-meta case
               needs no remainder. */
            const other = state.bySlug.get('other');
            state.selected = other ? [...top, other.slug] : top;
            state.noRank.clear();
            state.noField.clear();
            if (other) state.noRank.add(other.slug);
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
        renderLive();
    });

    el('share-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role]');
        if (!btn) return;
        const { role, slug } = btn.dataset;
        const set = role === 'rank' ? state.noRank : state.noField;
        const other = role === 'rank' ? state.noField : state.noRank;
        if (set.has(slug)) {
            set.delete(slug);
        } else if (other.has(slug)) {
            return;   // turning off both roles would leave the deck doing nothing
        } else {
            set.add(slug);
        }
        render();
    });

    el('add-custom').addEventListener('click', () => {
        state.custom = { name: '', evidence: 30, share: 0, rates: new Map() };
        state.noField.add(CUSTOM);   // rank it against the field by default
        registerCustom();
        render();
        el('custom-name').focus();
    });

    el('remove-custom').addEventListener('click', () => {
        state.custom = null;
        state.noRank.delete(CUSTOM);
        state.noField.delete(CUSTOM);
        if (state.openDeck === CUSTOM) state.openDeck = null;
        registerCustom();
        render();
    });

    el('custom-name').addEventListener('input', (e) => {
        state.custom.name = e.target.value;
        registerCustom();
        renderLive();
    });

    el('custom-copy').addEventListener('change', (e) => {
        const slug = e.target.value;
        e.target.value = '';
        if (!slug) return;
        copyRatesFrom(slug);
        if (!state.custom.name.trim()) {
            state.custom.name = `${state.bySlug.get(slug).name} variant`;
            registerCustom();
        }
        render();
    });

    el('custom-evidence').addEventListener('change', (e) => {
        state.custom.evidence = Number(e.target.value);
        render();
    });

    el('custom-share').addEventListener('input', (e) => {
        const pct = Number(e.target.value);
        state.custom.share = Number.isFinite(pct) && pct >= 0 ? pct : 0;
        renderLive();
    });

    el('custom-rates').addEventListener('input', (e) => {
        const input = e.target.closest('input[data-crate]');
        if (!input) return;
        const pct = Number(input.value);
        state.custom.rates.set(input.dataset.crate,
            Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 50);
        renderLive();
    });

    el('custom-roles').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-crole]');
        if (!btn) return;
        const set = btn.dataset.crole === 'rank' ? state.noRank : state.noField;
        const other = btn.dataset.crole === 'rank' ? state.noField : state.noRank;
        if (set.has(CUSTOM)) set.delete(CUSTOM);
        else if (other.has(CUSTOM)) return;   // both off would do nothing
        else set.add(CUSTOM);
        render();
    });

    el('shrink').addEventListener('input', (e) => { state.k = Number(e.target.value); render(); });
    el('tie-mode').addEventListener('change', (e) => { state.tieMode = e.target.value; render(); });
    el('include-mirror').addEventListener('change', (e) => {
        state.includeMirror = e.target.checked;
        render();
    });
    el('show-matrix').addEventListener('change', (e) => {
        state.showMatrix = e.target.checked;
        render();
    });

    const toggleOpen = (row) => {
        state.openDeck = state.openDeck === row.dataset.deck ? null : row.dataset.deck;
        renderResults(computeResults());
        syncHash();
    };
    el('results').addEventListener('click', (e) => {
        const row = e.target.closest('.result-row');
        if (row) toggleOpen(row);
    });
    el('results').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.result-row');
        if (!row) return;
        e.preventDefault();
        toggleOpen(row);
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
