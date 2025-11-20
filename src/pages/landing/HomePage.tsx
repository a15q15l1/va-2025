import { useState, type FormEvent, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { GlassPanel } from "@/components/ui/GlassPanel"
import { ResponsiveImage } from "@/components/ui/ResponsiveImage"
import {
  ArrowRight,
  CalendarClock,
  CreditCard,
  MessageSquare,
  ShieldCheck,
  Clock3,
  MapPin,
  PhoneCall,
  Star,
  Plane,
  Users,
  type LucideIcon,
} from "lucide-react"
import { heroServiceCopy } from "@/data/homeHero"
import { introStatsCopy } from "@/data/homeIntro"
import { experienceCopy } from "@/data/homeFeatures"
import { callFunction } from "@/lib/api/client"

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
  }
}

const adjustWidth = (url: string, width: number) => {
  if (!url) return url
  if (url.includes("w=")) {
    return url.replace(/w=\d+/g, `w=${width}`)
  }
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}w=${width}`
}

const ensureWebp = (url: string) => {
  if (!url) return url
  return url.includes("fm=webp") ? url : `${url}${url.includes("?") ? "&" : "?"}fm=webp`
}

const airportGallery = [
  {
    title: "Abbotsford International Airport (YXX)",
    image: "https://images.unsplash.com/photo-1529070538774-1843cb3265df?auto=format&fit=crop&w=1200&q=80",
    description: "Morning departures across the Fraser Valley hub.",
  },
  {
    title: "Vancouver International Airport (YVR)",
    image: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&w=1200&q=80",
    description: "Canada's gateway to the world, served day and night.",
  },
  {
    title: "Bellingham International Airport (BLI)",
    image: "https://images.unsplash.com/photo-1464037866556-6812c9d1c72e?auto=format&fit=crop&w=1200&q=80",
    description: "Cross-border flights with quick customs processing.",
  },
]

const highlights = [
  {
    title: 'Door-to-Door Service',
    description:
      'Comprehensive shuttle coverage across the Fraser Valley, Lower Mainland, and GVRD.',
    icon: MapPin,
  },
  {
    title: "Fluid Scheduling",
    description:
      "Book, reschedule, or cancel rides with live availability and instant confirmations. Syncs to Google Calendar automatically.",
    icon: CalendarClock,
  },
  {
    title: "Secure Payments",
    description:
      "Square and Stripe integrations with saved cards, receipts, promo codes, and enterprise invoicing.",
    icon: CreditCard,
  },
]

const serviceHighlights = [
  {
    title: "Door-to-Door Coverage",
    description: "Every Fraser Valley, Lower Mainland, and GVRD address—no surge pricing or zones.",
    icon: MapPin,
  },
  {
    title: "24/7 Dispatch",
    description: "Live humans confirm every leg, track traffic, and coordinate last-minute changes.",
    icon: Clock3,
  },
  {
    title: "Major Airport & Ferry Access",
    description: "Service to YXX, YVR, BLI, and the terminals feeding BC Ferries and cruise ships.",
    icon: Plane,
  },
  {
    title: "Corporate & Groups",
    description: "Centralized billing, saved routes, and managed traveler preferences for teams.",
    icon: Users,
  },
]

export const HomePage = () => {
  return (
    <div className="flex flex-col gap-12 pb-8">
      <Hero />
      <section className="grid gap-6 md:grid-cols-3">
        {airportGallery.map((airport) => (
          <GlassPanel key={airport.title} className="overflow-hidden p-0">
            <ResponsiveImage
              src={airport.image}
              alt={airport.title}
              className="h-48 w-full object-cover transition duration-500 group-hover:scale-105"
              sources={[
                {
                  srcSet: ensureWebp(adjustWidth(airport.image, 640)),
                  type: "image/webp",
                  media: "(max-width: 768px)",
                },
              ]}
            />
            <div className="space-y-3 p-6">
              <h3 className="font-heading text-lg uppercase tracking-[0.32em] text-horizon">
                {airport.title}
              </h3>
              <p className="text-base text-midnight/75">{airport.description}</p>
            </div>
          </GlassPanel>
        ))}
      </section>
      <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
       {highlights.map((item) => (
         <GlassPanel key={item.title} className="p-6">
           <item.icon className="mb-4 h-10 w-10 text-glacier" />
           <h3 className="font-heading text-xl uppercase tracking-[0.35em] text-horizon">
             {item.title}
           </h3>
           <p className="mt-3 text-sm text-midnight/75 leading-relaxed">{item.description}</p>
         </GlassPanel>
       ))}
     </section>
      <section className="grid gap-6">
        <GlassPanel className="flex flex-col gap-6 p-6">
          <h3 className="font-heading text-lg uppercase tracking-[0.35em] text-horizon">
            Why Travelers Choose Valley Airporter
          </h3>
          <p className="text-sm text-midnight/80 whitespace-pre-line leading-relaxed">{introStatsCopy}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <FeatureCallout icon={CalendarClock} title="Reserve Ahead" description="Book round-trips and recurring rides" />
            <FeatureCallout icon={CreditCard} title="Flexible Payment" description="Cash, card, e-transfer, airline vouchers" />
            <FeatureCallout icon={MessageSquare} title="Real-Time Updates" description="Text, email, and in-app notifications" />
            <FeatureCallout icon={ShieldCheck} title="Professional Chauffeurs" description="Trusted team with spotless safety record" />
          </div>
        </GlassPanel>
      </section>
      <GlassPanel className="p-6">
        <h3 className="font-heading text-lg uppercase tracking-[0.45em] text-horizon">
          Corporate & Groups
        </h3>
        <p className="mt-2 text-sm text-midnight/75">
          Get centralized invoicing, pre-cleared travelers, and priority dispatch.
        </p>
        <CorporateInquiryForm />
      </GlassPanel>
      <GlassPanel className="p-6">
        <h3 className="font-heading text-lg uppercase tracking-[0.45em] text-horizon text-center">
          Key Service Highlights
        </h3>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {serviceHighlights.map((perk) => (
            <div
              key={perk.title}
              className="rounded-2xl border border-horizon/25 bg-white/70 p-4 shadow-sm"
            >
              <perk.icon className="h-6 w-6 text-horizon" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.32em] text-horizon">
                {perk.title}
              </p>
              <p className="mt-2 text-sm text-midnight/70 leading-relaxed">{perk.description}</p>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}

const Hero = () => {
  return (
    <section className="relative flex flex-col gap-6">
      <GlassPanel className="flex flex-col gap-6 p-8">
        <div className="space-y-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-horizon/40 bg-white/70 px-4 py-1 text-xs uppercase tracking-[0.35em] text-horizon">
            Airport Shuttle Specialists
          </span>
          <h1 className="font-heading text-4xl uppercase tracking-[0.28em] text-horizon sm:text-5xl">
            Book • Track • Relax
          </h1>
          <p className="text-base text-midnight/80 whitespace-pre-line">
            {heroServiceCopy}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <HeroStat icon={ShieldCheck} label="Flat Rate" description="Guaranteed for any address" />
          <HeroStat
            icon={Clock3}
            label="24/7 Support"
            description={
              <a href="tel:+16047516688" className="underline text-horizon">
                Call or text 604-751-6688
              </a>
            }
          />
          <HeroStat
            icon={MapPin}
            label="Cheam Tours Partner"
            description={
              <a href="tel:+16045943333" className="underline text-horizon">
                Airport Link Shuttle 604-594-3333
              </a>
            }
          />
        </div>
        <div className="mt-6 flex flex-col items-center gap-4 sm:flex-row sm:flex-wrap sm:justify-center lg:justify-start">
          <Link
            to="/booking"
            className="inline-flex items-center justify-center gap-3 rounded-full border border-emerald-400 bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-600 px-10 py-5 text-[30px] font-heading font-bold uppercase tracking-[0.28em] text-white shadow-[0_20px_45px_-18px_rgba(16,185,129,0.55)] transition hover:from-emerald-500 hover:via-emerald-600 hover:to-emerald-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300/50"
          >
            Start Booking
            <ArrowRight className="h-8 w-8" />
          </Link>
          <a
            href="tel:+16047516688"
            className="inline-flex items-center gap-2 rounded-full border border-horizon/40 bg-white/80 px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-horizon transition hover:border-horizon/60 hover:bg-white"
          >
            Call / Text 24/7
            <PhoneCall className="h-4 w-4" />
          </a>
          <Link
            to="/faq"
            className="inline-flex items-center gap-2 rounded-full border border-horizon/30 bg-white/75 px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-horizon transition hover:border-horizon/60 hover:bg-white/90"
          >
            Explore FAQs
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </GlassPanel>
    </section>
  )
}

const FeatureCallout = ({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) => (
  <div className="rounded-2xl border border-horizon/25 bg-white/70 p-4 shadow-sm">
    <Icon className="h-8 w-8 text-horizon" />
    <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.3em] text-horizon">
      {title}
    </h4>
    <p className="mt-2 text-base text-midnight/75">{description}</p>
  </div>
)

const HeroStat = ({
  icon: Icon,
  label,
  description,
}: {
  icon: LucideIcon
  label: string
  description: string | ReactNode
}) => (
  <div className="rounded-2xl border border-white/50 bg-white/70 p-4 shadow-sm">
    <Icon className="h-6 w-6 text-horizon" />
    <p className="mt-3 text-sm font-semibold uppercase tracking-[0.32em] text-horizon">{label}</p>
    <p className="mt-1 text-xs text-midnight/70 leading-relaxed">{description}</p>
  </div>
)

const CorporateInquiryForm = () => {
  const [values, setValues] = useState({
    company: "",
    contact: "",
    email: "",
    phone: "",
    trips: "",
  })
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!values.company || !values.contact || !values.email || !values.phone) {
      setError("Please complete the required fields.")
      return
    }
    try {
      setStatus("loading")
      setError(null)
      await callFunction<{ ok: boolean }>("submitContactMessage", {
        method: "POST",
        body: {
          fullName: values.contact,
          email: values.email,
          phone: values.phone,
          subject: `Corporate Program Inquiry – ${values.company}`,
          message: `Company: ${values.company}\nContact: ${values.contact}\nEstimated trips per month: ${values.trips || "Not provided"}`,
        },
      })
      setValues({
        company: "",
        contact: "",
        email: "",
        phone: "",
        trips: "",
      })
      setStatus("success")
    } catch (err) {
      console.error(err)
      setStatus("error")
      setError(err instanceof Error ? err.message : "We could not send your request. Please try again.")
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 grid gap-3 text-sm">
      <div className="grid gap-2">
          <label className="text-[0.85rem] uppercase tracking-[0.35em] text-midnight/70">Company</label>
        <input
          required
          type="text"
          value={values.company}
          onChange={(event) => setValues((prev) => ({ ...prev, company: event.target.value }))}
          className="h-12 rounded-2xl border border-horizon/25 bg-white/80 px-4 text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <label className="text-[0.85rem] uppercase tracking-[0.35em] text-midnight/70">Contact</label>
          <input
            required
            type="text"
            value={values.contact}
            onChange={(event) => setValues((prev) => ({ ...prev, contact: event.target.value }))}
            className="h-12 rounded-2xl border border-horizon/25 bg-white/80 px-4 text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </div>
        <div className="grid gap-2">
          <label className="text-[0.85rem] uppercase tracking-[0.35em] text-midnight/70">Phone</label>
          <input
            required
            type="tel"
            value={values.phone}
            onChange={(event) => setValues((prev) => ({ ...prev, phone: event.target.value }))}
            className="h-12 rounded-2xl border border-horizon/25 bg-white/80 px-4 text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <label className="text-[0.85rem] uppercase tracking-[0.35em] text-midnight/70">Email</label>
          <input
            required
            type="email"
            value={values.email}
            onChange={(event) => setValues((prev) => ({ ...prev, email: event.target.value }))}
            className="h-12 rounded-2xl border border-horizon/25 bg-white/80 px-4 text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </div>
        <div className="grid gap-2">
          <label className="text-[0.85rem] uppercase tracking-[0.35em] text-midnight/70">Trips / Month</label>
          <input
            type="text"
            value={values.trips}
            onChange={(event) => setValues((prev) => ({ ...prev, trips: event.target.value }))}
            placeholder="e.g. 6-10"
            className="h-12 rounded-2xl border border-horizon/25 bg-white/80 px-4 text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={status === "loading"}
        className="mt-2 inline-flex items-center justify-center gap-2 rounded-full border border-horizon/40 bg-horizon px-6 py-3 text-xs font-semibold uppercase tracking-[0.32em] text-white transition hover:bg-horizon/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "loading" ? "Sending..." : "Submit"}
        <ArrowRight className="h-4 w-4" />
      </button>
      {error ? <p className="text-xs text-ember">{error}</p> : null}
      {status === "success" ? (
        <p className="text-xs text-aurora">Thank you! Dispatch will confirm your program shortly.</p>
      ) : null}
    </form>
  )
}
