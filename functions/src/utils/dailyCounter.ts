import * as admin from "firebase-admin";
import { SERVICE_TIME_ZONE } from "./timezone";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SERVICE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const formatDateKey = (value: Date) => {
  const parts = formatter.formatToParts(value);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
};

export const incrementDailyCounter = async (name: "quoteLogs") => {
  const todayKey = formatDateKey(new Date());
  const dailyRef = db.collection("counters").doc(`daily-${name}`);
  const overallRef = db.collection("counters").doc(`overall-${name}`);

  await db.runTransaction(async (tx) => {
    const [dailySnap, overallSnap] = await Promise.all([tx.get(dailyRef), tx.get(overallRef)]);

    if (!dailySnap.exists) {
      tx.set(
        dailyRef,
        {
          date: todayKey,
          count: 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: false },
      );
    } else {
      const data = dailySnap.data() as { date?: string; count?: number } | undefined;
      if (!data || data.date !== todayKey) {
        tx.set(
          dailyRef,
          {
            date: todayKey,
            count: 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: false },
        );
      } else {
        tx.update(dailyRef, {
          count: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    if (!overallSnap.exists) {
      tx.set(
        overallRef,
        {
          count: 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: false },
      );
    } else {
      tx.update(overallRef, {
        count: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
};
