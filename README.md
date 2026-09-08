# Timetable Fixer

Timetable Fixer loads U of T Engineering course sections and generates a clash-free timetable using the existing section and preference optimizer.

## Supported first-year programs

The web selector supports first-year Fall and Winter data for:

- Computer (`computer` cache ID)
- Mechanical (`mechanical`)
- Industrial (`industrial`)
- Chemical (`chemical`)
- Material Science (`materials`)
- Civil (`civil`)
- Mineral (`mineral`)
- Track One (`trackone`)
- Electrical (`electrical` cache ID)

Track One uses the shared Computer first-year curriculum. The existing `electrical` cache ID remains available for the distinct second-year Electrical track.

## Supported second-year programs

The web selector and generated cache matrix support second-year Fall and Winter data for all of these majors/tracks:

- Computer (`computer`)
- Electrical (`electrical`)
- Mechanical (`mechanical`)
- Industrial (`industrial`)
- Chemical (`chemical`)
- Materials (`materials`)
- Civil (`civil`)
- Mineral (`mineral`)

Track One is intentionally first-year-only: `curriculum.py` rejects Track One year 2 and no `trackone-2-*` cache is published. The optimizer reports a complete exact `NO_SOLUTION` result when the live timetable data has no usable meeting time for a required course. In the current cache, this applies to Civil Fall (`CIV201H1`) and Mineral Fall (`MIN201H1`); their source data is retained rather than inventing a timetable for a TBA section.

## Refreshing timetable data

The scraper derives the current Fall/Winter session codes, reads required course codes from the official Engineering calendar, fetches matching sections from the Timetable Builder API, and writes static files under `web/data/`. If a required curriculum course is absent from the default APSC response, it retries with the configured fallback divisions and fails before writing a cache if the course is still missing.

Generate one program’s first-year Fall and Winter files:

```powershell
python scrape.py --curriculum mechanical --year 1 --session both
```

Generate all requested first-year program files from PowerShell:

```powershell
$programs = @('computer','mechanical','industrial','chemical','materials','civil','mineral','trackone','electrical')
foreach ($program in $programs) {
  python scrape.py --curriculum $program --year 1 --session both
}
```

Generate all supported second-year program files from PowerShell:

```powershell
$secondYearPrograms = @('computer','electrical','mechanical','industrial','chemical','materials','civil','mineral')
foreach ($program in $secondYearPrograms) {
  python scrape.py --curriculum $program --year 2 --session both
}
```

The command refreshes `web/data/manifest.json`. Serve the `web` directory over HTTP to use the frontend, for example:

```powershell
python -m http.server --directory web
```

## Validation

Run the offline parser, scraper, cache, and frontend catalog checks with:

```powershell
python -m unittest discover -s tests -v
```
