# Local test checklist (production build)

A hands-on pass over Seatwise running as a production build on your Mac. Test it in Chrome, Safari, Firefox and Edge on the Mac, and in Safari on your iPhone over Wi-Fi.

Every date in the app, its emails and its PDFs should read MM-DD-YYYY, with 12-hour times ("4:30 PM"). Anything else is a finding. So is anything that happens only once and can't be repeated: note the browser, the account, the time and what you clicked.

---

## 1. Starting it up

The lead normally does this part. It's written down so you can restart it yourself.

All commands run from the repo folder (`~/Projects/seatwise`).

1. **Get the sample data and passwords.**

   ```
   pnpm db:local-test-data
   ```

   This prints four sign-ins (email + password), the two weddings, some ready-made links, and where the sample guest file is. **Keep that terminal output.** The passwords aren't saved anywhere, and every run makes new ones.

   You can run it again at any time for a fresh start. It deletes only the `@demo.seatwise.test` accounts and their weddings, then makes them again. Nothing else in your local database is touched, and it refuses to run against anything except the database on this Mac.

2. **Build the app.**

   ```
   pnpm build
   ```

3. **Start it so the iPhone can reach it**, with emails printed instead of sent:

   ```
   cd apps/web
   EMAIL_TRANSPORT=log pnpm start -H 0.0.0.0 -p 3000 2>&1 | tee ~/seatwise-local-test.log
   ```

   - `-H 0.0.0.0` lets other devices on your Wi-Fi reach it. If macOS asks whether "node" may accept incoming connections, click **Allow**.
   - `EMAIL_TRANSPORT=log` means **no email is sent to anyone**. Each email is printed in this terminal as a line starting with `[email-log]`, and the same lines are saved in `~/seatwise-local-test.log`.
   - Leave `APP_URL` as `http://localhost:3000` in `apps/web/.env`. A production build only accepts `localhost` for a plain-`http` address.
   - To stop the server, press Ctrl+C.

4. **Open it.**
   - **On the Mac:** go to <http://localhost:3000>.
   - **On the iPhone:** use the same Wi-Fi as the Mac and go to `http://<Mac's address>:3000`. The data script prints the exact address. You can also get it with `ipconfig getifaddr en0` (it looks like `192.168.1.23`).
   - Links the app shows or prints (RSVP, vendor, invite links) start with `http://localhost:3000`. On the iPhone, swap `localhost` for the Mac's address.

### Reading the emails

- **See the emails:** run `grep email-log ~/seatwise-local-test.log`, or watch the server terminal.
- **What's hidden:** this is a production build, so the log hides the secret part of every link (`/reset-password/[hidden]`) and masks the address. This is on purpose: real server logs must never hold a working link.
- **Getting a working link:** when you need to actually click one, ask the data script for a fresh link (run these from the repo folder):

  | You need | Run |
  |---|---|
  | Confirm-your-email link | `pnpm db:local-test-data --confirm-link <email>` |
  | Password-reset link | `pnpm db:local-test-data --reset-link <email>` |
  | Invite link (replaces the pending invite's link, like "resend") | `pnpm db:local-test-data --invite-link <email>` |

  These make the same kind of link the email carries, and they work for any account in the local database, including ones you sign up yourself.

### Tips for the browsers

- **Two people at once:** for collaborator tests, use two different browsers (say Chrome as the owner and Firefox as the viewer), or one normal and one private window.
- **Safari and the Tab key:** Tab skips links and buttons in Safari until you turn on Safari → Settings → Advanced → "Press Tab to highlight each item".
- **Firefox and the Tab key:** Firefox on the Mac follows System Settings → Keyboard → "Keyboard navigation". Turn it on.
- **Dark mode:** use System Settings → Appearance on the Mac, and Settings → Display & Brightness on the iPhone. The app follows whichever is set.

---

## 2. What the sample data contains

| Account | Who | Access |
|---|---|---|
| `owner@demo.seatwise.test` | Morgan Ellis | Owner of both weddings |
| `couple@demo.seatwise.test` | Jamie Rivera | Couple member, Edit (can approve plans) |
| `commenter@demo.seatwise.test` | Priya Shah | Collaborator, Comment |
| `viewer@demo.seatwise.test` | Lee Okafor | Collaborator, View |

All four are already confirmed. Passwords are in the script's output.

**"Jamie & Morgan's Wedding"** (11-14-2026 at Lakeside Pavilion, RSVP cutoff 11-01-2026) has something on every tab:

- **Guests:** 61 guests (68 people) on "Jamie's side", "Morgan's side" and both. Some households, plus-ones, every tier and age group, 3 guests needing accessible seating, 4 declined (and Not attending), several pending. Some guests have email addresses and private notes.
- **Tables (8):**
  - Head Table: Restricted, with 6 required guests
  - Table 1: accessible
  - Table 2: locked
  - Family Table: Single-Side-Only
  - Kids' Table: Purpose = children
  - Friends Table: Purpose = Friend tier
  - Table 3 and Table 4: plain
- **Seating rules:** a "must sit together" chain (Maya → Priya → Olivia), Carmen and Luis together, Ethan and Lucas must not sit together, Logan avoids Jack, and two "prefer near" pairs.
- **Plans:**
  - Plan 1 is an older draft, made before the rules.
  - Plan 2, "Final plan", is current and **Approved**.
  - Plan 3 is a comparison draft with one guest moved; its label says who.
  - Nora Fitzgerald is locked in her seat.
- **Timeline:** 1:00 PM to 11:30 PM, plus "12:30 AM (next day)".
- **Vendors and budget:**
  - 8 vendors, including an "Other" (Photo booth) and one with no cost.
  - Arrival times, including the shuttle at 1:30 AM, which shows as the next day.
  - The caterer has a share link.
  - Budget is $35,000.
- **Comments:** threads on a guest, a table and a timeline entry, with replies; one thread is resolved.
- **Notifications:** each account has some from the comments and from an RSVP. One of the owner's is already read.
- **Links and invites:**
  - RSVP links for Hannah Lee (already answered), Victor Morales, Isabel Ortiz and Mason Young.
  - A pending invite for `new.helper@demo.seatwise.test` (Edit).

**"Taylor & Quinn's Wedding"** (05-22-2027) has 4 empty tables and no guests. Use it for Import and Generate from scratch.

**Sample guest file:** `docs/sample-guest-import.csv` has 20 rows with tricky but valid names (José Álvarez, Siobhán O'Brien, Zoë Müller-Schmidt, Łukasz Wróbel, Ó Súilleabháin…), a quoted note with a comma, households, plus-ones, an infant and two declined guests.

---

## 3. Checklists

Tick each item per browser. The iPhone column only needs the layout and touch items. At the end of each section, note anything that looked off, even if it worked.

### A. Sign up, confirm, sign in, reset, log out

- [ ] **Sign up** with a new address such as `tester1@demo.seatwise.test` (your sign-ups on that domain are cleaned up by the next data run).
  You should see: you're signed in on your dashboard, with a note asking you to confirm your email. A `[email-log]` line with the subject "Confirm your email for Seatwise" appears in the log.
- [ ] **Sign-up form rules:** try a name with digits or a web address, a short password (under 8), and an address already in use.
  You should see: a plain message by the box at fault, and nothing is created. Boxes stop accepting typing at their limit.
- [ ] **Confirm:** run `--confirm-link tester1@demo.seatwise.test` and open the link.
  You should see: the email is confirmed and the note on the dashboard is gone. Opening the same link again says it no longer works.
- [ ] **Sign in and out:** log out, then sign in with a wrong password, then the right one.
  You should see: a wrong password gets a general "email or password is wrong" style message that doesn't say which one. The right one takes you to the dashboard.
- [ ] **Forgot password:** use "Forgot password" for `owner@demo.seatwise.test`.
  You should see: a neutral "if that account exists we've sent a link" message and a reset email line in the log. Then run `--reset-link owner@demo.seatwise.test`, open the link and set a new password. You can sign in with the new one, and the old one fails. **Write the new password down.**
- [ ] **Reset logs out other devices:** sign in as the owner in two browsers, then reset the password in one.
  You should see: the other browser is signed out on its next click or refresh.
- [ ] **Log out on all devices** (on Your account), with the owner signed in in two browsers.
  You should see: both are signed out. "Log out" alone signs out only that browser.
- [ ] **Asking too often:** ask for several resets for the same address quickly.
  You should see: after a few, a polite "try again later" message. That's the limit working, not a bug.

### B. Dashboard

- [ ] Sign in as the owner.
  You should see: both weddings, with dates as 11-14-2026 and 05-22-2027. Jamie & Morgan shows Approved and 61 guests; Taylor & Quinn shows "No plan yet".
- [ ] Try search, the plan-status filter and every Sort option.
  You should see: the list changes as expected. A search that matches nothing says so.
- [ ] Sign in as the viewer.
  You should see: only Jamie & Morgan, since the viewer has no access to Taylor & Quinn.
- [ ] Create a wedding.
  You should see: it appears on the dashboard and opens with its Getting started help.

### C. Guests tab

- [ ] As the owner, open Jamie & Morgan → Guests.
  You should see: all 61 guests. Sides show as "Jamie's side" / "Morgan's side" / Both, and plus-ones and households are visible.
- [ ] Add a guest with "more details" (side, tier, age, email, note, accessible).
  You should see: they're saved and appear in the list. Wrong characters in a name are refused with a message.
- [ ] Edit a guest. Then change Victor Morales to Declined.
  You should see: the edit saves. Declining also makes him Not attending, and his seat is freed (Tom's decision).
- [ ] Private notes: open Carmen Delgado.
  You should see: the note "Uses a wheelchair." as the owner. As the commenter or viewer, the note isn't shown.
- [ ] RSVP link: open Hannah Lee's row.
  You should see: her RSVP answer and her own note ("Can't wait! Vegetarian meal, please."), kept separate from the planner's note. The "RSVP link" button shows the same link the script printed.
- [ ] Delete a guest.
  You should see: a confirmation first, then they're gone, and the seating plan is updated.
- [ ] Export the guest list.
  You should see: a CSV whose accented names look right when opened in Numbers or Excel.

### D. Seating rules tab

- [ ] Look at the list of rules.
  You should see: all 7 rules, in plain words.
- [ ] Add "must not sit together" for Maya Chen and Olivia Brooks.
  You should see: it's refused, with a message explaining the "must sit together" chain through Priya.
- [ ] Delete a rule, then add it back.

### E. Tables tab

- [ ] Look at the 8 tables.
  You should see: each one's features: accessible, Restricted, locked, Single-Side-Only and Purpose.
- [ ] Head Table's required guests.
  You should see: Rosa, Hector, Margaret, Richard, Michael O'Brien and Rachel Price. Adding guests past the seat count is refused.
- [ ] Quick-create 2 tables.
  You should see: they're numbered after the existing ones, with no duplicate names.
- [ ] Edit a table's seat count below the people seated there.
  You should see: a clear message, or the affected guests flagged Needs Reassignment, never silent loss.
- [ ] Drag tables on the floor plan (Mac) and check they stay put after a refresh.

### F. Seating plan: Generate, approve, replace, restore, compare, undo

- [ ] Open Seating plan.
  You should see: plan 2, "Final plan", Approved and current, with every attending guest seated.
- [ ] Use each of the three PDF exports (seating chart, guest lookup list, place cards).
  You should see: each downloads and opens. Names with accents and apostrophes print correctly, and the date reads 11-14-2026.
- [ ] As the owner, click Generate.
  You should see: a prompt first saying this replaces the approved plan. Cancel changes nothing. Confirm makes a new current Draft, and Table 2's guests stay at Table 2 because it's locked.
- [ ] Approve the new plan, then undo the approval.
- [ ] Move a guest to another table, then click Undo.
  You should see: the guest goes back.
- [ ] Moving a guest into Head Table (Restricted) when they're not on its list.
  You should see: it's refused with a reason.
- [ ] Compare plan 2 with plan 3.
  You should see: exactly the one guest named in plan 3's label, shown as moved.
- [ ] Restore plan 1.
  You should see: a preview first (including the "replaces the approved plan" warning if the current plan is approved). After restoring, a new version with plan 1's seats becomes current.
- [ ] Generate in Taylor & Quinn after importing guests (see I).
  You should see: everyone seated across the 4 tables.

### G. Day-of mode

- [ ] Open Day-of mode.
  You should see: table occupancy for the current plan.
- [ ] Add a walk-in, first with a table and then without one.
  You should see: they appear in the guest list, either seated or waiting for a seat.
- [ ] Swap two guests' tables.
- [ ] Mark a seated guest Not attending.
  You should see: their seat frees up. If the plan was approved, it shows "Modified since approval".
- [ ] Try all of the above on the iPhone too.

### H. Timeline, Budget and vendors

- [ ] Timeline.
  You should see: the entries in order, from 1:00 PM to 11:30 PM, then "12:30 AM (next day)" last.
- [ ] Add, edit and reorder entries that share the same time.
- [ ] Budget.
  You should see: a $35,000 budget against the vendor costs. The bakery has no cost and doesn't break the totals.
- [ ] Vendor categories.
  You should see: "Photo booth" shown for the Other vendor.
- [ ] Vendor arrival times.
  You should see: the shuttle at "1:30 AM (next day)", listed after the day's arrivals.
- [ ] Add a vendor with category Other but no label.
  You should see: it's refused.
- [ ] Try a phone number like "317-555-0199 ext. 4" (accepted) and one with letters (refused).
- [ ] Get, copy and then regenerate the caterer's share link.
  You should see: the old link stops working.

### I. Import (Taylor & Quinn's Wedding)

- [ ] Guests → Import → choose `docs/sample-guest-import.csv`.
  You should see: every column picked automatically (First Name, Last Name, Household, … Plus-ones).
- [ ] Preview.
  You should see: 20 new rows and 0 errors, with every accent, apostrophe and hyphen shown exactly as in the file.
- [ ] Import.
  You should see: 20 guests added. The two declined guests are Not attending.
- [ ] Import the same file again.
  You should see: the rows show as new again, because rows only match existing guests by Guest ID (never by name). Cancel it.
- [ ] Export, change a name in the file, and re-import with Guest ID mapped.
  You should see: it shows as 1 update.

### J. Collaborators, access levels and invites (two browsers)

- [ ] **Viewer** (Lee, second browser).
  You should see: every tab, but no edit or comment controls. Guest notes are hidden. Opening Taylor & Quinn's address directly shows no access.
- [ ] **Commenter** (Priya).
  You should see: she can comment and reply, but can't edit guests, tables or plans.
- [ ] **Couple member** (Jamie).
  You should see: Jamie can edit and can approve or undo approval. Jamie can't see Collaborators management or the owner-only wedding note.
- [ ] **Owner changes access live:** with the viewer's page open, change Lee to Comment.
  You should see: on refresh or next action, Lee has Comment access. If Lee's change was in flight, it says "your access changed" and saves nothing.
- [ ] **Pending invite:**
  You should see: `new.helper@demo.seatwise.test` listed as pending.
  1. In a second browser, sign up as that address.
  2. Confirm it with `--confirm-link`.
  3. Open the invite link (`--invite-link new.helper@demo.seatwise.test`) and accept.

  You should see: they join with Edit access.
- [ ] **Edit collaborator who isn't Couple:** as new.helper, click Generate while the plan is approved.
  You should see: the plan is saved as a comparison draft, with a note saying only the owner or a Couple member can replace an approved plan.
- [ ] Invite an address, then revoke the invite.
  You should see: the revoked link says it no longer works.
- [ ] Remove a collaborator.
  You should see: their open page loses access on their next action.

### K. Hand-off

- [ ] As the owner: Collaborators → Hand off this wedding → choose Jamie.
  You should see: the confirmation names Jamie and says you'll stay on with Edit access. It **also warns that the new owner will be able to read the wedding's owner-only note** (new in this round).
- [ ] Confirm the hand-off.
  You should see: Jamie is the owner (check in Jamie's browser), and you're an Edit collaborator. The Collaborators list is up to date in both browsers without switching tabs.
- [ ] As Jamie, hand it back.

### L. Guest RSVP page (no sign-in)

- [ ] Open Victor Morales's RSVP link in a private window (and on the iPhone).
  You should see: the wedding name, 11-14-2026, and his name. No other guest's details.
- [ ] Answer coming, with a note.
  You should see: a thank-you message. The owner's bell gets "Victor Morales is coming." and the Guests tab shows Confirmed.
- [ ] Isabel Ortiz's link.
  You should see: a party of up to 2, with "Who's coming with you?" Going above her party size isn't possible.
- [ ] Hannah Lee's link.
  You should see: her earlier answer filled in.
- [ ] Change one guest's answer to Declined.
  You should see: their seat is freed and the owner is notified.
- [ ] As the owner, move the RSVP cutoff to yesterday, then reload an RSVP link.
  You should see: the RSVP is read-only, and the cutoff date shows as MM-DD-YYYY. Put the cutoff back afterwards.

### M. Vendor page (no sign-in)

- [ ] Open the Harvest Table Catering link.
  You should see: the wedding, the date 11-14-2026, the venue, the caterer's contact and an arrival of 2:00 PM, other vendors by arrival time (the shuttle last, "next day"), and the timeline. **No costs, contract notes or guest details.**
- [ ] After regenerating or revoking that link (H), open the old link.
  You should see: "This link is no longer active".

### N. Comments and notifications

- [ ] Comments tab.
  You should see: 4 threads, one marked resolved, on a guest, a table and a timeline entry. Authors' names and times are in 12-hour format.
- [ ] As the commenter, reply to a thread.
  You should see: the owner's and Jamie's bells show a new notification, and a `[email-log]` line appears for each person who gets email.
- [ ] Resolve a thread.
  You should see: allowed for the owner, Edit members and the person who started it. Not allowed for the viewer.
- [ ] Bell.
  You should see: the unread count matches. "Mark all read" clears it, and opening a notification takes you to the right wedding.
- [ ] On the Collaborators tab, turn off email notifications for yourself on this wedding, then trigger one.
  You should see: the bell still updates, but no new `[email-log]` line appears for you.

### O. Activity tab

- [ ] Open Activity.
  You should see: the changes you made today, newest first, with names and 12-hour times.

### P. Phone layout (iPhone, and a narrow Mac window)

- [ ] Every tab.
  You should see: no sideways scrolling of the page. Tables and lists fit or scroll inside their own box, and buttons are big enough to tap.
- [ ] Forms (add guest, vendor, timeline).
  You should see: the keyboard doesn't hide the box you're typing in, and the email box shows the email keyboard.
- [ ] Sign-in, the RSVP page and the vendor page.
  You should see: comfortable to read without zooming.
- [ ] Rotate the iPhone.
  You should see: nothing breaks.

### Q. Keyboard: Tab order

- [ ] On sign-in, sign-up, the add-guest form, a table edit, a vendor form and the RSVP page, press Tab repeatedly.
  You should see: focus moves top-left → right → down, the focus outline is always visible, nothing is skipped and focus never lands on something hidden.
- [ ] Open a confirmation (delete, hand off).
  You should see: Enter or Space works the buttons, Escape cancels where offered, and focus goes back to where you were.

### R. Dark mode

- [ ] Switch the Mac and the iPhone to Dark, and look at every tab, the dashboard, sign-in, RSVP and vendor pages, and the confirmations.
  You should see: everything readable, with no white boxes, invisible text or invisible focus outlines.
- [ ] PDFs in dark mode.
  You should see: still normal (white paper).

---

## 4. When you're done

- Stop the server (Ctrl+C).
- **Wipe the sample data:** run `pnpm db:local-test-data` once more to get fresh data, or leave it as it is. It's only on this Mac.
- **Clean up the log:** `~/seatwise-local-test.log` holds masked addresses and hidden links only. Delete it when you no longer need it.
