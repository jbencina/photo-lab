import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

let lockCount = 0
let savedOverflow = ''
let savedPadding = ''

/** Prevent the page behind an overlay from scrolling (reference counted for stacked overlays). */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const body = document.body
    if (lockCount === 0) {
      const scrollbar = window.innerWidth - document.documentElement.clientWidth
      savedOverflow = body.style.overflow
      savedPadding = body.style.paddingRight
      body.style.overflow = 'hidden'
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
      document.documentElement.style.overscrollBehavior = 'none'
    }
    lockCount++
    return () => {
      lockCount--
      if (lockCount === 0) {
        body.style.overflow = savedOverflow
        body.style.paddingRight = savedPadding
        document.documentElement.style.overscrollBehavior = ''
      }
    }
  }, [active])
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay: number) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const call = useRef((...args: A) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => fnRef.current(...args), delay)
  })
  return call.current
}

export function useLocalStorage<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial
    } catch {
      return initial
    }
  })
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, v)
    } catch {
      /* ignore */
    }
  }
  return [value, set]
}

export interface Point {
  x: number
  y: number
}

/**
 * Distinguishes a single tap from a double tap. Call `tap(point)` whenever a tap gesture was recognized
 * (pointer went down and up without moving much). Single taps are delayed by `delay` ms so they never fire
 * when the user is actually double tapping.
 */
export function useDoubleTap(opts: {
  onSingle?: (p: Point) => void
  onDouble?: (p: Point) => void
  delay?: number
}) {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const last = useRef<{ t: number; p: Point } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const api = useRef({
    tap(p: Point) {
      const delay = optsRef.current.delay ?? 300
      const now = performance.now()
      const prev = last.current
      if (prev && now - prev.t < delay && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < 40) {
        window.clearTimeout(timer.current)
        last.current = null
        optsRef.current.onDouble?.(p)
        return
      }
      last.current = { t: now, p }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        last.current = null
        optsRef.current.onSingle?.(p)
      }, delay)
    },
    cancel() {
      window.clearTimeout(timer.current)
      last.current = null
    },
  })
  return api.current
}

/** Pointer handlers that recognize a tap (short press, little movement) and forward it to `onTap`. */
export function useTapRecognizer(onTap: (p: Point, pointerType: string) => void, tolerance = 10) {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null)
  const onTapRef = useRef(onTap)
  onTapRef.current = onTap
  return {
    onPointerDown(e: ReactPointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      start.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }
    },
    onPointerUp(e: ReactPointerEvent) {
      const s = start.current
      start.current = null
      if (!s || s.id !== e.pointerId) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > tolerance) return
      if (performance.now() - s.t > 600) return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onTapRef.current({ x: e.clientX - rect.left, y: e.clientY - rect.top }, e.pointerType)
    },
    onPointerCancel() {
      start.current = null
    },
    onPointerLeave() {
      start.current = null
    },
  }
}
