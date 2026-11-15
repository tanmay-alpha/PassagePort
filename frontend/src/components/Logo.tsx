import { cx } from '@/lib/cx'

/** The mark: an archway (the port) with one highlighted line of text passing through it. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7.5" fill="#0F766E" />
      <path
        d="M9.5 25.5V15a6.5 6.5 0 0 1 13 0v10.5"
        fill="none"
        stroke="#FAFAF7"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="4.5" y="17.25" width="23" height="3.5" rx="1.75" fill="#FBBF24" />
    </svg>
  )
}

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">PassagePort</span>
    </span>
  )
}
