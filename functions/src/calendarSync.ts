import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import { calendar_v3, google } from "googleapis";
import { createHash } from "crypto";
import { getDrivingDistance, MAPS_SERVER_KEY, type LatLng } from "./maps";

if (!admin.apps.length) {
  admin.initializeApp();
}

const DEFAULT_TIME_ZONE = process.env.SERVICE_TIME_ZONE || "America/Vancouver";
const OPS_CAL_ID =
  process.env.OPS_CAL_ID ||
  "53a9a502add992d6088ad81e929f24ad8bf92fe7c605b6ec6ab324e469487971@group.calendar.google.com";

const calendarScopes = ["https://www.googleapis.com/auth/calendar"];
const auth = new google.auth.GoogleAuth({ scopes: calendarScopes });
let calendarClientPromise: Promise<calendar_v3.Calendar> | null = null;

type BookingDoc = admin.firestore.DocumentData & {
  bookingNumber?: number;
  pickupTimeUtc?: number;
  trip?: {
    origin?: string | null;
    originAddress?: string | null;
    originLat?: number | null;
    originLng?: number | null;
    destination?: string | null;
    destinationAddress?: string | null;
    destinationLat?: number | null;
    destinationLng?: number | null;
    passengerCount?: number | null;
  };
  schedule?: {
    pickupTimestamp?: admin.firestore.Timestamp | number | null;
    notes?: string | null;
    flightNumber?: string | null;
  };
  passenger?: {
    primaryPassenger?: string | null;
    email?: string | null;
    phone?: string | null;
    baggage?: string | null;
    specialNotes?: string | null;
  };
  payment?: {
    totalCents?: number | null;
    currency?: string | null;
    preference?: string | null;
  };
  pricing?: {
    distanceDetails?: {
      km?: number;
      durationMinutes?: number;
    };
  };
  status?: string | null;
  calendar?: {
    eventId?: string | null;
    calendarId?: string | null;
    syncedHash?: string | null;
    status?: string | null;
    syncedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp | Date | null;
    lastError?: string | null;
    estimate?: {
      driveMinutes?: number | null;
      durationMinutes?: number | null;
      distanceKm?: number | null;
    };
  };
  driverAssignments?: Record<
    string,
    {
      driverId?: string | null;
      driverName?: string | null;
      driverEmail?: string | null;
      driverPhone?: string | null;
      calendarId?: string | null;
      calendarEventId?: string | null;
      syncedHash?: string | null;
      syncedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp | Date | null;
      lastError?: string | null;
      assignedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp | Date | null;
    } | null
  > | null;
};

const STATUS_COLOR: Record<string, string> = {
  cancelled: "11", // red
  confirmed: "2", // green
  pending: "5", // yellow
};

async function getCalendarClient() {
  if (!calendarClientPromise) {
    calendarClientPromise = (async () => {
      const authClient = await auth.getClient();
      return google.calendar({ version: "v3", auth: authClient as any });
    })();
  }
  return calendarClientPromise;
}

const formatCurrency = (amountCents?: number | null, currency = "CAD") => {
  if (typeof amountCents !== "number") return "TBD";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
};

const formatBookingNumber = (value?: number | null) => {
  if (typeof value === "number") {
    return value.toString().padStart(5, "0");
  }
  return "XXXXX";
};

const resolveDateFromBooking = (booking: BookingDoc): Date => {
  if (typeof booking.pickupTimeUtc === "number" && Number.isFinite(booking.pickupTimeUtc)) {
    return new Date(booking.pickupTimeUtc);
  }
  const ts = booking.schedule?.pickupTimestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return new Date(ts);
  }
  if (ts && typeof ts === "object" && "toDate" in ts && typeof ts.toDate === "function") {
    return ts.toDate() as Date;
  }
  return new Date();
};

type TripLatKey = "originLat" | "destinationLat";
type TripLngKey = "originLng" | "destinationLng";
type TripAddressKey = "originAddress" | "destinationAddress";

const resolvePlaceInput = (
  trip: BookingDoc["trip"],
  kind: "origin" | "destination",
): string | LatLng | null => {
  if (!trip) return null;
  const latKey: TripLatKey = kind === "origin" ? "originLat" : "destinationLat";
  const lngKey: TripLngKey = kind === "origin" ? "originLng" : "destinationLng";
  const addressKey: TripAddressKey = kind === "origin" ? "originAddress" : "destinationAddress";
  const labelKey = kind === "origin" ? "origin" : "destination";

  const lat = trip[latKey];
  const lng = trip[lngKey];
  if (typeof lat === "number" && typeof lng === "number") {
    return { lat, lng };
  }
  const address = trip[addressKey];
  if (address && address.trim().length > 0) {
    return address.trim();
  }
  const fallbackLabel = trip[labelKey];
  return fallbackLabel && fallbackLabel.trim().length > 0 ? fallbackLabel.trim() : null;
};

const detectPickupAirport = (trip?: BookingDoc["trip"]): "YVR" | "YXX" | null => {
  if (!trip) return null;
  const text = [trip.origin ?? "", trip.originAddress ?? ""].join(" ").toLowerCase();
  const normalized = text.replace(/\s+/g, " ");
  if (normalized.includes("vancouver international airport") || normalized.includes(" yvr") || normalized.includes("(yvr)") || normalized.includes("yvr ")) {
    return "YVR";
  }
  if (normalized.includes("abbotsford international airport") || normalized.includes(" yxx") || normalized.includes("(yxx)") || normalized.includes("yxx ")) {
    return "YXX";
  }
  return null;
};

const buildDescription = (bookingId: string, booking: BookingDoc, fareLabel: string) => {
  const pickup = booking.trip?.originAddress ?? booking.trip?.origin ?? "Pickup TBD";
  const dropoff = booking.trip?.destinationAddress ?? booking.trip?.destination ?? "Dropoff TBD";
  const passengerName = booking.passenger?.primaryPassenger ?? "Customer";
  const paxCount = booking.trip?.passengerCount ?? "N/A";
  const phone = booking.passenger?.phone ?? "N/A";
  const email = booking.passenger?.email ?? "N/A";
  const baggage = booking.passenger?.baggage ?? "Normal";
  const passengerNotes = booking.passenger?.specialNotes ?? null;
  const scheduleNotes = booking.schedule?.notes ?? null;
  const status = booking.status ?? "pending";
  const paymentPref = booking.payment?.preference ?? "pay_on_arrival";
  const bookingReference = booking.bookingNumber
    ? formatBookingNumber(booking.bookingNumber)
    : bookingId;
  const lines = [
    `Booking #: ${bookingReference}`,
    `Status: ${status}`,
    `Passenger: ${passengerName}`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    `Passengers: ${paxCount}`,
    `Baggage: ${baggage}`,
    booking.schedule?.flightNumber ? `Flight: ${booking.schedule.flightNumber}` : null,
    `Pickup: ${pickup}`,
    `Drop-off: ${dropoff}`,
    `Fare: ${fareLabel}`,
    `Payment Preference: ${paymentPref}`,
    passengerNotes ? `Passenger Notes: ${passengerNotes}` : null,
    scheduleNotes ? `Schedule Notes: ${scheduleNotes}` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
};

const buildEventSummary = (booking: BookingDoc, fareLabel: string) => {
  const bookingNumber = formatBookingNumber(booking.bookingNumber);
  const passengerName = booking.passenger?.primaryPassenger ?? "Customer";
  return `Booking #${bookingNumber} - ${passengerName} - ${fareLabel}`;
};

const computeHash = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const resolveColorId = (status?: string | null) => {
  if (!status) return STATUS_COLOR.pending;
  const normalized = status.toLowerCase();
  return STATUS_COLOR[normalized] ?? STATUS_COLOR.pending;
};

const isNotFoundError = (error: unknown) => {
  const code =
    (error as { code?: number })?.code ??
    (error as { status?: number })?.status ??
    Number((error as { response?: { status?: number } }).response?.status);
  return code === 404;
};

const sanitizeEventId = (bookingId: string) => {
  const digest = createHash("sha256").update(bookingId).digest("hex");
  return `b${digest}`.slice(0, 1024);
};

const sanitizeDriverEventId = (bookingId: string, driverId: string) => {
  return sanitizeEventId(`${bookingId}_${driverId}`);
};

const buildEventPayload = async (
  bookingId: string,
  booking: BookingDoc,
  calendarId: string,
): Promise<{
  event: {
    id: string;
    summary: string;
    description: string;
    location?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees?: Array<{ email: string }>;
    colorId?: string;
  };
  metadata: {
    durationMinutes: number;
    driveMinutes: number;
    distanceKm: number | null;
  };
  hash: string;
  eventId: string;
}> => {
  const start = resolveDateFromBooking(booking);
  const startIso = start.toISOString();

  const originInput = resolvePlaceInput(booking.trip, "origin");
  const destinationInput = resolvePlaceInput(booking.trip, "destination");
  let driveMinutes = booking.pricing?.distanceDetails?.durationMinutes ?? null;
  let distanceKm = booking.pricing?.distanceDetails?.km ?? null;

  if ((!driveMinutes || !distanceKm) && originInput && destinationInput) {
    try {
      const distance = await getDrivingDistance({
        origin: originInput,
        destination: destinationInput,
      });
      driveMinutes = distance.durationMinutes;
      distanceKm = distance.distanceKm;
    } catch (error) {
      logger.warn("calendarSync: distance lookup failed", {
        bookingId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  const estimatedDrive = typeof driveMinutes === "number" ? driveMinutes : 60;
  const pickupAirport = detectPickupAirport(booking.trip);
  let bufferMinutes = 30;
  if (pickupAirport === "YVR") {
    bufferMinutes += 60;
  } else if (pickupAirport === "YXX") {
    bufferMinutes += 30;
  }
  const totalMinutes = estimatedDrive + bufferMinutes;
  const end = new Date(start.getTime() + totalMinutes * 60000);

  const fareLabel = formatCurrency(
    booking.payment?.totalCents ?? null,
    booking.payment?.currency ?? "CAD",
  );
  const dropoffLocation = booking.trip?.destinationAddress ?? booking.trip?.destination ?? "";

  const eventId = sanitizeEventId(bookingId);
  const event = {
    id: eventId,
    summary: buildEventSummary(booking, fareLabel),
    description: buildDescription(bookingId, booking, fareLabel),
    location: dropoffLocation || undefined,
    start: { dateTime: startIso, timeZone: DEFAULT_TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: DEFAULT_TIME_ZONE },
    colorId: resolveColorId(booking.status),
  };

  const hash = computeHash({
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    colorId: event.colorId,
  });

  return {
    event,
    metadata: {
      durationMinutes: totalMinutes,
      driveMinutes: typeof driveMinutes === "number" ? driveMinutes : estimatedDrive,
      distanceKm: distanceKm ?? null,
    },
    hash,
    eventId,
  };
};

async function syncCalendarForBooking(
  bookingId: string,
  booking: BookingDoc,
  ref: admin.firestore.DocumentReference<BookingDoc>,
  previousBooking?: BookingDoc | null,
) {
  const status = (booking.status ?? "pending").toLowerCase();
  const calendar = await getCalendarClient();
  const calendarId = OPS_CAL_ID;
  const existingHash = booking.calendar?.syncedHash ?? null;

  if (status === "cancelled" || status === "canceled") {
    const { event, hash, eventId } = await buildEventPayload(bookingId, booking, calendarId);
    const cancelledSummary = event.summary.startsWith("CANCELLED")
      ? event.summary
      : `CANCELLED – ${event.summary}`;
    try {
      await calendar.events.update({
        calendarId,
        eventId,
        requestBody: {
          ...event,
          summary: cancelledSummary,
          colorId: STATUS_COLOR.cancelled,
        },
      });
    } catch (error) {
      logger.error("calendarSync: failed to mark event cancelled", {
        bookingId,
        error: error instanceof Error ? error.message : error,
      });
    }

    await ref.set(
      {
        calendar: {
          eventId,
          calendarId,
          status: "cancelled",
          syncedHash: hash,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastError: null,
        },
      } as admin.firestore.DocumentData,
      { merge: true },
    );
    return;
  }

  const { event, metadata, hash, eventId } = await buildEventPayload(bookingId, booking, calendarId);
  if (existingHash === hash) {
    return;
  }

  try {
    await calendar.events.update({
      calendarId,
      eventId,
      requestBody: event,
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      await calendar.events.insert({
        calendarId,
        requestBody: event,
      });
    } else {
      logger.error("calendarSync: failed to upsert event", {
        bookingId,
        error: error instanceof Error ? error.message : error,
      });
      await ref.set(
        {
          calendar: {
            eventId,
            calendarId,
            status,
            syncedAt: admin.firestore.FieldValue.serverTimestamp(),
            syncedHash: existingHash,
            lastError: error instanceof Error ? error.message : String(error),
          },
        } as admin.firestore.DocumentData,
        { merge: true },
      );
      throw error;
    }
  }

  await ref.set(
    {
      calendar: {
        eventId,
        calendarId,
        status,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        syncedHash: hash,
        lastError: null,
        estimate: {
          driveMinutes: metadata.driveMinutes,
          durationMinutes: metadata.durationMinutes,
          distanceKm: metadata.distanceKm,
        },
      },
    } as admin.firestore.DocumentData,
    { merge: true },
  );

  await syncDriverCalendarEvents({
    bookingId,
    booking,
    previousBooking,
    calendar,
    baseEvent: event,
    hash,
    ref,
  });
}

type DriverAssignmentEntry = NonNullable<NonNullable<BookingDoc["driverAssignments"]>[string]>;

const normalizeDriverAssignments = (
  value?: BookingDoc["driverAssignments"] | null,
): Record<string, DriverAssignmentEntry> => {
  if (!value) return {};
  return Object.entries(value).reduce<Record<string, DriverAssignmentEntry>>((acc, [key, entry]) => {
    if (!entry) return acc;
    acc[key] = entry;
    return acc;
  }, {});
};

const syncDriverCalendarEvents = async ({
  bookingId,
  booking,
  previousBooking,
  calendar,
  baseEvent,
  hash,
  ref,
}: {
  bookingId: string;
  booking: BookingDoc;
  previousBooking?: BookingDoc | null;
  calendar: calendar_v3.Calendar;
  baseEvent: {
    summary: string;
    description: string;
    location?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    colorId?: string;
  };
  hash: string;
  ref: admin.firestore.DocumentReference<BookingDoc>;
}) => {
  const currentAssignments = normalizeDriverAssignments(booking.driverAssignments);
  const previousAssignments = normalizeDriverAssignments(previousBooking?.driverAssignments);
  const removedDrivers = Object.keys(previousAssignments).filter(
    (driverId) => !currentAssignments[driverId],
  );

  for (const driverId of removedDrivers) {
    const previous = previousAssignments[driverId];
    if (!previous?.calendarId || !previous?.calendarEventId) {
      continue;
    }
    try {
      await calendar.events.delete({
        calendarId: previous.calendarId,
        eventId: previous.calendarEventId,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.error("calendarSync: failed to delete driver event", {
          bookingId,
          driverId,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  const updates: Record<string, unknown> = {};
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  for (const [driverId, assignment] of Object.entries(currentAssignments)) {
    const calendarId = assignment?.calendarId;
    if (!calendarId) continue;
    const driverEventId =
      assignment?.calendarEventId ?? sanitizeDriverEventId(bookingId, driverId);
    const existingHash = assignment?.syncedHash ?? null;
    if (existingHash === hash && assignment?.calendarEventId) {
      continue;
    }
    const driverEvent = {
      id: driverEventId,
      summary: baseEvent.summary,
      description: baseEvent.description,
      location: baseEvent.location,
      start: baseEvent.start,
      end: baseEvent.end,
      colorId: baseEvent.colorId,
    };

    try {
      await calendar.events.update({
        calendarId,
        eventId: driverEventId,
        requestBody: driverEvent,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        await calendar.events.insert({
          calendarId,
          requestBody: driverEvent,
        });
      } else {
        logger.error("calendarSync: failed to sync driver event", {
          bookingId,
          driverId,
          error: error instanceof Error ? error.message : error,
        });
        updates[`driverAssignments.${driverId}.lastError`] =
          error instanceof Error ? error.message : String(error);
        continue;
      }
    }

    updates[`driverAssignments.${driverId}.calendarEventId`] = driverEventId;
    updates[`driverAssignments.${driverId}.calendarId`] = calendarId;
    updates[`driverAssignments.${driverId}.syncedHash`] = hash;
    updates[`driverAssignments.${driverId}.syncedAt`] = serverTimestamp;
    updates[`driverAssignments.${driverId}.lastError`] = null;
  }

  if (Object.keys(updates).length > 0) {
    await ref.set(updates as admin.firestore.DocumentData, { merge: true });
  }
};

export const bookingCreatedCalendarSync = onDocumentCreated(
  {
    document: "bookings/{bookingId}",
    region: "us-central1",
    timeoutSeconds: 300,
    secrets: [MAPS_SERVER_KEY] as (string | typeof MAPS_SERVER_KEY)[],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() as BookingDoc;
    await syncCalendarForBooking(event.params.bookingId, data, snap.ref, null);
  },
);

export const bookingUpdatedCalendarSync = onDocumentUpdated(
  {
    document: "bookings/{bookingId}",
    region: "us-central1",
    timeoutSeconds: 300,
    secrets: [MAPS_SERVER_KEY] as (string | typeof MAPS_SERVER_KEY)[],
  },
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after) return;
    const data = after.data() as BookingDoc;
    const previous = before ? (before.data() as BookingDoc) : null;
    await syncCalendarForBooking(event.params.bookingId, data, after.ref, previous);
  },
);
