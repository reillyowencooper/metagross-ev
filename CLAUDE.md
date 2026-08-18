# Metagross-EV — notes for Claude

## What this is

A static page. It ranks Pokémon TCG decks by expected win rate against a meta
that the user describes. Matchup data comes from Trainer Hill.

There is no build step, no framework and no package manager. Do not add one.

## Files

| File | Role |
|---|---|
| `index.html` | Page structure |
| `style.css` | Design tokens and layout |
| `app.js` | All logic: load, math, render, URL state |
| `data.json` | Snapshot of Trainer Hill data |
| `expected_win_rates.py` | Command-line version of the same math |
| `.github/workflows/pages.yml` | Deploys the site to GitHub Pages |

`MATRIX_MAX` in `app.js` caps the matchup grid at 24 decks. Past that the grid
stops being readable well before it stops being possible: 130 decks is 16,900
cells and over a megabyte of markup. Above the cap the page shows a note and
points at the per-deck breakdown.

## Where the data comes from

`data.json` is a snapshot of the Trainer Hill meta page. A separate private
repository builds it and commits it here on a weekly schedule. **Do not add a
fetcher to this repository.** If the data needs a new field or a different
filter, change it in the private repository.

`data.json` holds:

- `filter` — the tournament window, division, platform and minimum event size
- `decks` — slug, display name, sprite URLs, usage share and game count
- `matchups` — `[deck_i, deck_j, wins_i, losses_i, ties]`, one triangle only
- `total_matches`, `generated_at`, `source`

## Facts that the code depends on

- A tie is a choice. `TIE_MODES` in `app.js` and `expected_win_rates.py` hold the
  three readings, each as the two sides of a Beta posterior. The snapshot stores
  wins, losses and ties separately, so no refetch is needed to switch.
- A deck has two independent roles, `noRank` and `noField`. One flag cannot
  express both cases: Other belongs in the field but is not ranked, and a rogue
  deck is ranked but held out of the field.
- The grid is symmetric, so `data.json` stores one triangle. `app.js` mirrors it
  on load.
- The grid is sparse. About one third of deck pairs have games. The median pair
  has two decisive games.
- `other` is a bucket, not a deck. The presets put it in the field so the shares
  describe a whole meta, give it whatever share the listed decks leave over, and
  hold it out of the ranking.
- A few sprite URLs return 404. This is known and accepted.

## The math

Both `app.js` and `expected_win_rates.py` regress each matchup toward 50%:

```
(wins + k/2) / (wins + losses + k)
```

The default is `k = 20`. A pair with no games lands on exactly 50%.

The expected win rate is the share-weighted mean of the matchups, divided by the
total share.

The prior doubles as the uncertainty. Beta(alpha, beta) has variance
`alpha*beta / ((alpha+beta)^2 * (alpha+beta+1))`, and the weighted mean's
variance is `sum(weight^2 * variance)`. That gives the 95% interval, so the
regression and the interval always tell the same story. Beta(0, 0) is improper,
which happens only at `k = 0` with no games; both implementations fall back to
`1/12`, the variance of a flat prior, rather than report a false zero.

Interval groups: walk down the ranking, and keep adding decks while their
interval still reaches the group leader's lower bound. Inside a group the order
is noise, and the table draws a rule where a new group starts.

Shares carry **no** uncertainty in the interval. They are the user's assumption,
not a measurement. A sensitivity view is the right home for that question.

**The two implementations must agree.** If you change one, change the other.
To check parity, run the CLI and the page on the same decks and shares. They
matched to four decimal places at the last check.

## Colors

The win-rate scale is diverging: red below 50%, neutral gray at 50%, blue above.
The two arms share their lightness. They were built by a hue rotation in OKLCH.

The scale passes the checks in the `dataviz` skill. Every cell label clears WCAG
AA against its own background. If you change a step, run the validator again:

```bash
node scripts/validate_palette.js "<hex,hex,...>" --ordinal --mode light --surface "#ffffff"
```

The page tokens follow the sibling project `porygon-r`: Inter, a red accent
(`#dc2626`) and light cards on a gray plane.

## How to test

There is no test suite. Use these two checks.

1. **Math.** Run `expected_win_rates.py` and the page on the same input. Compare
   the numbers.
2. **Layout.** Serve the folder and take a screenshot:

```bash
python -m http.server 8777
/Applications/Firefox.app/Contents/MacOS/firefox --headless \
  --profile /tmp/ffprof --no-remote --window-size=1300,3000 \
  --screenshot /tmp/shot.png "http://localhost:8777/index.html#decks=dragapult-ex:16,slowking-scr:6&k=20"
```

The URL hash holds the full state. Add `open=<slug>` to expand a breakdown. This
makes every view reachable without a click.

Headless Firefox does not load lazy images. Sprites in the deck picker use
`loading="lazy"`, so they stay blank in a screenshot. This is not a bug.

## Hosting

GitHub Pages serves this repository. The source is **GitHub Actions**, and
`pages.yml` does the deploy. Every path in the page is relative, because the
site is served from a subfolder of a custom domain.

## Style

Write prose in Simplified Technical English. Keep sentences short and active.
Keep code comments about intent, not mechanics.
