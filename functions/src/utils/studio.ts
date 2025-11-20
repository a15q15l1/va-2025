import twilio from "twilio";

const FLOW_SID = process.env.TWILIO_FLOW_SID;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER ?? "+17787714625";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const client =
  FLOW_SID && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? (twilio as unknown as (sid: string, token: string) => any)(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

export const sendStudioMessage = async (to: string, message: string) => {
  if (!client || !FLOW_SID || !TWILIO_NUMBER) return;
  if (!to || !message) return;

  await client.studio.v2.flows(FLOW_SID).executions.create({
    to,
    from: TWILIO_NUMBER,
    parameters: {
      to,
      from: TWILIO_NUMBER,
      message,
    },
  });
};
