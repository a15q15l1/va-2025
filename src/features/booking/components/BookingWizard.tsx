import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEventHandler, type ReactNode } from "react"
import { z } from "zod"
import { Controller, useForm, type Resolver, type UseFormReturn } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { FirebaseError } from "firebase/app"
import { useNavigate } from "@tanstack/react-router"
import { GlassPanel } from "@/components/ui/GlassPanel"
import DispatchAlchemist from "@/components/DispatchAlchemist"
import carsAnimation from "@/lotties/loading-car.json"
import driverAnimation from "@/lotties/driver.json"
import confettiAnimation from "@/lotties/confetti.json"
import calculatorAnimation from "@/lotties/booking-calculator.json"
import finalizerAnimation from "@/lotties/finalize-spinner.json"
import {
  calculatePricing,
  getDestinationsForOrigin,
  getOriginsForDirection,
  getAvailableDirections,
} from "@/features/booking/pricing"
import type { TripDirection, PricingResult, PricingQuoteResult } from "@/features/booking/pricing"
import { addHours, differenceInMinutes, format } from "date-fns"
import { clsx } from "clsx"
import { useFirebaseServices } from "@/app/providers/FirebaseContext"
import { PlacesAutocompleteInput } from "@/components/maps/PlacesAutocompleteInput"
import { apiFetch } from "@/lib/api/rest"
import { callFunction } from "@/lib/api/client"
import { saveBookingThankYouState, type BookingThankYouState } from "@/features/booking/utils/thankYouState"

const baseDirections = getAvailableDirections()
const extraDirections = ["Ferry Terminal", "Cruise Terminal"] as const
const directionOptions = [...baseDirections, ...extraDirections] as const
type DirectionOption = (typeof directionOptions)[number]
const ABBOTSFORD_ANY_ADDRESS = "Abbotsford (Any Address)"
const additionalTerminals = [
  "Abbotsford International Airport (YXX)",
  "Vancouver International Airport (YVR)",
  "Bellingham International Airport (BLI)",
]
const TEST_LOCATION_LABEL = "OT"

type LocationOptionGroup = {
  label: string
  options: string[]
}

const PASSENGER_MAX = 14
const MIN_ADVANCE_HOURS = 10
const SOFT_NOTICE_HOURS = 24
const MIN_ADVANCE_MINUTES = MIN_ADVANCE_HOURS * 60
const ADDITIONAL_PASSENGER_FEE = 10
const FALLBACK_PRICE_CAP = 300
const PASSENGER_LIMIT_MESSAGE =
  "If you would like more than 14 passengers, please call or email us instead for a group quote."

const LOCATION_CATEGORY_ORDER = [
  "Airports",
  "Ferry Terminals",
  "Cruise Terminals",
  "Transit Hubs",
  "Metro Areas",
] as const

const STEP_SCROLL_BUFFER = 12
const APP_HEADER_SELECTOR = "[data-app-header]"

const normalizeLocationLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/\s*\(.*?\)/g, "")
    .replace(/\s+in\s+.*$/g, "")
    .trim()

const getLocationCategory = (label: string): (typeof LOCATION_CATEGORY_ORDER)[number] => {
  const lower = label.toLowerCase()
  if (lower.includes("airport")) return "Airports"
  if (lower.includes("ferry")) return "Ferry Terminals"
  if (lower.includes("cruise")) return "Cruise Terminals"
  if (lower.includes("skytrain") || lower.includes("station")) return "Transit Hubs"
  return "Metro Areas"
}

const buildLocationGroups = (options: string[]): LocationOptionGroup[] => {
  const grouped = new Map<string, string[]>()
  options.forEach((option) => {
    const category = getLocationCategory(option)
    const existing = grouped.get(category)
    if (existing) {
      existing.push(option)
    } else {
      grouped.set(category, [option])
    }
  })

  const ordered: LocationOptionGroup[] = []
  LOCATION_CATEGORY_ORDER.forEach((category) => {
    const items = grouped.get(category)
    if (items?.length) {
      ordered.push({ label: category, options: items })
      grouped.delete(category)
    }
  })

  grouped.forEach((items, category) => {
    ordered.push({ label: category, options: items })
  })

  return ordered.map((group) => ({
    label: group.label,
    options: group.options.filter((option, index, array) => {
      const key = normalizeLocationLabel(option)
      return array.findIndex((candidate) => normalizeLocationLabel(candidate) === key) === index
    }),
  }))
}

const shouldShowDistanceFare = (origin: string, destination: string) => {
  const target = normalizeLocationLabel(ABBOTSFORD_ANY_ADDRESS)
  return (
    normalizeLocationLabel(origin) === target ||
    normalizeLocationLabel(destination) === target
  )
}

const isYxxToAbbotsfordRoute = (origin: string, destination: string) => {
  const originLower = origin.toLowerCase()
  const destinationLower = destination.toLowerCase()
  const matchesAirport = (text: string) =>
    text.includes("abbotsford international airport") || text.includes("(yxx)")
  const matchesAnyAddress = (text: string) =>
    text.includes("abbotsford (any address)") || text.includes("abbotsford any address")

  return (
    (matchesAirport(originLower) && matchesAnyAddress(destinationLower)) ||
    (matchesAirport(destinationLower) && matchesAnyAddress(originLower))
  )
}

const getExtraPassengerFee = (origin: string, destination: string) =>
  isYxxToAbbotsfordRoute(origin, destination) ? 0 : ADDITIONAL_PASSENGER_FEE

const roundMinutesToStep = (minutes: number, step: number) => Math.floor(minutes / step) * step

const extractTimeParts = (date: Date) => {
  const hours24 = date.getHours()
  const minutes = roundMinutesToStep(date.getMinutes(), 5)
  const period: "AM" | "PM" = hours24 >= 12 ? "PM" : "AM"
  const hour12 = hours24 % 12 || 12
  return {
    hour: String(hour12).padStart(2, "0"),
    minute: String(minutes).padStart(2, "0"),
    period,
  }
}

const buildScheduleDefaults = (offsetHours: number) => {
  const target = addHours(new Date(), offsetHours)
  const { hour, minute, period } = extractTimeParts(target)
  return {
    pickupDate: format(target, "yyyy-MM-dd"),
    pickupHour: hour,
    pickupMinute: minute,
    pickupPeriod: period,
  }
}

const combineDateAndTime = (date: string, hour: string, minute: string, period: "AM" | "PM") => {
  const normalizedHour = Number(hour) || 0
  const normalizedMinute = Number(minute) || 0
  let hours24 = normalizedHour % 12
  if (period === "PM") hours24 += 12
  const isoHour = String(hours24).padStart(2, "0")
  const isoMinute = String(normalizedMinute).padStart(2, "0")
  return new Date(`${date}T${isoHour}:${isoMinute}`)
}

const vehicleOptions = [
  {
    id: "sevenVan",
    label: "7-Seater Van (up to 6 passengers)",
    helper: "Plenty of room for families and carry-ons.",
  },
  {
    id: "chevyExpress",
    label: "8-Seater Chevrolet Express (up to 7 passengers, extra luggage space)",
    helper: "Great for sports teams and ski groups.",
  },
  {
    id: "mercedesSprinter",
    label: "12-Seater Mercedes Benz Sprinter Van (up to 11 passengers)",
    helper: "Premium shuttle with standing room height.",
  },
  {
    id: "freightlinerSprinter",
    label: "15-Seater Freightliner Sprinter (up to 14 passengers)",
    helper: "Max capacity option for large crews.",
  },
] as const

type VehicleOptionId = (typeof vehicleOptions)[number]["id"]

const vehicleLabelMap: Record<VehicleOptionId, string> = Object.fromEntries(
  vehicleOptions.map((option) => [option.id, option.label]),
) as Record<VehicleOptionId, string>

type PassengerOption = {
  id: string
  passengers: number
  label: string
  vehicleId?: VehicleOptionId
  preferredRateKey?: string | null
  warning?: string
}

const passengerOptions: PassengerOption[] = [
  { id: "p1", passengers: 1, label: "1 Passenger" },
  { id: "p2", passengers: 2, label: "2 Passengers" },
  { id: "p3", passengers: 3, label: "3 Passengers" },
  { id: "p4", passengers: 4, label: "4 Passengers" },
  { id: "p5", passengers: 5, label: "5 Passengers" },
  {
    id: "p6-standard",
    passengers: 6,
    label: "6 Passengers (7-Seater Regular Van)",
    vehicleId: "sevenVan",
    warning: "Limited luggage room on the 7-seater. Choose a larger van if you need extra space.",
  },
  {
    id: "p6-large",
    passengers: 6,
    label: "6 Passengers (8-Seater Larger Van)",
    vehicleId: "chevyExpress",
    preferredRateKey: "7v",
  },
  {
    id: "p7-large",
    passengers: 7,
    label: "7 Passengers (8-Seater Larger Van)",
    vehicleId: "chevyExpress",
    preferredRateKey: "7v",
  },
  {
    id: "p8-11",
    passengers: 11,
    label: "8-11 Passengers (12-Seater Mercedes Sprinter)",
    vehicleId: "mercedesSprinter",
    preferredRateKey: "8-11",
  },
  {
    id: "p12-14",
    passengers: 14,
    label: "12-14 Passengers (15-Seater Freightliner Sprinter)",
    vehicleId: "freightlinerSprinter",
    preferredRateKey: "12-14",
  },
] as const

const resolvePassengerOption = (
  passengerCount: number,
  vehicleId?: VehicleOptionId | null,
): PassengerOption | null => {
  if (vehicleId) {
    const exact = passengerOptions.find(
      (option) => option.passengers === passengerCount && option.vehicleId === vehicleId,
    )
    if (exact) return exact
  }
  return (
    passengerOptions.find(
      (option) => option.passengers === passengerCount && option.vehicleId == null,
    ) ?? null
  )
}

const vehiclePreferenceMap: Record<VehicleOptionId, "standard" | "van"> = {
  sevenVan: "standard",
  chevyExpress: "van",
  mercedesSprinter: "van",
  freightlinerSprinter: "van",
}

const largeVehicleIds = new Set<VehicleOptionId>(["chevyExpress", "mercedesSprinter", "freightlinerSprinter"])
const hasLargeVehicleSelection = (selections: VehicleOptionId[]) =>
  selections.some((selection) => largeVehicleIds.has(selection))

const determineVehicleOption = (passengerCount: number): VehicleOptionId => {
  if (passengerCount >= 12) return "freightlinerSprinter"
  if (passengerCount >= 8) return "mercedesSprinter"
  if (passengerCount >= 6) return "chevyExpress"
  return "sevenVan"
}

const to24Hour = (hour: string, minute: string, period: "AM" | "PM") => {
  let h = parseInt(hour, 10)
  if (Number.isNaN(h)) h = 0
  h = h % 12
  if (period === "PM") h += 12
  return `${String(h).padStart(2, "0")}:${minute.padStart(2, "0")}`
}

const vehicleSelectionEnum = z.enum(vehicleOptions.map((option) => option.id) as [VehicleOptionId, ...VehicleOptionId[]])

const directionEnum = z.enum(directionOptions as unknown as [DirectionOption, ...DirectionOption[]])

const tripSchema = z.object({
  direction: directionEnum,
  origin: z.string().min(1, "Select a pick-up address"),
  originAddress: z.string().optional(),
  destination: z.string().min(1, "Select a drop-off address"),
  destinationAddress: z.string().optional(),
  passengerCount: z
    .coerce
    .number()
    .min(1, "Select passenger count")
    .max(PASSENGER_MAX, {
      message: PASSENGER_LIMIT_MESSAGE,
    }),
  vehicleSelections: z.array(vehicleSelectionEnum).min(1),
})

const scheduleSchema = z.object({
  pickupDate: z.string().min(1, "Choose a pickup date"),
  pickupHour: z.string().min(1),
  pickupMinute: z.string().min(1),
  pickupPeriod: z.enum(["AM", "PM"]),
  flightNumber: z.string().optional(),
  notes: z.string().max(280, "Keep notes under 280 characters").optional(),
})

const passengerSchema = z.object({
  primaryPassenger: z.string().min(1, "Enter passenger name"),
  email: z.string().email("Valid email required"),
  phone: z.string().min(7, "Enter contact phone"),
  baggage: z.enum(["Normal", "Oversized", "Minimal"]).default("Normal"),
})

type TripForm = z.infer<typeof tripSchema>
type ScheduleForm = z.infer<typeof scheduleSchema>
type PassengerForm = z.infer<typeof passengerSchema>

type TripData = {
  direction: DirectionOption
  origin: string
  originAddress?: string
  destination: string
  destinationAddress?: string
  passengerCount: number
  vehicleSelections: VehicleOptionId[]
  preferredRateKey?: string | null
}

type ScheduleData = {
  pickupDate: string
  pickupTime: string
  flightNumber?: string
  notes?: string
}

type StepKey = 0 | 1 | 2 | 3 | 4

export const BookingWizard = () => {
  const [step, setStep] = useState<StepKey>(0)
  const [maxStepReached, setMaxStepReached] = useState<StepKey>(0)
  const [tripData, setTripData] = useState<TripData | null>(null)
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null)
  const [passengerData, setPassengerData] = useState<PassengerForm | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submittingBooking, setSubmittingBooking] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submissionDetails, setSubmissionDetails] = useState<{ paymentLink?: string | null } | null>(null)
  const [tipAmount, setTipAmount] = useState<number>(0)
  const [paymentPreference, setPaymentPreference] = useState<"pay_on_arrival" | "pay_now" | null>(null)
  const [paymentSelectionError, setPaymentSelectionError] = useState<string | null>(null)
  const [quoteLogId, setQuoteLogId] = useState<string | null>(null)
  const quoteLogIdRef = useRef<string | null>(null)
  const [remotePricing, setRemotePricing] = useState<PricingResult | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const stepHeaderRef = useRef<HTMLDivElement | null>(null)
  const { enabled: firebaseEnabled } = useFirebaseServices()
  const navigate = useNavigate()
  const [tripDistanceEstimate, setTripDistanceEstimate] = useState<{
    distanceKm: number
    durationMinutes: number
  } | null>(null)

  const tripResolver = zodResolver(tripSchema) as Resolver<TripForm>
  const scheduleResolver = zodResolver(scheduleSchema) as Resolver<ScheduleForm>
  const passengerResolver = zodResolver(passengerSchema) as Resolver<PassengerForm>

  const scheduleDefaults = useMemo(() => buildScheduleDefaults(SOFT_NOTICE_HOURS), [])

  const creatingQuoteLogRef = useRef(false)

  useEffect(() => {
    quoteLogIdRef.current = quoteLogId
  }, [quoteLogId])

  const createQuoteLog = useCallback(async (payload: Record<string, unknown>) => {
    if (quoteLogIdRef.current) return quoteLogIdRef.current
    if (creatingQuoteLogRef.current) return quoteLogIdRef.current
    creatingQuoteLogRef.current = true
    try {
      const response = await apiFetch<{ id: string }>("/quoteLogs", {
        method: "POST",
        body: payload,
        skipAuth: true,
      })
      if (response?.id) {
        quoteLogIdRef.current = response.id
        setQuoteLogId(response.id)
        return response.id
      }
    } catch (error) {
      console.error("Failed to create quote log", error)
    } finally {
      creatingQuoteLogRef.current = false
    }
    return quoteLogIdRef.current
  }, [])

  const updateQuoteLog = useCallback(async (payload: Record<string, unknown>) => {
    const targetId = quoteLogIdRef.current
    if (!targetId) return
    try {
      await apiFetch(`/quoteLogs/${targetId}`, {
        method: "PATCH",
        body: payload,
        skipAuth: true,
      })
    } catch (error) {
      console.error("Failed to update quote log", error)
    }
  }, [])

  const tripForm = useForm<TripForm>({
    resolver: tripResolver,
    defaultValues: {
      direction: directionOptions[0],
      origin: "",
      destination: "",
      passengerCount: 0,
      vehicleSelections: [vehicleOptions[0].id],
      originAddress: "",
      destinationAddress: "",
    },
  })

  const scheduleForm = useForm<ScheduleForm>({
    resolver: scheduleResolver,
    defaultValues: scheduleDefaults,
  })

  const passengerForm = useForm<PassengerForm>({
    resolver: passengerResolver,
    defaultValues: {
      baggage: "Normal",
    },
  })

  useEffect(() => {
    if (!tripData) {
      setRemotePricing(null)
      setQuoteError(null)
      setQuoteLoading(false)
      return
    }

    const preferred =
      tripData.vehicleSelections.some((selection) => vehiclePreferenceMap[selection] === "van") ?
        "van" :
        "standard"

    const controller = new AbortController()
    let active = true

    const fetchQuote = async () => {
      try {
        setRemotePricing(null)
        setQuoteLoading(true)
        setQuoteError(null)
        const result = await apiFetch<PricingResult>("/fares/quote", {
          method: "POST",
          skipAuth: true,
          signal: controller.signal,
          body: {
            direction: tripData.direction,
            origin: tripData.origin,
            destination: tripData.destination,
            passengerCount: tripData.passengerCount,
            preferredVehicle: preferred,
            originAddress: tripData.originAddress ?? null,
            destinationAddress: tripData.destinationAddress ?? null,
            suppressLog: true,
          },
        })
        if (!active) return
        setRemotePricing(result)
      } catch (error) {
        if (!active) return
        if ((error as Error).name === "AbortError") return
        console.error("Failed to refresh live pricing", error)
        setRemotePricing(null)
        const fallbackMessage =
          error instanceof Error && /api base url/i.test(error.message) ?
            "Live pricing is temporarily offline. Showing base rates instead." :
            error instanceof Error ?
              error.message :
              "We couldn’t reach live pricing. Showing base rates instead."
        setQuoteError(fallbackMessage)
      } finally {
        if (!active) return
        setQuoteLoading(false)
      }
    }

    void fetchQuote()

    return () => {
      active = false
      controller.abort()
    }
  }, [tripData])

  const fallbackPricingResult = useMemo<{
    pricing: PricingResult | null
    suppressed: boolean
  }>(() => {
    if (!tripData) {
      return { pricing: null, suppressed: false }
    }
    const preferred =
      tripData.vehicleSelections.some((selection) => vehiclePreferenceMap[selection] === "van") ?
        "van" :
        "standard"

    if (!baseDirections.includes(tripData.direction as TripDirection)) {
      return { pricing: null, suppressed: false }
    }

    const result = calculatePricing({
      direction: tripData.direction as TripDirection,
      origin: tripData.origin,
      destination: tripData.destination,
      passengerCount: tripData.passengerCount,
      preferredVehicle: preferred,
      preferredRateKey: tripData.preferredRateKey ?? null,
    })
    const suppressed = Boolean(result?.baseRate != null && result.baseRate > FALLBACK_PRICE_CAP)
    return {
      pricing: suppressed ? null : result,
      suppressed,
    }
  }, [tripData])

  const fallbackPricing = fallbackPricingResult.pricing
  const pricing = remotePricing ?? (quoteLoading ? null : fallbackPricing)
  const fallbackSuppressed =
    fallbackPricingResult.suppressed && !remotePricing && !quoteLoading

  const estimatedQuote = useMemo(() => {
    if (!tripData || !pricing || pricing.baseRate == null) {
      return null
    }
    const breakdown = (pricing as PricingQuoteResult | null)?.breakdown ?? null
    const distanceRuleActive = Boolean(
      (pricing as PricingQuoteResult | null)?.distanceRuleApplied &&
        (pricing as PricingQuoteResult | null)?.distanceRule
    )
    const resolvedRateKey = tripData.preferredRateKey ?? pricing.vehicleKey ?? null
    const resolvedRateValue =
      !distanceRuleActive &&
      resolvedRateKey &&
      pricing.ratesTable &&
      typeof pricing.ratesTable[resolvedRateKey] === "number" ?
        Math.round(pricing.ratesTable[resolvedRateKey]!) :
        null
    const fallbackRateValue = (() => {
      if (!pricing.ratesTable) return null
      const passengerKey = tripData.passengerCount.toString()
      if (!distanceRuleActive) {
        if (typeof pricing.ratesTable[passengerKey] === "number") {
          return Math.round(pricing.ratesTable[passengerKey]!)
        }
        if (typeof pricing.ratesTable["1"] === "number") {
          return Math.round(pricing.ratesTable["1"]!)
        }
      }
      return null
    })()
    const resolvedTotalRate = Math.max(0, resolvedRateValue ?? fallbackRateValue ?? pricing.baseRate ?? 0)
    const roundedBaseRate = Math.round(resolvedTotalRate)
    const usesFlatRateSelection = Boolean(tripData.preferredRateKey)
    const chargeablePassengerCount = usesFlatRateSelection ? 1 : Math.min(6, tripData.passengerCount)
    const extraPassengers = Math.max(0, chargeablePassengerCount - 1)
    const perPassengerFee = getExtraPassengerFee(tripData.origin, tripData.destination)
    const breakdownPassengerCharge =
      breakdown?.additionalPassengerCharge != null ? Math.round(breakdown.additionalPassengerCharge) : null
    const extraPassengerTotal = breakdownPassengerCharge ?? Math.round(extraPassengers * perPassengerFee)
    const ratesTableBaseFare =
      !usesFlatRateSelection && pricing.ratesTable && typeof pricing.ratesTable["1"] === "number" ?
        Math.round(pricing.ratesTable["1"]!) :
        null
    const baseFareFromBreakdown =
      breakdown?.baseFare != null ? Math.round(breakdown.baseFare) : null
    const fallbackBaseFare =
      !usesFlatRateSelection ?
        Math.max(0, Math.round(resolvedTotalRate - extraPassengerTotal)) :
        null
    const baseFare = baseFareFromBreakdown ?? ratesTableBaseFare ?? fallbackBaseFare ?? Math.round(resolvedTotalRate)
    const usesDistanceFare = shouldShowDistanceFare(tripData.origin, tripData.destination)
    const additionalCharges = Math.max(0, roundedBaseRate - baseFare - extraPassengerTotal)
    const distanceFareFromBreakdown =
      breakdown?.distanceCharge != null ? Math.round(breakdown.distanceCharge) : null
    const distanceFare =
      distanceFareFromBreakdown ?? (usesDistanceFare ? Math.max(0, Math.round(additionalCharges)) : 0)
    const largeVehicleSelected = hasLargeVehicleSelection(tripData.vehicleSelections)
    const vehiclePremium = largeVehicleSelected ? Math.max(0, Math.round(additionalCharges - distanceFare)) : 0
    const estimatedGst = Math.round(roundedBaseRate * 0.05 * 100) / 100
    return {
      baseRate: roundedBaseRate,
      baseFare,
      distanceFare,
      extraPassengers,
      extraPassengerTotal,
      perPassenger: perPassengerFee,
      estimatedGst,
      vehiclePremium,
    }
  }, [pricing, tripData])

  const requiresFullAddress = (value?: string | null) =>
    Boolean(value && value.toLowerCase().includes("any address"))

  const handleTripSubmit = tripForm.handleSubmit((values: TripForm) => {
    const originFinal = values.origin?.trim()
    const destinationFinal = values.destination?.trim()

    if (!originFinal) {
      tripForm.setError("origin", { type: "required", message: "Select a pick-up address" })
      return
    }
    if (!destinationFinal) {
      tripForm.setError("destination", { type: "required", message: "Select a drop-off address" })
      return
    }

    const originAddressFinal = values.originAddress?.trim()
    if (requiresFullAddress(values.origin) && !originAddressFinal) {
      tripForm.setError("originAddress", { type: "required", message: "Enter full pickup address" })
      return
    }

    const destinationAddressFinal = values.destinationAddress?.trim()
    if (requiresFullAddress(values.destination) && !destinationAddressFinal) {
      tripForm.setError("destinationAddress", {
        type: "required",
        message: "Enter full drop-off address",
      })
      return
    }

    const passengerOptionMeta = resolvePassengerOption(
      values.passengerCount,
      values.vehicleSelections?.[0],
    )

    const payload: TripData = {
      direction: values.direction,
      origin: originFinal,
      originAddress: originAddressFinal,
      destination: destinationFinal,
      destinationAddress: destinationAddressFinal,
      passengerCount: values.passengerCount,
      vehicleSelections: values.vehicleSelections,
      preferredRateKey: passengerOptionMeta?.preferredRateKey ?? null,
    }

    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_trip" })
    }
    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_trip" })
    }
    setTripData(payload)
    goToStep(1, { scroll: true })
  })

  const handleScheduleSubmit = scheduleForm.handleSubmit((values: ScheduleForm) => {
    const pickupTime = to24Hour(values.pickupHour, values.pickupMinute, values.pickupPeriod)
    const pickupDateTime = combineDateAndTime(values.pickupDate, values.pickupHour, values.pickupMinute, values.pickupPeriod)
    const leadTimeMinutes = differenceInMinutes(pickupDateTime, new Date())
    if (!Number.isFinite(leadTimeMinutes) || leadTimeMinutes < MIN_ADVANCE_MINUTES) {
      const message = `Please choose a pickup at least ${MIN_ADVANCE_HOURS} hours from now.`
      scheduleForm.setError("pickupDate", { type: "manual", message })
      scheduleForm.setError("pickupHour", { type: "manual", message })
      scheduleForm.setError("pickupMinute", { type: "manual", message })
      return
    }
    scheduleForm.clearErrors(["pickupDate", "pickupHour", "pickupMinute"])
    const schedule: ScheduleData = {
      pickupDate: values.pickupDate,
      pickupTime,
      flightNumber: values.flightNumber,
      notes: values.notes,
    }

    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_schedule" })
    }
    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_schedule" })
    }
    setScheduleData(schedule)
    void updateQuoteLog({
      schedule: {
        pickupDate: schedule.pickupDate,
        pickupTime,
        flightNumber: schedule.flightNumber ?? null,
        notes: schedule.notes ?? null,
      },
      lastStep: 3,
    })
    goToStep(3, { scroll: true })
  })

  const handlePassengerSubmit = passengerForm.handleSubmit((values: PassengerForm) => {
    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_contact" })
    }
    if (typeof window !== "undefined") {
      window.dataLayer?.push?.({ event: "booking_form_step_contact" })
    }
    setPassengerData(values)
    setSubmitted(false)
    setSubmissionDetails(null)
    setSubmitError(null)
    setSubmittingBooking(false)
    void updateQuoteLog({
      contact: {
        name: values.primaryPassenger,
        email: values.email,
        phone: values.phone,
        baggage: values.baggage ?? "Normal",
      },
      lastStep: 4,
    })
    goToStep(4, { scroll: true })
  })

  const handleConfirm = useCallback(async () => {
    if (submitted || submittingBooking) return
    if (!tripData || !scheduleData || !passengerData) return
    if (!paymentPreference) {
      setPaymentSelectionError("Payment method must be selected.")
      return
    }

    const safeTip = Number.isFinite(tipAmount) ? Math.max(0, tipAmount) : 0
    const baseEstimate = pricing?.baseRate ?? null
    const estimatedTotalForState = baseEstimate != null ? baseEstimate + safeTip : null

    const preferredVehicle =
      tripData.vehicleSelections.some((selection) => vehiclePreferenceMap[selection] === "van") ?
        "van" :
        "standard"

    if (!firebaseEnabled) {
      const fallbackState: BookingThankYouState = {
        context: "booking",
        paymentPreference,
        paymentLink: null,
        bookingNumber: null,
        bookingId: null,
        total: estimatedTotalForState ?? null,
      }
      void updateQuoteLog({
        lastStep: 5,
        booking: {
          id: null,
          paymentPreference,
          paymentLink: null,
          tipAmount: safeTip,
        },
      })
      saveBookingThankYouState(fallbackState)
      navigate({
        to: "/thank-you",
        state: {
          context: "booking",
          paymentPreference,
          ...(estimatedTotalForState != null ? { total: estimatedTotalForState } : {}),
        },
      })
      return
    }

    try {
      setSubmittingBooking(true)
      setSubmitError(null)
      setSubmissionDetails(null)

      const response = await callFunction<{
        ok: boolean
        id: string
        bookingNumber?: string
        paymentLink?: { url?: string | null; orderId?: string | null } | null
        totals?: {
          baseCents: number
          gstCents: number
          tipCents: number
          totalCents: number
          currency: string
        }
      }>("createBooking", {
        method: "POST",
        body: {
          trip: {
            direction: tripData.direction,
            origin: tripData.origin,
            originAddress: tripData.originAddress ?? null,
            destination: tripData.destination,
            destinationAddress: tripData.destinationAddress ?? null,
            passengerCount: tripData.passengerCount,
            includeReturn: false,
            vehicleSelections: tripData.vehicleSelections,
            preferredVehicle,
            preferredRateKey: tripData.preferredRateKey ?? null,
          },
          schedule: {
            pickupDate: scheduleData.pickupDate,
            pickupTime: scheduleData.pickupTime,
            notes: scheduleData.notes ?? null,
            flightNumber: scheduleData.flightNumber ?? null,
          },
          passenger: {
            primaryPassenger: passengerData.primaryPassenger,
            email: passengerData.email,
            phone: passengerData.phone,
            baggage: passengerData.baggage ?? "Normal",
          },
          payment: {
            preference: paymentPreference,
            tipAmount: safeTip,
          },
          quoteRequestId: null,
        },
      })

      let navigateState:
        | (Record<string, unknown> & {
            context: "booking"
            paymentPreference: "pay_on_arrival" | "pay_now"
          })
        | null = null

      if (response?.ok) {
        const paymentUrl = response.paymentLink?.url ?? null
        setSubmissionDetails({
          paymentLink: paymentUrl,
        })
        void updateQuoteLog({
          lastStep: 5,
          booking: {
            id: response.id ?? null,
            paymentPreference,
            paymentLink: paymentUrl,
            tipAmount: safeTip,
            bookingNumber: response.bookingNumber ?? null,
          },
        })

        const totalCents = response.totals?.totalCents ?? null
        const gstCents = response.totals?.gstCents ?? null
        const displayCents =
          totalCents != null ?
            Math.max(0, totalCents - (gstCents ?? 0)) :
            null

        const totalForUi =
          displayCents != null ?
            displayCents / 100 :
            estimatedTotalForState != null ? estimatedTotalForState : null

        navigateState = {
          context: "booking",
          paymentLink: paymentUrl ?? undefined,
          paymentPreference,
          bookingId: response.id ?? undefined,
          bookingNumber: response.bookingNumber ?? undefined,
          ...(totalForUi != null ? { total: totalForUi } : {}),
        }

        const storedState: BookingThankYouState = {
          context: "booking",
          paymentPreference,
          paymentLink: paymentUrl ?? null,
          bookingNumber:
            typeof response.bookingNumber === "number" && Number.isFinite(response.bookingNumber) ?
              response.bookingNumber :
              null,
          bookingId: typeof response.id === "string" ? response.id : null,
          total: totalForUi,
        }
        saveBookingThankYouState(storedState)
      }
      setSubmitted(true)
      if (navigateState) {
        navigate({ to: "/thank-you", state: navigateState })
      }
    } catch (error) {
      console.error(error)
      const status = typeof (error as { status?: number })?.status === "number" ? (error as { status?: number }).status : null
      if (
        (error instanceof FirebaseError && error.code === "permission-denied") ||
        status === 401 ||
        status === 403
      ) {
        setSubmitError("We couldn’t reach our booking system right now. Please call or email dispatch to finish this reservation.")
      } else {
        setSubmitError(
          error instanceof Error
            ? error.message
            : "We couldn’t submit this booking. Please try again or contact dispatch.",
        )
      }
    } finally {
      setSubmittingBooking(false)
    }
  }, [
    firebaseEnabled,
    passengerData,
    paymentPreference,
    scheduleData,
    submitted,
    submittingBooking,
    tipAmount,
    tripData,
    updateQuoteLog,
    navigate,
    pricing,
    estimatedQuote,
  ])

  const scrollToStepHeader = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return
    const anchor = stepHeaderRef.current
    if (!anchor) return

    const header = document.querySelector<HTMLElement>(APP_HEADER_SELECTOR)
    const headerStyles = header ? getComputedStyle(header) : null
    const headerPosition = headerStyles?.position ?? ""
    const headerIsOverlay = headerPosition === "fixed" || headerPosition === "sticky"
    const headerOffset = header && headerIsOverlay ? header.getBoundingClientRect().height : 0

    const targetTop = anchor.getBoundingClientRect().top + window.scrollY - headerOffset - STEP_SCROLL_BUFFER
    window.scrollTo({ top: Math.max(targetTop, 0), behavior: "smooth" })
  }, [])

  const goToStep = useCallback(
    (next: StepKey, options?: { reset?: boolean; scroll?: boolean }) => {
      if (options?.scroll) {
        requestAnimationFrame(() => {
          scrollToStepHeader()
        })
      }
      if (next < 4) {
        setSubmitted(false)
        setSubmissionDetails(null)
        setSubmitError(null)
        setSubmittingBooking(false)
      }
      setStep(next)
      setMaxStepReached((prev) => {
        if (options?.reset) return next
        return next > prev ? next : prev
      })
    },
    [],
  )

  const handlePaymentPreferenceChange = useCallback(
    (value: "pay_on_arrival" | "pay_now") => {
      setPaymentSelectionError(null)
      setPaymentPreference(value)
    },
    [],
  )

  const resetWizard = useCallback(() => {
    tripForm.reset({
      direction: directionOptions[0],
      origin: "",
      destination: "",
      passengerCount: 0,
      vehicleSelections: [determineVehicleOption(1)],
      originAddress: "",
      destinationAddress: "",
    })
    scheduleForm.reset(buildScheduleDefaults(SOFT_NOTICE_HOURS))
    passengerForm.reset({ baggage: "Normal" })
    setTripData(null)
    setScheduleData(null)
    setPassengerData(null)
    setSubmitted(false)
    setSubmittingBooking(false)
    setSubmitError(null)
    setSubmissionDetails(null)
    setTipAmount(0)
    setPaymentPreference(null)
    setPaymentSelectionError(null)
    setQuoteLogId(null)
    quoteLogIdRef.current = null
    setRemotePricing(null)
    setQuoteError(null)
    setQuoteLoading(false)
    setTripDistanceEstimate(null)
    goToStep(0, { reset: true, scroll: true })
  }, [goToStep, passengerForm, scheduleForm, tripForm])

  const locationOptions = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    const addOption = (value: string) => {
      const key = normalizeLocationLabel(value)
      if (seen.has(key)) return
      seen.add(key)
      list.push(value)
    }
    baseDirections.forEach((direction) => {
      const origins = getOriginsForDirection(direction)
      origins.forEach((origin) => {
        addOption(origin)
        const destinations = getDestinationsForOrigin(direction, origin)
        destinations.forEach(addOption)
      })
    })
    additionalTerminals.forEach(addOption)
    addOption(TEST_LOCATION_LABEL)
    return list
  }, [])

  useEffect(() => {
    if (!tripData) {
      setTripDistanceEstimate(null)
      return
    }
    const originForDistance = (tripData.originAddress ?? tripData.origin)?.trim()
    const destinationForDistance = (tripData.destinationAddress ?? tripData.destination)?.trim()
    if (!originForDistance || !destinationForDistance) {
      setTripDistanceEstimate(null)
      return
    }
    let cancelled = false
    const fetchDistance = async () => {
      try {
        const result = await apiFetch<{ distanceKm: number; durationMinutes: number }>("/distance", {
          method: "POST",
          body: {
            origin: originForDistance,
            destination: destinationForDistance,
          },
          skipAuth: true,
        })
        if (!cancelled && result?.distanceKm && result?.durationMinutes) {
          setTripDistanceEstimate({
            distanceKm: result.distanceKm,
            durationMinutes: result.durationMinutes,
          })
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to fetch trip distance", error)
          setTripDistanceEstimate(null)
        }
      }
    }
    fetchDistance()
    return () => {
      cancelled = true
    }
  }, [
    tripData?.origin,
    tripData?.originAddress,
    tripData?.destination,
    tripData?.destinationAddress,
  ])

  const originOptions = useMemo(() => [...locationOptions], [locationOptions])
  const destinationOptions = useMemo(() => [...locationOptions], [locationOptions])

  useEffect(() => {
    if (step !== 1 || !tripData || quoteLoading) return

    const baseQuote = estimatedQuote?.baseRate ?? pricing?.baseRate ?? null

    const payload: Record<string, unknown> = {
      trip: {
        direction: tripData.direction,
        origin: tripData.origin,
        originAddress: tripData.originAddress ?? null,
        destination: tripData.destination,
        destinationAddress: tripData.destinationAddress ?? null,
        passengers: tripData.passengerCount,
        vehicleSelections: tripData.vehicleSelections,
        preferredVehicle:
          tripData.vehicleSelections?.[0] ?? determineVehicleOption(tripData.passengerCount),
        preferredRateKey: tripData.preferredRateKey ?? null,
        status: baseQuote != null ? "success" : "no_price",
      },
      quote:
        baseQuote != null
          ? {
              amount: baseQuote,
              baseFare: estimatedQuote?.baseFare ?? null,
              distanceFare: estimatedQuote?.distanceFare ?? null,
              extraPassengers: estimatedQuote?.extraPassengers ?? null,
              extraPassengerTotal: estimatedQuote?.extraPassengerTotal ?? null,
              estimatedGst: estimatedQuote?.estimatedGst ?? null,
              perPassenger: estimatedQuote?.perPassenger ?? null,
              vehiclePremium: estimatedQuote?.vehiclePremium ?? null,
            }
          : { amount: null },
      lastStep: 2,
    }

    if (scheduleData) {
      payload.schedule = {
        pickupDate: scheduleData.pickupDate,
        pickupTime: scheduleData.pickupTime,
        flightNumber: scheduleData.flightNumber ?? null,
        notes: scheduleData.notes ?? null,
      }
    }

    if (passengerData) {
      payload.contact = {
        name: passengerData.primaryPassenger,
        email: passengerData.email,
        phone: passengerData.phone,
      }
    }

    if (!quoteLogId) {
      void createQuoteLog(payload)
    } else {
      void updateQuoteLog(payload)
    }
  }, [
    createQuoteLog,
    estimatedQuote,
    passengerData,
    pricing,
    quoteLoading,
    quoteLogId,
    scheduleData,
    step,
    tripData,
    updateQuoteLog,
  ])

  return (
    <div className="flex flex-col gap-6">
      <div ref={stepHeaderRef} className="step-scroll-anchor">
        <StepHeader
          current={step}
          maxStep={maxStepReached}
          onSelect={(target) => {
            if (target > maxStepReached) return
            goToStep(target, { scroll: true })
          }}
        />
      </div>
      {step === 0 ? (
        <TripStep
          form={tripForm}
          onSubmit={handleTripSubmit}
          originOptions={originOptions}
          destinationOptions={destinationOptions}
        />
      ) : null}
      {step === 1 && tripData ? (
        <PriceQuoteStep
          trip={tripData}
          distanceEstimate={tripDistanceEstimate}
          pricing={pricing}
          quote={estimatedQuote}
          fallbackSuppressed={fallbackSuppressed}
          loading={quoteLoading}
          error={quoteError}
          onEditTrip={() => goToStep(0, { scroll: true })}
          onContinue={() => goToStep(2, { scroll: true })}
        />
      ) : null}
      {step === 2 && tripData ? (
        <ScheduleStep
          form={scheduleForm}
          onSubmit={handleScheduleSubmit}
          direction={tripData.direction}
        />
      ) : null}
      {step === 3 ? <PassengerStep form={passengerForm} onSubmit={handlePassengerSubmit} /> : null}
      {step === 4 && tripData && scheduleData && passengerData ? (
        <ReviewStep
          trip={tripData}
          schedule={scheduleData}
          passenger={passengerData}
          pricing={pricing}
          quote={estimatedQuote}
          submitting={submittingBooking}
          submitted={submitted}
          onConfirm={handleConfirm}
          onBack={() => goToStep(3, { scroll: true })}
          onReset={resetWizard}
          error={submitError}
          tipAmount={tipAmount}
          onTipChange={setTipAmount}
          paymentPreference={paymentPreference}
          onPaymentPreferenceChange={handlePaymentPreferenceChange}
          paymentSelectionError={paymentSelectionError}
          paymentLink={submissionDetails?.paymentLink ?? null}
        />
      ) : null}
    </div>
  )
}

const StepHeader = ({
  current,
  maxStep,
  onSelect,
}: {
  current: StepKey
  maxStep: StepKey
  onSelect: (step: StepKey) => void
}) => {
  const steps: Array<{ label: string; short: string }> = [
    { label: "Trip", short: "1" },
    { label: "Price", short: "2" },
    { label: "Schedule", short: "3" },
    { label: "Passengers", short: "4" },
    { label: "Review", short: "5" },
  ]
  return (
    <GlassPanel className="p-3 sm:p-4">
      <div className="grid grid-cols-5 gap-2 sm:gap-3">
        {steps.map((stepItem, index) => {
          const stepIndex = index as StepKey
          const enabled = stepIndex <= maxStep
          const isActive = stepIndex === current
          return (
            <button
              key={stepItem.label}
              type="button"
              onClick={() => (enabled ? onSelect(stepIndex) : undefined)}
              disabled={!enabled}
              aria-label={`Step ${stepItem.short}: ${stepItem.label}`}
              className={clsx(
                "flex h-11 w-full items-center justify-center rounded-full text-sm font-semibold uppercase tracking-[0.24em] transition sm:h-12 sm:text-base sm:tracking-[0.28em]",
                isActive
                  ? "bg-horizon text-white shadow-glow"
                  : enabled
                    ? "border border-horizon/30 bg-white/85 text-horizon hover:border-horizon/50"
                    : "border border-horizon/20 bg-white/65 text-horizon/40",
              )}
            >
              <span>{stepItem.short}</span>
              <span className="sr-only sm:not-sr-only sm:ml-2 sm:text-xs sm:font-normal sm:tracking-[0.35em]">
                {stepItem.label}
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-center text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-horizon/70 sm:hidden">
        {steps[current].label}
      </p>
    </GlassPanel>
  )
}

const TripStep = ({
  form,
  onSubmit,
  originOptions,
  destinationOptions,
}: {
  form: UseFormReturn<TripForm>
  onSubmit: () => void
  originOptions: string[]
  destinationOptions: string[]
}) => {
  const { register, formState, watch, setValue, control } = form
  const selectedOrigin = (watch("origin") ?? "").trim()
  const selectedDestination = (watch("destination") ?? "").trim()
  const passengerCount = watch("passengerCount")
  const passengerCountNumber = Number(passengerCount)
  const hasValidPassengerCount = Number.isFinite(passengerCountNumber) && passengerCountNumber >= 1
  const selectedVehicles = watch("vehicleSelections") ?? []
  const passengerLimitExceeded = hasValidPassengerCount && passengerCountNumber > PASSENGER_MAX

  const originGroups = useMemo(() => buildLocationGroups(originOptions), [originOptions])
  const destinationGroups = useMemo(() => buildLocationGroups(destinationOptions), [destinationOptions])

  const [pickupAcknowledged, setPickupAcknowledged] = useState(Boolean(selectedOrigin))
  const [dropoffAcknowledged, setDropoffAcknowledged] = useState(Boolean(selectedDestination))

  const passengerCountRegister = register("passengerCount", {
    valueAsNumber: true,
    max: { value: PASSENGER_MAX, message: PASSENGER_LIMIT_MESSAGE },
  })

  const originRegister = register("origin", {
    onChange: () => setPickupAcknowledged(true),
  })
  const destinationRegister = register("destination", {
    onChange: () => setDropoffAcknowledged(true),
  })

  const shouldCollectAddress = (value?: string | null) =>
    Boolean(value && value.toLowerCase().includes("any address"))

  useEffect(() => {
    if (!selectedOrigin) {
      setPickupAcknowledged(false)
    }
  }, [selectedOrigin])

  useEffect(() => {
    if (!selectedDestination) {
      setDropoffAcknowledged(false)
    }
  }, [selectedDestination])

  useEffect(() => {
    const inferredDirection =
      selectedOrigin.toLowerCase().includes("airport") && !selectedDestination.toLowerCase().includes("airport")
        ? ("From the Airport" as DirectionOption)
        : selectedDestination.toLowerCase().includes("airport")
          ? ("To the Airport" as DirectionOption)
          : form.getValues("direction")
    if (inferredDirection && inferredDirection !== form.getValues("direction")) {
      setValue("direction", inferredDirection)
    }
  }, [form, selectedDestination, selectedOrigin, setValue])

  useEffect(() => {
    if (!shouldCollectAddress(selectedOrigin)) {
      setValue("originAddress", "", { shouldValidate: true })
    }
  }, [selectedOrigin, setValue])

  useEffect(() => {
    if (!shouldCollectAddress(selectedDestination)) {
      setValue("destinationAddress", "", { shouldValidate: true })
    }
  }, [selectedDestination, setValue])

  useEffect(() => {
    const resolvedPassengerCount = Math.max(1, Number(passengerCount) || 1)
    const currentVehicle = selectedVehicles[0]
    const matchedOption = resolvePassengerOption(resolvedPassengerCount, currentVehicle)
    if (matchedOption) {
      if (currentVehicle && selectedVehicles.length === 1) {
        return
      }
      setValue("vehicleSelections", [matchedOption.vehicleId ?? determineVehicleOption(resolvedPassengerCount)], {
        shouldValidate: true,
      })
      return
    }
    const fallbackOption = resolvePassengerOption(resolvedPassengerCount, undefined)
    const preferredVehicle =
      fallbackOption?.vehicleId ?? determineVehicleOption(resolvedPassengerCount)
    if (currentVehicle !== preferredVehicle || selectedVehicles.length > 1) {
      setValue("vehicleSelections", [preferredVehicle], { shouldValidate: true })
    }
  }, [passengerCount, selectedVehicles, setValue])

  useEffect(() => {
    if (!hasValidPassengerCount) {
      return
    }
    if (passengerLimitExceeded) {
      form.setError("passengerCount", { type: "manual", message: PASSENGER_LIMIT_MESSAGE })
    } else if (formState.errors.passengerCount?.message === PASSENGER_LIMIT_MESSAGE) {
      form.clearErrors("passengerCount")
    }
  }, [form, formState.errors.passengerCount, hasValidPassengerCount, passengerLimitExceeded])

  const pickupReady = Boolean(selectedOrigin)
  const dropoffReady = Boolean(selectedDestination)
  const showDropoff = pickupAcknowledged && pickupReady
  const showPassengerCount = dropoffAcknowledged && dropoffReady

  const normalizedPassengerCount = hasValidPassengerCount ? passengerCountNumber : 1
  const autoPassengerCount = Math.max(1, normalizedPassengerCount)
  const autoVehicle = selectedVehicles[0] ?? determineVehicleOption(autoPassengerCount)
  const autoVehicleLabel = vehicleLabelMap[autoVehicle] ?? "Auto-assigned vehicle"
  const selectedPassengerOption = useMemo(() => {
    if (!hasValidPassengerCount) return null
    return resolvePassengerOption(autoPassengerCount, autoVehicle)
  }, [autoPassengerCount, autoVehicle, hasValidPassengerCount])
  const selectedPassengerOptionId = hasValidPassengerCount ? selectedPassengerOption?.id ?? "" : ""

  const handlePassengerOptionSelect = useCallback(
    (option: PassengerOption) => {
      const vehicle = option.vehicleId ?? determineVehicleOption(option.passengers)
      setValue("passengerCount", option.passengers, { shouldValidate: true, shouldDirty: true })
      setValue("vehicleSelections", [vehicle], { shouldValidate: true, shouldDirty: true })
    },
    [setValue],
  )

  return (
    <GlassPanel className="p-5 sm:p-6">
      <h2 className="font-heading text-xl uppercase tracking-[0.3em] text-horizon">Trip Details</h2>
      <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
        <Field
          label="Pick-up Address"
          error={formState.errors.origin?.message}
          helper="Select a pick-up location to continue."
        >
          <select
            {...originRegister}
            onBlur={() => setPickupAcknowledged(true)}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          >
            <option value="">Select pick-up address</option>
            {originGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((origin) => (
                  <option key={origin} value={origin}>
                    {origin}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        {shouldCollectAddress(selectedOrigin) ? (
          <Field
            label="Full Pick-up Address"
            error={formState.errors.originAddress?.message}
            helper="Add the exact pick-up details, including unit number."
          >
            <Controller
              control={control}
              name="originAddress"
              render={({ field }) => (
                <PlacesAutocompleteInput
                  {...field}
                  placeholder="Full street address with unit number"
                  onChange={(value) => field.onChange(value)}
                  onPlaceSelect={(selection) => field.onChange(selection.address)}
                  onPlaceCleared={() => field.onChange("")}
                />
              )}
            />
          </Field>
        ) : null}

        {showDropoff ? (
          <>
            <Field
              label="Drop-off Address"
              error={formState.errors.destination?.message}
              helper="Add the exact drop-off details, including unit number."
            >
              <select
                {...destinationRegister}
                onBlur={() => setDropoffAcknowledged(true)}
                className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
              >
                <option value="">Select drop-off address</option>
                {destinationGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((destination) => (
                      <option key={destination} value={destination}>
                        {destination}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>

            {shouldCollectAddress(selectedDestination) ? (
              <Field
                label="Full Drop-off Address"
                error={formState.errors.destinationAddress?.message}
                helper="Add the exact drop-off details, including unit number."
              >
                <Controller
                  control={control}
                  name="destinationAddress"
                  render={({ field }) => (
                      <PlacesAutocompleteInput
                        {...field}
                        placeholder="Full street address with unit number"
                        onChange={(value) => field.onChange(value)}
                        onPlaceSelect={(selection) => field.onChange(selection.address)}
                        onPlaceCleared={() => field.onChange("")}
                      />
                  )}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {showPassengerCount ? (
          <Field label="Passenger Count" error={formState.errors.passengerCount?.message}>
            <>
              <input type="hidden" {...passengerCountRegister} />
              <p className="text-sm text-midnight/70">
                If you are booking for more than 14 passengers, please call or email us instead for a group quote.
              </p>
              <select
                className="mt-3 h-12 w-full rounded-2xl border border-horizon/30 bg-white/85 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                value={selectedPassengerOptionId}
                onChange={(event) => {
                  const option = passengerOptions.find((candidate) => candidate.id === event.target.value)
                  if (option) {
                    handlePassengerOptionSelect(option)
                  }
                }}
              >
                <option value="" disabled hidden>
                  Select an option
                </option>
                {passengerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedPassengerOption?.warning ? (
                <p className="mt-2 text-xs text-amber-700">
                  {selectedPassengerOption.warning}
                </p>
              ) : null}
            </>
          </Field>
        ) : null}

        {showPassengerCount && hasValidPassengerCount ? (
          <Field
            label="Vehicle Fleet"
            helper={`Auto-selected: ${autoVehicleLabel}. Adjust the passenger count if you need a different vehicle size.`}
          >
            <div className="grid gap-3 md:grid-cols-2">
              {vehicleOptions.map((option) => {
                const isSelected = autoVehicle === option.id
                return (
                  <div
                    key={option.id}
                    className={clsx(
                      "flex h-full flex-col gap-4 rounded-3xl px-4 py-4 transition sm:px-5 sm:py-5",
                      isSelected
                        ? "border-[3px] border-emerald-400 bg-emerald-50/90 text-horizon shadow-glow"
                        : "border border-horizon/30 bg-white/85 text-midnight/70",
                    )}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div className="flex-1 space-y-2 text-left">
                        {(() => {
                          const [title, restRaw] = option.label.split("(")
                          const rest = restRaw ? restRaw.replace(/\)+$/, "").trim() : null
                          return (
                            <>
                              <p className="text-base font-semibold uppercase tracking-[0.2em] text-horizon">
                                {title.trim()}
                              </p>
                              {rest ? (
                                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-horizon/70">
                                  ({rest})
                                </p>
                              ) : null}
                            </>
                          )
                        })()}
                        <p className="text-sm text-midnight/70">{option.helper}</p>
                      </div>
                      {isSelected ? (
                        <div className="flex flex-none items-start justify-end">
                          <span
                            className="inline-flex min-w-[7rem] justify-center rounded-full border border-emerald-500 bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-emerald-600 shadow-sm sm:min-w-[8rem] sm:px-4 sm:text-[12px] sm:tracking-[0.2em]"
                          >
                            Auto-selected
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </Field>
        ) : null}

        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
          <button
            type="button"
            onClick={() => {
              form.reset({
                direction: directionOptions[0],
                origin: "",
                destination: "",
                passengerCount: 0,
                originAddress: "",
                destinationAddress: "",
                vehicleSelections: [determineVehicleOption(1)],
              })
              setPickupAcknowledged(false)
              setDropoffAcknowledged(false)
            }}
            className="flex-1 rounded-full border border-horizon/30 bg-white/70 px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-horizon transition hover:bg-white/90 sm:px-6 sm:text-xs sm:tracking-[0.32em]"
          >
            Reset Trip Details
          </button>
          <button
            type="submit"
            disabled={
              !pickupReady ||
              !dropoffReady ||
              !showPassengerCount ||
              !passengerCount ||
              passengerLimitExceeded
            }
            className="flex-1 rounded-full border border-horizon/50 bg-horizon px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:border-horizon/60 hover:bg-horizon/90 disabled:cursor-not-allowed disabled:border-horizon/30 disabled:bg-horizon/40 sm:px-8 sm:py-4 sm:text-base sm:tracking-[0.32em]"
          >
            Continue to Price Quote
          </button>
        </div>
      </form>
    </GlassPanel>
  )
}


const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)

const PriceQuoteStep = ({
  trip,
  distanceEstimate,
  pricing,
  quote,
  fallbackSuppressed,
  onEditTrip,
  onContinue,
  loading,
  error,
}: {
  trip: TripData
  distanceEstimate?: { distanceKm: number; durationMinutes: number } | null
  pricing: PricingResult | null
  quote: {
    baseRate: number
    baseFare: number
    distanceFare: number
    extraPassengers: number
    extraPassengerTotal: number
    perPassenger: number
    estimatedGst: number
    vehiclePremium: number
  } | null
  onEditTrip: () => void
  onContinue: () => void
  fallbackSuppressed?: boolean
  loading?: boolean
  error?: string | null
}) => {
  const [animationComplete, setAnimationComplete] = useState(false)
  const waitingForQuote = Boolean(loading && (!pricing || !quote))
  const quoteAvailable = Boolean(!waitingForQuote && quote && pricing?.baseRate != null)
  const fallbackBlocked = Boolean(fallbackSuppressed)
  const passengerLabel =
    trip.passengerCount === 1 ? "1 passenger" : `${trip.passengerCount} passengers`
  const selectedVehicles = useMemo(
    () => trip.vehicleSelections.map((id) => vehicleLabelMap[id] ?? id).join(", "),
    [trip.vehicleSelections],
  )
  const vehicleSignature = useMemo(
    () => trip.vehicleSelections.join("|"),
    [trip.vehicleSelections],
  )
  const originAddress = trip.originAddress?.trim() ? trip.originAddress.trim() : null
  const destinationAddress = trip.destinationAddress?.trim() ? trip.destinationAddress.trim() : null
  const instantQuote =
    quoteAvailable ?
      quote?.baseRate ?? pricing?.baseRate ?? null :
      null
  const roundedInstantQuote = instantQuote != null ? Math.round(instantQuote) : null
  const distanceFareEnabled = shouldShowDistanceFare(trip.origin, trip.destination) && !trip.preferredRateKey
  const vehiclePremium = quote?.vehiclePremium ?? 0

  const surgeGuess = trip.direction === "From the Airport" ? 1.1 : 1
  const discountGuess = trip.passengerCount >= 4 ? 5 : 0
  const resolvedDistanceKm =
    distanceEstimate?.distanceKm ??
    Math.max(10, trip.passengerCount * 8)
  const resolvedDriveMinutes =
    distanceEstimate?.durationMinutes ??
    Math.max(20, trip.passengerCount * 4)

  const runAnimatedQuote = useCallback(async () => {
    const payload = {
      distanceKm: resolvedDistanceKm,
      timeMin: resolvedDriveMinutes,
      surge: surgeGuess,
      discountPct: discountGuess,
    }

    try {
      const apiResult = await apiFetch<{ total?: number; currency?: string }>("/price", {
        method: "POST",
        body: payload,
        skipAuth: true,
      })
      const resolvedTotal = roundedInstantQuote ?? apiResult.total ?? 0
      return {
        total: resolvedTotal,
        currency: apiResult.currency ?? "CAD",
      }
    } catch (fetchError) {
      console.error("DispatchAlchemist: calculatePrice failed", fetchError)
      return {
        total: roundedInstantQuote ?? 0,
        currency: "CAD",
      }
    }
  }, [discountGuess, roundedInstantQuote, surgeGuess, resolvedDistanceKm, resolvedDriveMinutes])

  const handleComplete = useCallback(() => {
    setAnimationComplete(true)
  }, [])

  useEffect(() => {
    setAnimationComplete(false)
  }, [
    trip.direction,
    trip.origin,
    trip.destination,
    trip.passengerCount,
    vehicleSignature,
  ])
  const showDetails = animationComplete

  return (
    <GlassPanel className="space-y-6 p-5 sm:space-y-8 sm:p-8">

      <div className="flex justify-center py-4">
        <DispatchAlchemist
          carsAnimation={carsAnimation}
          driverAnimation={driverAnimation}
          confettiAnimation={confettiAnimation}
          calculatorAnimation={calculatorAnimation}
          finalizerAnimation={finalizerAnimation}
          messages={[
            "working magic...",
            "checking surge & demand...",
            "applying available discounts...",
            "gathering the drivers...",
            "gathering the vehicles...",
          ]}
          calculatePrice={runAnimatedQuote}
          theme={{
            progressColor: "#7c3aed",
            ticketFrom: "#0b1220",
            ticketTo: "#1c2540",
            glowFrom: "#eef2ff",
            glowVia: "#faf5ff",
            glowTo: "#fff1f2",
          }}
          onComplete={handleComplete}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr,1fr]">
        {showDetails ? (
          <>
            <div className="rounded-3xl border border-horizon/15 bg-white/90 p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-horizon/70">Quote details</p>
              {waitingForQuote ? (
                <p className="mt-3 text-sm uppercase tracking-[0.28em] text-midnight/60">Calculating live quote…</p>
              ) : quoteAvailable ? (
                <div className="mt-3 space-y-3 text-base text-midnight/80">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Base fare</span>
                    <span>{formatCurrency(quote!.baseFare)}</span>
                  </div>
                  {distanceFareEnabled ? (
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">Distance fare</span>
                      <span>{formatCurrency(quote!.distanceFare)}</span>
                    </div>
                  ) : null}
                  {quote!.extraPassengerTotal > 0 ? (
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">
                        Extra passengers • {quote!.extraPassengers} × {formatCurrency(quote!.perPassenger)}
                      </span>
                      <span>{formatCurrency(quote!.extraPassengerTotal)}</span>
                    </div>
                  ) : null}
                  {vehiclePremium > 0 ? (
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">Vehicle type premium</span>
                      <span>{formatCurrency(vehiclePremium)}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between border-t border-horizon/10 pt-3 text-base font-semibold">
                    <span>Final Total</span>
                    <span>{roundedInstantQuote != null ? formatCurrency(roundedInstantQuote) : "—"}</span>
                  </div>
                  {quoteAvailable ? (
                    <button
                      type="button"
                      onClick={onContinue}
                      className="mt-6 w-full rounded-full bg-horizon px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:bg-horizon/90 sm:px-8 sm:py-4 sm:text-base sm:tracking-[0.3em]"
                    >
                      Continue to Pickup Schedule
                    </button>
                  ) : null}
                </div>
              ) : fallbackBlocked ? (
                <div className="mt-3 space-y-2 text-base text-midnight/70">
                  <p>We do not currently have pricing for this selection online, contact us via phone/email instead.</p>
                  <p>
                    Call{" "}
                    <a className="font-semibold text-horizon underline" href="tel:+16047516688">
                      (604) 751-6688
                    </a>{" "}
                    or email{" "}
                    <a className="font-semibold text-horizon underline" href="mailto:info@valleyairporter.ca">
                      info@valleyairporter.ca
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <div className="mt-3 space-y-2 text-base text-midnight/70">
                  <p>We couldn’t calculate an instant fare for this route.</p>
                  <p>
                    Please adjust the trip details or call dispatch at{" "}
                    <a className="font-semibold text-horizon underline" href="tel:+16047516688">
                      (604) 751-6688
                    </a>
                    .
                  </p>
                </div>
              )}
              {!waitingForQuote && error ? (
                <p className="mt-3 text-xs uppercase tracking-[0.28em] text-ember/70">{error}</p>
              ) : null}
            </div>

            <div className="rounded-3xl border border-horizon/10 bg-white/80 p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-horizon/70">
                Trip checklist
              </p>
              <ul className="mt-4 space-y-2 text-base text-midnight/80">
                <li>
                  <span className="font-semibold">Passengers •</span> {passengerLabel}
                </li>
                <li>
                  <span className="font-semibold">From •</span>{" "}
                  <span>{trip.origin}</span>
                  {originAddress ? (
                    <span className="block text-xs text-midnight/60">{originAddress}</span>
                  ) : null}
                </li>
                <li>
                  <span className="font-semibold">To •</span>{" "}
                  <span>{trip.destination}</span>
                  {destinationAddress ? (
                    <span className="block text-xs text-midnight/60">{destinationAddress}</span>
                  ) : null}
                </li>
                <li>
                  <span className="font-semibold">Vehicle type •</span> {selectedVehicles}
                </li>
              </ul>
            </div>
          </>
        ) : (
          <div className="col-span-full rounded-3xl border border-horizon/10 bg-white/80 p-6 mt-4 text-center text-sm text-midnight/70">
            The Dispatch Alchemist is working. Quote details will appear once the ticket flips.
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 pt-2">
        <button
          type="button"
          onClick={onEditTrip}
          className="flex-1 rounded-full border border-horizon/40 bg-white px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-horizon transition hover:bg-white/90 sm:px-6 sm:text-xs sm:tracking-[0.3em] md:flex-none md:px-10"
        >
          Edit details
        </button>
      </div>
    </GlassPanel>
  )
}

const ScheduleStep = ({
  form,
  onSubmit,
  direction,
}: {
  form: UseFormReturn<ScheduleForm>
  onSubmit: () => void
  direction: DirectionOption
}) => {
  const { register, formState, watch, setValue } = form
  const pickupPeriod = watch("pickupPeriod")

  const minSelectableDate = useMemo(() => format(addHours(new Date(), MIN_ADVANCE_HOURS), "yyyy-MM-dd"), [])

  const hourOptions = useMemo(
    () => Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")),
    [],
  )
  const minuteOptions = useMemo(
    () => Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, "0")),
    [],
  )

  useEffect(() => {
    if (!pickupPeriod) {
      setValue("pickupPeriod", "AM")
    }
  }, [pickupPeriod, setValue])

  return (
    <GlassPanel className="p-5 sm:p-6">
      <h2 className="font-heading text-xl uppercase tracking-[0.3em] text-horizon">
        Pickup Schedule
      </h2>
      <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
        <Field label="Pickup Date" error={formState.errors.pickupDate?.message}>
          <input
            type="date"
            {...register("pickupDate")}
            min={minSelectableDate}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <Field label="Pickup Time" error={formState.errors.pickupHour?.message}>
          <div className="flex flex-nowrap items-center gap-2 overflow-x-auto rounded-2xl bg-white/60 px-3 py-2 shadow-inner sm:gap-3 sm:bg-transparent sm:px-0 sm:py-0 sm:shadow-none">
            <select
              {...register("pickupHour")}
              className="h-11 min-w-[4.25rem] flex-1 rounded-2xl border border-horizon/30 bg-white/90 px-3 text-base text-midnight text-center focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30 sm:h-12"
            >
              {hourOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <span className="text-lg font-semibold text-horizon/60">:</span>
            <select
              {...register("pickupMinute")}
              className="h-11 min-w-[4.25rem] flex-1 rounded-2xl border border-horizon/30 bg-white/90 px-3 text-base text-midnight text-center focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30 sm:h-12"
            >
              {minuteOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <div className="flex flex-none rounded-full border border-horizon/30 bg-white/80">
              <button
                type="button"
                onClick={() => setValue("pickupPeriod", "AM")}
                className={clsx(
                  "px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em]",
                  pickupPeriod === "AM" ? "bg-horizon text-white" : "text-horizon",
                )}
              >
                AM
              </button>
              <button
                type="button"
                onClick={() => setValue("pickupPeriod", "PM")}
                className={clsx(
                  "px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em]",
                  pickupPeriod === "PM" ? "bg-horizon text-white" : "text-horizon",
                )}
              >
                PM
              </button>
            </div>
          </div>
        </Field>
        <Field
          label={direction === "From the Airport" ? "Departure Flight Number" : "Arrival Flight Number"}
          helper="(If arriving at an airport only)"
          helperPosition="before"
        >
          <input
            type="text"
            {...register("flightNumber")}
            placeholder="AC 123"
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <Field label="Special Notes" error={formState.errors.notes?.message} className="sm:col-span-2">
          <textarea
            {...register("notes")}
            rows={4}
            placeholder="Accessibility requirements, additional pickup details..."
            className="w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 py-3 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:gap-3">
          <button
            type="button"
            onClick={() => form.reset(buildScheduleDefaults(SOFT_NOTICE_HOURS))}
            className="flex-1 rounded-full border border-horizon/20 bg-white/70 px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-horizon transition hover:bg-white/90 sm:px-6 sm:text-xs sm:tracking-[0.32em]"
          >
            Reset
          </button>
          <button
            type="submit"
            className="flex-1 rounded-full border border-horizon/50 bg-horizon px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:border-horizon/60 hover:bg-horizon/90 sm:px-8 sm:py-4 sm:text-base sm:tracking-[0.32em]"
          >
            Continue to Passengers
          </button>
        </div>
      </form>
    </GlassPanel>
  )
}


const PassengerStep = ({
  form,
  onSubmit,
}: {
  form: UseFormReturn<PassengerForm>
  onSubmit: () => void
}) => {
  const { register, formState } = form

  return (
    <GlassPanel className="p-5 sm:p-6">
      <h2 className="font-heading text-xl uppercase tracking-[0.3em] text-horizon">
        Passenger Details
      </h2>
      <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={onSubmit}>
        <Field label="Primary Passenger" error={formState.errors.primaryPassenger?.message}>
          <input
            type="text"
            {...register("primaryPassenger")}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <Field label="Email" error={formState.errors.email?.message}>
          <input
            type="email"
            {...register("email")}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <Field label="Mobile Phone Number" error={formState.errors.phone?.message}>
          <input
            type="tel"
            {...register("phone")}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          />
        </Field>
        <Field label="Baggage Profile">
          <select
            {...register("baggage")}
            className="h-12 w-full rounded-2xl border border-horizon/30 bg-white/80 px-4 text-base text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
          >
            <option value="Normal">Normal</option>
            <option value="Oversized">Oversized</option>
            <option value="Minimal">Minimal</option>
          </select>
        </Field>
        <div className="sm:col-span-2 flex">
          <button
            type="submit"
            className="flex-1 rounded-full border border-horizon/50 bg-horizon px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:border-horizon/60 hover:bg-horizon/90 sm:px-8 sm:py-4 sm:text-base sm:tracking-[0.32em]"
          >
            Continue to Review
          </button>
        </div>
      </form>
    </GlassPanel>
  )
}

const ReviewStep = ({
  trip,
  schedule,
  passenger,
  pricing,
  quote,
  tipAmount,
  onTipChange,
  paymentPreference,
  onPaymentPreferenceChange,
  paymentSelectionError,
  onConfirm,
  onBack,
  onReset,
  submitting,
  submitted,
  error,
  paymentLink,
}: {
  trip: TripData
  schedule: ScheduleData
  passenger: PassengerForm
  pricing: PricingResult | null
  quote: {
    baseRate: number
    baseFare: number
    distanceFare: number
    extraPassengers: number
    extraPassengerTotal: number
    perPassenger: number
    estimatedGst: number
    vehiclePremium: number
  } | null
  tipAmount: number
  onTipChange: (value: number) => void
  paymentPreference: "pay_on_arrival" | "pay_now" | null
  onPaymentPreferenceChange: (value: "pay_on_arrival" | "pay_now") => void
  paymentSelectionError: string | null
  onConfirm: () => void
  onBack: () => void
  onReset: () => void
  submitting: boolean
  submitted: boolean
  error: string | null
  paymentLink: string | null
}) => {
  const vehicleSummary = trip.vehicleSelections.map((vehicle) => vehicleLabelMap[vehicle] ?? vehicle).join(", ")
  const scheduleDate = new Date(`${schedule.pickupDate}T${schedule.pickupTime}`)
  const scheduleDisplay = Number.isNaN(scheduleDate.getTime()) ? "TBD" : format(scheduleDate, "PPP • p")
  const distanceFareEnabled = shouldShowDistanceFare(trip.origin, trip.destination)
  const groupTotal = quote?.baseRate ?? pricing?.baseRate ?? null
  const baseFare = quote?.baseFare ?? null
  const perPassengerFee = quote?.perPassenger ?? getExtraPassengerFee(trip.origin, trip.destination)
  const extraPassengers = quote?.extraPassengers ?? Math.max(0, trip.passengerCount - 1)
  const extraPassengerTotal = quote?.extraPassengerTotal ?? extraPassengers * perPassengerFee
  const distanceFare =
    quote?.distanceFare ??
    (groupTotal != null && baseFare != null ? Math.max(0, groupTotal - baseFare - extraPassengerTotal) : 0)
  const renderedDistanceFare = distanceFareEnabled ? distanceFare : 0
  const largeVehicleSelected = hasLargeVehicleSelection(trip.vehicleSelections)
  const fallbackVehiclePremium =
    largeVehicleSelected && groupTotal != null && baseFare != null ?
      Math.max(0, Math.round(groupTotal - baseFare - extraPassengerTotal - distanceFare)) :
      0
  const vehiclePremium = quote?.vehiclePremium ?? fallbackVehiclePremium
  const safeTip = Number.isFinite(tipAmount) ? Math.max(0, tipAmount) : 0
  const [tipInputValue, setTipInputValue] = useState(safeTip > 0 ? String(safeTip) : "")
  useEffect(() => {
    setTipInputValue((Number.isFinite(tipAmount) && tipAmount > 0 ? String(Math.max(0, tipAmount)) : ""))
  }, [tipAmount])
  const finalTotal = groupTotal != null ? groupTotal + safeTip : null
  const roundedFinalTotal = finalTotal != null ? Math.round(finalTotal) : null
  const confirmLabel =
    submitted ?
      "Request Sent" :
      submitting ?
        "Submitting..." :
        paymentPreference === "pay_now" ?
          "Confirm & Generate Payment Link" :
          "Confirm Booking"
  const hasPaymentLink = Boolean(paymentLink)
  const payNowDisabled = groupTotal == null
  const notes = schedule.notes?.trim()
  const formattedNotes = notes && notes.length > 0 ? notes : "None"

  const handleTipInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const raw = event.target.value.replace(/[^0-9.]/g, "")
    setTipInputValue(raw)
    const parsed = Number.parseFloat(raw)
    onTipChange(Number.isNaN(parsed) ? 0 : Math.max(0, parsed))
  }

  const finalTotalLabel =
    roundedFinalTotal != null ?
      `${formatCurrency(roundedFinalTotal)} for ${trip.passengerCount} passenger${trip.passengerCount === 1 ? "" : "s"}` :
      "TBD"

  return (
    <GlassPanel className="p-5 sm:p-6">
      <h2 className="font-heading text-xl uppercase tracking-[0.3em] text-horizon">Review</h2>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <SummaryCard title="Scheduling Info">
          <dl className="space-y-2 text-base text-midnight/80">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Pickup</dt>
              <dd className="mt-1 text-base sm:mt-0">{scheduleDisplay}</dd>
            </div>
            {schedule.flightNumber ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Flight</dt>
                <dd className="mt-1 text-base sm:mt-0">{schedule.flightNumber}</dd>
              </div>
            ) : null}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Special Notes</dt>
              <dd className="mt-1 text-base text-midnight/70 sm:mt-0">{formattedNotes}</dd>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Total Passengers</dt>
              <dd className="mt-1 text-base sm:mt-0">{trip.passengerCount}</dd>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Vehicle Type</dt>
              <dd className="mt-1 text-base sm:mt-0">{vehicleSummary}</dd>
            </div>
          </dl>
        </SummaryCard>

        <SummaryCard title="Trip Info">
          <dl className="space-y-3 text-base text-midnight/80">
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Pickup</dt>
              <dd className="mt-1">
                {trip.origin}
                {trip.originAddress ? (
                  <span className="block text-xs text-midnight/60">{trip.originAddress}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Drop-off</dt>
              <dd className="mt-1">
                {trip.destination}
                {trip.destinationAddress ? (
                  <span className="block text-xs text-midnight/60">{trip.destinationAddress}</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </SummaryCard>

        <SummaryCard title="Passenger Info">
          <dl className="space-y-2 text-base text-midnight/80">
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Primary Passenger</dt>
              <dd className="mt-1">{passenger.primaryPassenger}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Contact Email</dt>
              <dd className="mt-1">{passenger.email}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Contact Phone</dt>
              <dd className="mt-1">{passenger.phone}</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold uppercase tracking-[0.28em] text-horizon/70">Baggage</dt>
              <dd className="mt-1">{passenger.baggage}</dd>
            </div>
          </dl>
        </SummaryCard>

        <SummaryCard title="Final Quote">
          {groupTotal != null ? (
            <div className="space-y-3 text-base text-midnight/80">
              <div className="flex items-center justify-between">
                <span>Base fare</span>
                <span>{baseFare != null ? formatCurrency(baseFare) : "—"}</span>
              </div>
              {distanceFareEnabled ? (
                <div className="flex items-center justify-between">
                  <span>Distance fare</span>
                  <span>{formatCurrency(renderedDistanceFare)}</span>
                </div>
              ) : null}
              {extraPassengerTotal > 0 ? (
                <div className="flex items-center justify-between">
                  <span>
                    Extra passengers • {extraPassengers} × {formatCurrency(perPassengerFee)}
                  </span>
                  <span>{formatCurrency(extraPassengerTotal)}</span>
                </div>
              ) : null}
              {vehiclePremium > 0 ? (
                <div className="flex items-center justify-between">
                  <span>Vehicle type premium</span>
                  <span>{formatCurrency(vehiclePremium)}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between">
                <label htmlFor="tip-amount" className="text-sm font-medium text-midnight/80">
                  Optional tip
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="tip-amount"
                    type="text"
                    min={0}
                    step={1}
                    value={tipInputValue}
                    inputMode="decimal"
                    placeholder="0"
                    onChange={handleTipInputChange}
                    className="h-10 w-24 rounded-full border border-horizon/30 bg-white px-3 text-right text-sm text-midnight focus:border-horizon focus:outline-none focus:ring-2 focus:ring-horizon/30"
                  />
                  <span className="text-sm text-midnight/70">CAD</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-horizon/20 pt-3 font-semibold text-midnight">
                <span>Total</span>
                <span>{finalTotalLabel}</span>
              </div>
            </div>
          ) : (
            <p className="text-base text-midnight/70">We&apos;ll provide a custom quote within minutes.</p>
          )}
        </SummaryCard>

        <SummaryCard title="Payment Method" className="lg:col-span-2">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 md:flex-row">
              <button
                type="button"
                onClick={() => onPaymentPreferenceChange("pay_on_arrival")}
                aria-pressed={paymentPreference === "pay_on_arrival"}
                className={clsx(
                  "flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] transition",
                  paymentPreference === "pay_on_arrival"
                    ? "border-horizon bg-horizon text-white shadow-glow"
                    : "border-horizon/40 bg-white/80 text-horizon hover:border-horizon/60",
                )}
              >
                Pay driver (cash or card)
              </button>
              <button
                type="button"
                onClick={() => onPaymentPreferenceChange("pay_now")}
                aria-pressed={paymentPreference === "pay_now"}
                disabled={payNowDisabled}
                className={clsx(
                  "flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] transition",
                  paymentPreference === "pay_now"
                    ? "border-horizon bg-horizon text-white shadow-glow"
                    : "border-horizon/40 bg-white/80 text-horizon hover:border-horizon/60",
                  payNowDisabled ? "cursor-not-allowed opacity-60 hover:border-horizon/40" : "",
                )}
              >
                Pay online now
              </button>
            </div>
            <p className="text-xs text-midnight/70">
              Tips are optional and can be adjusted at pickup. Choosing pay online now will generate a secure Square
              checkout link.
            </p>
            {paymentSelectionError ? (
              <p className="text-xs font-semibold text-rose-600">
                {paymentSelectionError}
              </p>
            ) : null}
          </div>
        </SummaryCard>
      </div>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-full border border-horizon/30 bg-white/70 px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-horizon transition hover:bg-white/90 sm:px-6 sm:text-xs sm:tracking-[0.32em]"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onReset}
          className="flex-1 rounded-full border border-glacier/40 bg-white/60 px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-glacier transition hover:bg-white/90 sm:px-6 sm:text-xs sm:tracking-[0.32em]"
        >
          Start Over
        </button>
        <button
          onClick={() => {
            void onConfirm()
          }}
          disabled={
            submitted ||
            submitting ||
            (payNowDisabled && paymentPreference === "pay_now")
          }
          className="flex-1 rounded-full border border-horizon/50 bg-horizon px-4 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white transition hover:border-horizon/60 hover:bg-horizon/90 disabled:cursor-not-allowed disabled:border-horizon/30 disabled:bg-horizon/40 sm:px-6 sm:text-xs sm:tracking-[0.32em]"
        >
          {confirmLabel}
        </button>
      </div>

      {paymentSelectionError ? (
        <p className="mt-2 text-xs font-semibold text-rose-600">
          {paymentSelectionError}
        </p>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-2xl border border-ember/30 bg-ember/10 p-4 text-sm text-ember">{error}</div>
      ) : null}

      {submitted ? (
        <div className="mt-4 space-y-3 rounded-2xl border border-glacier/40 bg-glacier/15 p-4 text-base text-midnight/80">
          {hasPaymentLink ? (
            <>
              <p>Your booking request is confirmed. Continue below to finalize payment.</p>
              <a
                href={paymentLink ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-full border border-horizon/50 bg-horizon px-6 py-2 text-xs font-semibold uppercase tracking-[0.32em] text-white transition hover:border-horizon/60 hover:bg-horizon/90"
              >
                Open Secure Payment Link
              </a>
            </>
          ) : (
            <p>
              Your booking has been staged. Our dispatch team will contact you shortly with next steps or to arrange
              payment.
            </p>
          )}
        </div>
      ) : null}
    </GlassPanel>
  )
}

const Field = ({
  label,
  error,
  helper,
  helperPosition = "after",
  children,
  className,
}: {
  label: string
  error?: string
  helper?: string
  helperPosition?: "before" | "after"
  children: ReactNode
  className?: string
}) => (
  <div className={clsx("flex flex-col gap-2 sm:gap-2.5", className)}>
    <span className="text-sm font-semibold uppercase tracking-[0.2em] text-horizon/80 sm:text-lg sm:tracking-[0.3em]">
      {label}
    </span>
    {helper && helperPosition === "before" ? (
      <span className="text-sm text-midnight/70 sm:text-base">{helper}</span>
    ) : null}
    {error ? <div className="field-error-control">{children}</div> : children}
    {helper && helperPosition === "after" ? (
      <span className="text-sm text-midnight/70 sm:text-base">{helper}</span>
    ) : null}
    {error ? <span className="field-error-text text-xs">{error}</span> : null}
  </div>
)

const SummaryCard = ({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) => (
  <div className={clsx("rounded-2xl border border-horizon/20 bg-white/70 p-4 text-base text-midnight/80", className)}>
    <p className="text-lg font-semibold uppercase tracking-[0.22em] text-horizon/80">{title}</p>
    <div className="mt-2 space-y-1 text-base">{children}</div>
  </div>
)
