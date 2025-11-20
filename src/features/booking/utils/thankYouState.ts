const STORAGE_KEY = "va:last-booking-state"
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 120 // 2 hours

export type BookingThankYouState = {
  context: "booking"
  paymentPreference: "pay_on_arrival" | "pay_now"
  paymentLink?: string | null
  bookingNumber?: number | null
  bookingId?: string | null
  total?: number | null
}

type StoredState = BookingThankYouState & { storedAt: number }

const hasWindow = typeof window !== "undefined"

export const saveBookingThankYouState = (state: BookingThankYouState) => {
  if (!hasWindow) return
  try {
    const payload: StoredState = {
      ...state,
      paymentLink: state.paymentLink ?? null,
      bookingNumber:
        typeof state.bookingNumber === "number" && Number.isFinite(state.bookingNumber) ? state.bookingNumber : null,
      bookingId: typeof state.bookingId === "string" ? state.bookingId : null,
      total: typeof state.total === "number" && Number.isFinite(state.total) ? state.total : null,
      storedAt: Date.now(),
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn("Failed to persist thank-you state", error)
  }
}

export const loadBookingThankYouState = (maxAgeMs: number = DEFAULT_MAX_AGE_MS): BookingThankYouState | null => {
  if (!hasWindow) return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredState
    if (
      !parsed ||
      parsed.context !== "booking" ||
      (parsed.paymentPreference !== "pay_on_arrival" && parsed.paymentPreference !== "pay_now") ||
      typeof parsed.storedAt !== "number"
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    if (Date.now() - parsed.storedAt > maxAgeMs) {
      window.sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return {
      context: "booking",
      paymentPreference: parsed.paymentPreference,
      paymentLink: typeof parsed.paymentLink === "string" ? parsed.paymentLink : null,
      bookingNumber:
        typeof parsed.bookingNumber === "number" && Number.isFinite(parsed.bookingNumber) ?
          parsed.bookingNumber :
          null,
      bookingId: typeof parsed.bookingId === "string" ? parsed.bookingId : null,
      total: typeof parsed.total === "number" && Number.isFinite(parsed.total) ? parsed.total : null,
    }
  } catch (error) {
    console.warn("Failed to load thank-you state", error)
    window.sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export const clearBookingThankYouState = () => {
  if (!hasWindow) return
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.warn("Failed to clear thank-you state", error)
  }
}
