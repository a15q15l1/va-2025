import { useEffect, useMemo, useState } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { GlassPanel } from "@/components/ui/GlassPanel"
import { Plane, MapPin, Phone, Sparkles, Share2 } from "lucide-react"
import Lottie from "lottie-react"
import mailSentAnimation from "@/lotties/mail-sent.json"
import {
  loadBookingThankYouState,
  saveBookingThankYouState,
  type BookingThankYouState,
} from "@/features/booking/utils/thankYouState"

export const ThankYouPage = () => {
  const { location } = useRouterState()
  type RouterStateShape = {
    context?: string
    paymentLink?: unknown
    total?: unknown
    bookingNumber?: unknown
    bookingId?: unknown
    paymentPreference?: unknown
  }

  const routerState = location.state as RouterStateShape | undefined

  const normalizedRouterState = useMemo<BookingThankYouState | null>(() => {
    if (!routerState || routerState.context === "contact") return null
    const paymentPreference =
      routerState.paymentPreference === "pay_on_arrival" || routerState.paymentPreference === "pay_now"
        ? routerState.paymentPreference
        : null
    if (!paymentPreference) return null
    return {
      context: "booking",
      paymentPreference,
      paymentLink: typeof routerState.paymentLink === "string" ? routerState.paymentLink : null,
      bookingNumber: typeof routerState.bookingNumber === "number" ? routerState.bookingNumber : null,
      bookingId: typeof routerState.bookingId === "string" ? routerState.bookingId : null,
      total: typeof routerState.total === "number" ? routerState.total : null,
    }
  }, [routerState])

  const [bookingState, setBookingState] = useState<BookingThankYouState | null>(null)

  useEffect(() => {
    if (routerState?.context === "contact") {
      setBookingState(null)
      return
    }
    if (normalizedRouterState) {
      setBookingState(normalizedRouterState)
      saveBookingThankYouState(normalizedRouterState)
      return
    }
    const restored = loadBookingThankYouState()
    if (restored) {
      setBookingState(restored)
    }
  }, [normalizedRouterState, routerState?.context])

  const paymentLink = bookingState?.paymentLink ?? null
  const bookingTotalRaw = typeof bookingState?.total === "number" ? bookingState.total : null
  const bookingNumber =
    typeof bookingState?.bookingNumber === "number" && Number.isFinite(bookingState.bookingNumber) ?
      bookingState.bookingNumber :
      null
  const paymentPreference = bookingState?.paymentPreference ?? null
  const payOnArrival = paymentPreference === "pay_on_arrival"
  const hasBookingDetails = Boolean(bookingState)

  const formattedTotal =
    typeof bookingTotalRaw === "number"
      ? new Intl.NumberFormat("en-CA", {
          style: "currency",
          currency: "CAD",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(Math.round(bookingTotalRaw))
      : null

  return (
    <div className="flex flex-col gap-10 pb-16">
      <GlassPanel className="relative overflow-hidden p-8 space-y-6">
        <div className="absolute -right-36 -top-20 h-72 w-72 rounded-full bg-[#6fbfff22] blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-20 h-64 w-64 rounded-full bg-[#9cc6ff26] blur-3xl" aria-hidden />
        {bookingNumber != null ? (
          <div className="relative flex items-center rounded-2xl border border-white/50 bg-white/70 px-4 py-3 text-horizon shadow-inner">
            <p className="text-base font-bold text-horizon">Form # {bookingNumber}</p>
          </div>
        ) : null}
        <div className="relative flex flex-col gap-6 pt-2">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
            <div className="flex flex-1 flex-col gap-4">
              <span className="inline-flex items-center gap-2 self-start rounded-full border border-white/60 bg-white/80 px-4 py-1 text-xs font-semibold uppercase tracking-[0.35em] text-horizon shadow-sm">
                Thank you
              </span>
              <h1 className="max-w-3xl font-heading text-4xl uppercase tracking-[0.3em] text-horizon sm:text-5xl">
                Your Message Is Wheels Up
              </h1>
              <p className="max-w-2xl text-base leading-relaxed text-midnight/80">
                We’ve routed your request directly to the Valley Airporter dispatch desk. A coordinator is
                reviewing it now and will reach out shortly with confirmation, next steps, or a custom quote.
                Keep your phone handy—we typically reply within 1–2 hours via email.
              </p>
            </div>
            <div className="flex w-full max-w-md items-center justify-center self-stretch rounded-3xl bg-white/40 p-6 sm:ml-auto lg:max-w-md" aria-hidden>
              <Lottie animationData={mailSentAnimation} loop autoplay className="h-56 w-56 md:h-72 md:w-72" />
            </div>
          </div>
          {hasBookingDetails ? (
            paymentLink ? (
              <div className="rounded-3xl border border-white/70 bg-white/85 p-7 text-midnight shadow-inner space-y-3">
                <p className="text-base font-semibold uppercase tracking-[0.32em] text-horizon">
                  Complete Your Booking
                </p>
                <p className="text-base leading-relaxed text-midnight/80">
                  Secure your ride now—this Square checkout becomes your invoice once paid.
                </p>
                {formattedTotal ? (
                  <p className="text-lg font-semibold text-horizon">Amount: {formattedTotal}</p>
                ) : null}
                {bookingNumber != null ? (
                  <p className="text-base text-midnight/70">Form #: {bookingNumber}</p>
                ) : null}
                <a
                  href={paymentLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-400 bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-600 px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-white shadow-[0_20px_45px_-18px_rgba(16,185,129,0.55)] transition hover:from-emerald-500 hover:via-emerald-600 hover:to-emerald-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300/50"
                >
                  Complete Payment
                </a>
                <p className="text-base text-midnight/70">
                  Can’t click the button? Copy and paste this link into your browser:
                  <br />
                  <a href={paymentLink} className="break-all text-horizon underline" target="_blank" rel="noopener noreferrer">
                    {paymentLink}
                  </a>
                </p>
              </div>
            ) : (
              <div className="rounded-3xl border border-white/70 bg-white/75 p-7 text-base text-midnight/80 shadow-inner space-y-3">
                <p className="font-heading text-base font-bold uppercase tracking-[0.32em] text-horizon">
                  {payOnArrival ? "Pay Driver At Pickup" : "Payment Reminder"}
                </p>
                <p className="leading-relaxed">
                  {payOnArrival
                    ? "You chose to pay your driver directly at pickup. Dispatch will confirm once your shuttle is assigned—call or text (604) 751-6688 if anything changes."
                    : "We’ll email your secure Square payment link shortly. Need it right away? Call or text dispatch at (604) 751-6688 and we’ll send it instantly."}
                </p>
                {bookingNumber != null ? (
                  <p className="text-base font-bold text-midnight/80">Form # {bookingNumber}</p>
                ) : null}
              </div>
            )
          ) : (
            <div className="rounded-3xl border border-white/70 bg-white/80 p-7 text-base text-midnight/80 shadow-inner space-y-3">
              <p className="font-heading text-base font-bold uppercase tracking-[0.32em] text-horizon">
                Message Received
              </p>
              <p>
                Dispatch has your details and will reply shortly with next steps. If this is urgent, please call or text
                (604) 751-6688 so we can assist immediately.
              </p>
            </div>
          )}
          <div className="rounded-3xl border border-sky-100 bg-[#eaf4ff] p-6 text-midnight shadow-inner shadow-sky-100/80">
            <p className="font-heading text-base font-semibold uppercase tracking-[0.3em] text-horizon mb-2">
              Ready For Another Trip?
            </p>
            <p className="text-sm text-midnight/75">
              Need to schedule a second pickup or return journey? Start a fresh booking below and we’ll get it queued for dispatch.
            </p>
            <Link
              to="/booking"
              className="mt-4 inline-flex items-center justify-center rounded-full border border-sky-400 bg-white/90 px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-sky-600 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.3)] transition hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-200/80"
            >
              Make Another Booking
            </Link>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link
              to="/tours"
              className="inline-flex items-center gap-2 rounded-full border border-horizon/40 bg-white/80 px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-horizon transition hover:border-horizon/60 hover:bg-white/90"
            >
              <Plane className="h-4 w-4" />
              Explore Tours
            </Link>
          </div>
        </div>
      </GlassPanel>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <GlassPanel className="p-7">
          <div className="flex items-center gap-3 text-aurora">
            <Sparkles className="h-6 w-6" />
            <p className="font-heading text-sm uppercase tracking-[0.3em]">
              What Happens Next
            </p>
          </div>
          <ul className="mt-6 space-y-4 text-base text-midnight/75">
            <li className="flex gap-3">
              <span className="font-heading text-sm uppercase tracking-[0.35em] text-horizon">1</span>
              Our dispatchers review your details and match the best shuttle, driver, and pickup window.
            </li>
            <li className="flex gap-3">
              <span className="font-heading text-sm uppercase tracking-[0.35em] text-horizon">2</span>
              We’ll call or text if we need anything else—or simply send your confirmation itinerary.
            </li>
            <li className="flex gap-3">
              <span className="font-heading text-sm uppercase tracking-[0.35em] text-horizon">3</span>
              You get a shareable booking link, live updates, and the same dependable service we’ve
              provided since 2008.
            </li>
          </ul>
        </GlassPanel>
        <GlassPanel className="flex flex-col gap-5 p-6">
          <div className="flex items-center gap-3 text-aurora">
            <Share2 className="h-5 w-5" />
            <p className="font-heading text-sm uppercase tracking-[0.3em]">
              Need Immediate Help?
            </p>
          </div>
          <p className="text-sm text-midnight/75">
            We love email, but real-time solutions are even better. Reach us right now for urgent
            airport runs, same-day travel, or changes to an existing ride.
          </p>
          <div className="grid gap-4 rounded-3xl bg-white/80 p-5 text-midnight">
            <div className="flex items-center gap-3 text-horizon">
              <Phone className="h-5 w-5" />
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-midnight/50">Call or Text</p>
                <a className="text-base font-semibold text-horizon hover:underline" href="tel:+16047516688">
                  (604) 751-6688
                </a>
              </div>
            </div>
            <div className="flex items-center gap-3 text-horizon">
              <MapPin className="h-5 w-5" />
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-midnight/50">Dispatch HQ</p>
                <p className="text-base text-midnight/75">
                  31631 S Fraser Way #101<br />
                  Abbotsford, BC V2T 1T8
                </p>
              </div>
            </div>
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}

export default ThankYouPage
