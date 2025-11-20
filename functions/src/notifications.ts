import * as admin from "firebase-admin";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

interface EmailNotificationPayload {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | string[] | null;
  from?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const queueEmailNotification = async ({
  to,
  subject,
  text,
  html,
  replyTo,
  from,
  metadata,
}: EmailNotificationPayload) => {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) return null;

  const message = {
    subject,
    text,
    html:
      html ??
      (() => {
        const escaped = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;")
          .replace(/\r?\n/g, "<br/>");
        const bolded = escaped
          .replace(/Booking Date:/g, '<strong>Booking Date:</strong>')
          .replace(/From:/g, '<strong>From:</strong>')
          .replace(/To:/g, '<strong>To:</strong>');
        const linkified = bolded.replace(
          /ValleyAirporter\.ca\/booking/g,
          '<a href="https://ValleyAirporter.ca/booking" target="_blank" rel="noopener">ValleyAirporter.ca/booking</a>',
        );
        return `<div style="white-space:pre-line; font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif; font-size:14px; line-height:1.45">${linkified}</div>`;
      })(),
  };

  const payload: Record<string, unknown> = {
    subject,
    text,
    to: recipients,
    message,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdOn: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (metadata && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }

  const defaultFrom = from ?? process.env.DEFAULT_FROM_EMAIL ?? "info@valleyairporter.ca";
  if (defaultFrom) {
    payload.from = defaultFrom;
  }
  if (replyTo) {
    payload.replyTo = replyTo;
  }

  const ref = await db.collection("mail").add(payload);
  logger.info("Queued email notification", { to: recipients, subject, id: ref.id });
  return ref.id;
};

interface SmsNotificationPayload {
  to: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export const queueSmsNotification = async ({ to, message, metadata }: SmsNotificationPayload) => {
  const normalizedTo = typeof to === "string" ? to.trim() : "";
  const body = typeof message === "string" ? message.trim() : "";
  if (!normalizedTo || !body) return;

  const payload: Record<string, unknown> = {
    to: normalizedTo,
    body,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!payload.metadata) {
    delete payload.metadata;
  }

  const ref = await db.collection("sms_outbound").add(payload);
  logger.info("Queued SMS notification", { to: normalizedTo, id: ref.id });
};

interface PushNotificationPayload {
  userId?: string | null;
  tokens?: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}

export const queuePushNotification = async ({
  userId,
  tokens,
  title,
  body,
  data,
}: PushNotificationPayload) => {
  if (!userId && (!tokens || tokens.length === 0)) return;
  // Placeholder: integrate with FCM once device tokens are stored.
  logger.info("Push notification queued for future delivery", {
    userId,
    tokens,
    title,
    body,
    data,
  });
};
