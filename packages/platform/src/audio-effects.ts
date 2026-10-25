import { Schema } from 'effect'

/** Microphone effect chain of the Windows desktop app (plugin host process). */

export const AUDIO_EFFECTS_MAX_SLOTS = 16

export type AudioEffectParameterDefinition = {
  id: string
  minimum: number
  maximum: number
  initial: number
  step: number
  unit: 'db' | 'hz' | 'ms' | 'ratio' | 'percent' | 'semitones'
}

/** Mirrors native `builtin_effects.cpp`; the host clamps to the same ranges. */
export const AUDIO_EFFECT_BUILTINS = {
  eq: {
    initialMix: 1,
    parameters: [
      { id: 'lowGainDb', minimum: -12, maximum: 12, initial: 0, step: 0.5, unit: 'db' },
      { id: 'midGainDb', minimum: -12, maximum: 12, initial: 0, step: 0.5, unit: 'db' },
      { id: 'midFrequency', minimum: 200, maximum: 5000, initial: 1500, step: 50, unit: 'hz' },
      { id: 'highGainDb', minimum: -12, maximum: 12, initial: 0, step: 0.5, unit: 'db' },
    ],
  },
  compressor: {
    initialMix: 1,
    parameters: [
      { id: 'thresholdDb', minimum: -60, maximum: 0, initial: -24, step: 1, unit: 'db' },
      { id: 'ratio', minimum: 1, maximum: 20, initial: 4, step: 0.5, unit: 'ratio' },
      { id: 'attackMs', minimum: 0.1, maximum: 100, initial: 5, step: 0.1, unit: 'ms' },
      { id: 'releaseMs', minimum: 10, maximum: 1000, initial: 120, step: 10, unit: 'ms' },
      { id: 'makeupDb', minimum: 0, maximum: 24, initial: 6, step: 0.5, unit: 'db' },
    ],
  },
  reverb: {
    initialMix: 0.3,
    parameters: [
      { id: 'roomSize', minimum: 0, maximum: 1, initial: 0.5, step: 0.01, unit: 'percent' },
      { id: 'damping', minimum: 0, maximum: 1, initial: 0.5, step: 0.01, unit: 'percent' },
    ],
  },
  pitch: {
    initialMix: 1,
    parameters: [
      { id: 'semitones', minimum: -12, maximum: 12, initial: 0, step: 1, unit: 'semitones' },
    ],
  },
  echo: {
    initialMix: 0.3,
    parameters: [
      { id: 'timeMs', minimum: 20, maximum: 1000, initial: 250, step: 10, unit: 'ms' },
      { id: 'feedback', minimum: 0, maximum: 0.9, initial: 0.35, step: 0.01, unit: 'percent' },
    ],
  },
} as const satisfies Record<string, {
  initialMix: number
  parameters: readonly AudioEffectParameterDefinition[]
}>

export type AudioEffectBuiltinKind = keyof typeof AUDIO_EFFECT_BUILTINS
export const AUDIO_EFFECT_BUILTIN_KINDS = Object.keys(AUDIO_EFFECT_BUILTINS) as AudioEffectBuiltinKind[]

const SlotIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const MixSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const ParamsSchema = Schema.Record(Schema.String.check(Schema.isMaxLength(64)), Schema.Finite)
const PluginPathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

export const AudioEffectSlotSchema = Schema.Union([
  Schema.Struct({
    slotId: SlotIdSchema,
    kind: Schema.Literal('builtin'),
    builtin: Schema.Literals(['eq', 'compressor', 'reverb', 'pitch', 'echo']),
    mix: MixSchema,
    enabled: Schema.Boolean,
    params: ParamsSchema,
  }),
  Schema.Struct({
    slotId: SlotIdSchema,
    kind: Schema.Literal('vst3'),
    path: PluginPathSchema,
    classId: Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{32}$/)),
    name: Schema.String.check(Schema.isMaxLength(256)),
    vendor: Schema.String.check(Schema.isMaxLength(256)),
    mix: MixSchema,
    enabled: Schema.Boolean,
  }),
])
export type AudioEffectSlot = typeof AudioEffectSlotSchema.Type

export const AudioEffectChainSchema = Schema.Array(AudioEffectSlotSchema).check(
  Schema.isMaxLength(AUDIO_EFFECTS_MAX_SLOTS),
)

export const AudioEffectSlotUpdateSchema = Schema.Struct({
  slotId: SlotIdSchema,
  mix: Schema.optional(MixSchema),
  enabled: Schema.optional(Schema.Boolean),
  params: Schema.optional(ParamsSchema),
})
export type AudioEffectSlotUpdate = typeof AudioEffectSlotUpdateSchema.Type

export const AudioEffectSlotStatusSchema = Schema.Struct({
  slotId: Schema.String,
  state: Schema.Literals(['loading', 'ready', 'failed']),
  error: Schema.optional(Schema.String),
  latencySamples: Schema.optional(Schema.Finite),
  hasEditor: Schema.Boolean,
  /** The plugin crashed the host and is left out until switched on again. */
  crashed: Schema.optional(Schema.Boolean),
})
export type AudioEffectSlotStatus = typeof AudioEffectSlotStatusSchema.Type

export const AudioEffectsHostStatusSchema = Schema.Literals(['idle', 'starting', 'running', 'failed'])
export type AudioEffectsHostStatus = typeof AudioEffectsHostStatusSchema.Type

export const AudioEffectsStateSchema = Schema.Struct({
  host: AudioEffectsHostStatusSchema,
  slots: AudioEffectChainSchema,
  statuses: Schema.Array(AudioEffectSlotStatusSchema),
})
export type AudioEffectsState = typeof AudioEffectsStateSchema.Type

export const AudioEffectsStatsSchema = Schema.Struct({
  processCpuPercent: Schema.Finite,
  audioThreadCpuPercent: Schema.Finite,
  privateMegabytes: Schema.Finite,
  slots: Schema.Array(Schema.Struct({
    slotId: Schema.String,
    averageUs: Schema.Finite,
    p99Us: Schema.Finite,
    maxUs: Schema.Finite,
    /** Blocks that alone used the whole 4 ms host deadline: the voice went dry. */
    overDeadline: Schema.Finite,
  })),
})
export type AudioEffectsStats = typeof AudioEffectsStatsSchema.Type

export const AudioPluginInfoSchema = Schema.Struct({
  path: Schema.String,
  classId: Schema.String,
  name: Schema.String,
  vendor: Schema.String,
  version: Schema.String,
  subCategories: Schema.String,
})
export type AudioPluginInfo = typeof AudioPluginInfoSchema.Type

export const AudioPluginCatalogSchema = Schema.Struct({
  scanning: Schema.Boolean,
  plugins: Schema.Array(AudioPluginInfoSchema),
  failures: Schema.Array(Schema.Struct({ path: Schema.String, error: Schema.String })),
})
export type AudioPluginCatalog = typeof AudioPluginCatalogSchema.Type
