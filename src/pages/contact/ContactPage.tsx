import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { GlassPanel } from "@/components/ui/GlassPanel"
import { ResponsiveImage } from "@/components/ui/ResponsiveImage"
import { MapPin, Phone, Mail, Clock, Send } from "lucide-react"
import { callFunction } from "@/lib/api/client"

const contactSchema = z.object({
  fullName: z.string().min(2, "Enter your name"),
  email: z.string().email("Enter a valid email"),
  phone: z.string().min(7, "Enter your phone number"),
  subject: z.string().min(3, "Describe your request"),
  message: z.string().min(10, "Share a few details so we can help"),
})

type ContactFormValues = z.infer<typeof contactSchema>

export const ContactPage = () => {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [submitError, setSubmitError] = useState<string | null>(null)
  const navigate = useNavigate()
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      fullName: "",
      email: "",
      phone: "",
      subject: "",
      message: "",
    },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      setStatus("submitting")
      setSubmitError(null)

      await callFunction<{ ok: boolean }>("submitContactMessage", {
        method: "POST",
        body: values,
      })

      setStatus("success")
      form.reset()
      navigate({ to: "/thank-you", state: { context: "contact" } })
    } catch (error) {
      console.error(error)
      setSubmitError(
        error instanceof Error
          ? error.message
          : "We couldn't submit your message. Please try again or reach us by phone.",
      )
      setStatus("error")
    }
  })

  return (
    <div className="flex flex-col gap-6 pb-16">
      <GlassPanel className="grid gap-6 p-7 lg:grid-cols-[1fr_260px]">
        <div>
          <p className="font-heading text-base uppercase tracking-[0.35em] text-horizon/70">
            Reach the Operations Desk
          </p>
          <h1 className="mt-4 font-heading text-3xl uppercase tracking-[0.28em] text-horizon">
            Contact Valley Airporter
          </h1>
          <p className="mt-4 max-w-3xl text-base text-midnight/75">
            Our dispatch team responds to new booking requests, travel updates, and corporate inquiries
            around the clock. Use the form below or call/text for same-day travel.
          </p>
        </div>
        <ResponsiveImage
          src="https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=720&q=80"
          alt="Valley Airporter shuttle ready for departure"
          className="h-44 w-full rounded-3xl object-cover shadow-lg"
          sources={[
            {
              srcSet: "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=600&q=75&fm=webp",
              type: "image/webp",
              media: "(max-width: 768px)",
            },
          ]}
        />
      </GlassPanel>
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <GlassPanel className="grid gap-6 p-6">
          <ResponsiveImage
            src="https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80"
            alt="Map showing Fraser Valley routes"
            className="h-40 w-full rounded-3xl object-cover shadow"
            sources={[
              {
                srcSet: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=75&fm=webp",
                type: "image/webp",
                media: "(max-width: 768px)",
              },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ContactDetail
              icon={MapPin}
              label="Address"
              value="31631 S Fraser Way Unit #101, Abbotsford, BC V2T 1T8"
            />
            <ContactDetail
              icon={Phone}
              label="Call / Text"
              value="(604) 751-6688"
              helper="Toll-free: (877) 604-6688"
            />
            <ContactDetail icon={Mail} label="Email" value="info@valleyairporter.ca" />
            <ContactDetail icon={Clock} label="Operating Hours" value="24 hours • 7 days" />
          </div>
        </GlassPanel>
        <GlassPanel className="p-6">
          <form className="grid gap-4" onSubmit={onSubmit}>
            <FormField
              label="Full Name"
              error={form.formState.errors.fullName?.message}
              input={
                <input
                  type="text"
                  {...form.register("fullName")}
                  className="h-12 rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                />
              }
            />
            <FormField
              label="Email"
              error={form.formState.errors.email?.message}
              input={
                <input
                  type="email"
                  {...form.register("email")}
                  className="h-12 rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                />
              }
            />
            <FormField
              label="Phone"
              error={form.formState.errors.phone?.message}
              input={
                <input
                  type="tel"
                  {...form.register("phone")}
                  className="h-12 rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                />
              }
            />
            <FormField
              label="Subject"
              error={form.formState.errors.subject?.message}
              input={
                <input
                  type="text"
                  {...form.register("subject")}
                  className="h-12 rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                />
              }
            />
            <FormField
              label="Message"
              error={form.formState.errors.message?.message}
              input={
                <textarea
                  rows={5}
                  {...form.register("message")}
                  className="rounded-3xl border border-horizon/30 bg-white/80 px-4 py-3 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                />
              }
            />
            <button
              type="submit"
              disabled={status === "submitting"}
              className="mt-2 flex h-12 items-center justify-center gap-2 rounded-full border border-horizon/50 bg-horizon px-6 text-xs font-semibold uppercase tracking-[0.32em] text-white transition hover:border-horizon/60 hover:bg-horizon/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
              {status === "submitting" ? "Sending..." : "Send Message"}
            </button>
            {status === "success" ? (
              <p className="text-sm text-aurora">
                Message received. Dispatch will follow up shortly.
              </p>
            ) : null}
            {submitError ? (
              <p className="text-sm text-ember">{submitError}</p>
            ) : null}
            {status === "error" ? (
              <p className="text-sm text-ember">
                Something went wrong. Please try again or reach us by phone.
              </p>
            ) : null}
          </form>
        </GlassPanel>
      </div>
    </div>
  )
}

const ContactDetail = ({
  icon: Icon,
  label,
  value,
  helper,
}: {
  icon: typeof MapPin
  label: string
  value: string
  helper?: string
}) => (
  <div className="flex items-start gap-3 rounded-2xl border border-horizon/15 bg-white/85 px-4 py-4">
    <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-full border border-horizon/30 bg-white text-horizon">
      <Icon className="h-5 w-5" aria-hidden />
    </div>
    <div className="space-y-1">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-horizon/80">{label}</p>
      <p className="text-base text-midnight/80">{value}</p>
      {helper ? <p className="text-sm text-midnight/60">{helper}</p> : null}
    </div>
  </div>
)

const FormField = ({
  label,
  error,
  input,
}: {
  label: string
  error?: string
  input: React.ReactNode
}) => (
  <label className="flex flex-col gap-2">
    <span className="text-xs font-semibold uppercase tracking-[0.3em] text-horizon/80">
      {label}
    </span>
    {input}
    {error ? <span className="text-sm text-ember">{error}</span> : null}
  </label>
)

export default ContactPage
