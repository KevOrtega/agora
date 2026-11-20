import type { RawNotification } from "./types.js";
import { NotificationVerificationError } from "./types.js";

/** Issues deterministic notifications and recognizes only the ones it issued (mock stand-in for signature checks). */
export class NotificationRegistry<E extends { readonly eventId: string }> {
  private readonly issued = new Map<string, { raw: RawNotification; event: E }>();

  issue(event: E, resourceId: string): RawNotification {
    const raw: RawNotification = { id: event.eventId, resourceId, signature: `mock-signature:${event.eventId}` };
    this.issued.set(raw.id, { raw, event });
    return raw;
  }

  verify(raw: RawNotification): E {
    const entry = this.issued.get(raw.id);
    if (!entry || entry.raw.signature !== raw.signature || entry.raw.resourceId !== raw.resourceId) {
      throw new NotificationVerificationError("Notification could not be verified");
    }
    return entry.event;
  }
}
