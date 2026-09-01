"""PSqueeze: generalized root-cause localization on a multi-dimensional cube.

Li et al., "Generic and Robust Root Cause Localization for Multi-Dimensional Data in Online
Service Systems" (JSS 2022). CLAUDE.md section 9 names it as Localize's method.

Three steps, and the middle one is what makes it robust:

  1. score every leaf by its DEVIATION, not its raw delta, so a small segment that halved ranks
     beside a large one that halved;
  2. CLUSTER those deviation scores. Leaves driven by one cause deviate by a similar amount, so
     a cluster is a candidate root cause. This is what a greedy top-delta search cannot do -- it
     returns the biggest movers, which on a broad shift is just the biggest segments;
  3. for each cluster search cuboids bottom-up and keep the one with the best Generalized
     Potential Score, which rewards explaining the cluster and punishes over-broad answers.

Falls back cleanly: with too few leaves to cluster, the caller keeps the greedy search.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import combinations

EPSILON = 1e-9


def deviation_score(actual: float, expected: float) -> float:
    """PSqueeze's ripple-invariant deviation, in [-2, 2].

    Chosen over (v-f)/f because it is symmetric and bounded, so one tiny-denominator cell cannot
    dominate the ranking.
    """
    denom = actual + expected
    if abs(denom) < EPSILON:
        return 0.0
    return 2.0 * (expected - actual) / denom


def _kde_peaks(scores: list[float], bins: int = 64) -> list[float]:
    """Cut points between deviation clusters: the valleys of a smoothed 1-D histogram."""
    if len(scores) < 4:
        return []
    lo, hi = min(scores), max(scores)
    if hi - lo < EPSILON:
        return []
    width = (hi - lo) / bins
    hist = [0.0] * bins
    for s in scores:
        idx = min(bins - 1, int((s - lo) / width))
        hist[idx] += 1.0
    # Gaussian smoothing; a raw histogram is too spiky to find real valleys in.
    kernel = [math.exp(-0.5 * (k / 1.5) ** 2) for k in range(-3, 4)]
    smooth = []
    for i in range(bins):
        acc = wsum = 0.0
        for k, w in zip(range(-3, 4), kernel):
            j = i + k
            if 0 <= j < bins:
                acc += hist[j] * w
                wsum += w
        smooth.append(acc / wsum if wsum else 0.0)
    cuts = []
    for i in range(1, bins - 1):
        if smooth[i] < smooth[i - 1] and smooth[i] <= smooth[i + 1] and smooth[i] < 0.35 * max(smooth):
            cuts.append(lo + (i + 0.5) * width)
    return cuts


def cluster_leaves(leaves: dict[tuple, tuple[float, float]]) -> list[list[tuple]]:
    """Group leaf cells whose deviation scores sit in the same density mode."""
    scored = [(cell, deviation_score(v, f)) for cell, (v, f) in leaves.items()]
    # Only cells that actually moved are candidate causes.
    scored = [(c, s) for c, s in scored if abs(s) > 0.05]
    if not scored:
        return []
    cuts = _kde_peaks([s for _, s in scored])
    if not cuts:
        return [[c for c, _ in scored]]
    cuts = sorted(cuts)
    buckets: dict[int, list[tuple]] = {}
    for cell, s in scored:
        idx = sum(1 for c in cuts if s > c)
        buckets.setdefault(idx, []).append(cell)
    return [v for _, v in sorted(buckets.items()) if v]


def _ripple(v_s: float, f_s: float, f_e: float) -> float:
    """Generalized ripple effect: under a root cause S, each member deviates in proportion."""
    if abs(f_s) < EPSILON:
        return f_e
    return f_e * (v_s / f_s)


def gps(members: set[tuple], leaves: dict[tuple, tuple[float, float]]) -> float:
    """Generalized Potential Score for the hypothesis "S explains the movement".

    1.0 is a perfect explanation. Predicts members by the ripple effect and non-members by their
    own forecast, then compares that reconstruction against reality.
    """
    if not members or not leaves:
        return 0.0
    v_s = sum(leaves[c][0] for c in members if c in leaves)
    f_s = sum(leaves[c][1] for c in members if c in leaves)
    err = base = 0.0
    for cell, (v, f) in leaves.items():
        pred = _ripple(v_s, f_s, f) if cell in members else f
        err += abs(v - pred)
        base += abs(v - f)
    if base < EPSILON:
        return 0.0
    return max(0.0, 1.0 - err / base)


@dataclass
class Candidate:
    dims: tuple
    #: one value-tuple per element of the root cause SET, not a single cell
    cell: tuple
    members: set = field(default_factory=set)
    gps: float = 0.0
    delta: float = 0.0
    baseline: float = 0.0


def _cuboid_members(leaves: dict[tuple, tuple[float, float]], dim_index: dict[str, int],
                    combo: tuple, values: tuple) -> set[tuple]:
    idxs = [dim_index[d] for d in combo]
    return {cell for cell in leaves
            if all(cell[i] == val for i, val in zip(idxs, values))}


def search(leaves: dict[tuple, tuple[float, float]], dims: list[str], max_depth: int,
           direction: int, max_candidates: int = 400) -> list[Candidate]:
    """Bottom-up cuboid search, best Generalized Potential Score per cluster.

    Ascending layer order with an early stop is PSqueeze's succinctness rule: a one-attribute
    answer that explains the movement beats a three-attribute one that explains it marginally
    better.
    """
    if not leaves or not dims:
        return []
    dim_index = {d: i for i, d in enumerate(dims)}
    clusters = cluster_leaves(leaves)
    out: list[Candidate] = []

    for cluster in clusters:
        best: Candidate | None = None
        for depth in range(1, min(max_depth, len(dims)) + 1):
            for combo in combinations(dims, depth):
                idxs = [dim_index[d] for d in combo]
                # Distinct values of this cuboid among the cluster's leaves.
                values = []
                seen: set[tuple] = set()
                for cell in cluster:
                    v = tuple(cell[i] for i in idxs)
                    if v not in seen:
                        seen.add(v)
                        values.append(v)
                if not values or len(values) > max_candidates:
                    continue

                scored = []
                for v in values:
                    members = _cuboid_members(leaves, dim_index, combo, v)
                    if not members:
                        continue
                    delta = sum(leaves[c][0] - leaves[c][1] for c in members)
                    if direction < 0 and delta >= 0:
                        continue
                    if direction > 0 and delta <= 0:
                        continue
                    scored.append((abs(delta), v, members))
                if not scored:
                    continue
                scored.sort(reverse=True)

                # A root cause may be a SET of elements. Add the next best while it still
                # improves the explanation -- one region of a two-region outage explains half.
                chosen: list[tuple] = []
                union: set[tuple] = set()
                cur = 0.0
                for _, v, members in scored:
                    trial = union | members
                    score = gps(trial, leaves)
                    if score <= cur + 1e-6 and chosen:
                        break
                    chosen.append(v)
                    union = trial
                    cur = score
                if not chosen:
                    continue
                delta = sum(leaves[c][0] - leaves[c][1] for c in union)
                cand = Candidate(combo, tuple(chosen), union, cur, delta,
                                 sum(leaves[c][1] for c in union))
                if best is None or cand.gps > best.gps:
                    best = cand
            if best is not None and best.gps >= 0.7:
                break
        if best is not None:
            out.append(best)

    out.sort(key=lambda c: (-c.gps, len(c.dims), c.dims, c.cell))
    return out
