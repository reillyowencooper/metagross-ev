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
    python expected_win_rates.py data.json meta_shares.csv --ties losses
    python expected_win_rates.py matchups.csv meta_shares.csv --shrink 0
    python expected_win_rates.py data.json meta_shares.csv -o results.csv
"""

import argparse
import csv
import json
import math
import sys

THIN = 20   # counted games below which a matchup is worth flagging
Z = 1.96    # normal quantile for a 95% interval

# Each entry turns a raw record into the two sides of a Beta posterior.
TIE_MODES = {
    "ignore": {
        "formula": "W / (W + L)",
        "alpha": lambda w, l, t, k: w + k / 2,
        "beta": lambda w, l, t, k: l + k / 2,
        "counts_ties": False,
    },
    "losses": {
        "formula": "W / (W + L + T)",
        "alpha": lambda w, l, t, k: w + k / 2,
        "beta": lambda w, l, t, k: l + t + k / 2,
        "counts_ties": True,
    },
    "half": {
        "formula": "(W + T/2) / (W + L + T)",
        "alpha": lambda w, l, t, k: w + t / 2 + k / 2,
        "beta": lambda w, l, t, k: l + t / 2 + k / 2,
        "counts_ties": True,
    },
}


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
    for i, j, wins, losses, ties in data["matchups"]:
        out[(slugs[i], slugs[j])] = (wins, losses, ties)
        if i != j:
            out[(slugs[j], slugs[i])] = (losses, wins, ties)
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
        ties = int(r.get("ties") or 0)
        out[(r["deck1"], r["deck2"])] = (int(r["wins"]), int(r["losses"]), ties)
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


def win_rate(matchups: dict, deck: str, opponent: str, k: float,
             mode: str = "ignore") -> tuple:
    """Regressed win rate, its variance, and the games the tie rule counts."""
    wins, losses, ties = matchups.get((deck, opponent), (0, 0, 0))
    rule = TIE_MODES[mode]

    # A mirror is exactly 50% by symmetry, and carries no uncertainty about it.
    if deck == opponent:
        n = wins + losses + (ties if rule["counts_ties"] else 0)
        return 50.0, 0.0, n

    alpha = rule["alpha"](wins, losses, ties, k)
    beta = rule["beta"](wins, losses, ties, k)
    total = alpha + beta

    n = wins + losses + (ties if rule["counts_ties"] else 0)

    # Beta(0, 0) is improper, which only happens at k = 0 with no games. Fall
    # back to the variance of a flat prior rather than report a false zero.
    variance = ((alpha * beta) / (total * total * (total + 1))
                if total > 0 else 1 / 12)

    wr = (alpha / total) * 100 if total > 0 else 50.0
    return wr, variance, n


def expected_win_rates(matchups: dict, shares: dict, k: float,
                       include_mirror: bool = True,
                       mode: str = "ignore") -> list:
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
        variance = 0.0
        games = 0
        thin = 0
        for opponent, share in opponents.items():
            wr, var, n = win_rate(matchups, deck, opponent, k, mode)
            w = share / weight
            expected += w * wr
            # Variance of a weighted mean of independent matchups. The shares
            # are the caller's assumption, so they carry no uncertainty here.
            variance += (w ** 2) * var
            games += n
            if opponent != deck and n < THIN:
                thin += 1
        margin = Z * math.sqrt(variance) * 100
        results.append({
            "deck_name": deck,
            "expected_win_rate": round(expected, 2),
            "ci_low": round(max(0.0, expected - margin), 2),
            "ci_high": round(min(100.0, expected + margin), 2),
            "share_of_field": round(100 * shares[deck] / total, 1),
            "games": games,
            "thin_matchups": thin,
        })
    results.sort(key=lambda r: -r["expected_win_rate"])
    assign_groups(results)
    return results


def assign_groups(results: list) -> None:
    """Group decks the data cannot tell apart.

    Walk down the ranking and keep adding decks while their interval still
    reaches the group leader's lower bound. Inside a group the order is noise.
    """
    group = 0
    floor = float("inf")
    for r in results:
        if r["ci_high"] < floor:
            group += 1
            floor = r["ci_low"]
        r["group"] = group


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("matchups", help="data.json snapshot or Trainer Hill CSV export")
    p.add_argument("shares_csv", help="CSV of deck_name,meta_share")
    p.add_argument("-o", "--output", help="write results to this CSV")
    p.add_argument("-k", "--shrink", type=float, default=20.0,
                   help="regression strength in pseudo decisive games "
                        "(default: 20; 0 for raw Trainer Hill rates)")
    p.add_argument("--ties", choices=sorted(TIE_MODES), default="ignore",
                   help="how a tie counts (default: ignore)")
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
                                 include_mirror=not args.no_mirror,
                                 mode=args.ties)

    total = sum(shares.values())
    print(f"Field: {len(shares)} decks, shares total {total:.2f} (normalized)\n"
          f"Win rate: {TIE_MODES[args.ties]['formula']} · regression k = "
          f"{args.shrink:g}\n", file=sys.stderr)

    header = (f"{'deck_name':30s} {'exp_wr':>7s} {'95% interval':>16s} "
              f"{'share':>7s} {'games':>7s} {'thin':>5s}")
    print(header)
    print("-" * len(header))
    last_group = None
    for r in results:
        if last_group is not None and r["group"] != last_group:
            print("-" * len(header))   # the data can tell these apart
        last_group = r["group"]
        interval = f"{r['ci_low']:.1f} - {r['ci_high']:.1f}"
        print(f"{r['deck_name']:30s} {r['expected_win_rate']:6.2f}% "
              f"{interval:>16s} {r['share_of_field']:6.1f}% "
              f"{r['games']:7d} {r['thin_matchups']:5d}")

    groups = results[-1]["group"] if results else 0
    print(f"\nA rule separates groups the data can tell apart. "
          f"{groups} group(s). Inside a group the order is noise.",
          file=sys.stderr)

    if args.output:
        with open(args.output, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(results[0]))
            w.writeheader()
            w.writerows(results)
        print(f"\nWrote {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
