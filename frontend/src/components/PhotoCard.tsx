import { Heart } from 'lucide-react'
import { memo, useState } from 'react'
import { aspect, cn, exposureParts } from '../lib/format'
import { useDoubleTap, useTapRecognizer } from '../lib/hooks'
import type { ImageSummary } from '../lib/types'
import { HeartBurst, type Burst } from './HeartBurst'

let burstKey = 0

export const PhotoCard = memo(function PhotoCard({
  image,
  index,
  onOpen,
  onLike,
}: {
  image: ImageSummary
  index: number
  onOpen: (index: number) => void
  onLike: (image: ImageSummary, liked: boolean) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [burst, setBurst] = useState<Burst | null>(null)
  const ratio = aspect(image)
  const placeholder = image.colors[0]?.hex

  const doubleTap = useDoubleTap({
    delay: 280,
    onSingle: () => onOpen(index),
    onDouble: (p) => {
      const liked = !image.liked
      setBurst({ key: ++burstKey, liked, x: p.x, y: p.y })
      onLike(image, liked)
    },
  })
  const tap = useTapRecognizer((p) => doubleTap.tap(p))
  const parts = exposureParts(image)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${image.file_name}${image.liked ? ', liked' : ''}`}
      {...tap}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(index)
        } else if (e.key.toLowerCase() === 'l') {
          onLike(image, !image.liked)
        }
      }}
      className="group relative block w-full touch-manipulation overflow-hidden rounded-lg bg-zinc-200 select-none [-webkit-touch-callout:none] md:rounded-xl dark:bg-zinc-800"
      style={{ aspectRatio: String(ratio), backgroundColor: placeholder }}
    >
      <img
        src={image.thumb_url}
        alt={image.file_name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        className={cn(
          'absolute inset-0 size-full object-cover transition-[opacity,transform] duration-500 ease-out-soft [@media(hover:hover)]:group-hover:scale-[1.025]',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Hover details (pointer devices only) */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 transition-opacity duration-200 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1 p-3 text-white opacity-0 transition-[opacity,transform] duration-200 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:translate-y-0 [@media(hover:hover)]:group-focus-visible:opacity-100">
        <div className="truncate text-[13px] font-medium">{image.file_name}</div>
        {parts.length > 0 && <div className="mt-0.5 truncate text-[11px] text-white/75 tabular">{parts.join('  ·  ')}</div>}
      </div>

      {image.score != null && (
        <div className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white/90 tabular opacity-0 backdrop-blur-sm transition-opacity [@media(hover:hover)]:group-hover:opacity-100">
          {image.score.toFixed(2)}
        </div>
      )}

      {/* Like button: always visible when liked, otherwise on hover. */}
      <button
        type="button"
        aria-label={image.liked ? 'Unlike' : 'Like'}
        aria-pressed={image.liked}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          const liked = !image.liked
          if (liked) setBurst({ key: ++burstKey, liked })
          onLike(image, liked)
        }}
        className={cn(
          'absolute top-1 right-1 grid size-10 place-items-center rounded-full transition-[opacity,transform] duration-150 active:scale-90',
          image.liked
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 [@media(hover:hover)]:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100',
        )}
      >
        <span className="grid size-8 place-items-center rounded-full bg-black/30 backdrop-blur-sm transition-colors hover:bg-black/50">
          <Heart
            className={cn('size-4', image.liked ? 'fill-rose-500 text-rose-500' : 'text-white')}
            strokeWidth={image.liked ? 1.5 : 2}
          />
        </span>
      </button>

      <HeartBurst burst={burst} size={72} onDone={() => setBurst(null)} />
    </div>
  )
})
