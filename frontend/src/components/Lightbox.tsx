import { AnimatePresence, motion, useDragControls } from 'framer-motion'
import { ChevronLeft, ChevronRight, ExternalLink, Heart, Info, PanelRightClose, PanelRightOpen, ScanSearch, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { api, isAbort } from '../lib/api'
import { aspect, cn } from '../lib/format'
import { useBodyScrollLock, useDoubleTap, useLocalStorage, useMediaQuery } from '../lib/hooks'
import { usePropagation } from '../lib/propagation'
import type { AddTagResponse, ImageDetail, ImageSummary, SubjectScore } from '../lib/types'
import { HeartBurst, type Burst } from './HeartBurst'
import { PhotoDetails } from './PhotoDetails'
import { useToast } from './Toast'

let burstKey = 0

const slide = {
  enter: (dir: number) => ({ x: dir === 0 ? 0 : dir > 0 ? 80 : -80, opacity: 0, scale: dir === 0 ? 0.97 : 1 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (dir: number) => ({ x: dir === 0 ? 0 : dir > 0 ? -80 : 80, opacity: 0 }),
}

function Stage({
  image,
  dir,
  dragX,
  dragY,
  padding,
}: {
  image: ImageSummary
  dir: number
  dragX: number
  dragY: number
  padding: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [fullLoaded, setFullLoaded] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => setFullLoaded(false), [image.id])

  const r = aspect(image)
  const availW = Math.max(0, box.w - padding * 2)
  const availH = Math.max(0, box.h - padding * 2)
  let w = availW
  let h = w / r
  if (h > availH) {
    h = availH
    w = h * r
  }
  const dragging = dragX !== 0 || dragY !== 0

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      <AnimatePresence initial={false} custom={dir} mode="popLayout">
        <motion.div
          key={image.id}
          custom={dir}
          variants={slide}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 grid place-items-center"
        >
          <div
            className="relative"
            style={{
              width: w,
              height: h,
              transform: `translate3d(${dragX}px, ${dragY}px, 0) scale(${1 - Math.min(Math.abs(dragY) / 1500, 0.15)})`,
              transition: dragging ? 'none' : 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <img
              src={image.thumb_url}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 size-full object-contain"
              style={{ backgroundColor: image.colors[0]?.hex }}
            />
            <img
              src={image.image_url}
              alt={image.file_name}
              draggable={false}
              onLoad={() => setFullLoaded(true)}
              className={cn('absolute inset-0 size-full object-contain transition-opacity duration-300', fullLoaded ? 'opacity-100' : 'opacity-0')}
            />
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export function Lightbox({
  id,
  items,
  onClose,
  onNavigate,
  onLike,
  onSimilar,
  onColor,
  onSubject,
  onSubjectsChanged,
}: {
  id: string
  items: ImageSummary[]
  onClose: () => void
  onNavigate: (id: string) => void
  onLike: (image: ImageSummary, liked: boolean) => void
  onSimilar: (id: string) => void
  onColor: (hex: string) => void
  onSubject: (label: string) => void
  /** A photo's tags changed (manual add/remove: `id` + its new subjects) or a library-wide propagation finished (no args). */
  onSubjectsChanged?: (id?: string, subjects?: SubjectScore[]) => void
}) {
  useBodyScrollLock(true)
  const toast = useToast()
  const wide = useMediaQuery('(min-width: 1024px)')
  const [panelOpen, setPanelOpen] = useLocalStorage<'1' | '0'>('photolib:lightbox-panel', '1')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [detail, setDetail] = useState<ImageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [localLiked, setLocalLiked] = useState<boolean | null>(null)
  const [dir, setDir] = useState(0)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const [burst, setBurst] = useState<Burst | null>(null)
  const [chrome, setChrome] = useState(true)
  const sheetDrag = useDragControls()

  const index = items.findIndex((i) => i.id === id)
  const base: ImageSummary | null = index >= 0 ? items[index] : detail
  const image = base ? { ...base, liked: index >= 0 ? base.liked : (localLiked ?? base.liked) } : null
  const prev = index > 0 ? items[index - 1] : null
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null

  // Load full details (EXIF etc.) for the current image.
  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setLocalLiked(null)
    setDetail((d) => (d?.id === id ? d : null))
    api
      .image(id, ctrl.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (isAbort(err)) return
        toast.error(`Couldn't load photo details: ${(err as Error).message}`)
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false))
    return () => ctrl.abort()
  }, [id, toast])

  // ---- manual tags + "find this new tag in the rest of the library" ----
  const [removingTag, setRemovingTag] = useState<string | null>(null)
  const idRef = useRef(id)
  idRef.current = id
  const changedRef = useRef(onSubjectsChanged)
  changedRef.current = onSubjectsChanged
  const applySubjects = useCallback((imageId: string, subjects: SubjectScore[]) => {
    setDetail((d) => (d && d.id === imageId ? { ...d, subjects } : d))
    changedRef.current?.(imageId, subjects)
  }, [])
  const propagation = usePropagation({
    onError: toast.error,
    onInfo: toast.info,
    onDone: () => {
      // other photos (maybe this one's neighbours) gained the tag: refresh this photo and the subject counts
      const current = idRef.current
      api
        .image(current)
        .then((d) => setDetail((prev) => (prev?.id === d.id ? d : prev)))
        .catch(() => {})
      changedRef.current?.()
    },
  })
  const { propose } = propagation
  const onTagAdded = useCallback(
    (r: AddTagResponse) => {
      applySubjects(idRef.current, r.subjects)
      if (r.created && r.propagate !== undefined) propose(r.label, r.propagate) // undefined: models not available
      else if (r.added === false) toast.info(`This photo already has “${r.label}”`)
    },
    [applySubjects, propose, toast],
  )
  const onTagRemove = useCallback(
    (label: string) => {
      const imageId = idRef.current
      setRemovingTag(label)
      api
        .removeTag(imageId, label)
        .then((r) => applySubjects(imageId, r.subjects))
        .catch((err) => toast.error(`Couldn't remove the tag: ${(err as Error).message}`))
        .finally(() => setRemovingTag(null))
    },
    [applySubjects, toast],
  )

  // Preload neighbours so swiping feels instant.
  useEffect(() => {
    for (const n of [prev, next]) if (n) new Image().src = n.image_url
  }, [prev, next])

  const go = useCallback(
    (delta: -1 | 1) => {
      const target = delta < 0 ? prev : next
      if (!target) return
      setDir(delta)
      onNavigate(target.id)
    },
    [prev, next, onNavigate],
  )

  const toggleLike = useCallback(
    (at?: { x: number; y: number }) => {
      if (!image) return
      const liked = !image.liked
      if (at || liked) setBurst({ key: ++burstKey, liked, x: at?.x, y: at?.y })
      if (index < 0) setLocalLiked(liked)
      onLike(image, liked)
    },
    [image, index, onLike],
  )

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        if (sheetOpen) setSheetOpen(false)
        else onClose()
      } else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key.toLowerCase() === 'l') toggleLike()
      else if (e.key.toLowerCase() === 'i') {
        if (wide) setPanelOpen(panelOpen === '1' ? '0' : '1')
        else setSheetOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose, toggleLike, sheetOpen, wide, panelOpen, setPanelOpen])

  // ---- Gestures: swipe left/right to navigate, swipe down to close, double-tap to like ----
  const doubleTap = useDoubleTap({
    delay: 280,
    onDouble: (p) => toggleLike(p),
    onSingle: () => {
      if (!wide) setChrome((c) => !c)
    },
  })
  const gesture = useRef<{ id: number; x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as HTMLElement).closest('button,a')) return
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: null }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (!g.axis && Math.hypot(dx, dy) > 8) g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    if (g.axis === 'x') {
      const blocked = (dx > 0 && !prev) || (dx < 0 && !next)
      setDrag({ x: blocked ? dx * 0.25 : dx, y: 0 })
    } else if (g.axis === 'y' && dy > 0) {
      setDrag({ x: 0, y: dy })
    }
  }
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    gesture.current = null
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    const dt = Math.max(1, performance.now() - g.t)
    const width = stageRef.current?.clientWidth ?? window.innerWidth
    setDrag({ x: 0, y: 0 })
    if (g.axis === 'x') {
      const fast = Math.abs(dx) / dt > 0.5
      if (dx < 0 && next && (Math.abs(dx) > width * 0.18 || fast)) go(1)
      else if (dx > 0 && prev && (Math.abs(dx) > width * 0.18 || fast)) go(-1)
    } else if (g.axis === 'y') {
      if (dy > 120 || (dy > 40 && dy / dt > 0.5)) onClose()
    } else if (dt < 600) {
      const rect = e.currentTarget.getBoundingClientRect()
      doubleTap.tap({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
  }
  const onPointerCancel = () => {
    gesture.current = null
    setDrag({ x: 0, y: 0 })
  }

  const showPanel = wide && panelOpen === '1'
  const position = index >= 0 ? `${index + 1} / ${items.length}` : null

  const details = image && (
    <PhotoDetails
      image={image}
      detail={detail}
      loading={loading}
      onLike={() => toggleLike()}
      onSimilar={() => onSimilar(image.id)}
      onColor={onColor}
      onSubject={onSubject}
      onTagAdded={onTagAdded}
      onTagRemove={onTagRemove}
      onTagError={toast.error}
      removingTag={removingTag}
      propagation={propagation}
    />
  )

  const overlayBtn =
    'grid size-11 place-items-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors hover:bg-black/55 active:scale-95'

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex overscroll-none bg-zinc-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={image?.file_name ?? 'Photo'}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {/* Stage */}
      <div
        ref={stageRef}
        className="relative min-w-0 flex-1 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ backgroundColor: drag.y ? `rgba(9,9,11,${Math.max(0.4, 1 - drag.y / 500)})` : undefined }}
      >
        {image ? (
          <Stage image={image} dir={dir} dragX={drag.x} dragY={drag.y} padding={wide ? 72 : 0} />

        ) : (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/60">{loading ? 'Loading…' : 'Photo not found'}</div>
        )}
        <HeartBurst burst={burst} size={wide ? 120 : 104} onDone={() => setBurst(null)} />

        {/* Top bar */}
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/50 to-transparent px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-8 transition-opacity duration-200 lg:from-transparent lg:px-4',
            chrome ? 'opacity-100' : 'opacity-0',
          )}
        >
          <button type="button" onClick={onClose} className={cn(overlayBtn, 'pointer-events-auto')} aria-label="Close (Esc)">
            <X className="size-5" />
          </button>
          {position && (
            <span className="rounded-full bg-black/35 px-3 py-1 text-xs font-medium text-white/85 tabular backdrop-blur-md">{position}</span>
          )}
          <div className="pointer-events-auto flex gap-2">
            {wide ? (
              <button
                type="button"
                onClick={() => setPanelOpen(panelOpen === '1' ? '0' : '1')}
                className={overlayBtn}
                aria-label={showPanel ? 'Hide details (I)' : 'Show details (I)'}
                title={showPanel ? 'Hide details (I)' : 'Show details (I)'}
              >
                {showPanel ? <PanelRightClose className="size-5" /> : <PanelRightOpen className="size-5" />}
              </button>
            ) : (
              <button type="button" onClick={() => toggleLike()} className={overlayBtn} aria-label={image?.liked ? 'Unlike' : 'Like'}>
                <Heart className={cn('size-5', image?.liked && 'fill-rose-500 text-rose-500')} />
              </button>
            )}
          </div>
        </div>

        {/* Desktop arrows */}
        {wide && prev && (
          <button
            type="button"
            onClick={() => go(-1)}
            className={cn(overlayBtn, 'absolute top-1/2 left-4 -translate-y-1/2')}
            aria-label="Previous (←)"
          >
            <ChevronLeft className="size-6" />
          </button>
        )}
        {wide && next && (
          <button
            type="button"
            onClick={() => go(1)}
            className={cn(overlayBtn, 'absolute top-1/2 right-4 -translate-y-1/2')}
            aria-label="Next (→)"
          >
            <ChevronRight className="size-6" />
          </button>
        )}

        {/* Mobile bottom bar */}
        {!wide && image && (
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity duration-200',
              chrome ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <div className="mb-2 truncate px-1 text-center text-xs text-white/70">{image.file_name}</div>
            <div className="mx-auto flex max-w-sm items-center justify-around">
              <BarButton label={image.liked ? 'Liked' : 'Like'} onClick={() => toggleLike()}>
                <Heart className={cn('size-5', image.liked && 'fill-rose-500 text-rose-500')} />
              </BarButton>
              <BarButton label="Similar" onClick={() => onSimilar(image.id)}>
                <ScanSearch className="size-5" />
              </BarButton>
              <BarButton label="Info" onClick={() => setSheetOpen(true)}>
                <Info className="size-5" />
              </BarButton>
              <a
                href={image.image_url}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-11 min-w-16 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-white/85 active:bg-white/10"
              >
                <ExternalLink className="size-5" />
                Original
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Desktop side panel */}
      <AnimatePresence initial={false}>
        {showPanel && image && (
          <motion.aside
            key="panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 380, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="shrink-0 overflow-hidden border-l border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <div className="scrollbar-thin h-full w-[380px] overflow-y-auto overscroll-contain p-6">{details}</div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Mobile info sheet */}
      <AnimatePresence>
        {!wide && sheetOpen && image && (
          <>
            <motion.div
              key="scrim"
              className="absolute inset-0 z-10 bg-black/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSheetOpen(false)}
            />
            <motion.div
              key="sheet"
              className="absolute inset-x-0 bottom-0 z-20 flex max-h-[78dvh] flex-col rounded-t-2xl bg-white text-zinc-900 shadow-2xl dark:bg-zinc-900 dark:text-zinc-100"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'tween', duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              drag="y"
              dragListener={false}
              dragControls={sheetDrag}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.5 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 100 || info.velocity.y > 500) setSheetOpen(false)
              }}
            >
              {/* Fixed header (drag handle + close) so scrolled content never slides under the close button. */}
              <div
                className="relative flex h-12 shrink-0 touch-none items-start justify-center pt-2"
                onPointerDown={(e) => {
                  if (!(e.target as HTMLElement).closest('button')) sheetDrag.start(e)
                }}
              >
                <span className="h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  className="absolute top-1 right-2 grid size-11 place-items-center rounded-full text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                  aria-label="Close details"
                >
                  <X className="size-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                {details}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 min-w-16 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-white/85 active:bg-white/10"
    >
      {children}
      {label}
    </button>
  )
}
