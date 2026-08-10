// Animation primitives built on framer-motion.
//
// Design principles:
//   - Subtle. Motion as feedback, not as decoration. 200–300ms cubic
//     ease for the bulk of transitions; nothing slower than 400ms.
//   - Layout-preserving. Cards don't grow / shrink on hover (only
//     shadow + tiny y-translate). Avoids reflow jitter.
//   - Reduced-motion aware. framer-motion's `reduceMotion: 'user'` (set
//     globally via MotionConfig in main.jsx) respects the OS setting
//     and skips non-essential animations.
//
// Exposed primitives:
//   <FadeIn>              one-shot fade-in on mount
//   <SlideStep>           horizontal slide for wizard step swaps (with AnimatePresence)
//   <StaggerList> + <StaggerItem>  for queue rows / stat tiles entering together
//   <HoverLift>           wraps any card so it gets a smooth shadow + y-lift on hover
//   <PressScale>          wraps any clickable so it scales-down on press
//   shimmer keyframe util via the Skeleton component (in extras.jsx)
//
// These wrap motion.div so they accept the usual `className`, plus any
// motion props can be threaded through via `...rest`.

import { AnimatePresence, motion } from 'framer-motion'

// ----- Mount-in transitions -----------------------------------------------

export function FadeIn({ children, delay = 0, className, ...rest }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

// ----- Step wizard slide --------------------------------------------------
// Wrap the step content with this and pass a key that changes per step.
// Use inside <AnimatePresence mode="wait"> to get clean enter/exit.

export function SlideStep({ children, direction = 1, className, ...rest }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: direction * 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: direction * -24 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

export { AnimatePresence }

// ----- Stagger ------------------------------------------------------------
// Drop StaggerItem children inside a StaggerList and they fade in one by
// one. Useful for queue rows, stat tiles, doc rows.

const listVariants = {
  hidden: { opacity: 1 }, // parent itself is always visible
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.04 },
  },
}
const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  },
}

export function StaggerList({ children, className, ...rest }) {
  return (
    <motion.div
      variants={listVariants}
      initial="hidden"
      animate="show"
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, className, ...rest }) {
  return (
    <motion.div variants={itemVariants} className={className} {...rest}>
      {children}
    </motion.div>
  )
}

// ----- Hover lift ---------------------------------------------------------
// Wrap any card. Whileless reflow than a CSS-only :hover because framer
// reads/writes only transform + box-shadow on the same RAF tick.

export function HoverLift({ children, className, lift = 2, ...rest }) {
  return (
    <motion.div
      whileHover={{ y: -lift, transition: { duration: 0.18, ease: 'easeOut' } }}
      whileTap={{ y: 0, transition: { duration: 0.1 } }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

// ----- Press scale --------------------------------------------------------

export function PressScale({ children, className, scale = 0.97, ...rest }) {
  return (
    <motion.div
      whileTap={{ scale, transition: { duration: 0.08 } }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
