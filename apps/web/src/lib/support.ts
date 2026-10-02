// TS-100: where people reach Seatwise support (Tom's decision, 2026-10-02). A "+support" address
// on the notifications Gmail: it lands in that inbox, where a filter forwards it to Tom. Changing
// who answers support is a forwarding change in Gmail, not a code change.
export const SUPPORT_EMAIL = "seatwise.notifications+support@gmail.com";

/** The reply-time promise shown next to every "Contact support" link. */
export const SUPPORT_PROMISE = "A real person replies within 1 business day.";

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Seatwise support")}`;
