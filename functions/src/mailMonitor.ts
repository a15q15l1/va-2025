import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import { queueEmailNotification } from "./notifications";
import { queueBookingEmail } from "./email";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const SUPPORT_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL ?? "info@valleyairporter.ca";
const BOOKING_STATUSES_TO_MONITOR = ["confirmed", "paid"];
const MONITOR_LOOKBACK_MINUTES = 5;

const shouldSkipMailDoc = (metadata: Record<string, unknown> | null | undefined) => {
  if (!metadata) return false;
  if (metadata["type"] === "system-alert") return true;
  if (metadata["suppressWatch"] === true) return true;
  return false;
};

const extractDeliveryState = (data: Record<string, unknown> | null | undefined) => {
  if (!data) return "";
  const delivery = (data.delivery ?? {}) as Record<string, unknown>;
  const state = typeof delivery.state === "string" ? delivery.state : typeof data.deliveryState === "string" ? data.deliveryState : "";
  return state.toUpperCase();
};

const extractErrorMessage = (data: Record<string, unknown> | null | undefined) => {
  if (!data) return null;
  const delivery = (data.delivery ?? {}) as Record<string, unknown>;
  return (
    (typeof delivery.errorMessage === "string" && delivery.errorMessage) ||
    (typeof data.error === "string" && data.error) ||
    (typeof data.lastError === "string" && data.lastError) ||
    null
  );
};

export const watchMailDelivery = onDocumentWritten(
  {
    document: "mail/{messageId}",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async (event) => {
    const after = event.data?.after?.data() as Record<string, unknown> | undefined;
    if (!after) return;

    const metadata = after.metadata as Record<string, unknown> | undefined;
    if (shouldSkipMailDoc(metadata)) {
      return;
    }

    const currentState = extractDeliveryState(after);
    const beforeState = extractDeliveryState(event.data?.before?.data() as Record<string, unknown> | undefined);
    const errorMessage = extractErrorMessage(after);

    if (currentState !== "ERROR" && !errorMessage) {
      return;
    }
    if (beforeState === "ERROR" && currentState === "ERROR") {
      return;
    }

    const mailId = event.params.messageId;
    const bookingId = (metadata?.bookingId as string) ?? null;
    const notificationType = (metadata?.type as string) ?? "unknown";
    const message = errorMessage ?? "EMAIL_DELIVERY_FAILED";

    logger.error("Mail delivery reported an error", {
      mailId,
      bookingId,
      notificationType,
      message,
    });

    if (bookingId) {
      const update: Record<string, unknown> = {};
      let basePath = "system.notifications.email.bookingConfirmation";
      if (notificationType === "payment-confirmation") {
        basePath = "system.notifications.email.paymentConfirmation";
      }
      update[`${basePath}.lastError`] = {
        at: admin.firestore.FieldValue.serverTimestamp(),
        mailId,
        message,
      };
      update[`${basePath}.errorCount`] = admin.firestore.FieldValue.increment(1);
      await db.collection("bookings").doc(bookingId).set(update, { merge: true });
    }

    await queueEmailNotification({
      to: SUPPORT_EMAIL,
      subject: `[Alert] Email delivery failed (${notificationType})`,
      text: [
        `A ${notificationType} email failed to deliver.`,
        `Booking: ${bookingId ?? "unknown"}`,
        `Mail doc: ${mailId}`,
        `Error: ${message}`,
      ].join("\n"),
      metadata: {
        type: "system-alert",
        suppressWatch: true,
        reason: "mail-delivery-error",
        mailId,
        bookingId: bookingId ?? undefined,
      },
    });
  },
);

export const monitorBookingNotifications = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: process.env.SERVICE_TIME_ZONE ?? "America/Vancouver",
    region: "us-central1",
  },
  async () => {
    const cutoffDate = new Date(Date.now() - MONITOR_LOOKBACK_MINUTES * 60 * 1000);
    const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoffDate);

    const snapshot = await db
      .collection("bookings")
      .where("status", "in", BOOKING_STATUSES_TO_MONITOR)
      .where("system.notifications.email.bookingConfirmation.sent", "==", false)
      .where("createdAt", "<=", cutoffTimestamp)
      .limit(25)
      .get();

    if (snapshot.empty) {
      logger.debug("monitorBookingNotifications: no pending confirmations detected");
      return;
    }

    logger.warn("monitorBookingNotifications: found bookings missing confirmations", {
      count: snapshot.size,
    });

    await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data() ?? {};
        const passenger = (data.passenger ?? {}) as Record<string, unknown>;
        const trip = (data.trip ?? {}) as Record<string, unknown>;
        const schedule = (data.schedule ?? {}) as Record<string, unknown>;
        const payment = (data.payment ?? {}) as Record<string, unknown>;
        const bookingNumber = typeof data.bookingNumber === "number" ? data.bookingNumber : 0;
        const bookingId = doc.id;
        const createdAtTimestamp =
          data.createdAt instanceof admin.firestore.Timestamp
            ? data.createdAt
            : undefined;
        const createdAtIso = createdAtTimestamp
          ? createdAtTimestamp.toDate().toISOString()
          : new Date().toISOString();

        await doc.ref.set(
          {
            "system.notifications.email.bookingConfirmation.retryRequestedAt": admin.firestore.FieldValue.serverTimestamp(),
            "system.notifications.email.bookingConfirmation.retryCount": admin.firestore.FieldValue.increment(1),
          },
          { merge: true },
        );

        const totalCents =
          typeof payment.totalCents === "number"
            ? payment.totalCents
            : typeof payment.total === "number"
              ? Math.round(payment.total * 100)
              : 0;
        const tipCents =
          typeof payment.tipAmountCents === "number"
            ? payment.tipAmountCents
            : typeof payment.tipCents === "number"
              ? payment.tipCents
              : 0;
        const paymentPreference =
          payment.preference === "pay_now" || payment.preference === "pay_on_arrival"
            ? (payment.preference as "pay_on_arrival" | "pay_now")
            : "pay_on_arrival";

        const mailDocId = await queueBookingEmail({
          bookingId,
          bookingNumber,
          customerName: (passenger.primaryPassenger as string) ?? "Valley Airporter Passenger",
          customerEmail: (passenger.email as string) ?? "",
          pickupDate: (schedule.pickupDate as string) ?? "",
          pickupTime: (schedule.pickupTime as string) ?? "",
          origin: (trip.origin as string) ?? "",
          originAddress: (trip.originAddress as string) ?? null,
          destination: (trip.destination as string) ?? "",
          destinationAddress: (trip.destinationAddress as string) ?? null,
          passengerCount: Number(trip.passengerCount ?? 1),
          phone: (passenger.phone as string) ?? "",
          baggage: (passenger.baggage as string) ?? "Normal",
          notes: (schedule.notes as string) ?? null,
          totalCents,
          tipCents,
          currency: (payment.currency as string) ?? "CAD",
          paymentPreference,
          createdAtIso,
          paymentLinkUrl: (payment.link as string) ?? null,
          flightNumber: (schedule.flightNumber as string) ?? null,
          force: true,
        });

        if (!mailDocId) {
          logger.error("monitorBookingNotifications: unable to queue confirmation email", {
            bookingId,
          });
          await queueEmailNotification({
            to: SUPPORT_EMAIL,
            subject: `[Alert] Booking confirmation email missing (#${bookingNumber})`,
            text: [
              `Booking ${bookingId} is still missing its confirmation email after monitoring.`,
              `Please review and resend manually.`,
            ].join("\n"),
            metadata: { type: "system-alert", suppressWatch: true, reason: "booking-email-retry-failed", bookingId },
          });
        } else {
          await queueEmailNotification({
            to: SUPPORT_EMAIL,
            subject: `[Info] Booking confirmation re-queued (#${bookingNumber})`,
            text: [
              `Booking ${bookingId} did not have a confirmation email marked as sent within ${MONITOR_LOOKBACK_MINUTES} minutes.`,
              `The system has re-queued the email (mail doc ${mailDocId}).`,
            ].join("\n"),
            metadata: { type: "system-alert", suppressWatch: true, reason: "booking-email-retry", bookingId },
          });
        }
      }),
    );
  },
);
