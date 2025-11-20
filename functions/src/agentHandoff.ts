import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export const agentHandoff = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const rawBody = req.body || {};
    const body =
      typeof rawBody === "string"
        ? JSON.parse(rawBody || "{}")
        : (rawBody as Record<string, unknown>);

    const fromRaw =
      (body.from as string | undefined) ||
      (body.From as string | undefined) ||
      "";
    const messageRaw =
      (body.body as string | undefined) ||
      (body.Body as string | undefined) ||
      "";
    const source =
      (body.source as string | undefined) || "twilio-studio-agent";

    const from = fromRaw.trim();
    const message = messageRaw.trim();

    if (!from) {
      res.status(400).send("Missing 'from' in request body.");
      return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const docRef = await db.collection("agentRequests").add({
      from,
      message,
      source,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });

    logger.info("Created agent request", { from, docId: docRef.id });

    res.status(200).json({
      ok: true,
      id: docRef.id,
    });
  } catch (error) {
    logger.error("Error in agentHandoff", {
      error: error instanceof Error ? error.message : error,
    });
    res.status(500).send("Internal error in agentHandoff");
  }
});
