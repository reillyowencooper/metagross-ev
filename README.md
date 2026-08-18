# Metagross-EV

Metagross-EV shows you which Pokémon TCG deck has the best win rate against the
meta you expect. You choose the decks. You set the share of the field for each
one. The page ranks every deck against that field.

Matchup data comes from [Trainer Hill](https://www.trainerhill.com/meta?game=PTCG).
Trainer Hill collects and publishes the tournament results. This page only gives
them a different weight.

## Use the page

The page has three steps.

1. **Choose decks.** Select the decks that you expect to play against.
2. **Set the expected meta share.** Each deck starts at its current usage on
   Trainer Hill. Type a new percentage for any deck.
3. **Read the results.** Read the interval, not the decimal. Click a deck to see
   each of its matchups.

Your shares do not need to total 100%. The page scales them. Be careful what
that means: it drops the rest of the field, and it does not treat the rest as
neutral. Add the **Other** bucket to stand in for every deck you did not list.
The **Top 8**, **Top 12** and **Top 16** buttons do this for you, and they give
Other whatever share the listed decks leave over. **All 130** selects every deck
instead. Every deck at its observed share already totals 100%, so that view is
the whole meta with nothing left over.

Expect the full-meta ranking to put small-sample decks near the top. A deck with
200 games can look strong on very little evidence. This is what the intervals
and the thin labels are for: read them before you believe a rank.

### A deck of your own

**Add your own deck** describes a brew that has no tournament record. Give it a
win rate against each deck in the field, and say how much testing stands behind
those numbers.

The testing level becomes a game count. An estimate backed by 30 games enters the
arithmetic as an 18–12 record, so it regresses toward 50% exactly as a real
record does. A 60% call reads as 56% at that setting, and the page shows you
what each estimate counts as. An untested deck cannot climb the ranking on
assertion alone.

Give it a meta share and it becomes an opponent as well. Every other deck then
faces it at the complement of your numbers: a matchup you win 60% of the time is
one they win 40% of the time. This is how you ask what your brew would do *to*
the meta, not only how it fares against it.

### Two roles per deck

Every deck has two roles, and you can switch either one off.

| Role | What it means | Turn it off when |
|---|---|---|
| **rank** | The deck appears in the results | It is a bucket like Other, which nobody can register |
| **field** | The deck is an opponent | You want to test a deck nobody plays yet |

Turning off **field** is how you answer the useful question: *how does my rogue
deck do against the top eight?* The deck gets ranked against that field without
becoming part of it.

Use **Copy link** to save your setup. The link holds the decks, the shares and
the settings.

## The math

### A tie is a choice, not a fact

This format is best of three, so a tie often works out as a loss for whoever
needed the win. Settings offers all three readings:

| Setting | Win rate | 
|---|---|
| Ignore ties (default) | `W / (W + L)` |
| Ties count as losses | `W / (W + L + T)` |
| Ties count as half a win | `(W + T/2) / (W + L + T)` |

One matchup can move three points between them. Pick the reading that matches
your event.

The expected win rate for a deck is the average of its matchups. Each matchup
gets the weight of the opponent's meta share:

```
expected win rate = sum(share[opponent] * win rate vs opponent) / sum(share)
```

An example makes this clear. The field is 40% Dragapult and 60% Gardevoir. Your
deck wins 45% against Dragapult and 55% against Gardevoir. The expected win rate
is `(0.4 x 45 + 0.6 x 55) / 1.0 = 51%`.

### Why a 3-0 matchup does not show as 100%

Most matchups have very few games. Across all 130 decks, the median matchup has
only two decisive games. A 3-0 record tells you almost nothing.

The page therefore pulls each matchup toward 50%. The prior is worth `k`
pseudo games, split evenly:

```
adjusted win rate = (wins + k/2) / (wins + losses + k)
```

The default is `k = 20`. A 3-0 record then reads as 56%. A 60-40 record over 100
games hardly moves. Set `k` to 0 in **Settings** to see the raw Trainer Hill
numbers.

This also solves the empty matchups. Two thirds of all deck pairs have no
recorded games. With no evidence, they sit at exactly 50%.

The page marks a matchup as **thin** below 20 counted games. Treat a thin
matchup as a hint, not as a measurement.

### The interval is the honest part of the answer

That prior is a Beta distribution, so every matchup carries a variance as well
as a mean. The page adds those up across the matchups, weighted by your shares,
and reports a 95% interval.

A rule in the results table separates groups that the data can tell apart.
Inside a group the order is noise, and a deck one place higher is **not** a
better choice. Read the interval, not the decimal.

The interval covers the games played. It does not cover your shares being wrong,
which is usually the larger risk.

## Refresh the data

The page reads `data.json`. A scheduled job rebuilds this file every Tuesday and
commits it here. The snapshot records the window it covers, so the page can show
you which tournaments are behind the numbers.

The snapshot holds every recorded pair of decks, not only the popular ones. Each
row carries the wins, the losses and the ties, so the page can show the sample
size next to every matchup.

## Command line

`expected_win_rates.py` does the same math as the page. It is useful when you
want to script a comparison, or to check the page against a second
implementation. Give it a snapshot and a CSV of meta shares:

```bash
python expected_win_rates.py data.json example_meta_shares.csv
```

The share file needs two columns:

```csv
deck_name,meta_share
dragapult-ex,0.16
dragapult-blaziken,0.14
```

Add `-k 0` for raw win rates. Add `--ties losses` or `--ties half` to change the
tie rule. Add `--no-mirror` to remove mirror matches from the field. Add
`-o results.csv` to save the table.

The CLI prints the same intervals and the same groups as the page, and a rule
separates the groups there too.

The script also accepts a matchup CSV that you export from the Trainer Hill
meta page.

## Host the page

The site is plain HTML, CSS and JavaScript. It has no build step and no
dependencies. Every path is relative, so the site also works from a subfolder.

GitHub Pages serves this repository. To set that up, open **Settings > Pages**
and set the source to **GitHub Actions**. The workflow in
`.github/workflows/pages.yml` then deploys on every push, including the weekly
data refresh.

To try it on your machine:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Credits

All tournament data comes from [Trainer Hill](https://www.trainerhill.com), by
Bradley Erickson. Deck sprites come from
[pokesprite](https://github.com/msikma/pokesprite).

MIT licensed. See [LICENSE](LICENSE).
