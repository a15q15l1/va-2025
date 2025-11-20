import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import twilio from "twilio";
import {
  buildCancellationAdminMessage,
  buildCancellationEmail,
  buildCancellationPassengerMessage,
  summarizeBookingOption,
  extractPickupTimeUtc,
  SmsBookingContext,
  formatBookingTag,
} from "./smsTemplates";
import { queueEmailNotification, queueSmsNotification } from "./notifications";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const functionsConfig = (() => {
  try {
    return functions.config();
  } catch {
    return {};
  }
})();

const asTrimmedString = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const SESSION_COLLECTION = "smsInboundSessions";
const SESSION_TTL_MS = 15 * 60 * 1000;
const ADMIN_EMAIL =
  asTrimmedString(process.env.ADMIN_NOTIFICATION_EMAIL) ??
  asTrimmedString(functionsConfig?.admin?.notification_email) ??
  "info@valleyairporter.ca";
const ADMIN_PHONE =
  asTrimmedString(process.env.ADMIN_NOTIFICATION_PHONE) ??
  asTrimmedString(functionsConfig?.admin?.notification_phone) ??
  "";
const SECONDARY_ADMIN_PHONE =
  asTrimmedString(process.env.ADMIN_NOTIFICATION_PHONE_ALT) ??
  "";
const HELP_DESK_PHONE = "(604) 751-6688";
const DEFAULT_REPLY_HELP =
  asTrimmedString(process.env.SMS_HELP_MESSAGE) ??
  asTrimmedString(functionsConfig?.sms?.help_message) ??
  "Valley Airporter: Reply STOP to cancel future updates, START to resume, HELP for assistance, or OPTIONS for the help desk. valleyairporter.ca/contact";


const CANCEL_WORDS = new Set(["cancel", "2", "stop", "unsubscribe", "end", "quit"]);
const HELP_WORDS = new Set(["help", "?", "info"]);
const OPTIONS_WORDS = new Set(["options"]);

const resolveTwilioAuthToken = (): string | null => {
  const envToken = asTrimmedString(process.env.TWILIO_AUTH_TOKEN);
  if (envToken) return envToken;
  const configToken = asTrimmedString(functionsConfig?.twilio?.auth_token);
  return configToken ?? null;
};

const normalizePhone = (value: string) => value.replace(/[^+\d]/g, "");
const sessionIdForPhone = (phone: string) => Buffer.from(phone).toString("base64url");

const buildTwiml = (message: string) => {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<Response><Message>${escaped}</Message></Response>`;
};

const parseBody = (req: any) => {
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";
  const params = new URLSearchParams(rawBody);
  return {
    rawBody,
    params,
    asObject: Object.fromEntries(params.entries()),
  };
};

const toDigits = (value: string) => value.replace(/[^\d]/g, "");
const phoneVariants = (phone: string) => {
  const normalized = normalizePhone(phone);
  const digits = toDigits(normalized);
  const noPlus = normalized.startsWith("+") ? normalized.substring(1) : normalized;
  const withoutCountry = digits.startsWith("1") && digits.length > 1 ? digits.substring(1) : digits;
  return Array.from(new Set([normalized, noPlus, digits, withoutCountry].filter(Boolean)));
};

const findUpcomingBookings = async (phone: string, limit = 5) => {
  const now = Date.now();
  for (const candidate of phoneVariants(phone)) {
    const snapshot = await db
      .collection("bookings")
      .where("passengerPhone", "==", candidate)
      .where("status", "==", "confirmed")
      .where("pickupTimeUtc", ">=", now)
      .orderBy("pickupTimeUtc", "asc")
      .limit(limit)
      .get();
    if (!snapshot.empty) {
      return snapshot.docs;
    }
  }
  return [];
};

const formatCancelToken = (bookingNumber?: number | null) => {
  if (typeof bookingNumber === "number" && Number.isFinite(bookingNumber)) {
    return bookingNumber.toString().padStart(5, "0");
  }
  return "your booking #";
};

const buildOptionsReply = (bookingNumber?: number | null) => {
  const token = formatCancelToken(bookingNumber);
  return `- Valley Airporter SMS Help Desk -

1. For FAQ, Visit: ValleyAirporter.ca/FAQ
2. If you would like to cancel the booking, text: Cancel Booking [${token}]

To resume SMS alerts, reply START.

You can text/call us at anytime at ${HELP_DESK_PHONE}`;
};

export const cancelBooking = async (bookingRef: FirebaseFirestore.DocumentReference) => {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    if (data.status === "canceled") {
      return { alreadyCanceled: true, data }; // Already canceled
    }

    const updatedHistory = Array.isArray(data.statusHistory) ? [...data.statusHistory] : [];
    updatedHistory.push({
      status: "canceled",
      timestamp: admin.firestore.Timestamp.now(),
    });

    tx.update(bookingRef, {
      status: "canceled",
      remind24Sent: true,
      remind10Sent: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      statusHistory: updatedHistory,
    });

    return { alreadyCanceled: false, data };
  });
};

export const notifyCancellation = async (bookingId: string, bookingData: FirebaseFirestore.DocumentData) => {
  const context: SmsBookingContext & {
    passengerPhone?: string | null;
    passengerEmail?: string | null;
  } = {
    bookingId,
    bookingNumber: bookingData.bookingNumber ?? null,
    pickupTimeUtc: extractPickupTimeUtc(bookingData.pickupTimeUtc ?? bookingData.schedule?.pickupTimestamp ?? null),
    schedule: {
      pickupDate: bookingData.schedule?.pickupDate ?? null,
      pickupTime: bookingData.schedule?.pickupTime ?? null,
    },
    trip: {
      origin: bookingData.trip?.origin ?? null,
      originAddress: bookingData.trip?.originAddress ?? null,
      destination: bookingData.trip?.destination ?? null,
      destinationAddress: bookingData.trip?.destinationAddress ?? null,
    },
    passengerName: bookingData.passenger?.primaryPassenger ?? null,
    passengerPhone: bookingData.passengerPhone ?? bookingData.passenger?.phone ?? null,
    passengerEmail: bookingData.passenger?.email ?? null,
    passengerCount: bookingData.trip?.passengerCount ?? null,
    totalCents: bookingData.payment?.totalCents ?? null,
    currency: bookingData.payment?.currency ?? "CAD",
    specialNotes: bookingData.schedule?.notes ?? null,
  };

  const passengerMessage = buildCancellationPassengerMessage(context);
  if (context.passengerPhone) {
    await queueSmsNotification({
      to: context.passengerPhone,
      message: passengerMessage,
      metadata: { bookingId, type: "cancellation" },
    });
  }

  const adminMessage = buildCancellationAdminMessage({ ...context, passengerPhone: context.passengerPhone });
  const smsTargets = ADMIN_SMS_RECIPIENTS.length > 0
    ? ADMIN_SMS_RECIPIENTS
    : normalizeAdminPhone(ADMIN_PHONE)
      ? [normalizeAdminPhone(ADMIN_PHONE)!]
      : [];
  await Promise.all(
    smsTargets.map((to) =>
      queueSmsNotification({
        to,
        message: adminMessage,
        metadata: { bookingId, type: "cancellation-admin" },
      }),
    ),
  );

  const emailBody = buildCancellationEmail(context);
  const subject = `Valley Airporter booking canceled - ${formatBookingTag(context.bookingNumber, bookingId)}`;

  if (context.passengerEmail) {
    await queueEmailNotification({
      to: context.passengerEmail,
      subject,
      text: emailBody,
    });
  }

  await queueEmailNotification({
    to: ADMIN_EMAIL,
    subject,
    text: emailBody,
  });
};

const respond = (res: any, message: string) => {
  res.type("text/xml").send(buildTwiml(message));
};

export const smsInbound = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const { params, asObject, rawBody } = parseBody(req);
  const fromRaw = params.get("From") ?? "";
  const bodyRaw = params.get("Body") ?? "";
  const from = normalizePhone(fromRaw);
  const message = bodyRaw.trim();
  const optOutType = (params.get("OptOutType") ?? "").trim().toUpperCase();

  if (!from) {
    respond(res, DEFAULT_REPLY_HELP);
    return;
  }

  const twilioAuthToken = resolveTwilioAuthToken();
  if (twilioAuthToken) {
    const signature = req.header("x-twilio-signature") ?? "";
    const forwardedProtoRaw = asTrimmedString(req.header("x-forwarded-proto"));
    const forwardedHostRaw = asTrimmedString(req.header("x-forwarded-host"));
    const hostHeader = req.get("host");
    const protoCandidates = new Set<string>();
    if (forwardedProtoRaw) {
      forwardedProtoRaw.split(",").forEach((value) => {
        const trimmed = value.trim();
        if (trimmed) protoCandidates.add(trimmed);
      });
    }
    if (process.env.FUNCTIONS_EMULATOR === "true" && req.protocol) {
      protoCandidates.add(req.protocol);
    }
    protoCandidates.add("https");

    const hostCandidates = new Set<string>();
    if (forwardedHostRaw) {
      forwardedHostRaw.split(",").forEach((value) => {
        const trimmed = value.trim();
        if (trimmed) hostCandidates.add(trimmed);
      });
    }
    if (hostHeader) hostCandidates.add(hostHeader);

    const projectId = asTrimmedString(process.env.GCLOUD_PROJECT);
    const region = asTrimmedString(process.env.FUNCTION_REGION);
    if (projectId && region) {
      hostCandidates.add(`${region}-${projectId}.cloudfunctions.net`);
    }

    const pathCandidates = new Set<string>();
    const originalUrl = req.originalUrl ?? "/";
    const urlValue = typeof req.url === "string" ? req.url : undefined;
    const pathValue = typeof req.path === "string" ? req.path : undefined;
    const forwardedPrefix = asTrimmedString(req.header("x-forwarded-prefix"));
    const functionTarget = asTrimmedString(process.env.FUNCTION_TARGET);

    const pushPath = (value?: string) => {
      if (!value) return;
      pathCandidates.add(value.startsWith("/") ? value : `/${value}`);
    };

    pushPath(originalUrl);
    pushPath(urlValue);
    pushPath(pathValue);
    pushPath("/smsInbound");
    if (forwardedPrefix) pushPath(`${forwardedPrefix.replace(/\/+$/, "")}${originalUrl}`);
    if (functionTarget) {
      pushPath(`/${functionTarget}`);
      pushPath(`/${functionTarget}${originalUrl === "/" ? "" : originalUrl}`);
    }
    pushPath(`/${req.get("function-name") ?? ""}`); // custom header if set

    let valid = false;
    for (const hostCandidate of hostCandidates) {
      for (const proto of protoCandidates) {
        for (const pathCandidate of pathCandidates) {
          const url = `${proto}://${hostCandidate}${pathCandidate}`;
          if (twilio.validateRequest(twilioAuthToken, signature, url, asObject)) {
            valid = true;
            functions.logger.info("Twilio signature validated", { urlTried: url });
            break;
          }
        }
        if (valid) break;
      }
      if (valid) break;
    }

    if (!valid) {
      functions.logger.warn("Twilio signature validation failed", {
        protoCandidates: Array.from(protoCandidates),
        hostCandidates: Array.from(hostCandidates),
        pathCandidates: Array.from(pathCandidates),
      });
      res.status(403).send("Invalid signature");
      return;
    }
  } else {
    functions.logger.warn("TWILIO_AUTH_TOKEN env var not set. Inbound SMS validation skipped.");
  }

  const lower = message.toLowerCase();

  if (HELP_WORDS.has(lower)) {
    respond(res, DEFAULT_REPLY_HELP);
    return;
  }

  if (OPTIONS_WORDS.has(lower)) {
    const bookings = await findUpcomingBookings(from, 1);
    const bookingNumber = bookings.length > 0 ? bookings[0].data()?.bookingNumber ?? null : null;
    respond(res, buildOptionsReply(bookingNumber));
    return;
  }

  const sessionRef = db.collection(SESSION_COLLECTION).doc(sessionIdForPhone(from));
  const sessionSnap = await sessionRef.get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;
  const sessionValid = session && typeof session.expiresAt === "number" && session.expiresAt > Date.now();

  const shouldProcessStop = optOutType === "STOP" || CANCEL_WORDS.has(lower);

  if (shouldProcessStop) {
    const bookings = await findUpcomingBookings(from);
    if (bookings.length === 0) {
      respond(res, "We could not locate any upcoming bookings for this number.");
      if (sessionSnap.exists) await sessionRef.delete();
      return;
    }

    if (bookings.length === 1) {
      const result = await cancelBooking(bookings[0].ref);
      if (!result) {
        respond(res, "We could not cancel that booking. Please contact dispatch.");
        return;
      }
      if (!result.alreadyCanceled) {
        await notifyCancellation(bookings[0].id, result.data ?? {});
      }
      respond(res, "Your booking has been canceled. Reply START to resume alerts or HELP for assistance.");
      if (sessionSnap.exists) await sessionRef.delete();
      return;
    }

    const options = bookings.map((doc) => ({
      bookingId: doc.id,
      bookingNumber: doc.data()?.bookingNumber ?? null,
      pickupTimeUtc: extractPickupTimeUtc(doc.data()?.pickupTimeUtc ?? doc.data()?.schedule?.pickupTimestamp ?? null),
      schedule: {
        pickupDate: doc.data()?.schedule?.pickupDate ?? null,
        pickupTime: doc.data()?.schedule?.pickupTime ?? null,
      },
      trip: {
        origin: doc.data()?.trip?.origin ?? null,
        destination: doc.data()?.trip?.destination ?? null,
      },
    }));

    const lines = options.map((ctx, index) => `${index + 1}) ${summarizeBookingOption(ctx)}`);
    const replyText = `Multiple bookings found. Reply with the number to cancel:\n${lines.join("\n")}`;

    await sessionRef.set({
      phone: from,
      options,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      lastPromptAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    respond(res, replyText);
    return;
  }

  if (sessionValid) {
    const sessionOptions = Array.isArray(session?.options) ? (session!.options as any[]) : [];
    const digit = Number.parseInt(lower, 10);
    if (Number.isNaN(digit) || digit < 1 || digit > sessionOptions.length) {
      respond(res, "Please reply with the number of the booking you want to cancel.");
      return;
    }

    const selected = sessionOptions[digit - 1] as SmsBookingContext;
    const bookingRef = db.collection("bookings").doc(selected.bookingId);
    const result = await cancelBooking(bookingRef);
    if (!result) {
      respond(res, "We could not cancel that booking. Please contact dispatch.");
      await sessionRef.delete();
      return;
    }
    if (!result.alreadyCanceled) {
      await notifyCancellation(selected.bookingId, result.data ?? {});
    }
    await sessionRef.delete();
    respond(res, "Your booking has been canceled. Reply START to resume alerts or HELP for assistance.");
    return;
  }

  if (/^1$/.test(lower) || /\bconfirm\b/.test(lower)) {
    respond(res, "Thanks! Your booking remains confirmed. Reply 2 to cancel if plans change.");
    if (ADMIN_SMS_RECIPIENTS.length === 0 && !ADMIN_PHONE) {
      functions.logger.warn("ADMIN phones not configured; skipping admin SMS.");
      return;
    }
    const targets =
      ADMIN_SMS_RECIPIENTS.length > 0
        ? ADMIN_SMS_RECIPIENTS
        : [normalizeAdminPhone(ADMIN_PHONE) ?? ADMIN_PHONE].filter(Boolean) as string[];
    await Promise.all(
      targets.map((to) =>
        queueSmsNotification({
          to,
          message: `Customer ${from} confirmed by SMS.`,
          metadata: { type: "confirm-admin" },
        }),
      ),
    );
    return;
  }

  respond(res, DEFAULT_REPLY_HELP);
  });
const normalizeAdminPhone = (raw?: string | null) => {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
};

const ADMIN_SMS_RECIPIENTS = Array.from(
  new Set(
    [ADMIN_PHONE, SECONDARY_ADMIN_PHONE, "+16047516688", "+17788780546"]
      .map((value) => normalizeAdminPhone(value))
      .filter((value): value is string => Boolean(value)),
  ),
);
