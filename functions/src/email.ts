import { firestore } from "firebase-admin";
import { logger } from "firebase-functions";
import { parseDateTimeInTimeZone, SERVICE_TIME_ZONE } from "./utils/timezone";

export interface BookingEmailPayload {
  bookingId: string;
  bookingNumber: number;
  customerName: string;
  customerEmail: string;
  pickupDate: string;
  pickupTime: string;
  origin: string;
  originAddress?: string | null;
  destination: string;
  destinationAddress?: string | null;
  passengerCount: number;
  phone: string;
  baggage: string;
  notes?: string | null;
  totalCents: number;
  tipCents?: number;
  currency: string;
  paymentPreference: "pay_on_arrival" | "pay_now";
  createdAtIso: string;
  flightNumber?: string | null;
  paymentLinkUrl?: string | null;
  force?: boolean;
}

const SUPPORT_EMAIL = "info@valleyairporter.ca";
const BLOCKED_LINK_DOMAINS = ["shorturl.fm"] as const;

const sanitizeLinks = (input: string) => {
  let changed = false;
  let output = input;
  BLOCKED_LINK_DOMAINS.forEach((domain) => {
    const pattern = new RegExp(`https?:\\/\\/[^\\s"'<>]*${domain}[^\\s"'<>]*`, "gi");
    output = output.replace(pattern, () => {
      changed = true;
      return "";
    });
  });
  return { output, changed };
};

export const queueBookingEmail = async ({
  bookingId,
  bookingNumber,
  customerName,
  customerEmail,
  pickupDate,
  pickupTime,
  origin,
  originAddress,
  destination,
  destinationAddress,
  passengerCount,
  phone,
  baggage,
  notes,
  totalCents,
  tipCents = 0,
  currency,
  paymentPreference,
  createdAtIso,
  flightNumber,
  paymentLinkUrl,
  force = false,
}: BookingEmailPayload): Promise<string | null> => {
  const normalizedEmail = customerEmail?.trim().toLowerCase();
  if (!normalizedEmail) {
    logger.warn("queueBookingEmail skipped due to missing customer email", {
      bookingId,
      bookingNumber,
    });
    return null;
  }

  const specialNote = `Please reconfirm your booking via text message or email 1-2 days in advance to make sure there are no changes in your plans. We cannot guarantee service if information provided is incorrect or if service is required in less than 24 hours.`;

  const formatLocation = (label: string, address?: string | null) => {
    const trimmedLabel = (label ?? "").trim()
    const trimmedAddress = (address ?? "").trim()
    if (trimmedLabel && trimmedAddress) {
      const labelNormalized = trimmedLabel.replace(/\s+/g, " ").toLowerCase()
      const addressNormalized = trimmedAddress.replace(/\s+/g, " ").toLowerCase()
      if (addressNormalized.includes(labelNormalized)) {
        return trimmedAddress
      }
      return `${trimmedLabel} (${trimmedAddress})`
    }
    return trimmedAddress || trimmedLabel || "—"
  }

  const originDisplay = formatLocation(origin, originAddress)
  const destinationDisplay = formatLocation(destination, destinationAddress)

  const formatCurrency = (cents: number) => {
    const rounded = Math.round(cents / 100);
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(rounded);
  };

  const tipDisplay = tipCents > 0 ? formatCurrency(tipCents) : "—";
  const paymentMethod = paymentPreference === "pay_now" ? "Pay online now" : "Pay driver via cash or card";
  const totalDisplay = formatCurrency(totalCents);
  const subject = `Valley Airporter - Booking #${bookingNumber} - From: ${customerName}`;

  const formatFriendlyDateTime = (value: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: SERVICE_TIME_ZONE,
    }).format(value);

  const bookedOnDisplay = formatFriendlyDateTime(new Date(createdAtIso));
  const flightDisplay =
    flightNumber && flightNumber.trim().length > 0 ? flightNumber : "—";
  const greetingName = customerName.split(" ")[0] || customerName;

  const formatTripDateTime = (dateStr: string, timeStr: string) => {
    const parsed = parseDateTimeInTimeZone(dateStr, timeStr, SERVICE_TIME_ZONE);
    if (parsed) return formatFriendlyDateTime(parsed);
    return `${dateStr} at ${timeStr}`;
  };

  const pickupDisplay = formatTripDateTime(pickupDate, pickupTime);
  const showPaymentCta = paymentPreference === "pay_now";
  const normalizeLabel = (value?: string | null) => value?.toLowerCase().replace(/\s+/g, " ").trim() ?? ""

  const vehicleLocationBlocks = () => {
    const originNormalized = normalizeLabel(origin)
    const included = (needle: string) => originNormalized.includes(needle.toLowerCase())

    const wrapHtml = (content: string) => `
    <div style="margin: 1rem 0; padding: 1rem 1.25rem; border-radius: 18px; background: #fff7b2; border: 1px solid #fcd34d; color: #0b1f36;">
      ${content}
    </div>
    `

    if (included("vancouver international airport") || originNormalized.includes("yvr")) {
      const htmlContent = `
        <p style="margin: 0 0 0.4rem 0; font-weight: 700; text-decoration: underline;">Here is where our vehicle will be located at the Vancouver Airport:</p>
        <p style="margin: 0 0 0.6rem 0;">(Vehicle will be a 7-Seater Van with “Airport Shuttle” Stickers on all sides)</p>
        <p style="margin: 0 0 0.3rem 0; font-weight: 600;">Domestic Terminal:</p>
        <p style="margin: 0 0 0.6rem 0;">- On Floor Level One, by the Commercial Passenger Pick Up Area near the Car Rentals/Police Area.</p>
        <p style="margin: 0 0 0.3rem 0; font-weight: 600;">International Terminal:</p>
        <p style="margin: 0;">- Our dispatch team will coordinate via phone/text and the driver will meet you at one of the numbered pillars once you exit the International Arrivals Terminal.</p>
      `
      const textContent = [
        "",
        "Here is where our vehicle will be located at the Vancouver Airport:",
        "(Vehicle will be a 7-Seater Van with “Airport Shuttle” Stickers on all sides)",
        "Domestic Terminal:",
        "- On Floor Level One, by the Commercial Passenger Pick Up Area near the Car Rentals/Police Area.",
        "International Terminal:",
        "- Our dispatch team will coordinate via phone/text and the driver will meet you at one of the numbered pillars once you exit the International Arrivals Terminal.",
      ].join("\n")
      return { html: wrapHtml(htmlContent), text: textContent }
    }

    if (included("abbotsford international airport") || originNormalized.includes("yxx")) {
      const htmlContent = `
        <p style="margin: 0 0 0.4rem 0; font-weight: 700; text-decoration: underline;">Here is where our vehicle will be located at the Abbotsford Airport:</p>
        <p style="margin: 0 0 0.6rem 0;">(Vehicle will be a 7-Seater Van with “Airport Shuttle” Stickers on all sides)</p>
        <p style="margin: 0;">- Outside the Arrivals Terminal, in the second traffic lane, in front of the yellow taxis—you’ll see the reserved “Airport Shuttle/Limousine” spot.</p>
      `
      const textContent = [
        "",
        "Here is where our vehicle will be located at the Abbotsford Airport:",
        "(Vehicle will be a 7-Seater Van with “Airport Shuttle” Stickers on all sides)",
        "- Outside the Arrivals Terminal, in the second traffic lane, in front of the yellow taxis—you’ll see the reserved “Airport Shuttle/Limousine” spot.",
      ].join("\n")
      return { html: wrapHtml(htmlContent), text: textContent }
    }

    return null
  }

  const vehicleLocationBlock = vehicleLocationBlocks()

  const paymentLinkBlockHtml =
    showPaymentCta && paymentLinkUrl
      ? `
    <div style="margin: 1.5rem 0; padding: 1.25rem; border-radius: 18px; background: #cfe5ff; color: #0c2d5a;">
      <p style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #0c2d5a;">
        Complete Your Payment
      </p>
      <p style="margin: 0 0 1rem 0; line-height: 1.5; color: #0c2d5a;">
        Secure your shuttle by submitting payment now. Your Square checkout link is below—this doubles as your invoice once paid.
      </p>
      <p style="margin: 0;">
        <a href="${paymentLinkUrl}" target="_blank" rel="noopener noreferrer"
          style="display: inline-block; padding: 14px 30px; border-radius: 999px; border: 2px solid rgba(12,45,90,0.3); background: #0b3b83; color: #ffffff !important; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none !important; font-family: 'Inter', Arial, sans-serif; box-shadow: 0 12px 24px -10px rgba(11,59,131,0.65);">
          Pay Online Now
        </a>
      </p>
      <p style="margin: 1rem 0 0 0; font-size: 0.85rem; opacity: 0.85; color: #0c2d5a;">
        If the button does not work, copy and paste this URL into your browser:<br/>
        <span style="word-break: break-all;">${paymentLinkUrl}</span>
      </p>
    </div>
  `
      : showPaymentCta
        ? `
    <div style="margin: 1.5rem 0; padding: 1.25rem; border-radius: 18px; background: #fff2d6; color: #5f3b00;">
      <p style="margin: 0 0 0.75rem 0; font-weight: 600;">We'll send your secure payment link shortly.</p>
      <p style="margin: 0;">If you need the link right away, call dispatch at (604) 751-6688 and we’ll text it over.</p>
    </div>
  `
        : "";

  const paymentLinkBlockText =
    showPaymentCta && paymentLinkUrl
      ? [
          "",
          "---- Pay Online Now ----",
          `Secure payment link: ${paymentLinkUrl}`,
          "This Square checkout link becomes your receipt once paid.",
        ].join("\n")
      : showPaymentCta
        ? [
            "",
            "---- Pay Online Now ----",
            "We’re preparing your Square payment link and will send it shortly.",
            "Need it urgently? Call or text dispatch at (604) 751-6688.",
          ].join("\n")
        : "";

  const html = `
    <p>Hello ${greetingName || "there"},</p>
    <p>Thanks for the confirmation.</p>
    <p><strong>We have confirmed your booking as follows:</strong></p>
    <div style="margin-bottom: 1rem; line-height: 1.4;">
      <p style="margin: 0;"><strong>Booking Number:</strong> #${bookingNumber}</p>
      <p style="margin: 0;"><strong>Final Price:</strong> ${totalDisplay}</p>
      <p style="margin: 0;"><strong>Date:</strong> ${pickupDisplay}</p>
      <p style="margin: 0;"><strong>From:</strong> ${originDisplay}</p>
      <p style="margin: 0;"><strong>To:</strong> ${destinationDisplay}</p>
      <p style="margin: 0;"><strong>Main Passenger:</strong> ${customerName} - ${phone}</p>
      <p style="margin: 0;"><strong>Passengers:</strong> ${passengerCount}</p>
      <p style="margin: 0;"><strong>Baggage:</strong> ${baggage || "N/A"}</p>
      <p style="margin: 0;"><strong>Tip:</strong> ${tipDisplay}</p>
      <p style="margin: 0;"><strong>Payment Method:</strong> ${paymentMethod}</p>
      <p style="margin: 0;"><strong>Date Booked On:</strong> ${bookedOnDisplay}</p>
      <p style="margin: 0;"><strong>Arrival Flight Number:</strong> ${flightDisplay}</p>
      <p style="margin: 0;"><strong>Special Notes:</strong> ${notes || "None"}</p>
    </div>
    ${vehicleLocationBlock?.html ?? ""}
    ${paymentLinkBlockHtml}
    <p>If you would like to make any changes or have questions, please contact us via email or text message at (604) 751-6688.</p>
    <p><strong>Special note:</strong> ${specialNote}</p>
    <p>Thanks,<br/>Customer Service<br/>Valley Airporter</p>
    `;

  const text = [
    `Booking Number: #${bookingNumber}`,
    `Final Price: ${totalDisplay}`,
    `Date: ${pickupDisplay}`,
    `From: ${originDisplay}`,
    `To: ${destinationDisplay}`,
    `Main Passenger: ${customerName} - ${phone}`,
    `Passengers: ${passengerCount}`,
    `Baggage: ${baggage || "N/A"}`,
    `Tip: ${tipDisplay}`,
    `Payment Method: ${paymentMethod}`,
    `Date Booked On: ${bookedOnDisplay}`,
    `Arrival Flight Number: ${flightDisplay}`,
    `Special Notes: ${notes || "None"}`,
    vehicleLocationBlock?.text ?? "",
    paymentLinkBlockText,
    "",
    "If you would like to make any changes or have questions, please contact us via email or text message at (604) 751-6688.",
    "Special note: Please reconfirm your booking via text message or email 1-2 days in advance to make sure there are no changes in your plans. We cannot guarantee service if information provided is incorrect or if service is required in less than 24 hours.",
  ].join("\n");

  const sanitizedHtml = sanitizeLinks(html);
  const sanitizedText = sanitizeLinks(text);

  if (sanitizedHtml.changed || sanitizedText.changed) {
    logger.warn("Removed blocked link from booking email payload", {
      bookingId,
      bookingNumber,
      blockedDomains: BLOCKED_LINK_DOMAINS,
    });
  }

  const db = firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  const supportEmail = SUPPORT_EMAIL.trim().toLowerCase();
  const ccRecipients =
    supportEmail && supportEmail !== normalizedEmail ? [supportEmail] : [];
  const combinedRecipients = [normalizedEmail, ...ccRecipients];

  let mailDocId: string | null = null;

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    const notificationState =
      bookingSnap.data()?.system?.notifications?.email?.bookingConfirmation ?? {};
    const alreadySent = notificationState.sent === true;

    if (alreadySent && !force) {
      return;
    }

    const mailRef = db.collection("mail").doc();
    mailDocId = mailRef.id;

    tx.set(
      mailRef,
      {
        to: combinedRecipients[0],
        ...(ccRecipients.length > 0 ? { cc: ccRecipients } : {}),
        createdOn: firestore.FieldValue.serverTimestamp(),
        message: {
          subject,
          html: sanitizedHtml.output,
          text: sanitizedText.output,
        },
        metadata: {
          type: "booking-confirmation",
          bookingId,
          bookingNumber,
          createdAt: firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: false },
    );

    tx.set(
      bookingRef,
      {
        system: {
          notifications: {
            email: {
              bookingConfirmation: {
                sent: true,
                at: firestore.FieldValue.serverTimestamp(),
                mailId: mailRef.id,
                subject,
                to: combinedRecipients,
              },
            },
          },
        },
      },
      { merge: true },
    );
  });

  if (mailDocId) {
    logger.info("Queued booking confirmation email", {
      bookingId,
      bookingNumber,
      mailDocId,
      recipients: combinedRecipients,
    });
  }
  return mailDocId;
};

export interface PaymentConfirmationEmailPayload {
  bookingId: string;
  bookingNumber?: number | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  pickupDate?: string | null;
  pickupTime?: string | null;
  origin?: string | null;
  originAddress?: string | null;
  destination?: string | null;
  destinationAddress?: string | null;
  totalCents?: number | null;
  currency?: string | null;
  paymentId?: string | null;
  paymentOrderId?: string | null;
  completedAtIso?: string | null;
  force?: boolean;
}

export const queuePaymentConfirmationEmail = async ({
  bookingId,
  bookingNumber,
  customerName,
  customerEmail,
  customerPhone,
  pickupDate,
  pickupTime,
  origin,
  originAddress,
  destination,
  destinationAddress,
  totalCents,
  currency = "CAD",
  paymentId,
  paymentOrderId,
  completedAtIso,
  force = false,
}: PaymentConfirmationEmailPayload) => {
  const normalizedEmail =
    typeof customerEmail === "string" && customerEmail.trim().length > 0
      ? customerEmail.trim().toLowerCase()
      : null;

  const recipients = Array.from(
    new Set([normalizedEmail, SUPPORT_EMAIL].filter((value): value is string => Boolean(value))),
  );
  if (recipients.length === 0) return;

  const paddedBookingNumber =
    typeof bookingNumber === "number" && Number.isFinite(bookingNumber)
      ? bookingNumber.toString().padStart(5, "0")
      : null;
  const bookingLabel = paddedBookingNumber ?? bookingId;
  const heroTitle = paddedBookingNumber ? `Booking #${paddedBookingNumber}` : `Booking ${bookingLabel}`;
  const bookingReference = paddedBookingNumber ? `#${paddedBookingNumber}` : `#${bookingLabel}`;
  const subject = `Valley Airporter - Booking #${bookingLabel} has been paid online`;
  const greetingName = (customerName ?? "").trim() || "there";
  const rawPassengerEmail = typeof customerEmail === "string" ? customerEmail.trim() : "";

  const currencyCode =
    typeof currency === "string" && currency.trim().length > 0 ? currency.trim() : "CAD";

  const formatCurrency = (value: number | null | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
    }).format(value / 100);
  };

  const amountDisplay = formatCurrency(totalCents);

  const formatFriendlyDateTime = (value: string | null | undefined) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: SERVICE_TIME_ZONE,
    }).format(parsed);
  };

  const paymentCompletedDisplay = formatFriendlyDateTime(completedAtIso);

  const formatTripDateTime = (dateValue?: string | null, timeValue?: string | null) => {
    if (!dateValue) return null;
    if (!timeValue) return dateValue;
    const parsed = parseDateTimeInTimeZone(dateValue, timeValue, SERVICE_TIME_ZONE);
    if (!parsed) return `${dateValue} at ${timeValue}`;
    return formatFriendlyDateTime(parsed.toISOString());
  };

  const pickupDisplay = formatTripDateTime(pickupDate, pickupTime);

  const formatLocation = (label?: string | null, address?: string | null) => {
    const trimmedLabel = (label ?? "").trim();
    const trimmedAddress = (address ?? "").trim();
    if (trimmedLabel && trimmedAddress) {
      const labelNormalized = trimmedLabel.replace(/\s+/g, " ").toLowerCase();
      const addressNormalized = trimmedAddress.replace(/\s+/g, " ").toLowerCase();
      if (addressNormalized.includes(labelNormalized)) {
        return trimmedAddress;
      }
      return `${trimmedLabel} (${trimmedAddress})`;
    }
    return trimmedAddress || trimmedLabel || null;
  };

  const originDisplay = formatLocation(origin, originAddress);
  const destinationDisplay = formatLocation(destination, destinationAddress);
  const routeDisplay =
    originDisplay && destinationDisplay ? `${originDisplay} → ${destinationDisplay}` : null;

  const passengerLine =
    customerName && customerPhone ? `${customerName.trim()} • ${customerPhone.trim()}` : customerName?.trim() ?? null;

  const detailItems: Array<{ label: string; value: string | null }> = [
    { label: "Amount paid", value: amountDisplay },
    { label: "Payment ID", value: paymentId ?? null },
    { label: "Order reference", value: paymentOrderId ?? null },
    { label: "Completed on", value: paymentCompletedDisplay },
    { label: "Trip date", value: pickupDisplay },
    { label: "Route", value: routeDisplay },
    { label: "Passenger", value: passengerLine },
    { label: "Passenger email", value: rawPassengerEmail || null },
    { label: "Passenger phone", value: customerPhone?.trim() ?? null },
    { label: "Booking reference", value: bookingReference },
  ];

  const detailHtml = detailItems
    .filter((item) => item.value && item.value.trim().length > 0 && item.value !== "—")
    .map(
      (item) => `
        <div style="flex: 1 1 220px; padding: 14px 16px; border-radius: 18px; background: #f5f9ff; border: 1px solid rgba(21, 75, 138, 0.12); box-shadow: 0 14px 32px -24px rgba(15, 52, 96, 0.7);">
          <div style="text-transform: uppercase; letter-spacing: 0.2em; font-size: 0.6rem; color: rgba(15, 45, 92, 0.7); margin-bottom: 0.4rem;">
            ${item.label}
          </div>
          <div style="font-size: 1rem; font-weight: 600; color: #0f203d; word-break: break-word;">
            ${item.value}
          </div>
        </div>
      `,
    )
    .join("");

  const html = `
    <div style="font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(135deg, #e0f2ff 0%, #f8fbff 100%); padding: 28px;">
      <div style="max-width: 640px; margin: 0 auto; border-radius: 32px; overflow: hidden; background: #ffffff; box-shadow: 0 25px 65px -30px rgba(24, 73, 135, 0.45);">
        <div style="background: linear-gradient(135deg, #7cc8ff 0%, #1b4f91 100%); padding: 36px 32px; color: #ffffff; text-align: center;">
          <img src="https://i.postimg.cc/R0q7gbmw/compressed-transparent-logo.png" alt="Valley Airporter" style="width: 120px; height: auto; margin-bottom: 14px;" />
          <p style="margin: 0; text-transform: uppercase; letter-spacing: 0.28em; font-size: 11px; opacity: 0.85;">
            Payment Received
          </p>
          <h1 style="margin: 12px 0 8px; font-size: 30px; font-weight: 600;">
            ${heroTitle}
          </h1>
        </div>
        <div style="padding: 32px 34px; background: #f9fbff;">
          <p style="margin: 0 0 1.2rem 0; color: #0f2647; font-size: 1rem; line-height: 1.6;">
            Hi ${greetingName},
          </p>
          <p style="margin: 0 0 1.6rem 0; color: #2b4167; line-height: 1.7;">
            Your online payment has been confirmed. Our dispatch team has logged the receipt and you are all set for your upcoming ride.
          </p>
          ${
            detailHtml
              ? `<div style="border-radius: 24px; background: #ffffff; padding: 22px 24px; margin-bottom: 1.4rem; border: 1px solid rgba(25, 82, 146, 0.08);">
                  <div style="display: flex; flex-wrap: wrap; gap: 14px;">
                    ${detailHtml}
                  </div>
                </div>`
              : ""
          }
          <div style="border-radius: 24px; background: linear-gradient(135deg, #c9ebff 0%, #e9f3ff 100%); padding: 20px 24px; margin-bottom: 1.4rem;">
            <p style="margin: 0 0 0.6rem; font-weight: 600; color: #0f305c;">Need anything else?</p>
            <p style="margin: 0; color: #133864; line-height: 1.5;">Reply to this email or reach dispatch at <a href="tel:+16047516688" style="color: #0f4c81; text-decoration: none; font-weight: 600;">(604) 751-6688</a>.</p>
          </div>
          <p style="margin: 1rem 0 0; color: #10213f; font-weight: 600;">
            With gratitude,<br/>Valley Airporter Dispatch
          </p>
        </div>
      </div>
    </div>
  `;

  const textLines = [
    `Valley Airporter - Booking ${bookingReference} has been paid online`,
    amountDisplay ? `Amount paid: ${amountDisplay}` : null,
    paymentCompletedDisplay ? `Completed on: ${paymentCompletedDisplay}` : null,
    pickupDisplay ? `Trip date: ${pickupDisplay}` : null,
    routeDisplay ? `Route: ${routeDisplay}` : null,
    passengerLine ? `Passenger: ${passengerLine}` : null,
    rawPassengerEmail ? `Passenger email: ${rawPassengerEmail}` : null,
    customerPhone ? `Passenger phone: ${customerPhone.trim()}` : null,
    paymentId ? `Payment ID: ${paymentId}` : null,
    paymentOrderId ? `Order reference: ${paymentOrderId}` : null,
    "Dispatch line: (604) 751-6688",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  const sanitizedHtml = sanitizeLinks(html);
  const sanitizedText = sanitizeLinks(textLines);

  if (sanitizedHtml.changed || sanitizedText.changed) {
    logger.warn("Removed blocked link from payment confirmation email payload", {
      bookingId,
      bookingNumber,
      blockedDomains: BLOCKED_LINK_DOMAINS,
    });
  }

  const db = firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);

  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    const notificationState =
      bookingSnap.data()?.system?.notifications?.email?.paymentConfirmation ?? {};
    const alreadySent = notificationState.sent === true;
    if (alreadySent && !force) {
      return;
    }

    const mailRef = db.collection("mail").doc();

    tx.set(
      mailRef,
      {
        to: recipients,
        createdOn: firestore.FieldValue.serverTimestamp(),
        message: {
          subject,
          html: sanitizedHtml.output,
          text: sanitizedText.output,
        },
        metadata: {
          type: "payment-confirmation",
          bookingId,
          bookingNumber: bookingNumber ?? null,
          createdAt: firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: false },
    );

    tx.set(
      bookingRef,
      {
        system: {
          notifications: {
            email: {
              paymentConfirmation: {
                sent: true,
                at: firestore.FieldValue.serverTimestamp(),
                mailId: mailRef.id,
                subject,
                to: recipients,
              },
            },
          },
        },
      },
      { merge: true },
    );
  });
};
