# Seatwise quick check

A short pass through every part of Seatwise: **30 steps, about 1 hour.** It follows the main path through each area and looks for the things automated tests can't judge: how screens look, real PDFs, emails, and the phone.

The **full checklist** (`docs/local-test-checklist.md`, about 135 steps) stays the reference. Use it when you need to dig into an area. Words used here (plan version, Restricted table, Day-of mode and so on) are explained there under **"Words used in this checklist"**.

---

## Before you start

- **Someone has set up the Mac** (Part 1 of the full checklist) and given you the **setup sheet**: the sign-ins with their passwords, and some ready-made links.
- **Open the app:** <http://localhost:3000> on the Mac. On the iPhone, use the address from the setup sheet (like `http://192.168.1.23:3000`), on the same Wi-Fi.
- **Dates and times:** every date should look like **11-14-2026** (MM-DD-YYYY) and every time like **4:30 PM**. Anything else is a bug.
- **Two browsers:** a few steps need two people signed in at once. Use two browsers (for example Chrome and Safari), or a normal and a private window.
- **Tick the boxes** as you go, and write down anything that looked odd, even if it worked.

### Who you sign in as

| Sign in with | Person | What they can do |
|---|---|---|
| `owner@demo.seatwise.test` | Morgan Ellis | **Owner** of both sample weddings |
| `couple@demo.seatwise.test` | Jamie Rivera | One of the couple, **Edit** access |
| `commenter@demo.seatwise.test` | Priya Shah | Helper with **Comment** access |
| `viewer@demo.seatwise.test` | Lee Okafor | Helper with **View** access |

### Seeing emails

No real email is sent. Each email is written to a log. To see the last 5, open the **Terminal** app (Cmd+Space, type `Terminal`, Return), paste this and press Return:

```
grep email-log ~/seatwise-local-test.log | tail -5
```

To get a working **confirm-your-email** link, paste this (with the right email address at the end):

```
cd ~/Projects/seatwise && pnpm db:local-test-data --confirm-link tester1@demo.seatwise.test
```

### When something isn't as described

Take a screenshot (Mac: **Cmd+Shift+4**; iPhone: side button + volume up). Write down the browser, the account, the time, the step number and exactly what you did. Try it once more and note whether it happened again; once still counts. Use the bug report template at the end of the full checklist.

---

## 1. Getting in (5 steps)

- [ ] **Q1** Go to <http://localhost:3000>, click **Get started**. Type Name `Test Person`, Email `tester1@demo.seatwise.test`, Password `testing-pass-1`. Click **Create account**.
  You should see: your dashboard, with a yellow box "Please confirm your email address…". The email log has a new line with `subject="Confirm your email for Seatwise"`.
- [ ] **Q2** Get the confirm link (see "Seeing emails"), open it, click **Confirm my email**.
  You should see: "Thanks — your email address is confirmed." On the dashboard, the yellow box is gone.
- [ ] **Q3** Click **Log out**. Click **Log in**, type `owner@demo.seatwise.test` and a wrong password. Click **Log in**.
  You should see: "Invalid email or password". Then log in with the right password from the setup sheet: you reach the dashboard.
- [ ] **Q4** Look at the dashboard.
  You should see: **Jamie & Morgan's Wedding** with a green **Approved** label, "11-14-2026 · Lakeside Pavilion" and "61 invitations · 68 people invited · 64 attending"; **Taylor & Quinn's Wedding** with **No plan yet**, "05-22-2027 · Old Mill Barn".
- [ ] **Q5** Click **Account** (top right).
  You should see: **Your account**, with **Appearance**, **Get help**, **Signed in elsewhere** and **Delete my account** sections. Click **← Back to your weddings**.

## 2. The wedding (10 steps)

Open **Jamie & Morgan's Wedding**.

- [ ] **Q6** **Guests** tab: in **Add a guest**, type First name `Testy`, Last name `McTest`. Click **+ More details…**, set Headcount `2` and tick **Requires an accessible table**. Click **Add guest**.
  You should see: "Added Testy McTest." The guest shows "(+1)" and an "accessible table" label. The heading's numbers go up.
- [ ] **Q7** Try adding First name `J0hn` (with a zero), Last name `Smith`.
  You should see: refused, with a plain message about the name.
- [ ] **Q8** **Seating rules** tab.
  You should see: 7 rules, for example "Ethan Clark & Lucas Hall" — "Must NOT sit together".
- [ ] **Q9** **Tables** tab.
  You should see: 8 tables with their labels (Head Table "restricted", Table 1 "accessible", Table 2 "locked", Family Table "single-side only", Kids' Table and Friends Table "favors …"), and counts like "8/10 seated (2 remaining)".
- [ ] **Q10** **Seating plan** tab. Next to **Export:**, click **Seating chart (PDF)**, **Guest lookup list (PDF)** and **Place cards (PDF)**.
  You should see: each PDF downloads and opens, looks tidy, and prints names like "Lucía Rivera" and "Michael O'Brien" correctly. Dates read 11-14-2026.
- [ ] **Q11** Click **Generate new plan**.
  You should see: a question first, "This replaces the approved plan…". Click **Replace the approved plan**. A new version is current, marked **Draft**. Testy McTest is seated at Table 1 (the accessible table) or listed as unassigned with a reason.
- [ ] **Q12** Click **Move to review**, then **Approve**.
  You should see: the label goes **In review**, then **Approved**, and the PDF buttons are back.
- [ ] **Q13** In the plan's **Tables** list, pick a guest at Table 3 or Table 4. In their **Move to...** list pick another table with room, click **Move**. Then click **Undo**.
  You should see: "Moved [name] to [table].", then the guest goes back.
- [ ] **Q14** **Day-of mode** tab. In **Add a walk-in**, type First name `Walker`, Last name `Inn`, Party size `1`, pick a table with room, click **Add walk-in**. Then in **Find a guest** type `Diego` and click **Mark not attending** on Diego Ramos, then **Mark attending**.
  You should see: "Added walk-in Walker Inn and seated them…", and that table's count goes up. Diego's row changes to "Not attending" and back.
- [ ] **Q15** Click through **Timeline**, **Budget**, **Comments** and **Activity**.
  You should see: Timeline in time order, ending "12:30 AM (next day)". Budget $35,000.00, Recorded so far $27,550.00, Remaining $7,450.00. 4 comment threads with names and times like "10-08-2026, 9:15 AM". Activity lists today's changes, newest first.

## 3. Guests and vendors without signing in (4 steps)

Use a **private window** (Cmd+Shift+N in Chrome).

- [ ] **Q16** Open **Victor Morales's** RSVP link from the setup sheet. Click **Joyfully attending**, type `No mushrooms, please` in the dietary box, click **Submit RSVP**.
  You should see: "Thanks — your RSVP has been recorded…" with the date as 11-01-2026. No other guest's name anywhere.
- [ ] **Q17** Back in the owner's window, click the 🔔 bell.
  You should see: a new unread notification about Victor Morales's RSVP. On **Guests**, Victor shows **Confirmed** and his note.
- [ ] **Q18** Open the **Harvest Table Catering** vendor link from the setup sheet in the private window.
  You should see: the wedding name and date, Harvest Table Catering's details and arrival time, the timeline, and the other vendors in arrival order. **No costs, no contract notes and no guest names.**
- [ ] **Q19** As the owner, **Collaborators** tab: set **RSVP cutoff** to two days ago and click elsewhere, then **Save anyway**. Reload Victor's RSVP link.
  You should see: "RSVP responses have closed…" with the date as MM-DD-YYYY. Then set the cutoff back to `11/01/2026`.

## 4. Working together (5 steps)

Keep the owner in browser 1. Use browser 2 for the others.

- [ ] **Q20** Browser 2: sign in as `viewer@demo.seatwise.test` (Lee) and open the wedding. Click through the tabs.
  You should see: "Your access: View". Nothing can be added, changed or removed. Carmen Delgado shows no private note.
- [ ] **Q21** Browser 2: sign in as `commenter@demo.seatwise.test` (Priya). **Comments** tab: on the Elena Vargas thread click **Reply**, type `Thanks, that works.`, click **Reply**.
  You should see: the reply appears. In browser 1, the owner's 🔔 red number goes up within a few seconds, and the email log has new lines.
- [ ] **Q22** Browser 2: sign in as Lee again, leave the **Guests** tab open. Browser 1: **Collaborators** tab, change Lee Okafor's **Access level** to **Comment**.
  You should see: browser 2 shows "Your access to this wedding was changed to Comment." within about 5 seconds, without reloading. Change Lee back to **View**.
- [ ] **Q23** Browser 2: sign in as `couple@demo.seatwise.test` (Jamie), open the wedding's **Collaborators** tab. Browser 1: **Hand off this wedding**, pick **Jamie Rivera**, click **Hand off**.
  You should see: the question warns "Your private wedding note will be visible to the new owner…". Click **Yes, hand it off**. Browser 2 (Jamie) gets the owner sections within a few seconds.
- [ ] **Q24** Browser 2 (Jamie): hand it back to **Morgan Ellis**. Browser 1: on Jamie Rivera's row, set **Role** back to **Couple**.
  You should see: Morgan is the owner again, and Jamie is Couple.

## 5. Importing guests (2 steps)

- [ ] **Q25** Open **Taylor & Quinn's Wedding** → **Guests** → **Bulk import guests (CSV)**. Choose `sample-guest-import.csv` (in `~/Projects/seatwise/docs/`, or the copy in Documents → Seatwise). Click **Preview import**.
  You should see: "20 new, 0 updating, 0 with errors". Names look exactly like the file: José Álvarez, Zoë Müller-Schmidt, Siobhán O'Brien, Łukasz Wróbel.
- [ ] **Q26** Click **Confirm import (20 guest(s))**, then go to **Seating plan** and click **Generate new plan**.
  You should see: "Import complete: 20 guest(s) added…", then a first plan with everyone attending seated and "0 unassigned".

## 6. Look and feel (4 steps)

- [ ] **Q27** **Light and dark.** **Account → Appearance**: click **Light**, then **Dark**, then **Match my device**.
  You should see: the page changes at once each time, and the choice stays after a reload. In both Light and Dark, open the dashboard and every tab of the wedding: all text, labels (green **Approved**, red errors, yellow notes) and greyed-out buttons are easy to read.
- [ ] **Q28** **Keyboard.** On **Log in** and on **Add a guest**, press **Tab** again and again. (Safari: first turn on **Safari → Settings → Advanced → "Press Tab to highlight each item"**.)
  You should see: focus moves top-left, to the right, then down, with a clear outline. Then on a guest's **Remove**, press **Escape**: the question closes and the outline is back on **Remove**.
- [ ] **Q29** **iPhone.** Sign in as the owner. Open the dashboard, every tab of the wedding, **Day-of mode** (add a walk-in `Ivy Phone`), the bell, Victor's RSVP link and the vendor link.
  You should see: nothing runs off the side of the screen, buttons are easy to tap, the page doesn't zoom in when you tap a box, and the email boxes bring up the @ keyboard.
- [ ] **Q30** **Narrow window.** On the Mac, drag the browser window as narrow as it goes and look at the dashboard and the wedding's tabs.
  You should see: the page never scrolls sideways; long lists scroll inside their own box.

---

## When you're done

Send the bug reports and anything that looked odd. If everything passed, say so, with the browser and the date.
