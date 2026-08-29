import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { EASE } from '../lib/motion'

export default function SectionHeading({ title, desc }: { title: ReactNode; desc?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-15%' }}
      transition={{ duration: 0.6, ease: EASE }}
      className="mb-10"
    >
      <h2 className="font-serif text-3xl font-black leading-tight tracking-tight md:text-4xl">{title}</h2>
      {desc && <p className="mt-3 max-w-2xl text-sm leading-7 text-ink-soft">{desc}</p>}
    </motion.div>
  )
}
