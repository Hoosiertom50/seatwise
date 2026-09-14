# Seatwise — Acceptance Criteria

Companion to the *Seatwise Product Requirements Document* (v1.0). Every acceptance criterion below is written as **Given / When / Then** so a tester who has never seen the app can execute it without extra context, and traces back to a requirement ID (e.g., `FR-3.2`) in the PRD if more background is ever needed.

**How this is organized:** each `## Story:` section below is a candidate Jira story — a short user-story statement followed by its acceptance criteria. Copy a whole section into one Jira story's description/AC field. Two sections don't map to a single feature story on their own — *Definition of Done* and *Non-Functional Acceptance Criteria* — because they cut across every story; either give them their own small technical story or paste their criteria into every relevant story's AC list. The final *Integration* section is a good candidate for a last "smoke test" story once the individual feature stories are built.

---

## Definition of Done — Applies to Every Story Below

Two rules govern the entire app and should hold true no matter which story a tester is validating:

**AC1** (`FR-0.1`): Given any hard rule is in effect (table capacity, a Must-Sit-Together group, a Must-Not-Sit-Together pair, a Restricted table's guest list, or an accessible-seating requirement), when any action anywhere in the app — automated generation, a manual drag, or an edit to a guest's data — would leave that rule violated, then the system either blocks the action outright with a plain-language explanation (if the action directly causes it) or visibly flags the affected guest as needing reassignment (if the violation arises indirectly) — it never saves, displays, or exports a plan that silently violates a hard rule, and no override exists.

**AC2** (`FR-0.2`): Given a soft rule (Prefer-Near, Prefer-Avoid, Side-Mixing, a Purpose table, household grouping) is not fully satisfied, when the plan is viewed, then a visible, non-blocking warning is shown — the action that caused it is never blocked solely for that reason.

---

## Story: Account & Wedding Management

**As a** wedding planner running a multi-client business, **I want** to create an account and manage multiple fully separate wedding workspaces, **so that** I can plan seating for many clients without their data ever mixing.

**AC1** (`FR-1.1`): Given no existing planner account, when a planner signs up and creates two weddings under that account, then both weddings exist independently and can each be opened.

**AC2** (`FR-1.2`): Given a planner owns Wedding A and Wedding B, when a guest, rule, or table is added to Wedding A, then it never appears anywhere in Wedding B.

**AC3** (`FR-1.3`): Given a new wedding is being created, when the planner enters the couple's names, date, and venue and leaves the optional note blank, then all fields save and redisplay correctly, with no error for the blank note.

**AC4** (`FR-1.3a`): Given a wedding is using its default side labels, when the planner renames the two side labels (e.g., to something other than "Bride's Side" / "Groom's Side"), then every place Side is shown — guest list, rules — uses the new labels, with no guest data lost.

**AC5** (`FR-1.4`, `FR-1.4a`): Given a wedding exists, when the planner invites someone by email with a specific permission level (View, Comment, or Edit), then that person receives an invitation email containing no guest data, and no wedding data is shown to them until they sign in or create an account.

**AC6** (`FR-1.5`): Given a planner owns Wedding A and Wedding B, when a collaborator who was invited only to Wedding A logs in, then they see only Wedding A, with no list, link, or trace of Wedding B anywhere.

**AC7** (`FR-1.6`): Given a collaborator currently has access to a wedding, when the planner revokes that access, then the collaborator is denied entry immediately, even via a previously saved link.

---

## Story: Guest List Management

**As a** planner, **I want** to build and maintain each wedding's guest list — by hand or by importing a spreadsheet — **so that** every guest's identity, side, tier, and household are captured accurately before seating begins.

**AC1** (`FR-2.1`): Given a wedding exists, when a guest is added with only a name (Side and Relationship Tier left blank), then the guest saves successfully with Side defaulting to "Both" and Relationship Tier defaulting to "Guest," both editable afterward.

**AC2** (`FR-2.2`): Given a wedding exists, when a guest is added with a plus-one indicator, dietary note, accessibility note, age category, and free-text note, then all fields save and display correctly.

**AC3** (`FR-2.2a`): Given a guest is being marked as bringing a plus-one whose name isn't known yet, when that indicator is set, then a full, independent placeholder guest record (e.g., "[Guest]'s Guest") is created in the same household, and later renaming that placeholder does not affect any rule or seat assignment already involving it.

**AC4** (`FR-2.3`): Given a wedding exists, when a guest is added, edited, and then removed one at a time through the guest form, then each action succeeds and the guest list updates immediately.

**AC5** (`FR-2.4`): Given a spreadsheet with 10 valid guest rows and 2 invalid rows (e.g., one missing a name) is imported, when the import runs, then the 10 valid rows import successfully and each of the 2 invalid rows is reported individually with a specific reason (e.g., "row 4: missing name") rather than one generic failure.

**AC6** (`FR-2.4a`): Given an import spreadsheet has rows matching existing guests by a mapped ID column and other rows that are new, when the planner reaches the preview screen, then it clearly shows counts of new vs. updating rows, and nothing is written to the guest list until the planner explicitly confirms.

**AC7** (`FR-2.5`): Given three guests are grouped into one household with no other rule, when one is manually moved to a different table, then the move succeeds (household alone is only a soft default) — but given an explicit Must-Sit-Together rule is added for that household, when the same move is attempted again, then it is blocked.

**AC8** (`FR-2.6`): Given a guest list with guests on both sides, multiple tiers, and some unassigned, when the planner searches by name, filters by side, filters by "unassigned," or sorts by tier, then each returns the correct result set.

**AC9** (`FR-2.7`): Given a guest has not been assigned to a table, when the guest list is viewed, then that guest is clearly marked as unseated and easy to find (e.g., via a filter, count, or highlighted section).

**AC10** (`FR-2.8`): Given two different guests are both named "John Smith" from different households, when either is searched for anywhere in the app (guest list, rule creation), then both appear as distinct entries, each visually disambiguated (e.g., by household or side shown alongside the name).

**AC11** (`FR-2.9`): Given a seated guest's household is edited so a Must-Not-Sit-Together rule now applies to their current tablemate, when that edit is saved, then the guest is flagged as needing reassignment rather than left in a silent violation.

---

## Story: Relationships & Seating Rules

**As a** planner, **I want** to define which guests must, must not, or would prefer to sit together — and how much to mix the two sides — **so that** the automated seating reflects the real social rules of the wedding.

**AC1** (`FR-3.1`): Given a Must-Sit-Together rule links two guests, when the plan is generated and then a manual move tries to separate them, then generation always seats them together and the manual move is blocked.

**AC2** (`FR-3.2`): Given a Must-Not-Sit-Together rule links two guests, when the plan is generated and then a manual move tries to combine them, then generation never seats them together and the manual move is blocked.

**AC3** (`FR-3.3`): Given Prefer-Near and Prefer-Avoid rules exist between two guest pairs, when the plan is generated and a manual move works against one of these rules, then generation favors satisfying both rules where possible, and the manual move is allowed with a visible warning rather than blocked.

**AC4** (`FR-3.4`): Given a guest list with a roughly even split across both sides, when Side-Mixing is set to "Keep sides separate" and the plan is generated, then tables are noticeably grouped by side; when it is changed to "Fully mixed" and regenerated, tables are noticeably blended; when one specific table is marked "single-side only," it stays single-side regardless of the wedding-level setting.

**AC5** (`FR-3.5`): Given a Must-Sit-Together rule already exists between Guest A and Guest B, when someone tries to create a Must-Not-Sit-Together rule between the same two guests, then creation is blocked with a message naming the earlier, conflicting rule.

**AC6** (`FR-3.5a`): Given a Prefer-Near rule exists between two guests, when a Prefer-Avoid rule is also created between the same two guests, then both rules save successfully but are flagged with a visible warning wherever rules are listed.

**AC7** (`FR-3.6`): Given several rules of different types exist across different guests, when the dedicated rules list is opened, then every rule appears there and can be edited or removed from that one screen.

**AC8** (`FR-3.7`): Given a table is labeled "Kids' Table" (a Purpose table, not Restricted) and more children exist than its capacity, when the plan is generated, then the table favors seating children there while overflow children are seated elsewhere rather than the generation failing.

**AC9** (`FR-3.7a`): Given a table is marked Restricted with an explicit list of exactly two guests, when the plan is generated and a manual attempt is made to add a third, non-listed guest, then generation seats only the two listed guests there and the manual add is blocked.

**AC10** (`FR-3.8`): Given one guest requires accessible seating and only one table is marked Accessible, when the plan is generated and a manual move tries to relocate that guest to a non-Accessible table, then generation always seats the guest at the Accessible table and the manual move is blocked.

---

## Story: Table & Venue Layout

**As a** planner, **I want** to define the venue's tables — their shape, capacity, purpose, and accessibility — **so that** the seating engine has an accurate picture of the room to seat guests into.

**AC1** (`FR-4.1`): Given a wedding has no tables yet, when the planner creates a table for each shape option (including "Other" with a custom label) and sets a capacity, then all save correctly and shape affects only how the table is drawn, never seating behavior.

**AC2** (`FR-4.2`): Given a wedding has no tables yet, when the planner uses the quick-create option for "12 round tables of 8," then all 12 tables are created in a single action with capacity 8 each.

**AC3** (`FR-4.3`): Given a wedding is fully set up, when the planner completes a full generate-review-approve cycle without ever opening the floor plan, then the entire workflow works; when the floor plan is opened separately and a table is dragged, the reposition succeeds.

**AC4** (`FR-4.4`): Given one table is filled to its exact capacity and total guests exceed total seats wedding-wide, when a manual add to the full table is attempted and generation is run, then the manual add is blocked and generation reports the shortfall as impossible rather than overfilling any table.

**AC5** (`FR-4.5`): Given total guests exceed total available seats, when the wedding overview is viewed, then a clear shortfall warning is shown, and the warning disappears once seats are sufficient.

**AC6** (`FR-4.6`): Given a table exists, when the planner marks it Accessible and later toggles the flag off, then the flag saves, displays clearly, and can be reversed.

**AC7** (`FR-4.7`): Given any wedding with tables and seated guests, when the product is searched for a way to assign a specific numbered chair within a table, then no such control exists anywhere — assignment is always guest-to-table only.

---

## Story: Automated Seat Assignment Engine

**As a** planner, **I want** to generate a complete seating chart automatically from the guest list and rules, **so that** I have a strong starting draft instead of building one by hand.

**AC1** (`FR-5.1`): Given a wedding has a complete guest list, tables, and a non-contradictory rule set, when the planner clicks Generate, then every guest is assigned to exactly one table in a single action.

**AC2** (`FR-5.2`, `10.2`): Given a Must-Sit-Together group is larger than the capacity of any single table, when generation is run, then no plan is produced — instead, a report names exactly which guests/rules could not be placed and why, and no partial or rule-violating plan is saved.

**AC3** (`FR-5.3`): Given a normal, fully satisfiable wedding setup with some Prefer-Near rules, when generation is run, then a summary is shown of how well soft preferences were satisfied (e.g., a percentage of Prefer-Near requests honored).

**AC4** (`FR-5.4`): Given a plan has already been generated once, when a rule is changed and the plan is regenerated (repeatedly, if needed), then each run produces a new, retrievable draft reflecting the current inputs.

**AC5** (`FR-5.5`, `10.3`): Given an existing generated plan, when the planner locks two tables, adds one new guest, and regenerates, then the two locked tables are completely unchanged, unaffected guests elsewhere also remain largely unchanged, and the new guest is placed appropriately.

**AC6** (`FR-5.6`): Given a wedding ready for generation, when the plan is generated twice with a change in between, then two distinct, individually retrievable versions exist in history.

**AC7** (`FR-5.1`, `NFR 9.1`): Given a wedding with 300 guests and 40 tables and a satisfiable rule set, when generation is run and timed, then it completes in under 15 seconds.

---

## Story: Review & Approval

**As a** couple (or planner), **I want** to review a generated seating plan, comment on it, and formally approve it, **so that** everyone agrees on the plan before it's finalized.

**AC1** (`FR-6.1`): Given a generated plan exists, when the visual table-by-table layout and the guest-to-table list view are both opened, then both are available and show consistent assignment data.

**AC2** (`FR-6.2`): Given a plan is shared with a View-only collaborator and an Edit collaborator, when each opens it and attempts to move a guest, then the View-only collaborator cannot make the move and the Edit collaborator's move succeeds.

**AC3** (`FR-6.3`): Given a plan is shared with a Comment-permission collaborator, when they leave a comment on a specific table and on a specific guest's placement, then both comments save, are attributed to them, and are visible to everyone with access.

**AC4** (`FR-6.4`): Given a plan is in Draft status and a Collaborator (not Planner, not Couple) has Edit permission, when that collaborator moves it to In Review and then attempts to mark it Approved, then the move to In Review succeeds but marking it Approved is not permitted; when the Planner marks it Approved, that succeeds.

**AC5** (`FR-6.5`): Given a plan is Approved, when a manual edit is made to it, then the edit is allowed and takes effect — approval never locks the plan.

**AC6** (`FR-6.6`): Given a plan is Approved, when an edit is made, then the status remains Approved but a "Modified since approval" indicator appears with a timestamp and the editor's name, with no re-approval step required.

---

## Story: Manual Adjustment

**As a** planner or collaborator (like the mother of the bride), **I want** to drag guests between tables and have the system enforce the same rules automatically, **so that** I can fine-tune the plan by hand without accidentally breaking it.

**AC1** (`FR-7.1`): Given a plan exists with no rule conflict between a guest's current table and a target table, when that guest is dragged to the target table, then the move succeeds and updates immediately in both the visual and list views.

**AC2** (`FR-7.2`): Given a wedding has a full table, a Must-Sit-Together group, a Must-Not-Sit-Together pair, a Restricted table, and an accessible-seating guest, when a manual move attempts to exceed capacity, split the Must-Sit-Together group, combine the Must-Not-Sit-Together pair, add a non-listed guest to the Restricted table, or move the accessible-seating guest off its table, then every one of those five attempts is blocked with a specific explanation and no override option.

**AC3** (`FR-7.3`): Given a Prefer-Near rule links two seated guests, when one is manually moved away from the other, then the move succeeds and shows a visible, non-blocking warning.

**AC4** (`FR-7.4`): Given a generated plan exists, when a guest is locked, the plan is regenerated, and the locked guest is then manually moved, then the guest is unaffected by the regeneration but the manual move still succeeds.

**AC5** (`FR-7.5`): Given a plan exists, when a manual move is made, undone, and then redone, then undo reverts the move exactly and redo reapplies it exactly.

**AC6** (`FR-7.6`): Given a plan exists, when a manual edit is made, then it appears in the plan's change history with the correct user and timestamp.

**AC7** (`FR-7.7`): Given two users with Edit permission have the same plan open at the same time, when User A moves a guest, then User B's view reflects that change within 5 seconds without a manual refresh; when User B then attempts to move the same guest based on their now-stale view, they are shown the current state and asked to retry rather than silently overwriting User A's change.

---

## Story: Day-Of / Emergency Mode

**As a** planner or day-of coordinator, **I want** a fast, mobile-friendly way to handle no-shows, walk-ins, and last-minute swaps, **so that** changes on the wedding day take seconds, not a full replan.

**AC1** (`FR-8.1`): Given a seated guest is linked to another by a rule, when that guest is marked Not Attending, then their seat becomes available immediately with no full regeneration triggered, and the linked rule is re-evaluated.

**AC2** (`FR-8.2`): Given day-of mode is open with an open seat available, when a walk-in guest is added and assigned that seat, then the seating succeeds without a full regeneration; when a different walk-in is assigned a seat that would break a hard rule, that attempt is blocked.

**AC3** (`FR-8.3`): Given two seated guests have no rule conflict, when their seats are swapped in a single action, then the swap completes immediately; given a different swap would break a hard rule, that swap is blocked with the same protection as any other manual move.

**AC4** (`FR-8.4`): Given day-of mode is opened on a phone-sized screen, when guest search and the table-occupancy view are used, then both are usable one-handed and no interactive control is smaller than 44×44 CSS pixels.

**AC5** (`FR-8.5`): Given day-of mode is in use, when a no-show is marked and a walk-in is added, then both changes appear in the same version/change history as any other edit, with who made them and when.

---

## Story: Export & Print

**As a** planner, **I want** to export the finished plan as printable charts, lookup lists, and place cards, **so that** the wedding can run smoothly even without a screen or internet connection.

**AC1** (`FR-9.1`): Given an approved plan exists, when the full seating chart is exported, then a PDF is produced showing every table with its guests' names.

**AC2** (`FR-9.2`): Given an approved plan exists, when the alphabetical guest-to-table lookup list is exported, then a PDF lists every guest alphabetically with their table.

**AC3** (`FR-9.3`): Given an approved plan exists, when place cards are exported, then one print-ready card per guest is produced showing their name and table.

**AC4** (`FR-9.4`): Given a plan has five saved versions (v1–v5), when version v2 is restored, then a new version (v6) is created copying v2's assignments, while v3, v4, and v5 remain in the history rather than being deleted.

---

## Story: Collaboration & Notifications

**As a** planner or collaborator, **I want** to see an activity log, leave comments, and get notified of important changes, **so that** everyone with access stays in sync on a plan that may be edited by several people.

**AC1** (`FR-10.1`): Given several changes have been made by different users, when the activity log is viewed, then a chronological, correctly attributed log of those changes is shown.

**AC2** (`FR-10.2`): Given a plan is not yet Approved, when it is shared for review, a comment is replied to, and — after approval — a guest's table is changed, then each of those three actions produces a notification to the relevant collaborators.

**AC3** (`FR-10.3`): Given a comment thread exists, when the original commenter resolves it, an Edit-permission user who didn't write it resolves a different comment, and a View-only user attempts to resolve a third, then the first two succeed and show who resolved it and when, while the View-only attempt is not permitted.

---

## Non-Functional Acceptance Criteria

These verify *how well* the system behaves rather than one specific feature. Attach each to whichever story it's most relevant to, or track them together as one "Quality & Performance" technical story.

**AC1 — Performance at scale** (`NFR 9.1`): Given a wedding with 500 guests, when generation is run and timed, then it completes in under 60 seconds.

**AC2 — Manual-edit responsiveness** (`NFR 9.1`): Given a plan is open for editing, when a guest is dragged to a new table or a rule is applied, then the UI updates, including hard-rule validation, in under 1 second.

**AC3 — Usable without training** (`NFR 9.2`): Given a person who has never used Seatwise before and receives no training, when they're asked to find a specific guest's table in the review view and to explain a blocked action in their own words, then they complete both correctly unaided.

**AC4 — Specific error messages** (`NFR 9.2`): Given a full table, a Must-Not-Sit-Together pair, and a Restricted table all exist, when each kind of blocked move is triggered, then each shows a distinct, specific, plain-language message — never the same generic "action not allowed" text.

**AC5 — Cross-tenant data isolation** (`NFR 9.3`): Given a user has no access to Wedding X, when they attempt to reach Wedding X's data directly (e.g., by URL/ID, bypassing normal navigation), then access is denied at the data layer and no data is returned.

**AC6 — Guest data protection** (`NFR 9.3`): Given a wedding with guest names and accessibility/dietary notes, when data is loaded over the network and inspected in storage, then it is encrypted in transit and at rest, with retention/export controls matching documented policy.

**AC7 — Printed fallback works offline** (`NFR 9.4`): Given a chart and lookup list were printed the day before with no changes since, when they're used with no internet connection to locate 5 specific guests, then all 5 are found correctly from the printed materials alone.

**AC8 — Accessibility conformance** (`NFR 9.5`): Given the review view and day-of mode, when an automated accessibility scan, keyboard-only navigation, and screen-reader navigation are each run against them, then no critical WCAG 2.1 AA violations are found and every function is reachable without a mouse.

**AC9 — Responsive across devices** (`NFR 9.5`): Given a wedding with a generated plan, when the app is used on a desktop browser and on common mobile screen widths, then layout and functionality remain usable at both sizes, with day-of mode comfortable to use one-handed on a phone.

---

## Integration / End-to-End Acceptance Criteria

A good candidate for a final "smoke test" story once the individual feature stories above are built and merged.

**AC1 — Full setup-to-approval** (`§11.1–11.2`): Given a new wedding and a guest spreadsheet of about 100 guests, when the planner imports the guests, adds Must-Sit/Must-Not-Sit rules, sets Side-Mixing, quick-creates tables, generates the plan, shares it, and the couple approves it after a blocked edit is explained to a collaborator, then every step completes as described and the plan ends Approved with every guest seated.

**AC2 — Pre-wedding changes after approval** (`§11.3`): Given an Approved plan, when two guests are marked Not Attending and one late guest is added and seated, then the seats free up and re-check automatically, the new guest is seated without breaking any rule, and the plan remains Approved with a "Modified since approval" indicator.

**AC3 — Day-of execution** (`§11.4`): Given an approved, updated plan was exported and printed the day before, when a no-show is marked absent and two guests' seats are swapped in day-of mode, then both actions complete in under a minute each, following normal hard/soft rule behavior, and the printed materials still correctly reflect guests' tables as of when they were printed.

**AC4 — Multi-client isolation across a full lifecycle** (`§7, §1`): Given one planner account, when Wedding A and Wedding B are each fully set up, generated, and approved independently, then at no point does any guest, rule, table, or comment from one appear in the other.
