#!/usr/bin/env python3
"""Expected win rates per deck from Trainer Hill matchup data.

The command-line counterpart to the web page: same math, same defaults, so a
result you get here matches what the page shows for the same inputs.

  1. Read matchup data -- either a data.json snapshot from
     fetch_trainerhill.py, or a Trainer Hill CSV export
     (deck1, deck2, wins, losses, ...).
  2. For each deck: expected WR = sum over opponents of
     share[opponent] * WR(deck vs opponent), divided by the total share
     entered, so the answer reads as a win rate against that field.
  3. Regress each matchup toward 50% by a prior worth k pseudo decisive games:
     (wins + k/2) / (wins + losses + k). Most pairings are thin, and this also
     puts pairings with no recorded games at exactly 50%.

Win rate ignores ties throughout: wins / (wins + losses).

Meta shares live in a small CSV:
    deck_name,meta_share
    dragapult-ex,0.16
    dragapult-blaziken,0.14
    ...
Shares may cover only part of the meta and don't need to sum to 1 -- whatever
you enter is normalized.

Usage:
    python expected_win_rates.py data.json meta_shares.csv
    python expected_win_rates.py matchups.csv meta_shares.csv --shrink 0
    python expected_win_rates.py data.json meta_shares.csv -o results.csv
"""

import argparse
import csv
import json
import sys
from collections import defaultdict

THIN = 20  # decisive games below which a matchup is worth flagging


def load_matchups(path: str) -> dict:
    """Return {(deck1, deck2): (wins, losses)} from a snapshot or a CSV export."""
    if path.endswith(".json"):
        return load_snapshot(path)
    return load_csv(path)


def load_snapshot(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    slugs = [d["slug"] for d in data["decks"]]
    out = {}
    for i, j, wins, losses, _ties in data["matchups"]:
        out[(slugs[i], slugs[j])] = (wins, losses)
        if i != j:
            out[(slugs[j], slugs[i])] = (losses, wins)
    return out


def load_csv(path: str) -> dict:
    with open(path) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"{path} has no rows.")
    required = {"deck1", "deck2", "wins", "losses"}
    missing = required - set(rows[0])
    if missing:
        sys.exit(f"{path} is missing columns: {sorted(missing)}. Export the "
                 f"Trainer Hill matchup CSV, or use a data.json snapshot.")
    out = {}
    for r in rows:
        out[(r["deck1"], r["deck2"])] = (int(r["wins"]), int(r["losses"]))
    return out


def load_shares(path: str) -> dict:
    with open(path) as f:
        rows = list(csv.DictReader(f))
    required = {"deck_name", "meta_share"}
    if not rows or required - set(rows[0]):
        sys.exit(f"{path} needs columns: deck_name, meta_share")
    shares = {}
    for r in rows:
        name = r["deck_name"].strip()
        if name in shares:
            sys.exit(f"Duplicate deck in {path}: {name}")
        shares[name] = float(r["meta_share"])
    return shares


def win_rate(matchups: dict, deck: str, opponent: str, k: float) -> tuple:
    """Regressed win rate plus the decisive-game count behind it."""
    wins, losses = matchups.get((deck, opponent), (0, 0))
    decisive = wins + losses
    if decisive + k == 0:
        return 50.0, 0
    return ((wins + k / 2) / (decisive + k)) * 100, decisive


def expected_win_rates(matchups: dict, shares: dict, k: float,
                       include_mirror: bool = True) -> list:
    total = sum(shares.values())
    if total <= 0:
        sys.exit("Total meta share is zero -- nothing to weight against.")

    results = []
    for deck in shares:
        opponents = {o: s for o, s in shares.items()
                     if include_mirror or o != deck}
        weight = sum(opponents.values())
        if weight <= 0:
            continue
        expected = 0.0
        games = 0
        thin = 0
        for opponent, share in opponents.items():
            wr, n = win_rate(matchups, deck, opponent, k)
            expected += (share / weight) * wr
            games += n
            if n < THIN:
                thin += 1
        results.append({
            "deck_name": deck,
            "expected_win_rate": round(expected, 2),
            "share_of_field": round(100 * shares[deck] / total, 1),
            "decisive_games": games,
            "thin_matchups": thin,
        })
    results.sort(key=lambda r: -r["expected_win_rate"])
    return results


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("matchups", help="data.json snapshot or Trainer Hill CSV export")
    p.add_argument("shares_csv", help="CSV of deck_name,meta_share")
    p.add_argument("-o", "--output", help="write results to this CSV")
    p.add_argument("-k", "--shrink", type=float, default=20.0,
                   help="regression strength in pseudo decisive games "
                        "(default: 20; 0 for raw Trainer Hill rates)")
    p.add_argument("--no-mirror", action="store_true",
                   help="exclude mirror matches from the field")
    args = p.parse_args()

    matchups = load_matchups(args.matchups)
    shares = load_shares(args.shares_csv)

    decks_with_data = {d for pair in matchups for d in pair}
    unknown = sorted(set(shares) - decks_with_data)
    if unknown:
        print(f"Warning: no matchup data for {unknown} -- every matchup for "
              f"these sits at 50%.", file=sys.stderr)

    results = expected_win_rates(matchups, shares, args.shrink,
                                 include_mirror=not args.no_mirror)

    total = sum(shares.values())
    print(f"Field: {len(shares)} decks, shares total {total:.2f} "
          f"(normalized) · regression k = {args.shrink:g}\n", file=sys.stderr)

    header = f"{'deck_name':30s} {'exp_wr':>7s} {'share':>7s} {'games':>7s} {'thin':>5s}"
    print(header)
    print("-" * len(header))
    for r in results:
        print(f"{r['deck_name']:30s} {r['expected_win_rate']:6.2f}% "
              f"{r['share_of_field']:6.1f}% {r['decisive_games']:7d} "
              f"{r['thin_matchups']:5d}")

    if args.output:
        with open(args.output, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(results[0]))
            w.writeheader()
            w.writerows(results)
        print(f"\nWrote {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
