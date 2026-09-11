# Manual-test-to-automation worksheet

Copy this file (don't edit the template in place) and fill in every field for ONE manual test case
you're converting to an automated Playwright test. See `PLAYWRIGHT_TESTING.md`'s "First-test
tutorial" section for what to do with a filled-in copy — each field below maps directly onto a
`defineQualityTest(...)` call.

## 1. What are you testing, in plain language?

_(One or two sentences, as you'd describe it to a colleague — this becomes `objective`.)_

## 2. How do you know it worked?

_(One sentence — the specific, observable outcome. This becomes `expectedOutcome`. "It looks right"
is not specific enough; "the new guest's name appears in the guest list" is.)_

## 3. Which requirement does this protect?

_(A `quality/requirements.yaml` entry ID. If none fits, stop here and add one first — see
"Adding requirements..." in `PLAYWRIGHT_TESTING.md` — rather than inventing a test with no
requirement to trace to.)_

## 4. Does this test change any persistent data?

- [ ] No — it only reads/views existing state → tag `@readonly`
- [ ] Yes — it creates, updates, or deletes something → tag `@mutating`

## 5. Tags

Fill in at least: data-impact (from #4), one or more `@feature:*`, one or more `@suite:*`, exactly
one `@risk:*`. See `PLAYWRIGHT_TESTING.md`'s "Tagging cheat sheet" for the full list.

- data-impact: `@___`
- feature: `@___`
- suite: `@___`
- risk: `@___`
- (optional) role / test-type / lifecycle: `@___`

## 6. Arrange — what must exist before the behavior you're testing?

_(What data/account/state does the manual tester set up first, before performing the action being
tested? List it as concrete steps — this becomes the "Arrange" `test.step`. Prefer setting this up
through a fixture or the real API, not by driving the UI, unless the UI setup path itself is what's
being tested.)_

1. ...
2. ...

## 7. Act — what is the ONE action being tested?

_(The single behavior under test — a click, a form submission, a navigation. If your manual test
case actually checks several unrelated things, that's several separate automated tests, not one —
see "Extending an existing test vs. authoring a new one" in the `pw-author-test` skill.)_

## 8. Assert — how does the test confirm it worked?

_(What should be visible/true afterward, and where in the UI? Each check here becomes an
`expect`/`expect.poll` call against a page or component object method in the "Assert" `test.step` —
never a raw selector.)_

1. ...
2. ...

## 9. Does a page/component object already have what you need?

_(Check `e2e/pages/` and `e2e/components/` first. If not, what new business-readable method(s) do
you need to add, and where? e.g. `WeddingGuestsPage.addGuest(name)`.)_

## 10. File

_(New file: `e2e/tests/<feature>.spec.ts`, or an addition to an existing one — name it, and say
which.)_
