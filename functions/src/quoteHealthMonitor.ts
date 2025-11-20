import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { queueEmailNotification } from "./notifications";
import { SERVICE_TIME_ZONE } from "./utils/timezone";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const TZ = SERVICE_TIME_ZONE ?? "America/Vancouver";
const ADMIN_EMAIL = (process.env.ADMIN_NOTIFICATION_EMAIL ?? process.env.DAILY_ADMIN_EMAIL ?? "").trim();
const MONITOR_CRON = process.env.QUOTE_HEALTH_CRON ?? "every 30 minutes";
const LOOKBACK_MINUTES = Number(process.env.QUOTE_HEALTH_LOOKBACK_MINUTES ?? "60");
const LOOKBACK_MS = Number.isFinite(LOOKBACK_MINUTES) ? Math.max(5, LOOKBACK_MINUTES) * 60 * 1000 : 60 * 60 * 1000;
const OVERLAP_MS_RAW = Number(process.env.QUOTE_HEALTH_OVERLAP_MS ?? "300000");
const OVERLAP_MS = Number.isFinite(OVERLAP_MS_RAW) ? Math.max(0, OVERLAP_MS_RAW) : 300000;
const ISSUE_LIMIT = Math.max(5, Number(process.env.QUOTE_HEALTH_MAX_ISSUES ?? "20"));

type QuoteIssue = {
  id: string;
  quoteNumber?: number | null;
  status: string;
  passengers?: number | null;
  origin?: string | null;
  destination?: string | null;
  quoteAmount?: number | null;
  errorCode?: string | null;
};

type CounterSnapshot = {
  count: number;
  date?: string | null;
};

const normalizeString = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const formatTimestamp = (ts?: admin.firestore.Timestamp | null) => {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TZ,
  }).format(ts.toDate());
};

const formatCurrency = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `$${value.toFixed(0)}`;
};

const fetchQuoteIssues = async (since: admin.firestore.Timestamp) => {
  const snapshot = await db
    .collection("quoteLogs")
    .where("createdAt", ">", since)
    .orderBy("createdAt", "asc")
    .limit(ISSUE_LIMIT)
    .get();

  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const statusRaw = normalizeString(data.status);
      if (!statusRaw || statusRaw.toLowerCase() === "success") return null;
      return {
        id: doc.id,
        quoteNumber: typeof data.quoteNumber === "number" ? data.quoteNumber : null,
        status: statusRaw,
        passengers: typeof data.passengers === "number" ? data.passengers : null,
        origin: normalizeString(data.origin) ?? normalizeString(data["A2 origin address"]),
        destination: normalizeString(data.destination) ?? normalizeString(data["A3 destination address"]),
        quoteAmount: typeof data.quote === "number" ? data.quote : null,
        errorCode: normalizeString(data.errorCode) ?? normalizeString(data.error) ?? normalizeString(data.statusMessage),
      } as QuoteIssue;
    })
    .filter((issue): issue is QuoteIssue => Boolean(issue));
};

const fetchCounters = async () => {
  const ids = ["daily-quoteLogs", "overall-quoteLogs"];
  const snaps = await Promise.all(ids.map((id) => db.collection("counters").doc(id).get()));
  const [dailyQuote, overallQuote] = snaps.map((snap) => {
    if (!snap.exists) return { count: 0 } as CounterSnapshot;
    const data = snap.data() as { count?: number; date?: string };
    return {
      count: typeof data.count === "number" ? data.count : 0,
      date: data.date ?? null,
    } as CounterSnapshot;
  });

  return {
    quotes: { daily: dailyQuote, overall: overallQuote },
  };
};

const buildEmailBody = (
  sinceLabel: string,
  quoteIssues: QuoteIssue[],
  counters: Awaited<ReturnType<typeof fetchCounters>>,
) => {
  const lines: string[] = [];
  lines.push(`Quote monitor window starting ${sinceLabel}`);
  lines.push("");

  if (quoteIssues.length) {
    lines.push(`Quote form issues (${quoteIssues.length})`);
    quoteIssues.forEach((issue) => {
      const numberLabel =
        typeof issue.quoteNumber === "number"
          ? `#${issue.quoteNumber.toString().padStart(5, "0")}`
          : issue.id;
      const route = [issue.origin, issue.destination].filter(Boolean).join(" → ");
      const pax = issue.passengers ? `${issue.passengers} pax` : null;
      const quoteLabel = formatCurrency(issue.quoteAmount);
      const details = [pax, route, quoteLabel].filter(Boolean).join(" • ");
      const errorDetail = issue.errorCode ? ` (${issue.errorCode})` : "";
      lines.push(`- QuoteLog ${numberLabel} • status: ${issue.status}${errorDetail}${details ? ` • ${details}` : ""}`);
    });
    lines.push("");
  }

  lines.push("Counters");
  lines.push(
    `- Quote logs today: ${counters.quotes.daily.count} (lifetime ${counters.quotes.overall.count})`,
  );
  lines.push("");
  lines.push("Monitor sent from Valley Airporter booking watchdog.");
  return lines.join("\n");
};

export const monitorQuoteHealth = onSchedule(
  {
    schedule: MONITOR_CRON,
    timeZone: TZ,
  },
  async () => {
    if (!ADMIN_EMAIL) {
      logger.warn("monitorQuoteHealth: admin email missing; skipping run");
      return;
    }

    const now = admin.firestore.Timestamp.now();
    const stateRef = db.collection("system").doc("quoteHealthMonitor");
    const stateSnap = await stateRef.get();
    const storedLastChecked = stateSnap.data()?.lastChecked as admin.firestore.Timestamp | undefined;
    const baseSinceMs = storedLastChecked ? storedLastChecked.toMillis() : now.toMillis() - LOOKBACK_MS;
    const sinceMs = Math.max(0, baseSinceMs - OVERLAP_MS);
    const since = admin.firestore.Timestamp.fromMillis(sinceMs);

    const [quoteIssues, counters] = await Promise.all([fetchQuoteIssues(since), fetchCounters()]);

    const issuesFound = quoteIssues.length > 0;
    const sinceLabel = formatTimestamp(since);

    if (!issuesFound) {
      await stateRef.set({ lastChecked: now }, { merge: true });
      return;
    }

    const body = buildEmailBody(sinceLabel, quoteIssues, counters);

    await queueEmailNotification({
      to: ADMIN_EMAIL,
      subject: "Valley Airporter booking form alert",
      text: body,
    });

    await stateRef.set(
      {
        lastChecked: now,
        lastAlertAt: now,
        lastAlertCount: quoteIssues.length,
      },
      { merge: true },
    );
  },
);
