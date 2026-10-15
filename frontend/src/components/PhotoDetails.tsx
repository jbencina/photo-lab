import { Aperture, Camera, ChevronRight, ExternalLink, FileImage, Heart, Ruler, ScanSearch, X } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  cameraName,
  cn,
  exposureParts,
  formatBytes,
  formatDate,
  megapixels,
  labelCase,
  readableOn,
} from '../lib/format'
import { exifKey, exifValue } from '../lib/exif'
import type { Propagation } from '../lib/propagation'
import type { AddTagResponse, ImageDetail, ImageSummary } from '../lib/types'
import { AddTag, PropagationStatus } from './TagEditor'
import { SectionLabel, Spinner } from './ui'

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="mt-0.5 text-zinc-400 dark:text-zinc-500">{icon}</span>
      <div className="min-w-0 flex-1 text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
    </div>
  )
}


export function PhotoDetails({
  image,
  detail,
  loading,
  onLike,
  onSimilar,
  onColor,
  onSubject,
  onTagAdded,
  onTagRemove,
  onTagError,
  removingTag,
  propagation,
}: {
  image: ImageSummary
  detail: ImageDetail | null
  loading: boolean
  onLike: () => void
  onSimilar: () => void
  onColor: (hex: string) => void
  onSubject: (label: string) => void
  /** Manual tagging; the editor is hidden when these are not provided. */
  onTagAdded?: (r: AddTagResponse) => void
  onTagRemove?: (label: string) => void
  onTagError?: (message: string) => void
  removingTag?: string | null
  propagation?: Propagation
}) {
  const camera = cameraName(image)
  // Summaries carry the top 5 subjects; the detail response has all of them (with source / EG score).
  const subjects = detail && detail.id === image.id ? detail.subjects : image.subjects
  const parts = exposureParts(image)
  const exifEntries = detail?.exif ? Object.entries(detail.exif).sort(([a], [b]) => a.localeCompare(b)) : []

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere] text-zinc-900 dark:text-zinc-50">{image.file_name}</h2>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{formatDate(image.taken_at, true)}</p>
      </div>

      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <button
          type="button"
          onClick={onLike}
          aria-pressed={image.liked}
          className={cn(
            'inline-flex h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors md:h-10',
            image.liked
              ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-400 dark:hover:bg-rose-950/70'
              : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
          )}
        >
          <Heart className={cn('size-4', image.liked && 'fill-current')} />
          {image.liked ? 'Liked' : 'Like'}
        </button>
        <button
          type="button"
          onClick={onSimilar}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-zinc-900 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-800 md:h-10 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          <ScanSearch className="size-4" />
          Find similar
        </button>
        <a
          href={image.image_url}
          target="_blank"
          rel="noreferrer"
          title="Open original"
          aria-label="Open original"
          className="inline-flex size-11 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition-colors hover:bg-zinc-50 md:size-10 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
        <div className="pb-2">
          {camera && (
            <Row icon={<Camera className="size-4" />}>
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{camera}</div>
            </Row>
          )}
          {image.lens && (
            <Row icon={<Aperture className="size-4" />}>
              <div>{image.lens}</div>
            </Row>
          )}
          {parts.length > 0 && (
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {parts.map((p) => (
                <div
                  key={p}
                  className="truncate rounded-lg bg-zinc-100 px-1.5 py-2 text-center text-[12px] font-medium text-zinc-700 tabular dark:bg-zinc-800/80 dark:text-zinc-200"
                >
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="pt-2">
          <Row icon={<Ruler className="size-4" />}>
            {image.width && image.height ? (
              <>
                {image.width} × {image.height}
                <span className="text-zinc-400"> · {megapixels(image.width, image.height)}</span>
              </>
            ) : (
              '—'
            )}
          </Row>
          <Row icon={<FileImage className="size-4" />}>
            {detail ? formatBytes(detail.file_size) : loading ? <span className="text-zinc-400">…</span> : '—'}
            {image.id !== image.file_name && (
              <span className="block truncate text-xs text-zinc-400" title={image.id}>
                {image.id}
              </span>
            )}
          </Row>
        </div>
      </div>

      {image.colors.length > 0 && (
        <div>
          <SectionLabel>Palette</SectionLabel>
          <div className="flex h-2.5 overflow-hidden rounded-full ring-1 ring-black/5 dark:ring-white/10">
            {image.colors.map((c) => (
              <span key={c.hex} style={{ backgroundColor: c.hex, flexGrow: c.share }} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {image.colors.map((c) => (
              <button
                key={c.hex}
                type="button"
                onClick={() => onColor(c.hex)}
                title={`Search by ${c.hex}`}
                className="group/sw flex h-11 items-center gap-2 rounded-full border border-zinc-200 bg-white py-1 pr-3 pl-1 text-xs transition-colors hover:border-zinc-300 hover:bg-zinc-50 md:h-9 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <span
                  className="grid size-8 place-items-center rounded-full ring-1 ring-black/10 ring-inset md:size-7 dark:ring-white/15"
                  style={{ backgroundColor: c.hex }}
                >
                  <ScanSearch className="size-3 opacity-0 transition-opacity group-hover/sw:opacity-100" style={{ color: readableOn(c.hex) }} />
                </span>
                <span className="font-mono text-zinc-600 dark:text-zinc-300">{c.hex}</span>
                <span className="text-zinc-400 tabular">{Math.round(c.share * 100)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(subjects.length > 0 || onTagAdded) && (
        <div>
          <SectionLabel>Subjects</SectionLabel>
          {subjects.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {subjects.map((s) => {
                const eg = s.source === 'eg'
                const manual = s.source === 'user'
                const chip =
                  'relative inline-flex h-9 items-center gap-1.5 text-[13px] font-medium transition-colors after:absolute after:inset-x-0 after:-inset-y-1 md:h-8 md:after:hidden'
                if (manual)
                  return (
                    <span
                      key={s.label}
                      data-manual-tag={s.label}
                      className={cn(
                        'inline-flex items-stretch rounded-full border border-accent-300/80 bg-accent-50 text-accent-900 dark:border-accent-800 dark:bg-accent-950/50 dark:text-accent-100',
                        removingTag === s.label && 'opacity-50',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSubject(s.label)}
                        title={`Show all “${s.label}” photos · added by you`}
                        className={cn(chip, 'rounded-l-full pr-1 pl-3 hover:text-accent-700 dark:hover:text-white')}
                      >
                        {labelCase(s.label)}
                      </button>
                      {onTagRemove && (
                        <button
                          type="button"
                          onClick={() => onTagRemove(s.label)}
                          disabled={removingTag === s.label}
                          aria-label={`Remove tag ${s.label}`}
                          title="Remove this tag from the photo"
                          className="relative grid w-8 place-items-center rounded-r-full text-accent-700/70 transition-colors after:absolute after:-inset-y-1 after:-right-1 after:left-0 hover:bg-accent-100 hover:text-accent-900 md:w-7 md:after:hidden dark:text-accent-300/70 dark:hover:bg-accent-900/60 dark:hover:text-white"
                        >
                          <X className="size-3.5" strokeWidth={2.5} />
                        </button>
                      )}
                    </span>
                  )
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => onSubject(s.label)}
                    title={
                      eg
                        ? `Show all “${s.label}” photos · fallback: d1 confirmed none of the candidates, so this is EmbeddingGemma's best match (cosine ${s.score.toFixed(2)})`
                        : `Show all “${s.label}” photos · d1 confidence ${Math.round(s.score * 100)}%${s.eg_score != null ? ` · EmbeddingGemma ${s.eg_score.toFixed(2)}` : ''}`
                    }
                    className={cn(
                      chip,
                      'rounded-full border bg-white px-3 text-zinc-700 hover:border-accent-300 hover:bg-accent-50 hover:text-accent-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-accent-800 dark:hover:bg-accent-950/50 dark:hover:text-accent-200',
                      eg ? 'border-dashed border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800',
                    )}
                  >
                    {labelCase(s.label)}
                    {eg && (
                      <span className="-mr-1 rounded bg-amber-100 px-1 py-px text-[10px] font-semibold tracking-wide text-amber-800 uppercase dark:bg-amber-900/50 dark:text-amber-200">
                        EG
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {subjects.some((s) => s.source === 'eg') && (
            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              <span className="font-semibold text-amber-700 dark:text-amber-300">EG</span> = not confirmed: the d1 tagger rejected every
              candidate label, so EmbeddingGemma's closest match is shown instead.
            </p>
          )}
          {onTagAdded && (
            <div className={cn('space-y-2.5', subjects.length > 0 && 'mt-3')}>
              <AddTag imageId={image.id} onAdded={onTagAdded} onError={(m) => onTagError?.(m)} />
              {propagation && <PropagationStatus p={propagation} />}
            </div>
          )}
        </div>
      )}

      <details className="group/exif rounded-xl border border-zinc-200 dark:border-zinc-800">
        <summary className="flex h-11 cursor-pointer list-none items-center justify-between px-3.5 text-sm font-medium text-zinc-700 select-none dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
          <span>
            Full EXIF
            {exifEntries.length > 0 && <span className="ml-1.5 text-xs font-normal text-zinc-400">{exifEntries.length} fields</span>}
          </span>
          <ChevronRight className="size-4 text-zinc-400 transition-transform group-open/exif:rotate-90" />
        </summary>
        <div className="border-t border-zinc-200 px-3.5 py-2 dark:border-zinc-800">
          {loading && !detail ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : exifEntries.length === 0 ? (
            <p className="py-2 text-sm text-zinc-500">No EXIF data.</p>
          ) : (
            <dl className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800/70">
              {exifEntries.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-1.5">
                  <dt className="text-zinc-500 [overflow-wrap:anywhere] dark:text-zinc-400" title={k}>
                    {exifKey(k)}
                  </dt>
                  <dd className="break-words text-zinc-800 tabular dark:text-zinc-200" title={String(v ?? '')}>
                    {exifValue(k, v)}
                  </dd>

                </div>
              ))}
            </dl>
          )}
          {detail?.sha1 && (
            <p className="mt-2 truncate border-t border-zinc-100 pt-2 font-mono text-[11px] text-zinc-400 dark:border-zinc-800/70">
              sha1 {detail.sha1}
            </p>
          )}
        </div>
      </details>
    </div>
  )
}
