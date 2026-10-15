import type { ReactNode } from 'react'

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center md:py-28">
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-3 rounded-full bg-accent-500/10 blur-xl dark:bg-accent-400/10" />
        <div className="relative grid size-14 place-items-center rounded-2xl border border-zinc-200 bg-white text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {icon}
        </div>
      </div>
      <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
      {children && <div className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
