// Animated shells for dashboard stat cards (admin + superadmin).
//
// Follows the house motion language already set in motion.jsx and
// extras.jsx: a 2px lift, a border that darkens, a shadow that deepens.
// Deliberately layout-preserving — nothing scales or grows, so a row of
// tiles never reflows and the numbers don't jitter under the pointer.
//
// Reduced motion is handled globally: MotionConfig in main.jsx sets
// reducedMotion="user", so framer skips the transform for anyone who has
// asked for less movement. The border/shadow transitions are colour, not
// travel, so they're left on — they still give the hover feedback
// without anything sliding around.
//
// These tiles are NOT clickable, so there's no press state and no
// cursor-pointer: the hover is there to make the row feel alive and to
// help the eye track which card it's on, not to promise a click target.

import { motion } from 'framer-motion'

// Stock shadow utilities rather than a bespoke arbitrary value — the
// jump from sm to lg is the effect we want and it stays legible to the
// next person. Measured in the browser: 0 1px 3px → 0 10px 15px -3px.
const BASE =
  'group relative overflow-hidden rounded-xl border bg-white ' +
  'border-slate-200 shadow-sm ' +
  'transition-[box-shadow,border-color] duration-200 ease-out ' +
  'hover:border-slate-300 hover:shadow-lg'

export function StatShell({ children, className = '', ...rest }) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={`${BASE} ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

// Row wrapper — fades its tiles in one after another on first paint, so
// the dashboard assembles itself rather than snapping in all at once.
// 40ms apart is fast enough not to feel like a loading sequence.
const rowVariants = {
  hidden: { opacity: 1 },
  show: { opacity: 1, transition: { staggerChildren: 0.04 } },
}
const cellVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
}

export function StatRow({ children, className = '' }) {
  return (
    <motion.div variants={rowVariants} initial="hidden" animate="show" className={className}>
      {children}
    </motion.div>
  )
}

export function StatCell({ children, className = '' }) {
  return (
    <motion.div variants={cellVariants} className={className}>
      {children}
    </motion.div>
  )
}
