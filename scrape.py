"""Scrape U of T Engineering course data for schedule optimization.

Fetches course + section + meeting-time data from the official Timetable
Builder API (the same endpoint the ttb.utoronto.ca web app uses) and writes
it to courses.json, which the optimizer consumes.

    POST https://api.easi.utoronto.ca/ttb/getCourses

Common flags:
    --curriculum <program>  computer|electrical|mechanical|industrial|
                            chemical|materials|civil|mineral|trackone
                            -> exact required courses scraped live from the
                            academic calendar
    --year <n>              e.g. 1 or 2 -> year level for --curriculum
    --session fall|winter|both
                            fall=<YYYY>9 (current Fall), winter=<YYYY+1>1
                            (current Winter); codes auto-derived from today's
                            date (see active_sessions)
    --department <code>     e.g. ece -> matches course-code prefix (ECE)
    --codes <c1> <c2>       keep exact course codes
    --prefix <p1> <p2>     keep codes starting with any prefix

Examples:
    python scrape.py --curriculum computer --year 2
    python scrape.py --curriculum mechanical --year 1 --session fall
    python scrape.py --curriculum trackone --year 1 --session both
    python scrape.py --codes ECE201H1 MAT290H1
"""
import argparse
import datetime
import json
import os
import sys
from collections import defaultdict

import requests

from curriculum import PROGRAM_IDS, get_program_courses

API = "https://api.easi.utoronto.ca/ttb"
HEADERS = {
    "Accept": "application/json",
    "Origin": "https://ttb.utoronto.ca",
    "Content-Type": "application/json",
}


def fetch_courses(sessions, divisions, course_levels, page_size=500):
    """POST /getCourses with filter body, paginate, return list of raw entries."""
    all_courses = []
    page = 0
    while True:
        body = {
            "sessions": sessions,
            "divisions": divisions,
            "courseLevels": course_levels,
            "page": page,
            "pageSize": page_size,
            "direction": "ASC",
        }
        r = requests.post(f"{API}/getCourses", headers=HEADERS, json=body, timeout=60)
        r.raise_for_status()
        page_courses = r.json().get("payload", [])
        if not page_courses:
            break
        all_courses.extend(page_courses)
        if len(page_courses) < page_size:
            break
        page += 1
    return all_courses


def filter_by_prefix(courses, prefix):
    """Keep only courses whose code starts with the given prefix(es)."""
    if not prefix:
        return courses
    prefixes = prefix if isinstance(prefix, list) else [prefix]
    return [c for c in courses if any(c["code"].startswith(p) for p in prefixes)]


def filter_by_codes(courses, codes):
    """Keep only courses whose code is in the given list (case-insensitive)."""
    wanted = {c.upper() for c in codes}
    return [c for c in courses if c["code"].upper() in wanted]


def _mt_key(mt):
    """Sort key for a meeting-time: by day of week, then start time of day."""
    start = mt.get("start", {})
    return (start.get("day", 0), start.get("millisofday", 0))


def normalize_courses(courses):
    """Normalize the scraped data so downstream consumers get a stable shape.

    The ttb API returns a section's meetings in arbitrary order (e.g. a section
    meeting Fri/Mon/Tue is listed Fri first). We sort each section's
    meetingTimes chronologically (Mon -> Fri) so that meeting index 0 is the
    1st lecture of the week, index 1 the 2nd, etc. This keeps timetable logic
    (which picks one section per lecture position) correct without re-sorting
    at runtime. Also drops sections with no meeting times.
    """
    for course in courses:
        for sec in course.get("sections", []):
            mts = sec.get("meetingTimes") or []
            if mts:
                sec["meetingTimes"] = sorted(mts, key=_mt_key)
    return courses


# Department code -> course-code prefix. Year is appended (e.g. "ECE" + "2" -> "ECE2").
DEPARTMENT_PREFIX = {
    "ece": "ECE",
    "che": "CHE",
    "civ": "CIV",
    "mie": "MIE",
    "mse": "MSE",
    "bme": "BME",
    "cme": "CME",
    "esc": "ESC",
    "min": "MIN",
    "phy": "PHY",
    "aer": "AER",
    "tep": "TEP",
    "mat": "MAT",
}


def active_sessions(today=None):
    """Return the U of T session codes for the academic year that is *current*
    as of `today` (defaults to today's date).

    U of T session-code scheme:
      Fall YYYY   -> "<YYYY>9"   (e.g. Fall 2026 -> 20269)
      Winter Y+1  -> "<YYYY+1>1" (e.g. Winter 2027 -> 20271)

    The new academic year opens on July 1. A Fall session runs Sep-Dec and is
    the "current" one until Jan 31; a Winter session runs Jan-Apr and is current
    until Apr 30. So as soon as it is July 1 of year Y, we move to the Y -> Y+1
    academic year (Fall Y9, Winter (Y+1)1).

    Returns {"fall": ["<fallCode>"], "winter": ["<winterCode>"]} so the rest
    of the pipeline can stay unchanged.
    """
    if today is None:
        today = datetime.date.today()
    # Academic year Y->Y+1 becomes current on Jul 1 of Y.
    if today.month >= 7:
        fall_year = today.year
    else:
        fall_year = today.year - 1
    fall_code = f"{fall_year}9"
    winter_code = f"{fall_year + 1}1"
    return {"fall": [fall_code], "winter": [winter_code]}


# "both" is handled by running the fall and winter scrapes separately so each
# cached file gets its own semester suffix (e.g. computer-1-fall.json).
BOTH_SESSIONS = ["fall", "winter"]

# Year -> course-level code used by the ttb API (year 1 = 100/A, year 2 = 200/B).
YEAR_LEVEL = {"1": ["100/A"], "2": ["200/B"], "3": ["300/C"], "4": ["400/D"]}


def cached_filename(args):
    """Stable cache filename: <program>-<year>-<semester>.json
    e.g. electrical-2-fall.json, trackone-1-winter.json."""
    year = args.year or "all"
    session = args.session or "both"
    track = args.curriculum or "none"
    return f"{track}-{year}-{session}.json"


def save_cached(args, courses):
    """Write `courses` to web/data/<combo>.json and refresh the manifest
    listing every cached combination the website can pick from."""
    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(here, "web", "data")
    os.makedirs(data_dir, exist_ok=True)
    fname = cached_filename(args)
    path = os.path.join(data_dir, fname)
    with open(path, "w") as f:
        json.dump(courses, f, indent=2)
    print(f"Cached {len(courses)} entries to {path}")

    # Refresh manifest of all cached combos. Program IDs intentionally contain
    # no hyphens, so the existing filename format remains unambiguous.
    combos = []
    for fn in sorted(os.listdir(data_dir)):
        if not fn.endswith(".json") or fn == "manifest.json":
            continue
        stem = fn[:-5]
        try:
            t, y, s = stem.split("-", 2)
        except ValueError:
            continue
        combos.append({"file": fn, "program": t, "year": y, "session": s})
    with open(os.path.join(data_dir, "manifest.json"), "w") as f:
        json.dump({"combos": combos}, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Scrape U of T timetable data.")
    parser.add_argument("--sessions", nargs="+", default=None,
                        help="Session codes, e.g. 20269 20271 (overrides --session)")
    parser.add_argument("--session", choices=["fall", "winter", "both"], default="both",
                        help="Semester selector (codes auto-derived from today's date)")
    parser.add_argument("--department", default=None,
                        help="Department code, e.g. ece (maps to course-code prefix)")
    parser.add_argument("--year", default=None,
                        help="Year level, e.g. 1 (maps to course-code level digit)")
    parser.add_argument("--curriculum", default=None, choices=PROGRAM_IDS,
                        help="Pull exact required courses from the academic calendar. "
                             "Supported IDs: " + ", ".join(PROGRAM_IDS))
    parser.add_argument("--divisions", nargs="+", default=["APSC"],
                        help="Division codes, e.g. APSC")
    parser.add_argument("--levels", nargs="+", default=None,
                        help="Course level codes, e.g. 200/B (defaults to year's level)")
    parser.add_argument("--prefix", nargs="+", default=None,
                        help="Keep only course codes starting with these, e.g. ECE2 MAT2")
    parser.add_argument("--codes", nargs="+", default=None,
                        help="Keep only these exact course codes, e.g. ECE201H1 MAT290H1")
    parser.add_argument("--out", default="courses.json")
    args = parser.parse_args()

    # "both" runs the fall and winter scrapes as two separate passes, each
    # writing its own cached file (e.g. computer-1-fall.json / -winter.json).
    sessions_to_run = BOTH_SESSIONS if args.session == "both" else [args.session]
    for session in sessions_to_run:
        scrape_session(args, session)


def scrape_session(args, session):
    """Run one scrape for a single `session` ('fall' or 'winter')."""
    args.session = session  # so cached_filename / curriculum use the right semester
    # Explicit --sessions override, else derive the current academic year's
    # codes dynamically from today's date (auto-advances on Jul 1).
    if args.sessions:
        sessions = list(args.sessions)
    else:
        sessions = active_sessions()[session]

    # Pick the course level: explicit --levels, else infer from --year.
    levels = args.levels
    if levels is None:
        if args.year in YEAR_LEVEL:
            levels = YEAR_LEVEL[args.year]
        else:
            levels = ["200/B"]

    # Build prefix filter from --department/--year if provided.
    prefixes = list(args.prefix) if args.prefix else []
    if args.department:
        dept = args.department.lower()
        if dept not in DEPARTMENT_PREFIX:
            print(f"Unknown department '{args.department}'. Known: "
                  f"{', '.join(sorted(DEPARTMENT_PREFIX))}", file=sys.stderr)
            sys.exit(1)
        year = args.year if args.year else ""
        prefixes.append(DEPARTMENT_PREFIX[dept] + year)

    # Derive exact required course codes from the academic calendar when
    # --curriculum is given (no hardcoded course lists).
    curriculum_codes = None
    if args.curriculum:
        if not args.year:
            print("--curriculum requires --year (e.g. --year 1)", file=sys.stderr)
            sys.exit(1)
        prog = get_program_courses(args.curriculum, args.year)
        curriculum_codes = set(prog.get(session, []))
        if not curriculum_codes:
            print(f"No {args.year}-year courses found for '{args.curriculum}' "
                  f"in session '{session}'.", file=sys.stderr)
            sys.exit(1)
        print(f"  curriculum {args.curriculum} year {args.year} "
              f"({session}): {len(curriculum_codes)} courses")

    print(f"Fetching division={args.divisions} levels={levels} "
          f"sessions={sessions} ...")
    raw = fetch_courses(sessions, args.divisions, levels)
    print(f"  raw API entries: {len(raw)}")

    courses = filter_by_prefix(raw, prefixes) if prefixes else raw
    if prefixes:
        print(f"  after prefix filter {prefixes}: {len(courses)} entries")
    if curriculum_codes:
        courses = filter_by_codes(courses, curriculum_codes)
        print(f"  after curriculum filter: {len(courses)} entries")
    if args.codes:
        courses = filter_by_codes(courses, args.codes)
        print(f"  after codes filter {args.codes}: {len(courses)} entries")

    codes = sorted({c["code"] for c in courses})
    print(f"  distinct course codes ({len(codes)}): {', '.join(codes)}")

    if not courses:
        print("No courses matched. Check your session/division/prefix arguments.",
              file=sys.stderr)
        sys.exit(1)

    courses = normalize_courses(courses)

    with open(args.out, "w") as f:
        json.dump(courses, f, indent=2)
    print(f"Saved {len(courses)} entries to {args.out}")

    # Keep the website's copy in sync if the web folder exists.
    web_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "web", "courses.json")
    if os.path.isdir(os.path.dirname(web_path)):
        with open(web_path, "w") as f:
            json.dump(courses, f, indent=2)
        print(f"Synced web/courses.json ({len(courses)} entries)")

    # Also cache into web/data/<program>-<year>-<session>.json so the website
    # can offer a program/year/semester picker without re-scraping.
    save_cached(args, courses)


if __name__ == "__main__":
    main()
