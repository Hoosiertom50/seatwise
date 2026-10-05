/**
 * TS-160 (REQ-NON-FUNCTIONAL) — the database never holds a working RSVP, vendor or invite link.
 * Links are looked up by a SHA-256 hash of their token. Guests and vendors keep an encrypted copy
 * (so the planner's "RSVP link" / "Share link" button can show the same link again); invites keep
 * only the hash. A link made before this change keeps working and is encrypted the next time it is
 * shown. The RSVP rate limit is counted against the hash, not the link.
 */

import { createHash } from "node:crypto";
import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { uniquePersonName } from "../data/ids.js";
import { VendorViewPage } from "../pages/VendorViewPage.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import {
  inviteToken,
  plantPreHashingRsvpLink,
  storedGuestRsvpLink,
  storedInviteToken,
  storedVendorShareLink,
} from "../support/testDatabase.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const tokenOf = (url: string) => url.split("/").pop()!;

defineQualityTest(
  {
    id: "cross-cutting.link-tokens-are-stored-only-as-hashes.rsvp-vendor-invite-and-older-links",
    title: "RSVP, vendor and invite links are stored only as a hash (plus an encrypted copy where the link is shown again), and older links keep working",
    objective:
      "Confirms that a guest's RSVP link and a vendor's share link are stored as an 'enc:v1:' encrypted copy plus the SHA-256 hash of the token, never the token itself, while the link works and the button shows the same link again; that an invite row stores a 64-character hash and an invite link is found by the hash of its token; and that an RSVP link stored in plain text before this change still works, is shown unchanged, and is encrypted once shown.",
    expectedOutcome:
      "Stored copies start with 'enc:v1:' and don't contain the token; hashes equal sha256(token); RSVP preview reads OPEN; the vendor page shows the vendor's name; asking again returns the same URL. The invite row's stored value is never the token in the link, and equals sha256 of a working token. The older RSVP link reads OPEN before and after, the button returns it unchanged, and its stored copy is then encrypted.",
    requirementIds: ["REQ-NON-FUNCTIONAL"],
    tags: ["@mutating", "@feature:rsvp", "@feature:budget", "@feature:collaboration", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser, page }, testInfo) => {
    const w = managedWedding.id;
    const api = (path: string) => `/api/v1/weddings/${w}/${path}`;
    const rsvpLink = async (guestId: string) => {
      const res = await context.request.post(api(`guests/${guestId}/rsvp-link`), { data: {} });
      expect(res.status()).toBe(200);
      return ((await res.json()) as { rsvp: { url: string } }).rsvp.url;
    };
    const rsvpStatus = async (token: string) =>
      ((await (await context.request.get(`/api/v1/rsvp/${token}`)).json()) as { rsvp: { status: string } }).rsvp.status;

    await test.step("A guest's RSVP link is stored encrypted and hashed, and still works", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const url = await rsvpLink(guest.id);
      const token = tokenOf(url);
      const row = await storedGuestRsvpLink(guest.id);
      expect(row.stored).toMatch(/^enc:v1:/);
      expect(row.stored).not.toContain(token);
      expect(row.hash).toBe(sha256(token));
      expect(await rsvpStatus(token)).toBe("OPEN");
      expect(await rsvpLink(guest.id)).toBe(url);
    });

    await test.step("A vendor's share link is stored encrypted and hashed, and still works", async () => {
      const created = await context.request.post(api("vendors"), {
        data: { name: "Hashed Link Catering", category: "CATERING", costCents: 50000 },
      });
      expect(created.status()).toBe(201);
      const vendorId = ((await created.json()) as { vendor: { id: string } }).vendor.id;
      const share = async () =>
        ((await (await context.request.post(api(`vendors/${vendorId}/share-link`), { data: {} })).json()) as { link: { url: string } }).link.url;
      const url = await share();
      const token = tokenOf(url);
      const row = await storedVendorShareLink(vendorId);
      expect(row.stored).toMatch(/^enc:v1:/);
      expect(row.stored).not.toContain(token);
      expect(row.hash).toBe(sha256(token));
      const vendorPage = new VendorViewPage(page);
      await vendorPage.gotoUrl(url);
      await expect(vendorPage.yourDetails()).toContainText("Hashed Link Catering");
      expect(await share()).toBe(url);
    });

    await test.step("An invite stores only a hash, and its link is found by the hash of its token", async () => {
      const invitee = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "invitee");
      try {
        const sent = await weddingData.createInvite(w, invitee.email, "VIEW");
        expect(sent.status).toBe(201);
        const inviteId = sent.body.invite!.id;
        const stored = await storedInviteToken(inviteId);
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        // Whatever is in the row isn't itself a working link...
        const asLink = (await (await context.request.get(`/api/v1/invites/${stored}`)).json()) as { invite: { status: string } };
        expect(asLink.invite.status).toBe("NOT_FOUND");
        // ...but a token whose hash is in the row is.
        const token = await inviteToken(inviteId);
        expect(await storedInviteToken(inviteId)).toBe(sha256(token));
        const accepted = await invitee.context.request.post(`/api/v1/invites/${token}/accept`, { data: {} });
        expect(accepted.status()).toBe(200);
      } finally {
        await invitee.context.close();
      }
    });

    await test.step("An RSVP link made before this change keeps working, and is encrypted once shown", async () => {
      const guest = await weddingData.createGuest(w, uniquePersonName(testInfo.workerIndex));
      const token = await plantPreHashingRsvpLink(guest.id);
      expect((await storedGuestRsvpLink(guest.id)).stored).toBe(token);
      expect(await rsvpStatus(token)).toBe("OPEN");
      expect(tokenOf(await rsvpLink(guest.id))).toBe(token);
      const row = await storedGuestRsvpLink(guest.id);
      expect(row.stored).toMatch(/^enc:v1:/);
      expect(row.hash).toBe(sha256(token));
      expect(await rsvpStatus(token)).toBe("OPEN");
    });
  },
);
