export interface ColorSwatch {
  hex: string
  share: number
  lab?: [number, number, number]
}

/** 'user' = added by hand in the lightbox (kept by re-tags, removable). */
export type SubjectSource = 'd1' | 'eg' | 'user'

export interface SubjectScore {
  label: string
  /** d1 P(yes) for source 'd1'; EmbeddingGemma cosine for the 'eg' fallback; 1 for manual tags. */
  score: number
  source?: SubjectSource
  /** Detail only. */
  eg_score?: number | null
  display_rank?: number | null
}

export interface ImageSummary {
  id: string
  file_name: string
  thumb_url: string
  image_url: string
  width: number | null
  height: number | null
  taken_at: string | null
  make: string | null
  model: string | null
  lens: string | null
  iso: number | null
  f_number: number | null
  exposure_str: string | null
  focal_length: number | null
  liked: boolean
  colors: ColorSwatch[]
  subjects: SubjectScore[]
  score?: number
}

export interface ImageDetail extends ImageSummary {
  exif: Record<string, unknown>
  file_size: number | null
  sha1: string | null
  indexed_at: string | null
  tagged_at?: string | null
  tagger?: string | null
}

export interface ImagesResponse {
  items: ImageSummary[]
  total: number
}

export interface SearchResponse {
  items: ImageSummary[]
}

export type IndexPhase = 'scanning' | 'embedding' | 'tagging' | 'propagating' | 'done'
export type IndexMode = 'refresh' | 'tag' | 'retag' | 'propagate'

export interface IndexingState {
  running: boolean
  /** Progress of the current phase. */
  done: number
  total: number
  current: string | null
  started_at: string | null
  error: string | null
  // Present on the real backend (summary of the current/last run).
  finished_at?: string | null
  mode?: IndexMode | null
  phase?: IndexPhase | null
  interrupted?: boolean
  added?: number
  skipped?: number
  failed?: number
  missing?: number
  pruned?: number
  failures?: string[]
  embed_done?: number
  embed_total?: number
  embed_seconds?: number | null
  skip_tags?: boolean
  tag_done?: number
  tag_total?: number
  tag_failed?: number
  tag_seconds?: number | null
  /** Live DB counts. */
  tagged?: number
  untagged?: number
  /** Propagate job: the label(s) being looked for, tags added so far, wall time. `done/total` = candidate photos. */
  labels?: string[]
  propagate_added?: number
  propagate_seconds?: number | null
  /** Images/s of the current phase over a sliding window, and the seconds left in it. */
  rate?: number | null
  eta_seconds?: number | null
}


/** Where a model runs: in the server process, on another machine, or nowhere (flag omitted at startup). */
export type ModelMode = 'local' | 'remote' | null

export interface ModelInfo {
  name: string
  /** False when the server was started without --embedding-model: semantic search and indexing are off. */
  available?: boolean
  mode?: ModelMode
  endpoint?: string | null
  device: string | null
  dim: number
  loaded: boolean
}

export interface TaggerInfo {
  name: string
  /** False when the server was started without --decision-model: tagging and "find in library" are off. */
  available?: boolean
  mode?: ModelMode
  endpoint?: string | null
  device: string | null
  dtype?: string | null
  loaded: boolean
  labels?: number
  user_labels?: number
  threshold?: number
  seconds_per_image?: number
}

export interface Status {
  catalog_dir: string | null
  image_count: number
  liked_count: number
  subject_count: number
  db_size_bytes: number
  tagged_count?: number
  untagged_count?: number
  model: ModelInfo
  tagger?: TaggerInfo
  indexing: IndexingState
}

export interface FacetValue<V = string> {
  value: V
  count: number
}

export interface Range {
  min: number | null
  max: number | null
}

export interface DateRange {
  min: string | null
  max: string | null
}

export interface Facets {
  makes: FacetValue[]
  models: FacetValue[]
  lenses: FacetValue[]
  iso: Range
  f_number: Range
  focal_length: Range
  dates: DateRange
  /** Photo counts per distinct value (behind the preset counts) and per `YYYY-MM` (the date histogram). */
  iso_values: FacetValue<number>[]
  f_values: FacetValue<number>[]
  focal_values: FacetValue<number>[]
  months: FacetValue<string>[]
}

export interface SubjectCount {
  label: string
  count: number
  /** The builtin label's group (e.g. "Birds"); null for labels you created. */
  category?: string | null
}

export type LabelSource = 'builtin' | 'user'
/** Why a label is suggested: text matches, embedding similarity, or (empty query) a likely label for the photo. */
export type SuggestMatch = 'exact' | 'prefix' | 'text' | 'similar' | 'image'

export interface LabelSuggestion {
  label: string
  count: number
  match: SuggestMatch
  similarity: number | null
  source: LabelSource
  on_image: boolean
}

export interface SuggestResponse {
  items: LabelSuggestion[]
  exact_exists: boolean
  normalized: string
  can_create?: boolean
  reason?: string | null
}

export interface PropagatePreview {
  candidates: number
  est_seconds: number
}

export interface AddTagResponse {
  label: string
  created: boolean
  added?: boolean
  subjects: SubjectScore[]
  propagate?: PropagatePreview | null
}

export interface LabelInfo {
  label: string
  question: string | null
  category: string | null
  source: LabelSource
  created_at: string | null
  count: number
  manual_count: number
}

export interface AdminConfig {
  catalog_dir: string | null
  data_dir: string
  /** The current catalog's index folder inside the data dir (null when no catalog is set). */
  index_dir?: string | null
}

export type SortKey = 'random' | 'taken_at' | 'file_name' | 'indexed_at' | 'liked_at'
export type SortOrder = 'asc' | 'desc'
