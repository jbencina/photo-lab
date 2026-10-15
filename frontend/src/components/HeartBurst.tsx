import { AnimatePresence, motion } from 'framer-motion'
import { Heart, HeartCrack } from 'lucide-react'

export interface Burst {
  key: number
  liked: boolean
  x?: number
  y?: number
}

const PARTICLES = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2)

/** Big heart that pops where the user double-tapped. Render inside a `relative` container. */
export function HeartBurst({ burst, size = 88, onDone }: { burst: Burst | null; size?: number; onDone: () => void }) {
  return (
    <AnimatePresence>
      {burst && (
        <motion.div
          key={burst.key}
          className="pointer-events-none absolute z-20"
          style={{
            left: burst.x ?? '50%',
            top: burst.y ?? '50%',
            width: size,
            height: size,
            marginLeft: -size / 2,
            marginTop: -size / 2,
          }}
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          {burst.liked &&
            PARTICLES.map((a, i) => (
              <motion.span
                key={i}
                className="absolute top-1/2 left-1/2 size-2 rounded-full bg-rose-400"
                initial={{ x: -4, y: -4, scale: 0.4, opacity: 1 }}
                animate={{ x: Math.cos(a) * size * 0.75 - 4, y: Math.sin(a) * size * 0.75 - 4, scale: 0, opacity: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.08 }}
              />
            ))}
          <motion.div
            className="absolute inset-0 grid place-items-center"
            initial={{ scale: 0.3, opacity: 0, rotate: -12 }}
            animate={{ scale: [0.3, 1.15, 0.95, 1], opacity: [0, 1, 1, 1], rotate: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            onAnimationComplete={() => window.setTimeout(onDone, 250)}
          >
            {burst.liked ? (
              <Heart
                className="size-full fill-rose-500 text-rose-500 drop-shadow-[0_4px_16px_rgba(244,63,94,0.55)]"
                strokeWidth={1.25}
              />
            ) : (
              <HeartCrack className="size-full text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]" strokeWidth={1.5} />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
