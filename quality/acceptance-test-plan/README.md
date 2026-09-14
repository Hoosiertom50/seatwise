# Seatwise acceptance test plan (source material)

These files are the manual PRD/acceptance-test workbook Tom reviewed and finalized before the
Playwright Quality Engineering Framework existed. They're the actual source material the
[Test Automation] Application Test Coverage workstream (TS-35) authors real tests from -- each row
on the "Test Cases" tab of `Seatwise-Test-Cases-Final.xlsx` is a manual acceptance test (`AC-###`)
that maps to a `Requirement Ref` (`FR-#.#` / `NFR #.#`), and each `FR-#.#` maps to a `sourceRefs`
entry in `quality/requirements.yaml`. The Jira stories under TS-35 name the specific `AC-###` IDs
each one should convert.

- `Seatwise-Requirements.docx` -- the PRD itself (what `FR-#.#` IDs refer to).
- `Seatwise-Acceptance-Criteria.md` / `.xlsx` -- the acceptance-criteria draft this test plan was
  built from (Definition of Done, per-story ACs, Integration/E2E section).
- `Seatwise-Test-Cases-Final.xlsx` -- **the file to actually work from.** 84 manual test cases,
  one row per `AC-###`, each with Preconditions/Test Steps/Expected Result -- this maps almost
  directly onto a `defineQualityTest(...)` call; see `quality/manual-test-to-automation-worksheet.md`.

Coverage note: this test plan predates the later planner-pivot roadmap (TS-16-TS-21), so it has no
`AC-###` rows for Planner Portfolio, Client RSVP Collection, Day-Of Timeline, Reusable Templates, or
Budget & Vendor Tracking. Those requirements still need to be authored from their
`quality/requirements.yaml` descriptions directly, with no manual test case to convert.
