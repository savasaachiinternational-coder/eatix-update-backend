export type DiscountTier = {
  minValue: number;
  maxValue?: number | null;
  percent: number;
  metricType?: 'amount' | 'people';
  benefit?: 'free_tax_charge';
};

export const PROMO_BENEFITS = {
  FREE_TAX_CHARGE: 'free_tax_charge',
} as const;

export const OFFER_TYPES = {
  ORDER: 'order',
  AMOUNT: 'amount_discount',
  BOOKING: 'booking_discount',
  BOTH: 'both',
} as const;

export type ScheduleSlot = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function appliesToOrders(offerType?: string | null): boolean {
  const t = offerType || OFFER_TYPES.ORDER;
  return (
    t === OFFER_TYPES.ORDER ||
    t === OFFER_TYPES.AMOUNT ||
    t === OFFER_TYPES.BOTH
  );
}

export function appliesToBookings(offerType?: string | null): boolean {
  const t = offerType || OFFER_TYPES.ORDER;
  return t === OFFER_TYPES.BOOKING || t === OFFER_TYPES.BOTH;
}

export function requiresPromoCode(offerType?: string | null): boolean {
  const t = offerType || OFFER_TYPES.ORDER;
  return t === OFFER_TYPES.ORDER || t === OFFER_TYPES.BOTH;
}

export function parseHhMm(value?: string | null): {
  hours: number;
  minutes: number;
} | null {
  const m = String(value || '').trim().match(HHMM_RE);
  if (!m) return null;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

export function hhMmToMinutes(value?: string | null): number | null {
  const parsed = parseHhMm(value);
  if (!parsed) return null;
  return parsed.hours * 60 + parsed.minutes;
}

export function normalizeHhMm(value?: string | null): string | null {
  const parsed = parseHhMm(value);
  if (!parsed) return null;
  return `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`;
}

export function getLondonParts(date: Date | string) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  let hour = Number(parts.hour);
  if (parts.dayPeriod) {
    const period = String(parts.dayPeriod).toLowerCase();
    if (period.startsWith('p') && hour < 12) hour += 12;
    if (period.startsWith('a') && hour === 12) hour = 0;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    dayOfWeek: WEEKDAY_TO_DOW[parts.weekday] ?? 0,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function parseScheduleSlots(raw: unknown): ScheduleSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const item = row as Partial<ScheduleSlot>;
      const dayOfWeek = Number(item?.dayOfWeek);
      const startTime = normalizeHhMm(item?.startTime);
      const endTime = normalizeHhMm(item?.endTime);
      if (
        !Number.isInteger(dayOfWeek) ||
        dayOfWeek < 0 ||
        dayOfWeek > 6 ||
        !startTime ||
        !endTime
      ) {
        return null;
      }
      const startMin = hhMmToMinutes(startTime);
      const endMin = hhMmToMinutes(endTime);
      if (startMin == null || endMin == null || endMin <= startMin) {
        return null;
      }
      return { dayOfWeek, startTime, endTime };
    })
    .filter((s): s is ScheduleSlot => Boolean(s));
}

function isTimeInRange(
  minutes: number,
  startTime?: string | null,
  endTime?: string | null,
): boolean {
  const startMin = hhMmToMinutes(startTime);
  const endMin = hhMmToMinutes(endTime);
  if (startMin == null && endMin == null) return true;
  if (startMin != null && minutes < startMin) return false;
  if (endMin != null && minutes > endMin) return false;
  return true;
}

export function matchesScheduleSlot(
  slot: ScheduleSlot,
  at: Date | string,
): boolean {
  const parts = getLondonParts(at);
  if (parts.dayOfWeek !== slot.dayOfWeek) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return isTimeInRange(minutes, slot.startTime, slot.endTime);
}

export function isPromotionInDateRange(
  promo: {
    startDate: Date | string;
    expireDate: Date | string;
  },
  at: Date = new Date(),
): boolean {
  const start = new Date(promo.startDate);
  const end = new Date(promo.expireDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return false;
  }
  return start <= at && end >= at;
}

export function isPromotionActive(promo: {
  startDate: Date | string;
  expireDate: Date | string;
}): boolean {
  return isPromotionInDateRange(promo, new Date());
}

export function promotionAppliesAt(
  promo: {
    startDate: Date | string;
    expireDate: Date | string;
    startTime?: string | null;
    endTime?: string | null;
    scheduleSlots?: unknown;
  },
  at: Date = new Date(),
): boolean {
  if (!isPromotionInDateRange(promo, at)) return false;
  const slots = parseScheduleSlots(promo.scheduleSlots);
  if (slots.length) {
    return slots.some((slot) => matchesScheduleSlot(slot, at));
  }
  if (promo.startTime || promo.endTime) {
    const parts = getLondonParts(at);
    return isTimeInRange(
      parts.hour * 60 + parts.minute,
      promo.startTime,
      promo.endTime,
    );
  }
  return true;
}

export function matchesFulfillmentScope(
  scopes: string[] | undefined | null,
  fulfillmentType: 'collection' | 'delivery',
): boolean {
  if (!scopes || scopes.length === 0) return true;
  const ft = fulfillmentType === 'collection' ? 'collection' : 'delivery';
  if (scopes.includes('both')) return true;
  return scopes.includes(ft);
}

export function findMatchingTierInList(
  tiers: DiscountTier[] | null | undefined,
  value: number,
  metricType: 'amount' | 'people' = 'amount',
): DiscountTier | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  const sorted = [...tiers]
    .filter((t) => {
      const mt = (t.metricType || metricType) as string;
      return mt === metricType;
    })
    .sort((a, b) => Number(b.minValue) - Number(a.minValue));

  for (const tier of sorted) {
    const min = Number(tier.minValue);
    const max =
      tier.maxValue != null && String(tier.maxValue) !== ''
        ? Number(tier.maxValue)
        : null;
    if (!Number.isFinite(min)) continue;
    if (v >= min && (max == null || !Number.isFinite(max) || v <= max)) {
      return tier;
    }
  }
  return null;
}

export function findMatchingTier(
  tiers: DiscountTier[] | null | undefined,
  value: number,
  metricType: 'amount' | 'people' = 'amount',
): DiscountTier | null {
  return findMatchingTierInList(
    parsePercentDiscountTiers(tiers),
    value,
    metricType,
  );
}

export function calcPercentDiscount(amount: number, percent: number): number {
  const base = Number(amount);
  const pct = Number(percent);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(pct) || pct <= 0) {
    return 0;
  }
  return Math.round(((base * pct) / 100) * 100) / 100;
}

export function parsePromotionTiers(raw: unknown): DiscountTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ({
      minValue: Number((t as DiscountTier)?.minValue),
      maxValue:
        (t as DiscountTier)?.maxValue != null
          ? Number((t as DiscountTier).maxValue)
          : null,
      percent: Number((t as DiscountTier)?.percent),
      metricType: (t as DiscountTier)?.metricType as
        | 'amount'
        | 'people'
        | undefined,
      benefit:
        (t as DiscountTier)?.benefit === PROMO_BENEFITS.FREE_TAX_CHARGE
          ? PROMO_BENEFITS.FREE_TAX_CHARGE
          : undefined,
    }))
    .filter(
      (t) =>
        Number.isFinite(t.minValue) &&
        ((Number.isFinite(t.percent) && t.percent > 0) ||
          t.benefit === PROMO_BENEFITS.FREE_TAX_CHARGE),
    );
}

export function parsePercentDiscountTiers(raw: unknown): DiscountTier[] {
  return parsePromotionTiers(raw).filter(
    (t) => t.benefit !== PROMO_BENEFITS.FREE_TAX_CHARGE,
  );
}

export function parseDiscountTiers(raw: unknown): DiscountTier[] {
  return parsePercentDiscountTiers(raw);
}

export function getFreeTaxChargeTier(
  tiers: DiscountTier[] | null | undefined,
  itemsSubtotal: number,
): DiscountTier | null {
  return findMatchingTierInList(
    parsePromotionTiers(tiers).filter(
      (t) => t.benefit === PROMO_BENEFITS.FREE_TAX_CHARGE,
    ),
    itemsSubtotal,
    'amount',
  );
}
