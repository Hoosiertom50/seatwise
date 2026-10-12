/**
 * TS-234 (REQ-COLLABORATION-NOTIFICATIONS, REQ-ACCOUNT-WEDDING-MANAGEMENT) — two invites sent to the
 * same address at the same moment both stayed pending. A leftover one could later be accepted by
 * someone who had since been handed the wedding, making them owner and collaborator at once; their
 * next hand-off then failed with a server error. Now invites are sent under the wedding's lock (and
 * the database allows one pending invite per address), a hand-off revokes the new owner's own
 * pending invites, and accepting an invite to a wedding you own is refused with a plain message.
 *
 * The double send is made exact by holding the wedding's row lock from the test (holdWeddingLock):
 * both sends queue behind it, then run one after the other.
 */

import { expect, defineQualityTest, test } from "../fixtures/index.js";
import { WeddingDataSetup } from "../data/api.js";
import { uniqueToken } from "../data/ids.js";
import { signUpFreshAccountInNewContext } from "../support/auth.js";
import { holdWeddingLock, inviteToken, reopenInvite } from "../support/testDatabase.js";

defineQualityTest(
  {
    id: "collaboration.one-pending-invite-per-address-and-none-for-the-owner.double-send-and-hand-off",
    title: "invites sent twice at once leave one pending, and a new owner's own invite is revoked and can't be accepted",
    objective:
      "Confirms that two invites to the same address sent at the same moment both succeed but leave exactly one pending invite; that handing the wedding to someone revokes the invite still pending for their address while other invites stay pending; and that the new owner accepting an invite to the wedding they now own is refused with a plain message and changes nothing.",
    expectedOutcome:
      "Both sends return 201 and the invite list has one PENDING invite for that address (the other REVOKED). After the hand-off, the new owner's invite reads REVOKED and the other address's invite is still PENDING. Accepting the new owner's invite (put back to pending) returns 409 with status ALREADY_OWNER and a message saying they own the wedding; they stay its owner and don't appear as a collaborator.",
    requirementIds: ["REQ-COLLABORATION-NOTIFICATIONS", "REQ-ACCOUNT-WEDDING-MANAGEMENT"],
    tags: ["@mutating", "@feature:collaboration", "@feature:account", "@risk:high", "@suite:regression"],
  },
  async ({ managedWedding, weddingData, context, browser }, testInfo) => {
    test.setTimeout(120_000);
    const w = managedWedding.id;
    const doubleSent = `pw-tester-twice-${uniqueToken(testInfo.workerIndex)}@example.invalid`;
    const newOwner = await signUpFreshAccountInNewContext(browser, testInfo.workerIndex, "newowner");

    try {
      await test.step("Two invites to the same address sent at the same moment leave one pending", async () => {
        const lock = await holdWeddingLock(w);
        let first;
        let second;
        try {
          first = context.request.post(`/api/v1/weddings/${w}/invites`, { data: { email: doubleSent, permissionLevel: "VIEW", role: "COLLABORATOR" } });
          second = context.request.post(`/api/v1/weddings/${w}/invites`, { data: { email: doubleSent, permissionLevel: "VIEW", role: "COLLABORATOR" } });
          await lock.waitForWaiters(2);
        } finally {
          await lock.release();
        }
        const answers = await Promise.all([first, second]);
        for (const res of answers) expect(res!.status(), await res!.text()).toBe(201);
        const forAddress = (await weddingData.listInvites(w)).filter((i) => i.email === doubleSent);
        expect(forAddress).toHaveLength(2);
        expect(forAddress.filter((i) => i.status === "PENDING")).toHaveLength(1);
      });

      const ownInvite = await test.step("A hand-off revokes the new owner's own pending invite, and only theirs", async () => {
        const sent = await weddingData.createInvite(w, newOwner.email, "COMMENT");
        expect(sent.status, JSON.stringify(sent.body)).toBe(201);
        await weddingData.addCollaborator(w, newOwner.email, "EDIT");
        const collaborator = (await weddingData.listCollaborators(w)).find((c) => c.userEmail === newOwner.email)!;
        const res = await context.request.post(`/api/v1/weddings/${w}/transfer-ownership`, { data: { collaboratorId: collaborator.id } });
        expect(res.status(), await res.text()).toBe(200);

        const asNewOwner = new WeddingDataSetup(newOwner.context.request);
        const invites = await asNewOwner.listInvites(w);
        expect(invites.find((i) => i.id === sent.body.invite!.id)?.status).toBe("REVOKED");
        expect(invites.filter((i) => i.email === doubleSent && i.status === "PENDING")).toHaveLength(1);
        return sent.body.invite!;
      });

      await test.step("The owner accepting an invite to their own wedding is refused, and nothing changes", async () => {
        await reopenInvite(ownInvite.id);
        const token = await inviteToken(ownInvite.id);
        const accept = await newOwner.context.request.post(`/api/v1/invites/${token}/accept`);
        expect(accept.status(), await accept.text()).toBe(409);
        const body = (await accept.json()) as { error: string; status: string };
        expect(body.status).toBe("ALREADY_OWNER");
        expect(body.error).toContain("You own this wedding");

        const asNewOwner = new WeddingDataSetup(newOwner.context.request);
        expect((await asNewOwner.listInvites(w)).find((i) => i.id === ownInvite.id)?.status).toBe("PENDING");
        expect((await asNewOwner.listCollaborators(w)).some((c) => c.userEmail === newOwner.email)).toBe(false);
      });

      await test.step("Clean up: the new owner deletes the wedding", async () => {
        const res = await newOwner.context.request.delete(`/api/v1/weddings/${w}`);
        expect([200, 404]).toContain(res.status());
      });
    } finally {
      await newOwner.context.close();
    }
  },
);
