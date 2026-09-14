# Test value and quality model

> **Generated file — do not edit directly.** This is produced from `quality/test-value-model.yaml` by `pnpm pw:generate-value-model-md`. Edit the YAML and regenerate instead.

**Model version:** 1.0.0  
**Effective date:** 2026-09-10

## Principle

Test value and test implementation quality are different concepts and are never merged. Value measures business confidence and risk reduction (0-100); quality measures engineering craftsmanship (0-100). Neither pass/fail status nor flakiness directly changes a value score.

## Value scoring (100 points)

| Criterion | Weight | Scoring question |
|---|---:|---|
| Business criticality | 25 | How seriously would failure affect the organization's core operation or release decision? |
| User impact and frequency | 15 | How many users are affected, and how often is this behavior used? |
| Risk and defect likelihood | 20 | How likely and costly is a defect in this behavior, considering history and complexity? |
| Security, compliance, and data integrity | 15 | Does this protect access, privacy, regulated behavior, calculations, or durable data? |
| Unique coverage | 15 | How much important behavior would become unprotected if this test were removed? |
| Release-decision usefulness | 10 | If this intended behavior were reliably tested, would its result materially inform release or operational decisions? |

### Value scoring anchors

### Business criticality

  - **0%:** No plausible effect on core operation or any release decision.
  - **25%:** Minor inconvenience; would not itself change a release decision.
  - **50%:** Noticeable operational impact; could factor into a release decision alongside other issues.
  - **75%:** Serious operational impact; would likely block or delay a release on its own.
  - **100%:** Failure would stop core operation or must block release outright.

  _Example:_ A wedding owner being unable to sign up or log in at all would score at or near 100.

### User impact and frequency

  - **0%:** Affects effectively no users, or a behavior almost never exercised.
  - **25%:** Affects a small subset of users or an infrequently used path.
  - **50%:** Affects a common user segment or a regularly used path.
  - **75%:** Affects most users or a frequently used path.
  - **100%:** Affects nearly all users on a path used in nearly every session.

  _Example:_ Adding a guest to the guest list is exercised by every planner, every wedding.

### Risk and defect likelihood

  - **0%:** Simple, stable behavior with no history of defects and low complexity.
  - **25%:** Modest complexity; a defect would be low-cost to detect and fix.
  - **50%:** Moderate complexity or a prior history of related bugs.
  - **75%:** High complexity, prior defects, or a costly-to-detect failure mode.
  - **100%:** Historically defect-prone, complex, and costly if a defect reaches users.

  _Example:_ The automated seat-assignment engine (TS-8) combines multiple seating rules and constraints.

### Security, compliance, and data integrity

  - **0%:** No access, privacy, calculation, or persisted-data concern at all.
  - **25%:** Touches persisted data but with low sensitivity and easy recovery.
  - **50%:** Touches access control or data integrity for a moderately sensitive resource.
  - **75%:** Touches authentication/authorization boundaries or important calculations.
  - **100%:** Directly protects authentication, cross-account access control, or irreversible data changes.

  _Example:_ Wedding-scoped access control (a user cannot read another owner's wedding) scores at or near 100.

### Unique coverage

  - **0%:** Fully duplicated by another reliable test; removing this one loses nothing.
  - **25%:** Mostly overlaps another test, with a small distinguishing condition.
  - **50%:** Partially unique: some overlap, but also covers a condition nothing else does.
  - **75%:** Mostly unique coverage with only incidental overlap elsewhere.
  - **100%:** The only test protecting this behavior; removing it eliminates all coverage of it.

  _Example:_ The only test exercising the Day-of Mode read-only view during an active event.

### Release-decision usefulness

  - **0%:** A failure here would never change a release or operational decision.
  - **25%:** A failure here might be noted but would rarely change a decision.
  - **50%:** A failure here would often prompt a closer look before release.
  - **75%:** A failure here would usually delay or gate a release pending investigation.
  - **100%:** A failure here reliably and directly determines a release/operational go/no-go call.

  _Example:_ A failing RSVP-link email-delivery test should reliably gate a release touching that flow.

### Value bands

| Score | Band | Meaning |
|---:|---|---|
| 90-100 | Critical | Essential release confidence; failure normally blocks release or demands explicit risk acceptance |
| 75-89 | High value | Strong protection of important workflows or risks |
| 50-74 | Useful | Meaningful coverage but not normally release-critical by itself |
| 25-49 | Limited | Narrow, low-impact, overlapping, or weakly justified coverage |
| 0-24 | Questionable | Little demonstrated value; improve, replace, or retire after human review |

## Quality scoring (100 points)

| Criterion | Weight | Scoring question |
|---|---:|---|
| Independence and parallel safety | 20 | Can this test run in any order, in parallel, and in isolation, without depending on other tests' state? |
| Assertion strength and objective traceability | 20 | Do the assertions actually verify the stated objective, with meaningful failure detail? |
| Deterministic waiting and state control | 15 | Does the test wait on real, observable state instead of arbitrary timeouts, and control the state it depends on? |
| Page/component object and locator design | 15 | Are interactions expressed through resilient, well-structured page/component objects and locators? |
| Test-data setup and cleanup | 10 | Does the test create the data it needs and leave the environment clean afterward? |
| Readability and diagnostic steps | 10 | Can a human quickly understand what the test does and where it failed, from named steps? |
| Evidence and failure diagnostics | 5 | Does a failure leave enough evidence (screenshots, trace, console/network) to diagnose without rerunning? |
| Metadata completeness and standards compliance | 5 | Is the test's governed metadata (id, objective, expectedOutcome, requirementIds, tags) complete and valid? |

### Quality scoring anchors

### Independence and parallel safety

  - **0%:** Depends on execution order or leaks/depends on state from other tests.
  - **25%:** Mostly independent, with one identifiable order or shared-state dependency.
  - **50%:** Independent under normal conditions but not proven safe under parallel execution.
  - **75%:** Independent and parallel-safe, with minor shared-fixture coupling.
  - **100%:** Fully independent: creates its own data, runs in any order, safe under full parallelism.

  _Example:_ A test that assumes a guest created by a prior test still exists would score low.

### Assertion strength and objective traceability

  - **0%:** Assertions are missing, trivial (e.g. checking the page didn't crash), or unrelated to the objective.
  - **25%:** Assertions exist but only weakly relate to the stated objective.
  - **50%:** Assertions cover the objective's main case but miss important detail or edge conditions.
  - **75%:** Assertions directly and specifically verify the objective, with clear failure messages.
  - **100%:** Assertions fully and precisely verify the objective, distinguishing every meaningful outcome.

  _Example:_ Asserting the exact guest row's tier value, not just that some row exists.

### Deterministic waiting and state control

  - **0%:** Relies on fixed sleeps/timeouts or unmanaged ambient state.
  - **25%:** Mostly fixed waits, with a little real state-based waiting.
  - **50%:** Mixed: some deterministic waits, some fragile timing assumptions remain.
  - **75%:** Deterministic waits throughout, with state fully controlled by the test.
  - **100%:** Fully deterministic: waits only on real, specific application state; test-controlled data throughout.

  _Example:_ Waiting for a specific network response or DOM state rather than page.waitForTimeout().

### Page/component object and locator design

  - **0%:** Brittle raw locators (e.g. nth-child chains) scattered directly in the test body.
  - **25%:** Some structure, but locators are fragile or duplicated across tests.
  - **50%:** Reasonable page-object use with a few fragile or duplicated locators.
  - **75%:** Consistent, resilient page/component objects with accessible-role/testid locators.
  - **100%:** Clean, reusable page/component objects; locators are resilient and semantically meaningful.

  _Example:_ getByRole('button', { name: 'Add guest' }) inside a GuestListPage object.

### Test-data setup and cleanup

  - **0%:** Relies on preexisting/shared data and leaves created data behind.
  - **25%:** Creates some of its own data but leaves significant cleanup undone.
  - **50%:** Creates its own data; cleanup is partial or best-effort.
  - **75%:** Creates its own data and reliably cleans up in the common case.
  - **100%:** Fully self-contained setup and guaranteed cleanup, including on failure.

  _Example:_ Creating a fresh wedding/guest via the signup API per test, per Stage 03's data-setup approach.

### Readability and diagnostic steps

  - **0%:** No named steps; a failure gives no indication of which part of the flow broke.
  - **25%:** A few named steps; large ungrouped stretches remain.
  - **50%:** Most of the flow is broken into named steps.
  - **75%:** Clear, well-named steps covering the whole flow.
  - **100%:** Fully step-annotated, self-documenting flow; a failure immediately localizes to one step.

  _Example:_ test.step('fill guest form') / test.step('submit and verify row appears').

### Evidence and failure diagnostics

  - **0%:** No failure artifacts beyond the bare error message.
  - **25%:** Only the default Playwright failure screenshot.
  - **50%:** Screenshot plus trace, but no console/network capture.
  - **75%:** Screenshot, trace, and console/network capture on failure.
  - **100%:** Full evidence bundle on failure, plus a success checkpoint screenshot for key assertions.

  _Example:_ Attaching the network log for a failed RSVP-submission request.

### Metadata completeness and standards compliance

  - **0%:** Missing required metadata or fails tag-taxonomy validation.
  - **25%:** Metadata present but objective/expectedOutcome are vague or requirementIds is empty.
  - **50%:** Metadata complete but generic; tags are valid but coarse-grained.
  - **75%:** Metadata complete, specific, and correctly tagged.
  - **100%:** Metadata is complete, precise, correctly tagged, and clearly traceable to a real requirement.

  _Example:_ objective/expectedOutcome that name the exact business rule under test, not just "it works".

## Change history

| Date | Model version | Change |
|---|---|---|
| 2026-09-10 | 1.0.0 | Initial value and quality rubrics created for Stage 02, matching spec Section 8.3/8.5 exactly. |
