"""Scrape the official U of T Engineering calendar for program course lists.

The Timetable Builder API has no reliable "program requirement" filter, so we
parse the academic calendar (engineering.calendar.utoronto.ca) to discover which
courses a given program/year actually requires. Nothing is hardcoded: the course
codes are extracted live from the calendar HTML tables.
"""
import datetime
import re

import requests

CALENDAR_BASE = "https://engineering.calendar.utoronto.ca"

# A single registry keeps calendar URLs, headings, aliases, and cache-facing IDs
# consistent across the scraper and the website. ``computer`` and ``electrical``
# are retained as the existing ECE track IDs because their second-year curricula
# differ. Track One is intentionally an alias of the shared Computer/ECE first
# year and is only supported for year 1.
PROGRAM_CONFIG = {
    "computer": {
        "slug": "Electrical-and-Computer-Engineering",
        "heading": "COMPUTER ENGINEERING",
        "source": "computer",
    },
    "electrical": {
        "slug": "Electrical-and-Computer-Engineering",
        "heading": "ELECTRICAL ENGINEERING",
        "source": "electrical",
    },
    "mechanical": {
        "slug": "Mechanical-Engineering",
        "heading": "MECHANICAL ENGINEERING",
        "source": "mechanical",
    },
    "industrial": {
        "slug": "Industrial-Engineering",
        "heading": "INDUSTRIAL ENGINEERING",
        "source": "industrial",
    },
    "chemical": {
        "slug": "Chemical-Engineering-and-Applied-Chemistry",
        "heading": "CHEMICAL ENGINEERING",
        "source": "chemical",
    },
    "materials": {
        "slug": "Materials-Science-and-Engineering",
        "heading": "MATERIALS ENGINEERING",
        "source": "materials",
    },
    "civil": {
        "slug": "Civil-Engineering",
        "heading": "CIVIL ENGINEERING",
        "source": "civil",
    },
    "mineral": {
        "slug": "Mineral-Engineering",
        "heading": "MINERAL ENGINEERING",
        "source": "mineral",
    },
    "trackone": {
        "slug": "Electrical-and-Computer-Engineering",
        "heading": "COMPUTER ENGINEERING",
        "source": "computer",
        "first_year_only": True,
    },
}

# These are the cache/CLI IDs used by the requested first-year programs plus
# the existing ECE tracks. Keep the order stable for argparse help and tests.
PROGRAM_IDS = tuple(PROGRAM_CONFIG)
PROGRAM_ALIASES = {
    "ece": "computer",
    "track one": "trackone",
    "track-one": "trackone",
}

# Backwards-compatible public map retained for callers that used PROGRAM_SLUG.
PROGRAM_SLUG = {
    name: config["slug"] for name, config in PROGRAM_CONFIG.items()
}
PROGRAM_SLUG.update({"ece": PROGRAM_CONFIG["computer"]["slug"]})


def _normalize_program(program):
    """Return a canonical registry ID for a program or raise a useful error."""
    key = str(program).strip().lower()
    key = PROGRAM_ALIASES.get(key, key)
    if key not in PROGRAM_CONFIG:
        known = ", ".join(sorted((*PROGRAM_IDS, *PROGRAM_ALIASES)))
        raise ValueError(f"Unknown program '{program}'. Known: {known}")
    return key


def program_source(program):
    """Return the canonical calendar source for a public program ID."""
    key = _normalize_program(program)
    return PROGRAM_CONFIG[key]["source"]


def active_sessions(today=None):
    """Return the U of T session codes for the academic year current as of
    `today` (defaults to today's date). Mirrors scrape.py.

    Fall YYYY   -> "<YYYY>9"
    Winter Y+1  -> "<Y+1>1"
    The new academic year opens Jul 1, so from Jul 1 of year Y the active pair
    is Fall Y9 / Winter (Y+1)1.
    """
    if today is None:
        today = datetime.date.today()
    fall_year = today.year if today.month >= 7 else today.year - 1
    return {"fall": f"{fall_year}9", "winter": f"{fall_year + 1}1"}


def _section_url(program):
    key = _normalize_program(program)
    slug = PROGRAM_CONFIG[key]["slug"]
    return f"{CALENDAR_BASE}/section/{slug}"


def _year_heading_pattern(year_label, program):
    """Build a case-insensitive pattern for a program's real year heading."""
    key = _normalize_program(program)
    source = PROGRAM_CONFIG[key]["source"]
    title = PROGRAM_CONFIG[source]["heading"]
    return rf"\b{re.escape(str(year_label))}\s+YEAR\s+{re.escape(title)}\b"


def _next_year_heading_pattern(program):
    """Match any subsequent year heading for the selected calendar program."""
    key = _normalize_program(program)
    source = PROGRAM_CONFIG[key]["source"]
    title = PROGRAM_CONFIG[source]["heading"]
    # ECE and some programs use THIRD AND FOURTH YEAR as one section.
    ordinal = r"(?:FIRST|SECOND|THIRD(?:\s+AND\s+FOURTH)?|FOURTH)"
    return rf"\b{ordinal}\s+YEAR\s+{re.escape(title)}\b"


def _split_year_block(html, year_label, track=None, program=None):
    """Return the HTML slice for the given program/year section.

    ``track`` remains accepted for compatibility with the original ECE parser;
    ``program`` is preferred for non-ECE programs. Matching is case-insensitive
    because the live calendar uses title case on some pages and uppercase on
    others.
    """
    selected = program or track or "computer"
    selected = _normalize_program(selected)
    heading_pattern = _year_heading_pattern(year_label, selected)
    m = re.search(heading_pattern, html, flags=re.IGNORECASE)
    if not m:
        return None
    start = m.start()

    # Stop at the next year heading for this same program, or at the known
    # substitutions section that follows required-course tables on ECE pages.
    end_pattern = (
        rf"(?:{_next_year_heading_pattern(selected)}|"
        r"\bApproved Course Substitutions?\b)"
    )
    end_m = re.search(end_pattern, html[m.end():], flags=re.IGNORECASE)
    end = m.end() + end_m.start() if end_m else len(html)
    return html[start:end]


def _parse_sessions(block):
    """From a year block, return {session: set(course_codes)} using the
    Fall/Winter session headers inside the tables."""
    cur = None
    groups = {}
    parts = re.split(r"(Fall Session[^<]*|Winter Session[^<]*)", block,
                     flags=re.IGNORECASE)
    for part in parts:
        if re.match(r"Fall Session", part, flags=re.IGNORECASE):
            cur = "fall"
        elif re.match(r"Winter Session", part, flags=re.IGNORECASE):
            cur = "winter"
        elif cur:
            codes = re.findall(
                r"/course/([A-Z]{3,4}\d{3}[HY]\d)\b", part,
                flags=re.IGNORECASE,
            )
            groups.setdefault(cur, set()).update(code.upper() for code in codes)
    return groups


def _split_program_block(html, program):
    """Return the HTML slice for one program's section.

    The ECE calendar page repeats program titles in navigation and descriptive
    content before the actual curriculum tables. We therefore anchor the split
    on the first real ``FIRST YEAR <PROGRAM> ENGINEERING`` heading. The other
    supported pages contain one program section, so their full HTML is safe to
    pass to the program-specific year-heading parser.
    """
    selected = _normalize_program(program)
    source = PROGRAM_CONFIG[selected]["source"]
    if source not in ("computer", "electrical"):
        return html

    first_heading = _year_heading_pattern("FIRST", source)
    start_match = re.search(first_heading, html, flags=re.IGNORECASE)
    if not start_match:
        return html
    start = start_match.start()

    # Next ECE program section starts at its first real curriculum heading.
    other = "electrical" if source == "computer" else "computer"
    other_heading = _year_heading_pattern("FIRST", other)
    next_match = re.search(
        other_heading, html[start_match.end():], flags=re.IGNORECASE
    )
    end = start_match.end() + next_match.start() if next_match else len(html)
    return html[start:end]


def get_program_courses(program, year, track=None):
    """Return {session: [course_codes]} for a program + year (e.g. '2').

    ``computer`` and ``electrical`` preserve the existing ECE track-specific
    behavior. The legacy ``track`` argument is still honored when callers pass
    an ECE program plus ``track='computer'`` or ``track='electrical'``.
    ``trackone`` is an alias of the Computer/shared ECE curriculum for first
    year, which is the common Track One curriculum requested by the UI.
    """
    requested = _normalize_program(program)
    year = str(year)

    # The original public signature used ``track`` to disambiguate the shared
    # ECE calendar page. Preserve that behavior for external callers while the
    # new program IDs use the registry directly.
    if track is not None:
        legacy_track = _normalize_program(track)
        if legacy_track not in ("computer", "electrical"):
            raise ValueError("track must be 'computer' or 'electrical'")
        if requested in ("computer", "electrical"):
            requested = legacy_track

    if PROGRAM_CONFIG[requested].get("first_year_only") and year != "1":
        raise ValueError("Track One curriculum is only supported for year 1")

    source = PROGRAM_CONFIG[requested]["source"]
    url = _section_url(source)
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    html = _split_program_block(response.text, source)

    ordinal = {"1": "FIRST", "2": "SECOND", "3": "THIRD", "4": "FOURTH"}.get(year)
    if not ordinal:
        raise ValueError(f"Year must be 1-4, got '{year}'")
    block = _split_year_block(html, ordinal, program=source)
    if not block:
        return {}
    return {k: sorted(v) for k, v in _parse_sessions(block).items()}


if __name__ == "__main__":
    import json

    for program in PROGRAM_IDS:
        if program == "trackone":
            years = ("1",)
        else:
            years = ("1", "2")
        for year in years:
            result = get_program_courses(program, year)
            print(f"program={program} year={year}: {json.dumps(result)}")
