# Design mockups (quick HTML, not app code)

Static mockups made with Ryan on 2026-11-26. They are rebuilt in code once a direction is picked; nothing here is
loaded by the app.

| File | What |
|---|---|
| `perform-v6.html` | Perform v6 (D16): strips as the main screen, left sidebar (Quick, wheel), right sidebar (Drone, Setlist, Notes…), scrolling after 5 instruments, today's keyboard and menu bar popover |
| `chart.html` | Chart view (D7, 2.1) placed in the v6 layout: on the stage, or as a sidebar tab; iPad; Add a chart |
| `song-bank.html` | Song bank (O-AW-PP bank packs) as a browser over the stage: filters, detail, Try it, Add to library / setlist; opened from Setlist › + Add song. Proposal, not yet approved |
| `mock_v6.py`, `mock_chart.py`, `mock_bank.py` + CSS | Generators. Run with `python3`; the `OUT` and CSS paths at the top point at the session scratch folder, so adjust them first. |

Open the HTML files in a browser; the tabs at the top switch frames. The chart mockup's song and words are invented.
