import { Images, Moon, Settings, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '../lib/format'
import { useTheme } from '../lib/theme'

function Brand({ className, suffix }: { className?: string; suffix?: string }) {
  return (
    <Link to="/" className={cn('flex shrink-0 items-center gap-2.5 rounded-lg', className)} aria-label="photo-lib home">
      <span className="relative grid size-8 place-items-center overflow-hidden rounded-[10px] bg-gradient-to-br from-accent-500 to-accent-700 shadow-sm ring-1 ring-black/5 dark:from-accent-400 dark:to-accent-600">
        <svg viewBox="0 0 24 24" className="size-[18px] text-white" fill="none" aria-hidden>
          <path d="M3.5 17.5 9 11l4 4.5 2.5-2.5 5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16.5" cy="7.5" r="2" fill="currentColor" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        photo-lib
        {suffix && <span className="ml-2 font-normal text-zinc-400 dark:text-zinc-500">/ {suffix}</span>}
      </span>
    </Link>
  )
}

function IconButton({ label, children, onClick, to }: { label: string; children: ReactNode; onClick?: () => void; to?: string }) {
  const cls =
    'grid size-11 place-items-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-200/60 hover:text-zinc-900 md:size-9 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
  if (to)
    return (
      <Link to={to} className={cls} aria-label={label} title={label}>
        {children}
      </Link>
    )
  return (
    <button type="button" onClick={onClick} className={cls} aria-label={label} title={label}>
      {children}
    </button>
  )
}

function Actions({ page, className }: { page: 'library' | 'admin'; className?: string }) {
  const { theme, toggle } = useTheme()
  return (
    <div className={cn('flex shrink-0 items-center gap-0.5', className)}>
      <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
        {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
      </IconButton>
      {page === 'library' ? (
        <IconButton label="Admin" to="/admin">
          <Settings className="size-[18px]" />
        </IconButton>
      ) : (
        <IconButton label="Library" to="/">
          <Images className="size-[18px]" />
        </IconButton>
      )}
    </div>
  )
}

const BAR =
  'sticky top-0 z-30 border-b border-zinc-200/70 bg-zinc-50/80 backdrop-blur-xl backdrop-saturate-150 dark:border-zinc-800/70 dark:bg-zinc-950/80'

export function TopBar({ page, search }: { page: 'library' | 'admin'; search?: ReactNode }) {
  if (!search) {
    return (
      <header className={BAR}>
        <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between gap-3 px-4 md:h-16 md:px-6">
          <Brand suffix={page === 'admin' ? 'admin' : undefined} />
          <Actions page={page} />
        </div>
      </header>
    )
  }
  return (
    <>
      {/* Phone: brand row scrolls away, search row stays pinned. */}
      <div className="flex h-14 items-center justify-between px-4 md:hidden">
        <Brand />
        <Actions page={page} />
      </div>
      <header className={BAR}>
        <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-2 px-4 md:gap-4 md:px-6">
          <Brand className="hidden md:flex lg:w-[264px]" />
          <div className="min-w-0 flex-1 lg:max-w-2xl">{search}</div>
          <Actions page={page} className="ml-auto hidden md:flex" />
        </div>
      </header>
    </>
  )
}
