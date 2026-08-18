# Metagross-EV

Metagross-EV shows you which Pokémon TCG deck has the best win rate against the
meta you expect. You choose the decks. You set the share of the field for each
one. The page ranks every deck against that field.

Matchup data comes from [Trainer Hill](https://www.trainerhill.com/meta?game=PTCG).
Trainer Hill collects and publishes the tournament results. This page only gives
them a different weight.

## Use the page

The page has three steps.

1. **Choose decks.** Select the decks that you expect to play against. These
   decks are also the decks that the page ranks.
2. **Set the expected meta share.** Each deck starts at its current usage on
   Trainer Hill. Type a new percentage for any deck.
3. **Read the results.** Click a deck to see each of its matchups.

Your shares do not need to total 100%. The page divides by the total that you
enter. The result is always a win rate against the field that you describe.

Use **Copy link** to save your setup. The link holds the decks, the shares and
the settings.

## The math

Win rate ignores ties:

```
win rate = wins / (wins + losses)
```

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

The page marks a matchup as **thin** below 20 decisive games. Treat a thin
matchup as a hint, not as a measurement.

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

Add `-k 0` for raw win rates. Add `--no-mirror` to remove mirror matches from
the field. Add `-o results.csv` to save the table.

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
