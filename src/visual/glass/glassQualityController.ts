import { getGlassProfile } from './glassProfiles';
import type { VisualMode } from '../../runtime/visualPreferences';
import type {
  GlassDeviceClass,
  GlassQualityAllocation,
  GlassQualityAssignment,
  GlassQualityBudgetLimits,
  GlassQualityCandidate,
  GlassQualityContext,
  GlassQualityControllerOptions,
  GlassQualityReason,
  GlassQualityTier,
  GlassQualityTotals,
  ResolvedGlassQualityBudget,
} from './glassTypes';

export const DEFAULT_GLASS_QUALITY_BUDGETS: Readonly<
  Record<GlassDeviceClass, GlassQualityBudgetLimits>
> = {
  desktop: {
    staticRgbCount: 3,
    interactiveRgbCount: 1,
    rgbAreaRatio: 0.25,
    maxSingleCount: 8,
    refractedAreaRatio: 0.45,
    blurAreaRatio: 1,
  },
  mobile: {
    staticRgbCount: 1,
    interactiveRgbCount: 1,
    rgbAreaRatio: 0.12,
    maxSingleCount: 4,
    refractedAreaRatio: 0.25,
    blurAreaRatio: 0.6,
  },
};

/**
 * Visual tiers drive refraction intensity. `frosted` (standard) is the full
 * refraction profile; `transparent` keeps most of it while looking clearer;
 * `low-transparency` sits between the original and frosted tiers; `original`
 * is fully dormant (handled by the runtime, kept here as an all-solid budget).
 * `DEFAULT_GLASS_QUALITY_BUDGETS` remains the fallback for callers that do not
 * specify a mode, so pre-visualMode allocation tests keep their behavior.
 */
export const GLASS_QUALITY_BUDGETS_BY_MODE: Readonly<
  Record<VisualMode, Readonly<Record<GlassDeviceClass, GlassQualityBudgetLimits>>>
> = {
  original: {
    desktop: {
      staticRgbCount: 0,
      interactiveRgbCount: 0,
      rgbAreaRatio: 0,
      maxSingleCount: 0,
      refractedAreaRatio: 0,
      blurAreaRatio: 0,
    },
    mobile: {
      staticRgbCount: 0,
      interactiveRgbCount: 0,
      rgbAreaRatio: 0,
      maxSingleCount: 0,
      refractedAreaRatio: 0,
      blurAreaRatio: 0,
    },
  },
  frosted: {
    desktop: DEFAULT_GLASS_QUALITY_BUDGETS.desktop,
    mobile: {
      staticRgbCount: 4,
      interactiveRgbCount: 2,
      rgbAreaRatio: 0.32,
      maxSingleCount: 14,
      refractedAreaRatio: 0.9,
      blurAreaRatio: 1,
    },
  },
  'low-transparency': {
    desktop: {
      staticRgbCount: 1,
      interactiveRgbCount: 1,
      rgbAreaRatio: 0.12,
      maxSingleCount: 4,
      refractedAreaRatio: 0.22,
      blurAreaRatio: 0.7,
    },
    mobile: {
      staticRgbCount: 1,
      interactiveRgbCount: 1,
      rgbAreaRatio: 0.08,
      maxSingleCount: 2,
      refractedAreaRatio: 0.14,
      blurAreaRatio: 0.45,
    },
  },
  transparent: {
    desktop: {
      staticRgbCount: 2,
      interactiveRgbCount: 1,
      rgbAreaRatio: 0.18,
      maxSingleCount: 6,
      refractedAreaRatio: 0.35,
      blurAreaRatio: 1,
    },
    mobile: {
      staticRgbCount: 3,
      interactiveRgbCount: 1,
      rgbAreaRatio: 0.22,
      maxSingleCount: 8,
      refractedAreaRatio: 0.5,
      blurAreaRatio: 1,
    },
  },
};

/** Minimum optics the runtime keeps once frame pacing degrades, regardless of
 * the requested tier. It mirrors the strict legacy mobile profile so a slow
 * device always sheds refraction before the main thread stalls. */
const DEGRADED_BUDGET_CEILINGS: Readonly<GlassQualityBudgetLimits> = {
  staticRgbCount: 1,
  interactiveRgbCount: 1,
  rgbAreaRatio: 0.12,
  maxSingleCount: 6,
  refractedAreaRatio: 0.25,
  blurAreaRatio: 0.6,
};

const qualityRank: Readonly<Record<GlassQualityTier, number>> = {
  solid: 0,
  blur: 1,
  'refract-single': 2,
  'refract-rgb': 3,
};

const finiteNonNegative = (value: number, fallback = 0): number => (
  Number.isFinite(value) ? Math.max(0, value) : fallback
);

const finiteNumber = (value: number | undefined, fallback: number): number => (
  value !== undefined && Number.isFinite(value) ? value : fallback
);

const countLimit = (value: number): number => Math.floor(finiteNonNegative(value));

const effectiveMaxQuality = (candidate: GlassQualityCandidate): GlassQualityTier => {
  if (candidate.maxQuality) return candidate.maxQuality;
  if (candidate.interacting) return 'refract-rgb';
  return getGlassProfile(candidate.role).quality.defaultMaxQuality;
};

const allowsQuality = (maximum: GlassQualityTier, desired: GlassQualityTier): boolean => (
  qualityRank[desired] <= qualityRank[maximum]
);

/** Pure priority score. Visible area remains a cost in allocation rather than
 * an arbitrary priority multiplier, so a small active control can pre-empt a
 * large static surface without making partially clipped surfaces unstable. */
export const scoreGlassQualityCandidate = (candidate: GlassQualityCandidate): number => {
  const profilePriority = finiteNumber(
    candidate.priority,
    getGlassProfile(candidate.role).quality.basePriority,
  );
  const interaction = candidate.interacting ? 10_000 : 0;
  const modal = candidate.modal ? 4_000 : 0;
  const current = candidate.current ? 1_500 : 0;
  const focused = candidate.focused ? 1_200 : 0;
  return profilePriority + interaction + modal + current + focused
    + finiteNumber(candidate.priorityBoost, 0);
};

export const resolveGlassQualityBudget = (
  context: GlassQualityContext,
): ResolvedGlassQualityBudget => {
  if (!Number.isFinite(context.viewportArea) || context.viewportArea <= 0) {
    throw new RangeError('viewportArea must be a positive finite number');
  }
  const defaults = context.visualMode
    ? GLASS_QUALITY_BUDGETS_BY_MODE[context.visualMode][context.deviceClass]
    : DEFAULT_GLASS_QUALITY_BUDGETS[context.deviceClass];
  const configured = { ...defaults, ...context.budget };
  const viewportArea = context.viewportArea;
  let rgbAreaRatio = finiteNonNegative(configured.rgbAreaRatio, defaults.rgbAreaRatio);
  let refractedAreaRatio = Math.max(
    rgbAreaRatio,
    finiteNonNegative(configured.refractedAreaRatio, defaults.refractedAreaRatio),
  );
  let blurAreaRatio = finiteNonNegative(configured.blurAreaRatio, defaults.blurAreaRatio);
  let staticRgbCount = countLimit(configured.staticRgbCount);
  let interactiveRgbCount = countLimit(configured.interactiveRgbCount);
  let maxSingleCount = countLimit(configured.maxSingleCount);
  if (context.degraded) {
    staticRgbCount = Math.min(staticRgbCount, countLimit(DEGRADED_BUDGET_CEILINGS.staticRgbCount));
    interactiveRgbCount = Math.min(
      interactiveRgbCount,
      countLimit(DEGRADED_BUDGET_CEILINGS.interactiveRgbCount),
    );
    maxSingleCount = Math.min(maxSingleCount, countLimit(DEGRADED_BUDGET_CEILINGS.maxSingleCount));
    rgbAreaRatio = Math.min(rgbAreaRatio, DEGRADED_BUDGET_CEILINGS.rgbAreaRatio);
    refractedAreaRatio = Math.min(
      refractedAreaRatio,
      DEGRADED_BUDGET_CEILINGS.refractedAreaRatio,
    );
    blurAreaRatio = Math.min(blurAreaRatio, DEGRADED_BUDGET_CEILINGS.blurAreaRatio);
  }
  return {
    deviceClass: context.deviceClass,
    viewportArea,
    staticRgbCount,
    interactiveRgbCount,
    rgbAreaRatio,
    maxSingleCount,
    refractedAreaRatio,
    blurAreaRatio,
    rgbArea: viewportArea * rgbAreaRatio,
    refractedArea: viewportArea * refractedAreaRatio,
    blurArea: viewportArea * blurAreaRatio,
  };
};

const emptyTotals = (): GlassQualityTotals => ({
  rgbCount: 0,
  staticRgbCount: 0,
  interactiveRgbCount: 0,
  singleCount: 0,
  blurCount: 0,
  solidCount: 0,
  rgbArea: 0,
  refractedArea: 0,
  blurArea: 0,
});

const fallbackReason = (
  quality: GlassQualityTier,
  maximum: GlassQualityTier,
  context: GlassQualityContext,
): GlassQualityReason => {
  if (qualityRank[maximum] <= qualityRank[quality]) return 'candidate-ceiling';
  if (
    (quality === 'refract-single' && !context.capabilities.refractRgb)
    || (quality === 'blur'
      && (!context.capabilities.refractRgb || !context.capabilities.refractSingle))
    || (quality === 'solid' && !context.capabilities.backdropBlur)
  ) return 'capability-fallback';
  if (quality === 'refract-single') return 'single-budget';
  if (quality === 'blur') return 'blur-budget';
  return 'solid-fallback';
};

/**
 * Deterministically allocates quality without touching the DOM. Candidates are
 * ranked by semantic/interaction priority; exact visible pixels are charged
 * against desktop or mobile budgets. Offscreen candidates always become solid
 * so the registry can detach their lens and release the pool lease.
 */
export const allocateGlassQuality = (
  candidates: readonly GlassQualityCandidate[],
  context: GlassQualityContext,
): GlassQualityAllocation => {
  const budget = resolveGlassQualityBudget(context);
  const totals = emptyTotals();
  const seenIds = new Set<string>();
  const ranked = candidates.map((candidate, index) => {
    if (seenIds.has(candidate.id)) throw new Error(`Duplicate glass surface id: ${candidate.id}`);
    seenIds.add(candidate.id);
    return {
      candidate,
      index,
      priority: scoreGlassQualityCandidate(candidate),
      area: Math.min(
        budget.viewportArea,
        finiteNonNegative(candidate.visibleArea),
      ),
    };
  }).sort((left, right) => (
    right.priority - left.priority
    || left.area - right.area
    || left.candidate.id.localeCompare(right.candidate.id)
  ));

  const assigned = new Map<number, GlassQualityAssignment>();
  for (const rankedCandidate of ranked) {
    const { candidate, index, priority, area } = rankedCandidate;
    if (!candidate.visible || area <= 0) {
      totals.solidCount += 1;
      assigned.set(index, {
        id: candidate.id,
        role: candidate.role,
        quality: 'solid',
        reason: 'offscreen',
        priority,
        visibleArea: 0,
      });
      continue;
    }

    const maximum = effectiveMaxQuality(candidate);
    const rgbSlotAvailable = candidate.interacting
      ? totals.interactiveRgbCount < budget.interactiveRgbCount
      : totals.staticRgbCount < budget.staticRgbCount;
    const rgbAreaAvailable = totals.rgbArea + area <= budget.rgbArea;
    const rgbRefractedAreaAvailable = totals.refractedArea + area <= budget.refractedArea;
    if (
      context.capabilities.refractRgb
      && allowsQuality(maximum, 'refract-rgb')
      && rgbSlotAvailable
      && rgbAreaAvailable
      && rgbRefractedAreaAvailable
    ) {
      totals.rgbCount += 1;
      if (candidate.interacting) totals.interactiveRgbCount += 1;
      else totals.staticRgbCount += 1;
      totals.rgbArea += area;
      totals.refractedArea += area;
      assigned.set(index, {
        id: candidate.id,
        role: candidate.role,
        quality: 'refract-rgb',
        reason: 'rgb-budget',
        priority,
        visibleArea: area,
      });
      continue;
    }

    const singleAreaAvailable = totals.refractedArea + area <= budget.refractedArea;
    if (
      context.capabilities.refractSingle
      && allowsQuality(maximum, 'refract-single')
      && totals.singleCount < budget.maxSingleCount
      && singleAreaAvailable
    ) {
      totals.singleCount += 1;
      totals.refractedArea += area;
      assigned.set(index, {
        id: candidate.id,
        role: candidate.role,
        quality: 'refract-single',
        reason: fallbackReason('refract-single', maximum, context),
        priority,
        visibleArea: area,
      });
      continue;
    }

    if (
      context.capabilities.backdropBlur
      && allowsQuality(maximum, 'blur')
      && totals.blurArea + area <= budget.blurArea
    ) {
      totals.blurCount += 1;
      totals.blurArea += area;
      assigned.set(index, {
        id: candidate.id,
        role: candidate.role,
        quality: 'blur',
        reason: fallbackReason('blur', maximum, context),
        priority,
        visibleArea: area,
      });
      continue;
    }

    totals.solidCount += 1;
    assigned.set(index, {
      id: candidate.id,
      role: candidate.role,
      quality: 'solid',
      reason: fallbackReason('solid', maximum, context),
      priority,
      visibleArea: area,
    });
  }

  return {
    assignments: candidates.map((_candidate, index) => assigned.get(index) as GlassQualityAssignment),
    totals,
    budget,
  };
};

/** Stateful convenience wrapper. Frame-time feedback can later adjust its
 * budget/device class without changing the pure allocation contract. */
export class GlassQualityController {
  private deviceClass: GlassDeviceClass;

  private readonly capabilities: GlassQualityControllerOptions['capabilities'];

  private readonly budget?: Partial<GlassQualityBudgetLimits>;

  private visualMode?: VisualMode;

  private degraded = false;

  constructor(options: GlassQualityControllerOptions) {
    this.deviceClass = options.deviceClass;
    this.capabilities = { ...options.capabilities };
    this.budget = options.budget ? { ...options.budget } : undefined;
    this.visualMode = options.visualMode;
    this.degraded = options.degraded ?? false;
  }

  setDeviceClass(deviceClass: GlassDeviceClass): void {
    this.deviceClass = deviceClass;
  }

  setVisualMode(visualMode: VisualMode): void {
    this.visualMode = visualMode;
  }

  setDegraded(degraded: boolean): void {
    this.degraded = degraded;
  }

  allocate(
    candidates: readonly GlassQualityCandidate[],
    viewportArea: number,
  ): GlassQualityAllocation {
    return allocateGlassQuality(candidates, {
      deviceClass: this.deviceClass,
      viewportArea,
      capabilities: this.capabilities,
      budget: this.budget,
      visualMode: this.visualMode,
      degraded: this.degraded,
    });
  }
}
