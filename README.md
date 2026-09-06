# Timetable Fixer

Timetable Fixer loads U of T Engineering course sections and generates a clash-free timetable using the existing section and preference optimizer.

## Supported first-year programs

The web selector supports first-year Fall and Winter data for:

- ECE (`computer` cache ID)
- Mech (`mechanical`)
- Indy (`industrial`)
- Chem (`chemical`)
- MSE (`materials`)
- Civ (`civil`)
- Min (`mineral`)
- Track One (`trackone`)

Track One uses the shared ECE/Computer first-year curriculum. The existing `electrical` cache ID remains available for the distinct second-year ECE Electrical track.

## Refreshing timetable data

The scraper derives the current Fall/Winter session codes, reads required course codes from the official Engineering calendar, fetches matching sections from the Timetable Builder API, and writes static files under `web/data/`.

Generate one program’s first-year Fall and Winter files:

```powershell
python scrape.py --curriculum mechanical --year 1 --session both
```

Generate all requested first-year program files from PowerShell:

```powershell
$programs = @('computer','mechanical','industrial','chemical','materials','civil','mineral','trackone')
foreach ($program in $programs) {
  python scrape.py --curriculum $program --year 1 --session both
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
