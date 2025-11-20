import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import { getDrivingDistance, MapsError, MAPS_SERVER_KEY, type LatLng } from "./maps";
import { calculatePricing, type TripDirection } from "./pricing";
import { locationDirectory } from "./data/locationDirectory";
import pricingMatrix from "./data/pricingMatrix.json";
import { queueEmailNotification } from "./notifications";
import { incrementDailyCounter } from "./utils/dailyCounter";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL ?? "info@valleyairporter.ca";

const FALLBACK_PRICE_CAP = 300;
const ABBOTSFORD_ANY_ADDRESS = "Abbotsford (Any Address)";
const TEST_SERVICE_LABEL = "OT";
const FALLBACK_ALLOWED_AREAS = new Set([ABBOTSFORD_ANY_ADDRESS, TEST_SERVICE_LABEL]);

const clampPassengers = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  return Math.min(14, Math.max(1, Math.round(value)));
};

const roundToNearestFive = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value / 5) * 5);
};

const normalizeText = (value: string | null | undefined): string => {
  if (!value) return "";
  const lowered = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  // Expand common abbreviations so "Langley Twp" etc. can match "(Any Address)" entries.
  return lowered
    .replace(/\btwp\b/g, " township")
    .replace(/\btownship\b/g, " township")
    .replace(/\bcity of\b/g, " ")
    .replace(/\bdistrict municipality\b/g, " ")
    .replace(/\bst\b/g, " street")
    .replace(/\brd\b/g, " road");
};

const KNOWN_CITY_OVERRIDES: Record<string, string> = {
  "langley township bc": "Langley (Any Address)",
  "langley bc": "Langley (Any Address)",
  "city of langley": "Langley (Any Address)",
  "abbotsford bc": "Abbotsford (Any Address)",
  "surrey bc": "Surrey (Any Address)",
  "vancouver bc": "Vancouver (Any Address)",
};

type PricingMatrixJson = Record<string, Record<string, Record<string, unknown>>>;

const buildServiceAreaMatchers = () => {
  const labels = new Set<string>();
  const matrix = pricingMatrix as PricingMatrixJson;
  Object.values(matrix).forEach((origins) => {
    Object.keys(origins).forEach((origin) => labels.add(origin));
    Object.values(origins).forEach((destinations) => {
      Object.keys(destinations).forEach((destination) => labels.add(destination));
    });
  });

  return Array.from(labels)
    .filter((label) => /\(Any Address\)/i.test(label))
    .map((label) => {
      const keyword = normalizeText(label.replace(/\(.*?\)/g, " "));
      return {
        label,
        keyword,
      };
    })
    .filter((entry) => entry.keyword.length > 0)
    .sort((a, b) => b.keyword.length - a.keyword.length);
};

const SERVICE_AREA_MATCHERS = buildServiceAreaMatchers();

const TERMINAL_MATCHERS = Object.entries(locationDirectory).map(([label, metadata]) => {
  const keywords = new Set<string>();
  const normalizedLabel = normalizeText(label);
  if (normalizedLabel) keywords.add(normalizedLabel);
  const formattedAddress = normalizeText(metadata.formattedAddress);
  if (formattedAddress) keywords.add(formattedAddress);
  return {
    label,
    keywords: Array.from(keywords).filter((keyword) => keyword.length > 0),
    lat: metadata.latitude,
    lng: metadata.longitude,
    placeIds:
      typeof metadata.placeId === "string" && metadata.placeId.trim().length > 0 ?
        [metadata.placeId.trim()] :
        [],
    proximityRadiusKm: metadata.proximityRadiusKm ?? 3,
  };
});

const computeEstimate = ({
  distanceKm,
  durationMinutes,
  passengers,
}: {
  distanceKm: number;
  durationMinutes: number;
  passengers: number;
}): number => {
  const baseFare = 85; // core shuttle dispatch cost
  const perKm = 2.15;
  const timeCharge = durationMinutes * 0.35;
  const passengerFee = Math.max(0, passengers - 2) * 7.5;
  const distanceSurcharge = distanceKm > 90 ? 25 : 0;

  const rawTotal = baseFare + distanceKm * perKm + timeCharge + passengerFee + distanceSurcharge;
  const rounded = roundToNearestFive(rawTotal);
  return Math.max(75, rounded);
};

const matchServiceArea = (address: string | null | undefined): string | null => {
  const normalized = normalizeText(address);
  if (!normalized) return null;
  const override = KNOWN_CITY_OVERRIDES[normalized];
  if (override) return override;
  const match = SERVICE_AREA_MATCHERS.find((area) => normalized.includes(area.keyword));
  return match?.label ?? null;
};

const haversineDistanceKm = (a: LatLng, b: { latitude: number; longitude: number }): number => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.lat);
  const dLng = toRad(b.longitude - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const matchTerminal = (
  address: string | null | undefined,
  coords?: LatLng | null,
  placeId?: string | null,
): { label: string } | null => {
  if (placeId) {
    const matchById = TERMINAL_MATCHERS.find((terminal) => terminal.placeIds.includes(placeId));
    if (matchById) return { label: matchById.label };
  }
  const normalized = normalizeText(address);
  if (!normalized) return null;
  const match = TERMINAL_MATCHERS.find((terminal) =>
    terminal.keywords.some((keyword) => normalized.includes(keyword)),
  );
  if (match) return { label: match.label };

  if (coords) {
    const proximityMatch = TERMINAL_MATCHERS.find((terminal) => {
      if (typeof terminal.lat !== "number" || typeof terminal.lng !== "number") return false;
      const threshold = typeof terminal.proximityRadiusKm === "number" ? terminal.proximityRadiusKm : 3;
      return haversineDistanceKm(coords, { latitude: terminal.lat, longitude: terminal.lng }) <= threshold;
    });
    if (proximityMatch) {
      return { label: proximityMatch.label };
    }
  }

  return null;
};

const determineMatrixRoute = ({
  pickupAddress,
  dropoffAddress,
  pickupCoords,
  dropoffCoords,
  pickupPlaceId,
  dropoffPlaceId,
  pickupAreaOverride,
  dropoffAreaOverride,
}: {
  pickupAddress: string;
  dropoffAddress: string;
  pickupCoords?: LatLng | null;
  dropoffCoords?: LatLng | null;
  pickupPlaceId?: string | null;
  dropoffPlaceId?: string | null;
  pickupAreaOverride?: string | null;
  dropoffAreaOverride?: string | null;
}):
  | {
      direction: TripDirection;
      originLabel: string;
      destinationLabel: string;
    }
  | null => {
  const pickupTerminal = matchTerminal(pickupAddress, pickupCoords, pickupPlaceId);
  const dropoffTerminal = matchTerminal(dropoffAddress, dropoffCoords, dropoffPlaceId);
  const pickupArea = pickupAreaOverride ?? matchServiceArea(pickupAddress);
  const dropoffArea = dropoffAreaOverride ?? matchServiceArea(dropoffAddress);

  if (dropoffTerminal && pickupArea) {
    return {
      direction: "To the Airport",
      originLabel: pickupArea,
      destinationLabel: dropoffTerminal.label,
    };
  }

  if (pickupTerminal && dropoffArea) {
    return {
      direction: "From the Airport",
      originLabel: pickupTerminal.label,
      destinationLabel: dropoffArea,
    };
  }

  return null;
};

const parseLatLng = (value: unknown): LatLng | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as { lat?: unknown; lng?: unknown };
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
};

export const quickQuote = onRequest(
  {
    cors: true,
    invoker: "public",
    region: "us-central1",
    secrets: [MAPS_SERVER_KEY],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    try {
      const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
      const pickupAddress =
        typeof payload.pickupAddress === "string" ? payload.pickupAddress.trim() : "";
      const dropoffAddress =
        typeof payload.dropoffAddress === "string" ? payload.dropoffAddress.trim() : "";
      const passengers = clampPassengers(Number(payload.passengers));
      const pickupPlaceId =
        typeof payload.pickupPlaceId === "string" ? payload.pickupPlaceId.trim() || null : null;
      const dropoffPlaceId =
        typeof payload.dropoffPlaceId === "string" ? payload.dropoffPlaceId.trim() || null : null;
      const pickupLatLng = parseLatLng(payload.pickupLatLng);
      const dropoffLatLng = parseLatLng(payload.dropoffLatLng);

      if (pickupAddress.length < 5) {
        res.status(400).json({ error: "Enter a pickup address" });
        return;
      }

      if (dropoffAddress.length < 5) {
        res.status(400).json({ error: "Enter a dropoff address" });
        return;
      }

      const distance = await getDrivingDistance({
        origin: pickupLatLng ?? pickupAddress,
        destination: dropoffLatLng ?? dropoffAddress,
      });

      const pickupArea = matchServiceArea(pickupAddress);
      const dropoffArea = matchServiceArea(dropoffAddress);

      const matrixRoute = determineMatrixRoute({
        pickupAddress,
        dropoffAddress,
        pickupCoords: pickupLatLng,
        dropoffCoords: dropoffLatLng,
        pickupPlaceId,
        dropoffPlaceId,
        pickupAreaOverride: pickupArea,
        dropoffAreaOverride: dropoffArea,
      });

      let pricingSource: "matrix" | "fallback" = "fallback";
      let matrixQuote: number | null = null;

      if (matrixRoute) {
        try {
          const pricing = await calculatePricing({
            direction: matrixRoute.direction,
            origin: matrixRoute.originLabel,
            destination: matrixRoute.destinationLabel,
            passengerCount: passengers,
            originAddress: pickupAddress,
            destinationAddress: dropoffAddress,
            originLatLng: pickupLatLng ?? null,
            destinationLatLng: dropoffLatLng ?? null,
          });

          if (typeof pricing.baseRate === "number") {
            matrixQuote = Math.round(pricing.baseRate);
            pricingSource = "matrix";
          }
        } catch (pricingError) {
          logger.warn("quickQuote.matrix_pricing_failed", {
            message: pricingError instanceof Error ? pricingError.message : pricingError,
            route: matrixRoute,
          });
        }
      }

      const fallbackAmount =
        matrixQuote == null &&
        (Boolean(pickupArea && FALLBACK_ALLOWED_AREAS.has(pickupArea)) ||
          Boolean(dropoffArea && FALLBACK_ALLOWED_AREAS.has(dropoffArea))) ?
          computeEstimate({
            distanceKm: distance.distanceKm,
            durationMinutes: distance.durationMinutes,
            passengers,
          }) :
          null;
      const fallbackSuppressed =
        pricingSource === "fallback" &&
        (fallbackAmount == null || fallbackAmount > FALLBACK_PRICE_CAP);
      const amount = matrixQuote ?? fallbackAmount ?? 0;

      const recordedEstimate = matrixQuote ?? fallbackAmount ?? null;
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const docData = {
        pickupAddress,
        pickupPlaceId,
        pickupLocation: pickupLatLng
          ? new admin.firestore.GeoPoint(pickupLatLng.lat, pickupLatLng.lng)
          : null,
        dropoffAddress,
        dropoffPlaceId,
        dropoffLocation: dropoffLatLng
          ? new admin.firestore.GeoPoint(dropoffLatLng.lat, dropoffLatLng.lng)
          : null,
        passengers,
        distanceKm: distance.distanceKm,
        durationMinutes: distance.durationMinutes,
        estimate: recordedEstimate,
        currency: "CAD",
        pricingSource,
        suppressed: fallbackSuppressed,
        matrixDirection: matrixRoute?.direction ?? null,
        matrixOrigin: matrixRoute?.originLabel ?? null,
        matrixDestination: matrixRoute?.destinationLabel ?? null,
        createdAt: timestamp,
        userAgent: req.get("user-agent") ?? null,
        referer: req.get("referer") ?? null,
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
          req.socket.remoteAddress ??
          null,
        a1: pickupAddress,
        a2: dropoffAddress,
        a3: passengers,
        a4: recordedEstimate,
        a5: timestamp,
      };

      const docRef = await db.collection("quickQuoteLogs").add(docData);
      await incrementDailyCounter("quickQuoteLogs");

      if (pricingSource !== "matrix") {
        void notifyQuickQuoteFallback({
          pickupAddress,
          dropoffAddress,
          passengers,
          estimate: amount,
          pricingSource,
          logId: docRef.id,
        });
      }

      logger.info("quickQuote.logged", { id: docRef.id, passengers, distance: distance.distanceKm });

      if (fallbackSuppressed) {
        res.status(409).json({
          error: "No price available online. We've notified dispatch.",
          logId: docRef.id,
        });
        return;
      }

      res.json({
        ok: true,
        id: docRef.id,
        estimate: {
          amount,
          currency: "CAD",
        },
        distanceKm: distance.distanceKm,
        durationMinutes: distance.durationMinutes,
        passengers,
        pricingSource,
      });
    } catch (error) {
      if (error instanceof MapsError) {
        logger.warn("quickQuote.maps_error", { message: error.message, details: error.details });
        res.status(error.status).json({ error: error.message });
        return;
      }

      logger.error("quickQuote.failed", error);
      res.status(500).json({ error: "UNABLE_TO_GENERATE_QUOTE" });
    }
  },
);

const notifyQuickQuoteFallback = async ({
  pickupAddress,
  dropoffAddress,
  passengers,
  estimate,
  pricingSource,
  logId,
}: {
  pickupAddress: string;
  dropoffAddress: string;
  passengers: number;
  estimate: number;
  pricingSource: string;
  logId: string;
}) => {
  if (!ADMIN_EMAIL) return;
  try {
    await queueEmailNotification({
      to: ADMIN_EMAIL,
      subject: "Quick quote fallback used",
      text: [
        `A quick quote fell back to ${pricingSource}.`,
        `Pickup: ${pickupAddress}`,
        `Drop-off: ${dropoffAddress}`,
        `Passengers: ${passengers}`,
        `Estimate: $${estimate.toFixed(2)}`,
        `Log ID: ${logId}`,
      ].join("\n"),
    });
  } catch (error) {
    logger.warn("quickQuote.notify_admin_failed", {
      error: error instanceof Error ? error.message : error,
    });
  }
};
