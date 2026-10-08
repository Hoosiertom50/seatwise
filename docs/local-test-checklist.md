# Seatwise local test checklist

This checklist has two parts:

- **Part 1: Setting up.** For whoever runs the Mac. A few commands in Terminal. About 10 minutes.
- **Part 2: Testing.** For the tester. No Terminal needed, except one small helper for emails, explained step by step.

You test on the Mac in **Chrome, Safari, Firefox and Edge**, and on an **iPhone in Safari** over the same Wi-Fi.

---

# Part 1: Setting up

All commands run in Terminal, in the repo folder (`~/Projects/seatwise`).

### 1. Make the sample data

```
cd ~/Projects/seatwise
pnpm db:local-test-data
```

**Success looks like:** a block of text that starts with "Sample data for the local test is ready". It lists:

- four sign-ins (an email address and a password for each),
- the two sample weddings,
- some ready-made links (RSVP links, a vendor page, a pending invite),
- the iPhone address to use in place of `localhost`.

**Copy that whole block into a note or print it.** This is the tester's "setup sheet". The passwords are not saved anywhere, and every run makes new ones.

You can run it again at any time for a fresh start. It only deletes and remakes the `@demo.seatwise.test` accounts and their weddings. Nothing else in the local database is touched, and it refuses to run against any database except the one on this Mac.

### 2. Build the app

```
pnpm build
```

**Success looks like:** it ends without the word "error" and goes back to the prompt.

### 3. Start the app

```
cd ~/Projects/seatwise/apps/web
EMAIL_TRANSPORT=log pnpm start -H 0.0.0.0 -p 3000 2>&1 | tee ~/seatwise-local-test.log
```

**Success looks like:** a line saying it is ready on port 3000. Leave this Terminal window open.

- If macOS asks whether "node" may accept incoming connections, click **Allow**. The iPhone needs this.
- **No real email is sent to anyone.** Each email is written to this window and to the file `~/seatwise-local-test.log` instead.
- Leave `APP_URL` as `http://localhost:3000` in `apps/web/.env`.
- To stop the app, click in this window and press **Ctrl+C**.

### 4. Check it opens

- On the Mac, open <http://localhost:3000>. You should see the Seatwise home page with **Get started** and **Log in**.
- On the iPhone (same Wi-Fi), open the iPhone address from the setup sheet. It looks like `http://192.168.1.23:3000`. If the setup sheet doesn't show one, run `ipconfig getifaddr en0` and add `:3000` to the number it prints.

### 5. Hand over to the tester

Give the tester:

- the setup sheet from step 1,
- this checklist,
- the Mac (or tell them where it is) with the app running.

**Fresh data between full runs:** the tester runs all of Part 2 once in each browser being tested (Chrome, Safari, Firefox, Edge). Only when a whole run is finished and the next one is about to start, run step 1 again (no need to rebuild or restart) and give the tester the new setup sheet, because the passwords change. Do **not** run it when the tester opens a second browser in the middle of a run for the two-browser steps: that would sign the first browser out and undo the changes made so far.

---

# Part 2: Testing

## What Seatwise is

Seatwise helps a wedding planner build the guest list, set the tables, and say who must or must not sit together. Then it works out a seating plan. The planner can invite helpers (the couple, family, friends) with different levels of access, send each guest a private RSVP link, and give each vendor a private information page.

## Words used in this checklist

| Word | What it means |
|---|---|
| **Wedding** | One event. Everything else (guests, tables, plans) belongs to a wedding. Your dashboard lists every wedding you can see. |
| **Guest** | One line on the guest list. A guest can bring other people. |
| **Party / headcount** | How many people a guest line stands for, including the guest. "Isabel Ortiz (+1)" means a headcount of 2. "Invitations" counts guest lines; "people" counts headcount. |
| **Household** | A family or group name shared by several guests, like "Rivera Family". Shown as "Party / household" on screen. |
| **Plus-ones** | The names of the extra people a guest brings, like "Marco Ortiz". |
| **Side** | Whose side a guest is on. Each wedding names its two sides. The default names are "Bride" and "Groom"; the sample wedding uses "Jamie's side" and "Morgan's side". A guest can also be on "Both". |
| **Table** | A table with a number of seats. |
| **Restricted table** | Only guests on its "required guests" list may sit there (for example the Head Table). |
| **Accessible table** | Wheelchair-accessible. Guests who need accessible seating may only sit at one. |
| **Locked table** | A new plan keeps the people already sitting there and seats nobody new there. (A guest can be locked too: new plans keep them at their table when the rules allow.) |
| **Single-Side-Only table** | Everyone at it is from the same side. Shown as "single-side only". |
| **Purpose table** | A table that "favors" a kind of guest, like children or friends. It's a soft preference only and never blocks anyone. Shown as "favors …". |
| **Seating rules** | Rules about two guests: **Must sit together** and **Must NOT sit together** are hard rules (always followed). **Prefer near (soft)** and **Avoid (soft)** are wishes the plan tries to follow. |
| **Seating plan / plan version** | Who sits at which table. Every time a plan is made, it is saved as a new numbered version (v1, v2, v3…). One version is the **current** plan. |
| **Generate** | The **Generate new plan** button. Seatwise works out a new seating plan. |
| **Approve** | Marks the current plan as final. Steps: Draft → **Move to review** → **Approve**. **Reopen for review** undoes an approval. PDF printouts only work for an approved plan. |
| **Comparison draft** | A plan version that is saved to look at, but does not replace the current plan. |
| **Restore** | Make a new current version that copies an older version's seats. |
| **Day-of mode** | A tab for the wedding day itself: mark no-shows, add walk-ins, move or swap guests quickly. |
| **Walk-in** | A guest who turns up on the day without being on the list. |
| **Access levels** | What a helper may do. **View**: see everything, change nothing. **Comment**: View, plus write comments. **Edit**: change everything. **Owner**: Edit, plus manage who has access and the wedding's settings. Each wedding has one owner. |
| **Couple role** | A helper marked as one of the couple. Only the owner or a Couple member can approve a plan. Other helpers have the role "Collaborator". |
| **Hand-off** | The owner makes someone else the owner. The old owner stays on with Edit access. |
| **Invite** | An email with a link that lets someone join a wedding as a helper. |
| **RSVP link** | A private link for one guest. The guest opens it without signing in and says if they're coming. |
| **Vendor link** | A private, read-only page for one vendor (like the caterer): the date, the timeline, and when the other vendors arrive. Never costs. |
| **Notifications bell** | The 🔔 button at the top right of the dashboard and wedding pages. A red number shows unread notifications. |

## Who you sign in as

Passwords are on the **setup sheet** (from whoever set up the Mac). They change every time the sample data is remade.

| Sign in with | Person | What they can do |
|---|---|---|
| `owner@demo.seatwise.test` | Morgan Ellis | **Owner** of both sample weddings |
| `couple@demo.seatwise.test` | Jamie Rivera | **Couple** member with **Edit** access on Jamie & Morgan's Wedding (can approve plans) |
| `commenter@demo.seatwise.test` | Priya Shah | Helper with **Comment** access on Jamie & Morgan's Wedding |
| `viewer@demo.seatwise.test` | Lee Okafor | Helper with **View** access on Jamie & Morgan's Wedding |

Don't mix up Priya Shah (the commenter account) with **Priya Natarajan**, who is a guest.

## What's already in the sample data

**"Jamie & Morgan's Wedding"**: 11-14-2026 at Lakeside Pavilion. RSVPs close 11-01-2026. Something is on every tab:

- **Guests:** 61 guest lines (68 people). Three need accessible seating (Carmen Delgado, Elena Vargas, Walter Ellis). Four have declined (Grace Kim, Teresa Morales, Benjamin Adams, Brian Cook). Some guests have private notes.
- **Tables (8):** Head Table (Restricted, 8 seats, 6 required guests), Table 1 (accessible), Table 2 (locked), Family Table (single-side only), Kids' Table (favors children), Friends Table (favors friends), Table 3, Table 4.
- **Seating rules (7):** Maya Chen & Priya Natarajan must sit together, Priya Natarajan & Olivia Brooks must sit together, Carmen Delgado & Luis Delgado must sit together, Ethan Clark & Lucas Hall must not sit together, Logan Wright & Jack Turner avoid, Henry Scott & Samuel Green prefer near, Hannah Lee & Jordan Blake prefer near.
- **Plan versions:** v1 "First draft (before the seating rules)"; v2 "Final plan", current and **Approved**; v3, a comparison draft whose name starts with "Comparison:" and says which guest moved. Nora Fitzgerald is locked in her seat.
- **Timeline:** 1:00 PM to 11:30 PM, then "12:30 AM (next day)".
- **Budget:** $35,000. 8 vendors, including "Snap Happy Booth" (category "Photo booth"), "Sweet Layers Bakery" (no cost), and "Midnight Shuttle Co." arriving at 1:30 AM (next day).
- **Comments:** 4 threads (on a guest, a table and a timeline entry), with replies. One is resolved.
- **Links:** RSVP links for Victor Morales, Isabel Ortiz and Hannah Lee (Hannah has already answered). A vendor page for Harvest Table Catering. A pending invite for `new.helper@demo.seatwise.test`. All are on the setup sheet.

**"Taylor & Quinn's Wedding"**: 05-22-2027 at Old Mill Barn. 4 empty tables, no guests. You use it to try importing a guest file.

**Sample guest file:** `docs/sample-guest-import.csv` in the repo folder (`~/Projects/seatwise/docs/`). 20 guests with accents and apostrophes in their names.

## Before you start

- **Dates and times.** Every date anywhere (screens, emails, PDFs) should look like **MM-DD-YYYY**, for example 11-14-2026. Every time should be 12-hour, like **4:30 PM**. Anything else is a bug. (The browser's own date picker may look different; that's the browser, not Seatwise.)
- **Two people at once.** Some tests need two people signed in at the same time. Use two different browsers (for example Chrome and Firefox), or one normal window and one private window.
- **Safari and the Tab key.** Safari skips buttons and links when you press Tab, until you turn on: **Safari → Settings → Advanced → "Press Tab to highlight each item"**.
- **Firefox and the Tab key.** On a Mac, Firefox follows a Mac setting. Turn on: **System Settings → Keyboard → "Keyboard navigation"**.
- **Dark mode.** Mac: **System Settings → Appearance → Dark**. iPhone: **Settings → Display & Brightness → Dark**. Seatwise follows whichever is set.
- **iPhone address.** On the iPhone, use the address from the setup sheet (it looks like `http://192.168.1.23:3000`) instead of `http://localhost:3000`. The same goes for any link the app shows you: replace `localhost` with that number.
- **Tick the boxes** as you go. At the end of each section, write down anything that looked odd, even if it worked.

## Helper: emails and links

Seatwise doesn't send real email during this test. Each email is written to a log file instead. Two things you may need:

**A. See that an email was "sent".**

1. Open the **Terminal** app (press Cmd+Space, type `Terminal`, press Return).
2. Paste this line and press Return:

   ```
   grep email-log ~/seatwise-local-test.log | tail -5
   ```

3. You see the last 5 emails, one per line, each starting with `[email-log]`. Each line shows a hidden address and the subject, for example `subject="Confirm your email for Seatwise"`.

The secret part of every link is shown as `[hidden]` on purpose, so you can't click a link from the log.

**B. Get a working link** (to confirm an email, reset a password, or accept an invite). In Terminal, paste one of these, putting the right email address at the end, and press Return:

| You need | Paste this |
|---|---|
| A "confirm your email" link | `cd ~/Projects/seatwise && pnpm db:local-test-data --confirm-link tester1@demo.seatwise.test` |
| A password-reset link | `cd ~/Projects/seatwise && pnpm db:local-test-data --reset-link owner@demo.seatwise.test` |
| A fresh invite link (the old one stops working) | `cd ~/Projects/seatwise && pnpm db:local-test-data --invite-link new.helper@demo.seatwise.test` |

It prints a link starting with `http://localhost:3000/`. Copy it into the browser you're testing. These links work the same as the ones in the real emails.

## When something isn't as described

Don't try to work around it. Note it and carry on:

1. Take a screenshot (on the Mac: **Cmd+Shift+4**, then drag; on the iPhone: side button + volume up).
2. Write down: the **browser** (or iPhone), the **account** you were signed in as, the **time**, the **section and step number**, and **exactly what you clicked or typed**.
3. Try it once more. Write down whether it happened again. **Something that happens only once still counts.** Write it down anyway.
4. Fill in the bug report template at the end of this checklist.

---

## 1. Sign up, confirm your email, log in, reset password, log out

- [ ] **1.1** Go to `http://localhost:3000` and click **Get started**. Type Name `Test Person`, Email `tester1@demo.seatwise.test`, Password `testing-pass-1`. Click **Create account**.
  You should see: your dashboard ("Your weddings"), with a yellow box saying "Please confirm your email address…" and a **Resend link** button. Using the helper (A), a new line with `subject="Confirm your email for Seatwise"` is in the log.
- [ ] **1.2** Click **Log out** (top right). Click **Get started** again and try each of these, one at a time:
  - Name `Test 123` (digits in the name)
  - Name `www.example.com` (a web address)
  - Password `short` (under 8 characters)
  - Email `tester1@demo.seatwise.test` again (already used)

  You should see: a plain message explaining the problem each time, and no account is made. For the used email: "An account with that email already exists". Also: in any box, keep typing a very long text; at some point the box stops accepting more letters.
- [ ] **1.3** Get a confirm link for `tester1@demo.seatwise.test` (helper B). Open it. Click **Confirm my email**.
  You should see: "Thanks — your email address is confirmed." Click **Go to your dashboard**. The yellow "Please confirm" box is gone.
- [ ] **1.4** Open the same confirm link again and click **Confirm my email**.
  You should see: a message that the link no longer works. Nothing else changes.
- [ ] **1.5** Click **Log out**. Click **Log in**. Type Email `owner@demo.seatwise.test` and a wrong password, like `wrong-password`. Click **Log in**.
  You should see: "Invalid email or password". It doesn't say which one was wrong.
- [ ] **1.6** Log in as `owner@demo.seatwise.test` with the password from the setup sheet.
  You should see: your dashboard.
- [ ] **1.7** Click **Log out**. Click **Log in**, then **Forgot password?**. Type `nobody@demo.seatwise.test` and click **Send reset link**.
  You should see: "There's no Seatwise account for that email. Check the spelling, or sign up instead."
- [ ] **1.8** Now type `owner@demo.seatwise.test` and click **Send reset link**.
  You should see: "We've sent a link to reset your password. It works for 1 hour. Check your spam or junk folder if it doesn't arrive." Using helper A, a new line with `subject="Reset your Seatwise password"` is in the log.
- [ ] **1.9** Go back to **Forgot password?** and ask again for `owner@demo.seatwise.test`.
  You should see: "We've already sent you a link to reset your password, and it still works…". No new reset line appears in the log.
- [ ] **1.10** **Before this step, sign in as `owner@demo.seatwise.test` in a second browser** and leave it open on the dashboard. Then, in the first browser: get a password-reset link for `owner@demo.seatwise.test` (helper B) and open it. Type a new password twice, for example `new-owner-pass-1`, and click **Save new password**. **Write the new password down: you need it for the rest of the test.**
  You should see: the password is saved. Logging in with the old password fails, and the new one works.
- [ ] **1.11** Go to the second browser and click anything (or reload the page).
  You should see: it's signed out (it asks you to sign in again). Changing a password signs out every other device.
- [ ] **1.12** Sign in as the owner in both browsers again. In one, click **Account** (top right of the dashboard), then **Log out on all devices**.
  You should see: both browsers are signed out (the other one on its next click or reload).
- [ ] **1.13** Sign in as the owner in both browsers again. In one, click **Log out**.
  You should see: only that browser is signed out. The other one still works.

## 2. Dashboard

- [ ] **2.1** Sign in as `owner@demo.seatwise.test`.
  You should see: "Your weddings" with both weddings:
  - **Jamie & Morgan's Wedding**: green **Approved** label, "11-14-2026 · Lakeside Pavilion", and "61 invitations · 68 people invited · 64 attending".
  - **Taylor & Quinn's Wedding**: grey **No plan yet** label, "05-22-2027 · Old Mill Barn".
- [ ] **2.2** In **Search weddings**, type `Taylor`.
  You should see: only Taylor & Quinn's Wedding, and "Showing 1 of 2 weddings." Now type `zzz`. You should see: "No weddings match your search/filter." Clear the box.
- [ ] **2.3** Open the plan status list (it says **All plan statuses**). Pick **Approved**, then **No plan yet**.
  You should see: only Jamie & Morgan for Approved; only Taylor & Quinn for No plan yet. Set it back to **All plan statuses**.
- [ ] **2.4** Open the sort list and try each choice: **Sort: Needs attention first**, **Sort: Event date (soonest)**, **Sort: Name (A–Z)**, **Sort: Invitations (most)**, **Sort: Outstanding issues (most)**.
  You should see: the order changes as each name says. For example, Event date (soonest) puts Jamie & Morgan (11-14-2026) first.
- [ ] **2.5** In the form at the top, type Wedding name `Test Wedding`, pick any Date, type Venue `Test Hall`. Click **Add wedding**.
  You should see: the new wedding opens. At the top is a **Getting started** box with numbered steps ("2. Add tables", "3. Add seating rules (optional)", "4. Generate a seating plan"). Click **← Back to dashboard**: Test Wedding is in the list.
- [ ] **2.6** Log out and sign in as `viewer@demo.seatwise.test`.
  You should see: only Jamie & Morgan's Wedding, with a **Shared with you** label. Taylor & Quinn is not there.

## 3. Guests tab

Sign in as `owner@demo.seatwise.test`. Open **Jamie & Morgan's Wedding**. The **Guests** tab opens first.

- [ ] **3.1** Look at the guest list.
  You should see: the heading "Guests (61 invitations · 68 people invited · 64 attending)". Guests on one side show "Jamie's side" or "Morgan's side" under their name (guests on Both show neither). Isabel Ortiz shows "(+1)" and "· with Marco Ortiz". Rosa Rivera shows "Rivera Family".
- [ ] **3.2** In **Add a guest**, type First name `Testy`, Last name `McTest`. Click **+ More details (household, email, notes, headcount, tier, RSVP, side, age, accessibility)**. Type Party / household `Test Family`, Email `testy@demo.seatwise.test`, Notes `Allergic to shellfish`, Headcount `2`. Pick a Tier, RSVP and Side, and tick **Requires an accessible table**. Click **Add guest**.
  You should see: "Added Testy McTest." The guest appears in the list with "(+1)" and an "accessible table" label.
- [ ] **3.3** Add another guest with First name `J0hn` (a zero, not the letter O) and Last name `Smith`.
  You should see: it's refused with a message about the name. No guest is added.
- [ ] **3.4** Find **Testy McTest** in the list. Click into the last-name box, change it to `McTester`, then click somewhere else on the page.
  You should see: the change saves (the top of the page says "All changes saved").
- [ ] **3.5** Find **Victor Morales**. In his RSVP status list, pick **Declined**.
  You should see: a "not attending" label appears on his row. The heading's "attending" number goes down by 1.
- [ ] **3.6** Find **Carmen Delgado**.
  You should see: her private notes box says "Uses a wheelchair." (Later, in section 13, you check that the commenter and viewer can't see it.)
- [ ] **3.7** Find **Hannah Lee**.
  You should see: a green "responded" label, and "Guest's RSVP note: Can't wait! Vegetarian meal, please." This is separate from the private notes box under it.
- [ ] **3.8** On Hannah Lee's row, click **RSVP link**.
  You should see: a message that the link was copied (and emailed to her). Paste it somewhere (Cmd+V): it's the same as Hannah's RSVP link on the setup sheet.
- [ ] **3.9** On Testy McTester's row, click **Remove**.
  You should see: a question "Remove Testy McTester from the guest list? …" with **Yes, remove guest** and **Cancel**. Click **Cancel**: nothing changes. Click **Remove** again, then **Yes, remove guest**: the guest is gone.
- [ ] **3.10** Click **Export guest list (CSV)**.
  You should see: a file `guest-list.csv` downloads. Open it in Numbers or Excel. Names with accents look right, like "Lucía Rivera", "Daniel Gómez" and "Andrew Pérez" (no odd symbols like "Ã").

## 4. Seating rules tab

- [ ] **4.1** Click the **Seating rules** tab.
  You should see: 7 rules, each with two names and its kind, for example "Ethan Clark & Lucas Hall" with "Must NOT sit together".
- [ ] **4.2** In **Add a seating rule**, pick Guest A `Maya Chen`, Guest B `Olivia Brooks`, Rule **Must NOT sit together**. Click **Add rule**.
  You should see: it's refused. The message says Maya Chen and Olivia Brooks must not sit together, but "must sit together" rules (Maya Chen → Priya Natarajan → Olivia Brooks) would always seat them at the same table.
- [ ] **4.3** On the rule "Henry Scott & Samuel Green", click **Remove**, then **Yes, remove rule**.
  You should see: it's gone (6 rules). Now add it back: Guest A `Henry Scott`, Guest B `Samuel Green`, Rule **Prefer near (soft)**, **Add rule**. It's back (7 rules).

## 5. Tables tab

- [ ] **5.1** Click the **Tables** tab.
  You should see: 8 tables, each with labels: Head Table "restricted", Table 1 "accessible", Table 2 "locked", Family Table "single-side only", Kids' Table "favors …" (children), Friends Table "favors …" (friends). Each row shows something like "8/10 seated (2 remaining)".
- [ ] **5.2** On **Head Table**, click **Edit**.
  You should see: **Restricted — only the guests chosen below sit here** is ticked. Exactly these 6 are ticked: Rosa Rivera, Hector Rivera, Margaret Ellis, Richard Ellis, Michael O'Brien, Rachel Price.
- [ ] **5.3** Still in the Head Table form, also tick 3 more guests (for example Diego Ramos, Lily Evans, Zoe Adams). That's 9 people for 8 seats. Click **Save changes**.
  You should see: it's refused with a message about too many people for the seats. Click **Cancel**.
- [ ] **5.4** Click **Quick-create a standard set of tables** to open it. Type How many `2`, Seats each `10`, leave Name prefix as `Table`. Click the **Create 2 … table(s) of 10** button.
  You should see: two new tables, **Table 5** and **Table 6**. No name is used twice.
- [ ] **5.5** On **Table 3**, click **Edit**. Change Seats to `2`. Click **Save changes**.
  You should see: messages naming the guests who no longer fit, each ending "— flagged as Needs Reassignment." Nobody just disappears. Click **Edit** again, set Seats back to `10`, **Save changes**.
- [ ] **5.6** Remove the two new tables: on Table 5, click **Remove**, then **Yes, remove table**. Same for Table 6.
  You should see: both are gone.
- [ ] **5.7** (Mac only.) Click **Floor plan**. Drag two tables to new places. Reload the page and go back to **Tables → Floor plan**.
  You should see: the tables are still where you put them.

## 6. Seating plan tab

- [ ] **6.1** Click the **Seating plan** tab.
  You should see: the **Version** list shows "v2 — Final plan — …, Approved (…)", with a date and 12-hour time. Under it: "Version 2 — …", an **Approved** label, and a count of seated and unassigned guests. There is no **Needs reassignment** list: step 5.5 put Table 3 back to 10 seats, so its guests fit again and their flags are cleared.
- [ ] **6.2** Next to **Export:**, click **Seating chart (PDF)**, then **Guest lookup list (PDF)**, then **Place cards (PDF)**.
  You should see: each one downloads and opens. Names with accents and apostrophes print correctly (for example "Lucía Rivera", "Michael O'Brien"). Any date reads 11-14-2026.
- [ ] **6.3** Click **Compare two versions...**. Pick From `v2 …` and To `v3 …`. Click **Compare**.
  You should see: a summary like "v2 (Final plan) → v3 (Comparison: …): 1 moved, 0 added, 0 removed, … unchanged", and the table lists the guest named in v3's name as moved. (If v3's name says two guests "swapped", you should see 2 moved.) Click **Hide version comparison**.
- [ ] **6.4** In the **Tables** list on this tab, find a guest at Table 3 or Table 4 (not someone in a seating rule). In their **Move to...** list pick another table with room, then click **Move**.
  You should see: "Moved [name] to [table]." An **Undo** button appears.
- [ ] **6.5** Click **Undo**.
  You should see: the guest is back at their first table.
- [ ] **6.6** Try to move **Diego Ramos** to **Head Table** (pick Head Table in his **Move to...** list, click **Move**).
  You should see: it's refused, with a reason saying he isn't on Head Table's list.
- [ ] **6.7** Make sure **Save as comparison draft (don't replace the current version)** is **not** ticked. Click **Generate new plan**.
  You should see: a question first: "This replaces the approved plan. The new version becomes the current plan as a Draft, PDF exports wait until it's approved again, and everyone on the wedding is told." with **Replace the approved plan** and **Cancel**.
- [ ] **6.8** Click **Cancel**.
  You should see: nothing changed. Still v2, Approved.
- [ ] **6.9** Click **Generate new plan** again, then **Replace the approved plan**.
  You should see: a new version (v4) is now current, with a **Draft** label. The guests who were at **Table 2** in v2 are still at Table 2 (it's locked). Nora Fitzgerald is still at her table.
- [ ] **6.10** Click **Move to review**, then **Approve**.
  You should see: the label changes to **In review**, then **Approved**. The PDF export buttons come back.
- [ ] **6.11** Click **Reopen for review** (this undoes the approval).
  You should see: the label goes back to **In review**. Click **Approve** again.
- [ ] **6.12** In the **Version** list, pick `v1 — First draft (before the seating rules) …`.
  You should see: a note that this isn't the current version, and a **Restore version 1...** button.
- [ ] **6.13** Click **Restore version 1...**.
  You should see: a preview first: "Restoring version 1 will create a new version…", how many guests are kept, and (because the current plan is approved) the "This replaces the approved plan…" warning. Nothing has changed yet.
- [ ] **6.14** Click **Confirm restore**.
  You should see: a new version (v5) is current, with "(restored from v1)" in the Version list, and v1's seats. Some guests may be listed as needing fixing, because v1 was made before the seating rules.
- [ ] **6.15** Leave a clean approved plan for the next sections: click **Generate new plan**, then **Move to review**, then **Approve**.
  You should see: the current plan is **Approved** again.

## 7. Day-of mode

- [ ] **7.1** Click the **Day-of mode** tab.
  You should see: **Table occupancy** with a box per table, like "8/10 seated".
- [ ] **7.2** In **Add a walk-in**, type First name `Walker`, Last name `Inn`, Party size `1`, pick a table with room in **Seat at... (optional — can seat later)**. Click **Add walk-in**.
  You should see: "Added walk-in Walker Inn and seated them…". The table's count goes up by 1.
- [ ] **7.3** Add another walk-in: First name `Wanda`, Last name `Later`, Party size `1`, and leave the table list empty. Click **Add walk-in**.
  You should see: "Added walk-in Wanda Later — not yet seated." In **Find a guest**, type `Wanda`: her row has a **Seat at...** list.
- [ ] **7.4** In **Swap two guests' tables**, pick a guest in **First guest...** and a guest at another table in **Second guest...**. Click **Swap**.
  You should see: the two guests have changed tables.
- [ ] **7.5** In **Find a guest**, type `Diego`. On Diego Ramos's row, click **Mark not attending**.
  You should see: his row says "Not attending" and his table's count goes down by 1. Go to the **Seating plan** tab: it shows **Modified since approval** with the time of the first and latest change.
- [ ] **7.6** Back in **Day-of mode**, click **Mark attending** on Diego Ramos to undo it.
- [ ] **7.7** On the iPhone, sign in as the owner and do 7.1 to 7.6 again (use different walk-in names, like `Ivy Phone`).
  You should see: everything works by tapping, nothing is cut off.

## 8. Timeline tab

- [ ] **8.1** Click the **Timeline** tab.
  You should see: entries in time order from "1:00 PM Hair and makeup done" to "11:30 PM Last dance", then "12:30 AM (next day) Last shuttle leaves for the hotel" last.
- [ ] **8.2** In **Add a timeline entry**, set Time to 4:00 PM, type Event `Guests take their seats`. Click **Add to timeline**. Add one more at 4:00 PM: `Music starts`.
  You should see: three entries at 4:00 PM ("Ceremony begins" and your two), next to each other.
- [ ] **8.3** On one of the 4:00 PM entries, click the **↑** or **↓** arrow.
  You should see: it moves up or down among the 4:00 PM entries only. Arrows that would leave the 4:00 PM group can't be clicked.
- [ ] **8.4** On `Music starts`, click **Edit**. Change the text to `Music starts softly`. Click **Save**.
  You should see: the new text. Then click **Remove** on both of your entries, then **Yes, remove entry**.

## 9. Budget tab and vendors

- [ ] **9.1** Click the **Budget** tab.
  You should see: **Budget** $35,000.00, **Recorded so far** $27,550.00, **Remaining** $7,450.00. Sweet Layers Bakery shows "No cost set" and doesn't break the totals.
- [ ] **9.2** Look at the vendor list.
  You should see: vendors in name order. Snap Happy Booth's category says "Photo booth". Midnight Shuttle Co. says "Arrives 1:30 AM (next day)". Lakeside Pavilion's phone is "317-555-0199 ext. 4".
- [ ] **9.3** In **Add a vendor**, type Vendor name `Test Vendor`, pick Category **Other**, and leave **Category label** empty. Click **Add vendor**.
  You should see: it's refused and asks for a category label.
- [ ] **9.4** Type Category label `Balloons`, Contact phone `317-555-0199 ext. 4`. Click **Add vendor**.
  You should see: it's added, with category "Balloons".
- [ ] **9.5** On Test Vendor, click **Edit**. Change Contact phone to `call-me-maybe`. Click **Save**.
  You should see: it's refused with a message about the phone number. Click **Cancel**. Then click **Remove**, **Yes, remove vendor**.
- [ ] **9.6** On **Harvest Table Catering**, click **Share link**.
  You should see: "Link copied: …". Paste it (Cmd+V) somewhere: it's the same as the vendor page link on the setup sheet. Keep it for section 10.

## 10. Vendor page (no sign-in needed)

- [ ] **10.1** Open a **private window** (Chrome: Cmd+Shift+N; Safari/Firefox: Cmd+Shift+N or Cmd+Shift+P). Open the Harvest Table Catering vendor link from the setup sheet.
  You should see:
  - the wedding name, "11-14-2026 · Lakeside Pavilion",
  - **Your details**: Harvest Table Catering (Catering), Arrival 2:00 PM, Contact Dana Hughes, an email and the phone "(317) 555-0142",
  - **Timeline**: the same entries as the Timeline tab, ending with 12:30 AM (next day),
  - **Other vendors**: in arrival order, with Midnight Shuttle Co. at "Arrives 1:30 AM (next day)" after the evening ones.
  - **No costs, no contract notes and no guest names anywhere.**
- [ ] **10.2** Back in the owner's window, on Harvest Table Catering click **New link**, then **Yes, make a new link**.
  You should see: "New link — the old one no longer works." Reload the vendor page in the private window: it says "This link is no longer active".
- [ ] **10.3** Open the new link (paste it) in the private window: it works. In the owner's window click **Turn off link**, then **Yes, turn it off**. Reload the private window.
  You should see: "This link is no longer active".
- [ ] **10.4** Do 10.1 on the iPhone too (with a fresh link from **Share link**, and `localhost` replaced by the iPhone address).
  You should see: easy to read without zooming, nothing cut off.

## 11. Guest RSVP page (no sign-in needed)

- [ ] **11.1** In a private window, open **Victor Morales's** RSVP link from the setup sheet.
  You should see: the wedding name, 11-14-2026, and "Hi Victor — please let us know if you'll be able to join us." No other guest's name or details anywhere.
- [ ] **11.2** Click **Joyfully attending**. In **Dietary restrictions or anything else we should know**, type `No mushrooms, please`. Click **Submit RSVP**.
  You should see: "Thanks — your RSVP has been recorded. You can come back to this link to change it until 11-01-2026."
- [ ] **11.3** In the owner's browser, click the 🔔 bell.
  You should see: a new unread notification about Victor Morales's RSVP. On the **Guests** tab, Victor shows **Confirmed**, a "responded" label, and his note. (In section 3 you set him to Declined; his own answer replaces that.)
- [ ] **11.4** Open **Isabel Ortiz's** RSVP link. Click **Joyfully attending**.
  You should see: **Total in your party (including you)** and **Who's coming with you?**. Try a party of `3`: you can't go above 2 ("Your invitation is for up to 2 people.").
- [ ] **11.5** Open **Hannah Lee's** RSVP link.
  You should see: her earlier answer already filled in: attending, with "Can't wait! Vegetarian meal, please."
- [ ] **11.6** On Hannah's page, click **Regretfully declining** and **Submit RSVP**.
  You should see: a thank-you message. In the owner's browser: the bell has a new notification, and on the **Day-of mode** tab Hannah is "Not attending" and her seat is freed. Then change her back: open her link again, **Joyfully attending**, **Submit RSVP**.
- [ ] **11.7** Owner: go to the **Collaborators** tab. Find **RSVP cutoff**. Set the date to **two days ago**, then click somewhere else on the page.
  You should see: a warning that the date is in the past, ending "Save [the date] anyway?", with the date shown as MM-DD-YYYY. Click **Save anyway**.

  (Use two days ago, not yesterday. RSVPs stay open until the cutoff day has ended everywhere in the world, so yesterday's date may still be open in the morning.)
- [ ] **11.8** Reload Victor's RSVP link.
  You should see: "RSVP responses have closed (the deadline was [date])", with the date as MM-DD-YYYY. His answer is shown but can't be changed.
- [ ] **11.9** Put the cutoff back: on **Collaborators**, set **RSVP cutoff** to 11/01/2026 and click somewhere else. Reload Victor's link: it's open again.
- [ ] **11.10** Do 11.1 and 11.4 on the iPhone (with `localhost` replaced by the iPhone address).
  You should see: easy to read and tap, nothing cut off.

## 12. Comments and notifications

- [ ] **12.1** As the owner, click the **Comments** tab.
  You should see: 4 threads: on **Elena Vargas** (about the restrooms), on **Kids' Table** (marked **Resolved**), on **Ethan Clark**, and on the **Ceremony begins** timeline entry. Each shows the author's name and a date and time like "10-08-2026, 9:15 AM".
- [ ] **12.2** In a second browser, sign in as `commenter@demo.seatwise.test` (Priya Shah) and open Jamie & Morgan's Wedding → **Comments**. On the Elena Vargas thread, click **Reply**, type `Thanks, that works.`, click **Reply**.
  You should see: the reply appears under the thread. In the owner's browser, the bell's red number goes up within a few seconds. Using helper A, new `[email-log]` lines appear (one for each person who gets email).
- [ ] **12.3** As Priya, look for **Resolve** buttons.
  You should see: **Resolve** only on threads Priya started herself (Kids' Table is already resolved; the Ethan Clark one is hers). Not on threads others started.
- [ ] **12.4** As the owner, click **Resolve** on the Ethan Clark thread.
  You should see: it's marked **Resolved**. (The owner and Edit helpers can resolve any thread.)
- [ ] **12.5** Sign in as `viewer@demo.seatwise.test` in the second browser, open the wedding → **Comments**.
  You should see: all threads, but no **Add a comment** form, no **Reply** and no **Resolve** buttons.
- [ ] **12.6** As the owner, click the 🔔 bell.
  You should see: the red number matches the number of highlighted (unread) items. Each item says what happened and "· Jamie & Morgan's Wedding", with a date and 12-hour time. Click one unread item: it's no longer highlighted and the number goes down by 1. Click **Mark all read**: the red number disappears.
- [ ] **12.7** As the owner, go to **Collaborators** and untick **Email me about this wedding**. In the second browser (as Priya), reply to any thread.
  You should see: the owner's bell still gets the new notification, but using helper A, no new email line for the owner appears. Tick **Email me about this wedding** again afterwards.

## 13. Helpers and access levels (two browsers)

Keep the owner in browser 1. Use browser 2 for the other accounts.

- [ ] **13.1** Browser 2: sign in as `viewer@demo.seatwise.test` (Lee). Open the wedding and click through every tab.
  You should see: "Your access: View" next to the date. Everything is visible, but no add, edit, remove or comment controls anywhere (for example "You have view-only access to this wedding's guest list…"). On **Guests**, Carmen Delgado shows no private note.
- [ ] **13.2** Browser 2: change the address to the Taylor & Quinn wedding. (In browser 1, open Taylor & Quinn and copy its address from the address bar; paste it into browser 2.)
  You should see: Lee can't see it ("Wedding not found.").
- [ ] **13.3** Browser 2: sign in as `commenter@demo.seatwise.test` (Priya Shah).
  You should see: "Your access: Comment". She can add and reply to comments. She can't add or change guests, tables, rules or plans. No private guest notes.
- [ ] **13.4** Browser 2: sign in as `couple@demo.seatwise.test` (Jamie).
  You should see: "Your access: Edit". Jamie can edit guests and tables, and on **Seating plan** can approve and reopen a plan. On **Collaborators**, Jamie sees no invite form and no wedding settings (no wedding note, no RSVP cutoff).
- [ ] **13.5** Browser 2: sign in as Lee (viewer) and leave the **Guests** tab open. Browser 1 (owner): **Collaborators** tab, find Lee Okafor, change his **Access level** to **Comment**.
  You should see: in browser 2, within about 5 seconds and without reloading, a yellow note "Your access to this wedding was changed to Comment." and the comment controls appear on the Comments tab. Change Lee back to **View**.
- [ ] **13.6** Browser 1: on **Collaborators**, look at **Pending invites**.
  You should see: `new.helper@demo.seatwise.test` · Collaborator · Edit, with a **Revoke** button.
- [ ] **13.7** Browser 2: log out. Click **Get started** and sign up with Name `New Helper`, Email `new.helper@demo.seatwise.test`, Password `helper-pass-1`. Get a confirm link for that address (helper B), open it, click **Confirm my email**.
- [ ] **13.8** Browser 2: open the pending invite link from the setup sheet.
  You should see: the wedding name and that you're invited as a collaborator with edit access. Click **Accept invite**. You end up in the wedding with "Your access: Edit". In browser 1, New Helper is now in the collaborator list.
- [ ] **13.9** Browser 2 (New Helper): **Seating plan** tab. Make sure the current plan shows **Approved** (if not, approve it as the owner first). Click **Generate new plan**.
  You should see: "The plan is approved, so this was saved as a comparison draft — only the owner or a Couple member can replace an approved plan." The approved plan is still current.
- [ ] **13.10** Browser 1: in **Invite a collaborator**, type Email address `invite.test@demo.seatwise.test`, Role **Collaborator**, Access level **View**. Click **Send invite**.
  You should see: "Invite sent…" and it's under **Pending invites**. Get its link (helper B, `--invite-link invite.test@demo.seatwise.test`). Then click **Revoke**, **Yes, revoke invite**. Open the link.
  You should see: "This invite link is no longer active…".
- [ ] **13.11** Browser 2: as New Helper, open the wedding. Browser 1: on New Helper's row, click **Remove**, then **Yes, remove access**.
  You should see: in browser 2, within about 5 seconds: "This wedding is no longer available (it may have been deleted, or your access was removed)." and "Taking you back to your dashboard...".

## 14. Hand-off

First, in browser 2: log out, sign in as `couple@demo.seatwise.test` (Jamie), open **Jamie & Morgan's Wedding** and click the **Collaborators** tab. Leave it open there.

- [ ] **14.1** Browser 1 (owner): **Collaborators** tab, **Hand off this wedding**. In **New owner**, pick **Jamie Rivera**. Click **Hand off**.
  You should see: the question names Jamie: "Make Jamie Rivera the owner of this wedding? You'll stay on as a collaborator with Edit access. Only the new owner can undo this." It **also** says: "Your private wedding note will be visible to the new owner — clear it first if it's only for you."
- [ ] **14.2** Click **Yes, hand it off**.
  You should see: in browser 1, Morgan now has "Your access: Edit" and the owner sections are gone. In browser 2 (signed in as Jamie, on the Collaborators tab), within a few seconds and without switching tabs, Jamie has the owner sections, and the wedding note says "Owner-only note: venue balance due 10-30-2026. Keep the head table to 8." Jamie's bell has a "Now yours" notification.
- [ ] **14.3** Browser 2 (Jamie): hand it back to **Morgan Ellis** the same way.
  You should see: Morgan is the owner again.
- [ ] **14.4** Browser 1 (Morgan): on **Collaborators**, Jamie Rivera's **Role** now says Collaborator. Set it back to **Couple**.

## 15. Wedding settings open in two tabs

- [ ] **15.1** As the owner, open the wedding's **Collaborators** tab in **two tabs of the same browser** (call them tab A and tab B).
- [ ] **15.2** Tab B: in **Date and venue**, change **Venue** to `Lakeside Pavilion North`. **Don't** click save yet.
- [ ] **15.3** Tab A: change **Venue** to `Lakeside Pavilion East` and click **Save date and venue**.
- [ ] **15.4** Tab B: wait 5 seconds, then click **Save date and venue**.
  You should see: "This wedding's settings changed since you opened them (maybe in another tab) — showing the latest. Your change wasn't saved; make it again if it's still needed." The Venue box shows `Lakeside Pavilion East`.
- [ ] **15.5** Set **Venue** back to `Lakeside Pavilion` and click **Save date and venue**. Close tab B.

## 16. Importing guests (Taylor & Quinn's Wedding)

- [ ] **16.1** As the owner, open **Taylor & Quinn's Wedding**. On **Guests**, find **Bulk import guests (CSV)**. Click the file button and choose `sample-guest-import.csv` (in `~/Projects/seatwise/docs/`).
  You should see: "sample-guest-import.csv — map columns to guest fields:" and every list already picked: First name → First Name, Last name → Last Name, Party / household → Household, Headcount, Tier, RSVP status, accessible table, Attendance, Side, Age category, Notes, Plus-ones. Only Guest ID, Side code and Version say "— not in file —".
- [ ] **16.2** Click **Preview import**.
  You should see: "20 new, 0 updating, 0 with errors (of 20 row(s))." Every name looks exactly like the file, for example José Álvarez, Zoë Müller-Schmidt, Siobhán O'Brien, Łukasz Wróbel, Thị Lan Nguyễn, Liam Ó Súilleabháin.
- [ ] **16.3** Click **Confirm import (20 guest(s))**.
  You should see: "Import complete: 20 guest(s) added, 0 updated." The list has 20 guests. Jean-Luc St. Pierre and Øyvind Hågensen show "not attending". José Álvarez's note reads "Vegetarian, no nuts" (with the comma).
- [ ] **16.4** Choose the same file again and click **Preview import**.
  You should see: "20 new" again. Guests are only matched by Guest ID, never by name. Click **Cancel**. Nothing is added.
- [ ] **16.5** Click **Export guest list (CSV)**. Open the file, change one first name (for example `Kai` to `Kailani`), and save it as CSV. Import that file.
  You should see: the **Guest ID** list is picked automatically. Preview says "0 new, 1 updating…" and the other rows "unchanged". Confirm: Kai is now Kailani.
- [ ] **16.6** Go to **Seating plan** and click **Generate new plan**.
  You should see: a first plan (v1, Draft) with everyone attending seated across Table 1 to Table 4 and "0 unassigned".

## 17. Activity tab

- [ ] **17.1** Open Jamie & Morgan's Wedding → **Activity**.
  You should see: the changes you made today, newest first, each with a name and a date and 12-hour time.

## 18. Phone layout (iPhone, and a narrow Mac window)

On the iPhone, sign in as the owner. On the Mac, also drag a browser window as narrow as it goes.

- [ ] **18.1** Open every tab of Jamie & Morgan's Wedding, the dashboard and **Account**.
  You should see: the page never scrolls sideways. Long lists and tables scroll inside their own box. Buttons are big enough to tap. The tab row scrolls sideways on its own.
- [ ] **18.2** Fill in the forms: **Add a guest**, **Add a vendor**, **Add a timeline entry**.
  You should see: the keyboard never hides the box you're typing in. The **Email** boxes bring up the email keyboard (with @).
- [ ] **18.3** Open the **Log in** page, an RSVP link and the vendor link.
  You should see: comfortable to read without zooming.
- [ ] **18.4** Open the 🔔 bell.
  You should see: the list fits on the screen.
- [ ] **18.5** Turn the iPhone sideways and back on a few pages.
  You should see: nothing breaks or overlaps.

## 19. Keyboard only: the Tab key

Set up Safari and Firefox first (see "Before you start"). Use only the keyboard: **Tab** moves forward, **Shift+Tab** moves back, **Return** or **Space** presses a button.

- [ ] **19.1** On each of these, click in the address bar and press Tab again and again: **Log in**, **Get started** (sign up), **Add a guest** (with **+ More details** open), a table's **Edit** form, **Add a vendor**, and an RSVP link page.
  You should see: focus goes from top-left, to the right, then down, like reading a page. A clear outline always shows where you are. Nothing is skipped. Focus never lands on something you can't see.
- [ ] **19.2** On the wedding page, Tab to the row of tabs and press the **right arrow** and **left arrow**.
  You should see: you move between tabs (Guests, Seating rules, Tables…).
- [ ] **19.3** Open a question with the keyboard: **Remove** on a guest, and **Hand off**. Press **Escape**.
  You should see: the question closes, nothing changes, and the outline is back on the button you started from. Open it again and press Return on **Cancel**: same result.

## 20. Dark mode

- [ ] **20.1** Switch the Mac and the iPhone to Dark. Look at the dashboard, every tab of the wedding, **Log in**, **Account**, an RSVP page, the vendor page, the bell list and the questions (Remove, Hand off).
  You should see: everything is readable. No bright white boxes, no invisible text, and the Tab-key outline is still visible.
- [ ] **20.2** In dark mode, download the three seating plan PDFs.
  You should see: normal PDFs with a white background.

---

## When you're done

- Tell whoever set up the Mac. They stop the app (Ctrl+C in its Terminal window).
- The sample data only lives on this Mac. Running `pnpm db:local-test-data` again gives fresh data.
- The log file `~/seatwise-local-test.log` only holds hidden addresses and hidden links. Delete it when it's no longer needed.

---

## Bug report template

Copy this for each problem:

```
Title: (one line: what went wrong, where)

Browser / device: (e.g. Safari 18 on Mac, or iPhone Safari)
Account:          (e.g. owner@demo.seatwise.test)
Time:             (MM-DD-YYYY, h:mm AM/PM)
Checklist step:   (e.g. 6.9)

What I did:
1.
2.
3.

What I expected:  (copy the "You should see" text)

What happened:

Did it happen again when I tried once more?  Yes / No / Didn't try

Screenshot(s):    (attach)
```
