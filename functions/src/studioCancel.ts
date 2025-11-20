import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {
  buildCancellationEmail,
  extractPickupTimeUtc,
  formatBookingTag,
  SmsBookingContext,
} from "./smsTemplates";
import { queueEmailNotification, queueSmsNotification } from "./notifications";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const ADMIN_EMAIL = (() => {
  const envEmail = process.env.ADMIN_NOTIFICATION_EMAIL?.trim();
  if (envEmail) return envEmail;
  return "info@valleyairporter.ca";
})();
const ADMIN_SMS_RECIPIENTS = Array.from(
  new Set(
    [
      process.env.ADMIN_NOTIFICATION_PHONE,
      process.env.ADMIN_NOTIFICATION_PHONE_ALT,
      "+16047516688",
      "+17788780546",
    ]
      .map((value) => value?.trim())
      .filter(Boolean),
  ),
);

const normalizePhone = (raw: unknown) => {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
};

const phoneLookupKeys = (e164: string) => {
  const digits = e164.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return [`phone:${e164}`, `phone:${digits}`, `phone:${last10}`];
};

const tsOf = (d: FirebaseFirestore.DocumentData): number => {
  const toMillis = (value: any) => {
    if (typeof value === "number") return value;
    if (value?.toMillis) return value.toMillis();
    if (typeof value?.seconds === "number") return value.seconds * 1000;
    return null;
  };
  return (
    toMillis(d.pickupTimeUtc) ??
    toMillis(d.schedule?.pickupTimestamp) ??
    toMillis(d.schedule?.pickupTimeUtc) ??
    0
  );
};

const toContext = (
  id: string,
  d: FirebaseFirestore.DocumentData,
): SmsBookingContext & { passengerEmail?: string | null } => ({
  bookingId: id,
  bookingNumber: d.bookingNumber ?? null,
  pickupTimeUtc: extractPickupTimeUtc(
    d.pickupTimeUtc ?? d.schedule?.pickupTimestamp ?? null,
  ),
  schedule: {
    pickupDate: d.schedule?.pickupDate ?? null,
    pickupTime: d.schedule?.pickupTime ?? null,
  },
  trip: {
    origin: d.trip?.origin ?? null,
    originAddress: d.trip?.originAddress ?? null,
    destination: d.trip?.destination ?? null,
    destinationAddress: d.trip?.destinationAddress ?? null,
  },
  passengerName: d.passenger?.primaryPassenger ?? null,
  passengerPhone: d.passengerPhone ?? d.passenger?.phone ?? null,
  passengerEmail: d.passenger?.email ?? null,
  passengerCount: d.trip?.passengerCount ?? null,
  totalCents: d.payment?.totalCents ?? null,
  currency: d.payment?.currency ?? "CAD",
  specialNotes: d.schedule?.notes ?? null,
});

const HELP_MENU = (example?: number) =>
  [
    "- Valley Airporter SMS Help Desk -",
    "",
    "1. For FAQ, Visit: ValleyAirporter.ca/FAQ",
    example
      ? `2. If you would like to cancel the booking, text: Cancel Booking [${example}]`
      : `2. If you would like to cancel a booking, text: Cancel Booking [12345]`,
    "",
    "You can text/call us at anytime at 604-751-6688",
  ].join("\n");

const INVALID_MENU =
  'Sorry, that is an invalid option. Please text "options" for more information.';

export const studioCancel = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const bodyPayload =
      typeof req.body === "object" && req.body
        ? req.body
        : JSON.parse(req.rawBody?.toString("utf8") || "{}");

    const from = normalizePhone(bodyPayload?.from);
    const bodyTxt = (bodyPayload?.body ?? "").toString().trim();

    if (!from) {
      res.json({ ack: INVALID_MENU });
      return;
    }

    const reasonRaw = (bodyPayload?.reason ?? "").toString().trim().toLowerCase();
    const cancelMatch = bodyTxt.match(/^cancel\s+booking\s+#?(\d{5})\s*$/i);
    const isHelp = /^\s*(help|menu|options)\s*$/i.test(bodyTxt);
    const isStartStop = /^\s*(start|stop)\s*$/i.test(bodyTxt);

    if (isStartStop) {
      res.json({ send: false });
      return;
    }

    if (isHelp) {
      const keys = phoneLookupKeys(from);
      const qs = await db
        .collection("bookings")
        .where("status", "==", "confirmed")
        .where("lookupKeys", "array-contains-any", keys)
        .limit(50)
        .get();

      const now = Date.now();
      let nearest: number | undefined;
      qs.docs.forEach((doc) => {
        const data = doc.data();
        const pickup = tsOf(data);
        if (pickup && pickup >= now) {
          if (!nearest || pickup < nearest) {
            nearest = data.bookingNumber ?? nearest;
          }
        }
      });

      res.json({ send: true, ack: HELP_MENU(nearest) });
      return;
    }

    if (cancelMatch) {
      const bookingNumber = Number(cancelMatch[1]);
      const snap = await db
        .collection("bookings")
        .where("bookingNumber", "==", bookingNumber)
        .limit(1)
        .get();

      if (snap.empty) {
        res.json({
          send: true,
          ack:
            "We couldn't find an upcoming booking for that booking number.\n\n" +
            INVALID_MENU,
        });
        return;
      }

      const doc = snap.docs[0];
      const data = doc.data() ?? {};
      const lookupSet = new Set<string>(
        Array.isArray(data.lookupKeys) ? data.lookupKeys : [],
      );
      const keys = phoneLookupKeys(from);
      if (!keys.some((key) => lookupSet.has(key))) {
        res.json({
          send: true,
          ack:
            "We couldn't find an upcoming booking for that booking number.\n\n" +
            INVALID_MENU,
        });
        return;
      }

      if (data.status === "canceled") {
        res.json({
          send: true,
          ack: `Booking #${bookingNumber} is already canceled. If you need assistance, text "options".`,
        });
        return;
      }

      const cancellationReason =
        reasonRaw === "change-time"
          ? "customer_change_time"
          : reasonRaw === "cancel"
            ? "customer_cancel"
            : "customer_sms";
     const ackMessage =
       reasonRaw === "change-time"
         ? `Booking #${bookingNumber} has been marked for a schedule change. An agent will follow up shortly.`
          : `Booking #${bookingNumber} has been canceled. No further reminders will be sent. Need to rebook? valleyairporter.ca.`;

      await db.runTransaction(async (tx) => {
        tx.update(doc.ref, {
          status: "canceled",
          cancellationReason,
          cancellationSource: "sms",
          canceledAt: admin.firestore.FieldValue.serverTimestamp(),
          remind24Sent: true,
          remind10Sent: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          statusHistory: admin.firestore.FieldValue.arrayUnion({
            status: "canceled",
            reason: cancellationReason,
            source: "sms",
            timestamp: admin.firestore.Timestamp.now(),
          }),
        });
      });

      const ctx = toContext(doc.id, data);
      const emailBody = buildCancellationEmail(ctx);
      const subject = `Valley Airporter booking canceled - ${formatBookingTag(
        ctx.bookingNumber,
        doc.id,
      )}`;

      if (ctx.passengerEmail) {
        await queueEmailNotification({
          to: ctx.passengerEmail,
          subject,
          text: emailBody,
        });
      }
      await queueEmailNotification({
        to: ADMIN_EMAIL,
        subject,
        text: emailBody,
      });

      const adminAlert = `SMS cancellation from ${from}. Booking #${bookingNumber}. Reason: ${cancellationReason}.`;
      await Promise.all(
        ADMIN_SMS_RECIPIENTS.map((to) =>
          queueSmsNotification({
            to: to!,
            message: adminAlert,
            metadata: { bookingId: doc.id, type: "cancellation-admin" },
          }),
        ),
      );

      res.json({
        send: true,
        ack: ackMessage,
      });
      return;
    }

    res.json({ send: true, ack: INVALID_MENU });
  } catch (err) {
    functions.logger.error("studioCancel error", {
      err: err instanceof Error ? err.message : err,
    });
    res.json({
      send: true,
      ack:
        'Sorry, something went wrong. Please try again or text "options" for assistance.',
    });
  }
});
