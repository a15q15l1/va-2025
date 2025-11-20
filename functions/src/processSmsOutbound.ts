// functions/src/processSmsOutbound.ts

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// Use CommonJS require so TS is happy
// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilio = require("twilio");

// Safe initialize (in case another file already did this)
if (!admin.apps.length) {
  admin.initializeApp();
}

// Read Twilio config from environment variables (.env / .env.valleyairporterapp)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

// Firestore trigger: whenever a new doc is created in sms_outbound
export const processSmsOutbound = onDocumentCreated(
  {
    document: "sms_outbound/{docId}",
    region: "us-central1", // keep this consistent with your other functions
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("sms_outbound doc snapshot missing");
      return;
    }

    const data = snap.data() as any;
    if (!data) {
      logger.warn("sms_outbound doc had no data");
      return;
    }

    const to = data.to as string | undefined;
    const body = data.body as string | undefined;

    if (!to || !body) {
      logger.warn("Missing 'to' or 'body' on sms_outbound doc", {
        docId: snap.id,
        data,
      });
      return;
    }

    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_AUTH_TOKEN ||
      !TWILIO_MESSAGING_SERVICE_SID
    ) {
      logger.error(
        "Twilio environment variables are missing. " +
          "Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID."
      );
      return;
    }

    // Create Twilio client using env vars
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    try {
      const message = await client.messages.create({
        to,
        body,
        // Use your MG… Messaging Service SID
        messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
      });

      logger.info("Twilio SMS sent", {
        sid: message.sid,
        to,
        docId: snap.id,
      });
    } catch (err: any) {
      logger.error("Error sending Twilio SMS", {
        error: err?.message || String(err),
        to,
        docId: snap.id,
      });
    }
  }
);
