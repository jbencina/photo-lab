import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { aspect } from '../lib/format'
import type { ImageSummary } from '../lib/types'
import { PhotoCard } from './PhotoCard'

export type Density = 'compact' | 'comfortable'

function columnsFor(width: number, density: Density): number {
  if (density === 'compact') {
    if (width < 480) return 2
    if (width < 768) return 3
    if (width < 1024) return 4
    if (width < 1280) return 5
    return 6
  }
  if (width < 480) return 1
  if (width < 768) return 2
  if (width < 1024) return 3
  if (width < 1500) return 4
  return 5
}

/**
 * Masonry that keeps reading order roughly left-to-right: each image goes into the currently shortest
 * column. Heights come from the API's width/height, so nothing shifts while thumbnails load.
 */
export function PhotoGrid({
  items,
  density,
  onOpen,
  onLike,
}: {
  items: ImageSummary[]
  density: Density
  onOpen: (index: number) => void
  onLike: (image: ImageSummary, liked: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = width ? columnsFor(width, density) : 0
  const gap = width < 640 ? 6 : 12

  const columns = useMemo(() => {
    if (!cols) return []
    const out: { image: ImageSummary; index: number }[][] = Array.from({ length: cols }, () => [])
    const heights = new Array(cols).fill(0)
    items.forEach((image, index) => {
      let target = 0
      for (let c = 1; c < cols; c++) if (heights[c] < heights[target] - 0.01) target = c
      out[target].push({ image, index })
      heights[target] += 1 / aspect(image) + 0.04 // gap fudge, in column-width units
    })
    return out
  }, [items, cols])

  return (
    <div ref={ref} className="w-full">
      {cols > 0 && (
        <div className="flex items-start" style={{ gap }}>
          {columns.map((col, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap }}>
              {col.map(({ image, index }) => (
                <PhotoCard key={image.id} image={image} index={index} onOpen={onOpen} onLike={onLike} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
