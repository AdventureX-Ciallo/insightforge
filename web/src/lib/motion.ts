import type { Variants } from 'framer-motion'

/* 全站统一缓动：easeOutQuint —— 动效安静克制 */
export const EASE = [0.22, 1, 0.36, 1] as const

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE } },
}

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
}

export const drawerVariants: Variants = {
  hidden: { x: '100%' },
  show: { x: 0, transition: { type: 'spring', stiffness: 260, damping: 30 } },
  exit: { x: '100%', transition: { duration: 0.35, ease: EASE } },
}

export const overlayVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3 } },
  exit: { opacity: 0, transition: { duration: 0.25 } },
}

export const dialogVariants: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 320, damping: 28 } },
  exit: { opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.2, ease: EASE } },
}

/** 证据链瀑布：节点自上而下依次出现，引导视线沿链向下 */
export const pathNode: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.12 + i * 0.07, duration: 0.5, ease: EASE },
  }),
}
