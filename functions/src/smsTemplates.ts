import * as functions from "firebase-functions";
import type { Timestamp } from "firebase-admin/firestore";
import { parseDateTimeInTimeZone, SERVICE_TIME_ZONE } from "./utils/timezone";

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

const DISPATCH_PHONE =
  asTrimmedString(process.env.DISPATCH_PHONE) ??
  asTrimmedString(functionsConfig?.dispatch?.phone) ??
  "(604) 751-6688";
const TIME_ZONE = SERVICE_TIME_ZONE;
const OUTBOUND_HELP_HINT =
  "\nText OPTIONS for help, STOP to cancel reminders, or AGENT to forward your text to a live agent.";

const POI_LABELS = new Set([
  "Abbotsford International Airport (YXX)",
  "Bellingham International Airport (BLI)",
  "Canada Place Cruise Terminal in Vancouver",
  "Horseshoe Bay Ferry Terminal in West Vancouver",
  "King George Skytrain Station in Surrey",
  "Tsawwassen Ferry Terminal in Delta",
  "Vancouver International Airport (YVR)",
]);

export interface SmsBookingContext {
  bookingId: string;
  bookingNumber?: number | null;
  pickupTimeUtc?: number | null;
  schedule?: {
    pickupDate?: string | null;
    pickupTime?: string | null;
  } | null;
  trip?: {
    origin?: string | null;
    originAddress?: string | null;
    destination?: string | null;
    destinationAddress?: string | null;
  } | null;
  passengerName?: string | null;
  passengerCount?: number | null;
  passengerPhone?: string | null;
  passengerEmail?: string | null;
  specialNotes?: string | null;
  totalCents?: number | null;
  currency?: string | null;
}

const scheduleFallback = (schedule?: { pickupDate?: string | null; pickupTime?: string | null } | null) => {
  if (!schedule) return undefined;
  return {
    date: schedule.pickupDate ?? undefined,
    time: schedule.pickupTime ?? undefined,
  };
};

const formatDateTime = (
  utcMs?: number | null,
  fallback?: { date?: string | null; time?: string | null },
  includeDow = true,
) => {
  if (utcMs && Number.isFinite(utcMs)) {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        weekday: includeDow ? "short" : undefined,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return formatter.format(new Date(utcMs));
    } catch {
      // fall through to fallback
    }
  }
  const date = fallback?.date ?? "";
  const time = fallback?.time ?? "";
  return `${date} ${time}`.trim();
};

const formatRoute = (trip?: { origin?: string | null; destination?: string | null }) => {
  const origin = trip?.origin?.trim();
  const destination = trip?.destination?.trim();
  if (origin && destination) return `${origin} → ${destination}`;
  return origin || destination || "your trip";
};

const formatLocation = (label?: string | null, address?: string | null) => {
  const trimmedLabel = label?.trim();
  const trimmedAddress = address?.trim();
  if (trimmedLabel && POI_LABELS.has(trimmedLabel)) {
    return trimmedLabel;
  }
  if (trimmedAddress) {
    if (trimmedLabel && trimmedLabel.length > 0) {
      return `${trimmedLabel} • ${trimmedAddress}`;
    }
    return trimmedAddress;
  }
  return trimmedLabel ?? "—";
};

const formatCurrency = (cents?: number | null, currency = "CAD") => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const rounded = Math.round(cents / 100);
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(rounded);
  } catch {
    return `$${rounded.toFixed(0)}`;
  }
};

const needsVehicleLocationReminder = (origin?: string | null) => {
  if (!origin) return false;
  const normalized = origin.toLowerCase();
  return (
    normalized.includes("vancouver international airport") ||
    normalized.includes("(yvr)") ||
    normalized.includes("abbotsford international airport") ||
    normalized.includes("(yxx)")
  );
};

export const formatBookingTag = (bookingNumber?: number | null, bookingId?: string) => {
  if (typeof bookingNumber === "number" && Number.isFinite(bookingNumber)) {
    return `Booking #${bookingNumber}`;
  }
  if (bookingId) {
    return `Booking ${bookingId.substring(0, 8).toUpperCase()}`;
  }
  return "Your booking";
};

export const buildConfirmationMessage = (ctx: SmsBookingContext) => {
  const when = formatDateTime(ctx.pickupTimeUtc, scheduleFallback(ctx.schedule ?? undefined));
  const from = formatLocation(ctx.trip?.origin ?? null, ctx.trip?.originAddress ?? null);
  const to = formatLocation(ctx.trip?.destination ?? null, ctx.trip?.destinationAddress ?? null);
  const passengerName = ctx.passengerName?.trim() || "Valley Airporter Passenger";
  const bookingNumberLabel =
    typeof ctx.bookingNumber === "number" && Number.isFinite(ctx.bookingNumber)
      ? `booking #${ctx.bookingNumber.toString().padStart(5, "0")}`
      : ctx.bookingId
        ? `booking ${ctx.bookingId.substring(0, 8).toUpperCase()}`
        : "booking";

  const lines = [
    `New ${bookingNumberLabel} confirmed.`,
    "Automated Message For:",
    passengerName,
    `${from} → ${to}`,
    when,
  ];

  return `${lines.join("\n")}${OUTBOUND_HELP_HINT}`;
};

export const buildReminderMessage = (ctx: SmsBookingContext, timing: "24h" | "10h") => {
  const includeDow = timing === "24h";
  const when = formatDateTime(ctx.pickupTimeUtc, scheduleFallback(ctx.schedule ?? undefined), includeDow);
  const tag = formatBookingTag(ctx.bookingNumber, ctx.bookingId);
  const from = formatLocation(ctx.trip?.origin ?? null, ctx.trip?.originAddress ?? null);
  const to = formatLocation(ctx.trip?.destination ?? null, ctx.trip?.destinationAddress ?? null);
  const locationLine = needsVehicleLocationReminder(ctx.trip?.origin ?? null)
    ? "\nPlease check your email for our vehicle location."
    : "";

  if (timing === "24h") {
    return `${tag} reminder: pickup is tomorrow ${when}.
Pickup: ${from}
Drop-off: ${to}
${locationLine}${OUTBOUND_HELP_HINT}`;
  }
  return `${tag} reminder: pickup today at ${when}.
Pickup: ${from}
Drop-off: ${to}
${locationLine}${OUTBOUND_HELP_HINT}`;
};

export const buildCancellationPassengerMessage = (ctx: SmsBookingContext) => {
  const when = formatDateTime(ctx.pickupTimeUtc, scheduleFallback(ctx.schedule ?? undefined));
  const route = formatRoute(ctx.trip ?? undefined);
  const tag = formatBookingTag(ctx.bookingNumber, ctx.bookingId);
  return `${tag} has been canceled.
Date: ${when}
Route: ${route}
No further reminders will be sent. Need to rebook? valleyairporter.ca.${OUTBOUND_HELP_HINT}`;
};

export const buildCancellationAdminMessage = (ctx: SmsBookingContext & { passengerPhone?: string | null }) => {
  const when = formatDateTime(ctx.pickupTimeUtc, scheduleFallback(ctx.schedule ?? undefined));
  const route = formatRoute(ctx.trip ?? undefined);
  const tag = formatBookingTag(ctx.bookingNumber, ctx.bookingId);
  const passenger = ctx.passengerName ? ctx.passengerName.trim() : "Passenger";
  const phone = ctx.passengerPhone ? ` (${ctx.passengerPhone})` : "";
  return `${tag} canceled by ${passenger}${phone}. ${when} • ${route}.`;
};

export const buildCancellationEmail = (
  ctx: SmsBookingContext & {
    passengerEmail?: string | null;
    passengerPhone?: string | null;
  },
) => {
  const fallbackSchedule = ctx.schedule ?? undefined;
  const parsedSchedule = fallbackSchedule?.pickupDate && fallbackSchedule?.pickupTime
    ? parseDateTimeInTimeZone(fallbackSchedule.pickupDate, fallbackSchedule.pickupTime)
    : null;
  const when = parsedSchedule
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(parsedSchedule)
    : formatDateTime(ctx.pickupTimeUtc, scheduleFallback(fallbackSchedule));
  const tag = formatBookingTag(ctx.bookingNumber, ctx.bookingId);
  const from = formatLocation(ctx.trip?.origin ?? null, ctx.trip?.originAddress ?? null);
  const to = formatLocation(ctx.trip?.destination ?? null, ctx.trip?.destinationAddress ?? null);
  return (
    `Booking #${ctx.bookingNumber ?? ctx.bookingId} has been cancelled via SMS by the passenger.\n\n` +
    `Booking Date: ${when}\n` +
    `From: ${from}\n` +
    `To: ${to}\n\n` +
    "To book again, please visit: ValleyAirporter.ca/booking"
  );
};

export const summarizeBookingOption = (ctx: SmsBookingContext) => {
  const when = formatDateTime(ctx.pickupTimeUtc, scheduleFallback(ctx.schedule ?? undefined));
  const from = formatLocation(ctx.trip?.origin ?? null, ctx.trip?.originAddress ?? null);
  const to = formatLocation(ctx.trip?.destination ?? null, ctx.trip?.destinationAddress ?? null);
  const route = `${from} → ${to}`;
  const tag = formatBookingTag(ctx.bookingNumber, ctx.bookingId);
  return `${tag} • ${when} • ${route}`;
};

export const extractPickupTimeUtc = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && typeof (value as Timestamp).toMillis === "function") {
    try {
      return (value as Timestamp).toMillis();
    } catch {
      return null;
    }
  }
  return null;
};
