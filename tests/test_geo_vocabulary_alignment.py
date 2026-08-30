"""One geography across every producer, or the dashboard and the engine describe different worlds.

The bank used to have two disjoint geographies. The clickstream producers emitted global countries
(India, USA, Brazil), which is what the dashboard's Geographic Distribution renders. The reference
data seeded four US regions (Northeast, Midwest, South, West) with US cities, which is what the
retail KPIs localized on. So a chart said "India" and an intelligence answer about
net_deposit_growth said "Northeast" -- a place on no chart, and nothing failed to say so.

`region` is now a CONTINENT and every branch city is drawn from the clickstream vocabulary. These
tests parse the four producers directly, because a shared constant is not possible across three
languages and two services -- the repo's answer to that is a cross-file assertion, the same shape
as tests/test_dashboard_nav_matches_rbac.py.
"""
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_REF = os.path.join(ROOT, "NexaBank", "backend", "src", "scripts", "seedReferenceData.ts")
TRACKER = os.path.join(ROOT, "NexaBank", "backend", "src", "middleware", "eventTracker.ts")
SIM_ROUTE = os.path.join(ROOT, "NexaBank", "backend", "src", "routes", "eventRoutes.ts")
SEED_PY = os.path.join(ROOT, "scripts", "seed_data.py")

_MISSING = "NexaBank/ or scripts/ source not present in this checkout"


def _read(path):
    if not os.path.exists(path):
        pytest.skip("%s: %s" % (_MISSING, path))
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def branches():
    """[(region, country, city)] from seedReferenceData.ts's BRANCHES literal."""
    body = _read(SEED_REF)
    return [(m.group(1), m.group(2), m.group(3)) for m in re.finditer(
        r'region:\s*"([^"]+)",\s*country:\s*"([^"]+)",\s*city:\s*"([^"]+)"', body)]


def clickstream_places():
    """{(country, continent, city)} across the three producers that emit telemetry geo."""
    places = set()
    for m in re.finditer(r'\{\s*country:\s*"([^"]+)",\s*continent:\s*"([^"]+)",\s*city:\s*"([^"]+)"',
                         _read(TRACKER)):
        places.add((m.group(1), m.group(2), m.group(3)))
    for m in re.finditer(r'\{\s*city:\s*"([^"]+)",\s*country:\s*"([^"]+)",\s*continent:\s*"([^"]+)"',
                         _read(SIM_ROUTE)):
        places.add((m.group(2), m.group(3), m.group(1)))
    for m in re.finditer(r'\{"city":\s*"([^"]+)",\s*"country":\s*"([^"]+)",\s*"continent":\s*"([^"]+)"',
                         _read(SEED_PY)):
        places.add((m.group(2), m.group(3), m.group(1)))
    return places


def test_branch_regions_are_continents_the_clickstream_emits():
    continents = {c for _, c, _ in clickstream_places()}
    used = {r for r, _, _ in branches()}
    assert used, "no branches parsed -- the BRANCHES literal shape changed"
    stray = sorted(used - continents)
    assert not stray, (
        "branch regions that no clickstream producer emits as a continent, so a KPI localized on "
        "them names a place the dashboard cannot show: %s" % stray)


def test_branch_cities_exist_in_the_clickstream_vocabulary():
    cities = {c for _, _, c in clickstream_places()}
    stray = sorted({city for _, _, city in branches()} - cities)
    assert not stray, (
        "branch cities absent from every clickstream producer: %s. Add the city to the producers "
        "or move the branch to one they already emit." % stray)


def test_branch_countries_exist_in_the_clickstream_vocabulary():
    """The dashboard's DEFAULT geography view is countries, so retail has to speak them too.

    Before `Branch.country` the retail side could only match the continent toggle; a KPI could
    never name Germany the way the map does.
    """
    countries = {c for c, _, _ in clickstream_places()}
    stray = sorted({country for _, country, _ in branches()} - countries)
    assert not stray, (
        "branch countries no clickstream producer emits, so the country views cannot line up: %s"
        % stray)


def test_branch_country_agrees_with_its_city():
    """A branch in Berlin must not claim to be in France."""
    by_city = {}
    for country, _, city in clickstream_places():
        by_city.setdefault(city, set()).add(country)
    wrong = [(city, country, sorted(by_city[city]))
             for _, country, city in branches()
             if city in by_city and country not in by_city[city]]
    assert not wrong, "branch country/city disagree with the clickstream mapping: %s" % wrong


def test_no_us_region_vocabulary_survives():
    """The specific regression: a US-regional bank inside a global one."""
    legacy = {"Northeast", "Midwest", "South", "West"}
    used = {r for r, _, _ in branches()}
    assert not (used & legacy), "US-region vocabulary is back in BRANCHES: %s" % sorted(used & legacy)


def test_one_country_never_maps_to_two_continents():
    """Cheap consistency check across producers -- a split mapping makes the continent rollup wrong."""
    seen = {}
    for country, continent, _ in clickstream_places():
        seen.setdefault(country, set()).add(continent)
    split = {k: sorted(v) for k, v in seen.items() if len(v) > 1}
    assert not split, "producers disagree on which continent a country is in: %s" % split


def test_planted_outflow_region_is_the_region_with_the_stepped_competitor_rate():
    """The multi-source scenario needs both halves in the same place.

    If they drift apart the internal segment and the external factor stop lining up, Causal
    correctly degrades to attribution, and the scenario quietly stops demonstrating anything.
    """
    route = _read(SIM_ROUTE)
    m = re.search(r'DEPOSIT_FLIGHT_REGION\s*=\s*"([^"]+)"', route)
    assert m, "DEPOSIT_FLIGHT_REGION not found -- the outflow region was inlined again"
    region = m.group(1)
    ref = _read(SEED_REF)
    assert re.search(r'region === "%s" && monthsFromEnd' % re.escape(region), ref), (
        "the outflow is planted in %r but no competitor-rate step is seeded for it" % region)
