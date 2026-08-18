import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button, Input, Label } from './ui.jsx'
import { Icon } from './extras.jsx'

/**
 * OtpVerificationField
 * 
 * Provides an input field with integrated Email / SMS OTP verification.
 * 
 * @param {Object} props
 * @param {string} props.label - Field label (e.g. "Email", "Mobile")
 * @param {string} props.type - "email" | "tel" | "text"
 * @param {string} props.value - Input value
 * @param {Function} props.onChange - Input change callback
 * @param {Function} props.onBlur - Input blur callback
 * @param {string} props.placeholder - Input placeholder
 * @param {React.ComponentType} props.icon - Icon component
 * @param {boolean} props.required - Required indicator
 * @param {string} props.error - External validation error string
 * @param {boolean} props.isVerified - Whether this target is currently verified
 * @param {Function} props.onVerified - Callback (token) when verified
 * @param {Function} props.onResetVerification - Callback to clear verification if input changed
 * @param {Function} props.sendOtpFn - Function () => Promise<any>
 * @param {Function} props.verifyOtpFn - Function (code) => Promise<{ token: string }>
 * @param {boolean} props.canSendOtp - Condition under which "Send OTP" is enabled (e.g. valid format)
 * @param {string} props.inputMode - "email" | "numeric" | "text"
 * @param {number} props.maxLength - Input max length
 */
export default function OtpVerificationField({
  label,
  type = 'text',
  value = '',
  onChange,
  onBlur,
  placeholder,
  icon: IconComp,
  required = false,
  error,
  isVerified = false,
  onVerified,
  onResetVerification,
  sendOtpFn,
  verifyOtpFn,
  canSendOtp = false,
  inputMode,
  maxLength,
  className = '',
}) {
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [otpError, setOtpError] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [isEditing, setIsEditing] = useState(false)
  const otpInputRef = useRef(null)

  // Countdown timer for resending OTP
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [countdown])

  // Focus OTP input when OTP section opens
  useEffect(() => {
    if (otpSent && !isVerified) {
      setTimeout(() => otpInputRef.current?.focus(), 150)
    }
  }, [otpSent, isVerified])

  async function handleSendOtp() {
    if (!canSendOtp || sending) return
    setSending(true)
    setOtpError('')
    try {
      await sendOtpFn()
      setOtpSent(true)
      setCountdown(60)
      setOtpCode('')
    } catch (err) {
      setOtpError(err.message || 'Failed to send OTP')
    } finally {
      setSending(false)
    }
  }

  async function handleVerifyOtp(e) {
    e?.preventDefault()
    if (!otpCode || otpCode.trim().length !== 6 || verifying) return
    setVerifying(true)
    setOtpError('')
    try {
      const res = await verifyOtpFn(otpCode.trim())
      if (res?.token) {
        onVerified(res.token)
        setOtpSent(false)
        setIsEditing(false)
      }
    } catch (err) {
      setOtpError(err.message || 'Verification failed. Please check the code and try again.')
    } finally {
      setVerifying(false)
    }
  }

  function handleInputChange(e) {
    if (isVerified) {
      onResetVerification()
      setOtpSent(false)
    }
    onChange(e)
  }

  function handleStartEditing() {
    setIsEditing(true)
    onResetVerification()
    setOtpSent(false)
    setOtpCode('')
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Label and Verified Badge */}
      <div className="flex items-center justify-between">
        <Label>
          {label}
          {required && <span className="text-rose-600 ml-0.5" aria-label="required">*</span>}
        </Label>
        {isVerified && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
            <Icon.Check className="h-3.5 w-3.5 text-emerald-600" />
            Verified
          </span>
        )}
      </div>

      {/* Main Input Row */}
      <div className="relative flex items-center">
        <div className="relative flex-1 group">
          {IconComp && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-slate-700 transition-colors pointer-events-none">
              <IconComp className="h-4 w-4" />
            </span>
          )}
          <Input
            type={type}
            value={value}
            onChange={handleInputChange}
            onBlur={onBlur}
            placeholder={placeholder}
            inputMode={inputMode}
            maxLength={maxLength}
            disabled={isVerified && !isEditing}
            className={`${IconComp ? 'pl-9' : ''} ${
              isVerified
                ? 'border-emerald-300 bg-emerald-50/30 text-emerald-950 pr-24'
                : 'pr-24'
            }`}
          />
        </div>

        {/* Action Button inside/next to the input */}
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
          {isVerified ? (
            <button
              type="button"
              onClick={handleStartEditing}
              className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-md transition shadow-xs"
            >
              Change
            </button>
          ) : (
            <Button
              type="button"
              variant={otpSent ? 'secondary' : 'primary'}
              size="sm"
              disabled={!canSendOtp || sending}
              onClick={handleSendOtp}
              className="text-xs px-2.5 py-1 h-auto"
            >
              {sending ? (
                <span className="inline-flex items-center gap-1">
                  <Icon.Clock className="h-3 w-3 animate-spin" />
                  Sending…
                </span>
              ) : otpSent ? (
                'Resend'
              ) : (
                'Send OTP'
              )}
            </Button>
          )}
        </div>
      </div>

      {/* External Field Error */}
      {error && !otpError && (
        <p className="text-xs text-rose-600">{error}</p>
      )}

      {/* Expandable OTP Verification Drawer */}
      <AnimatePresence>
        {otpSent && !isVerified && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -6 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-3.5 bg-indigo-50/70 border border-indigo-100 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-indigo-950 font-medium">
                  Enter the 6-digit code sent to <strong className="font-semibold">{value}</strong>
                </span>
                {countdown > 0 ? (
                  <span className="text-slate-500 text-[11px] font-mono">
                    Resend in {countdown}s
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleSendOtp}
                    disabled={sending}
                    className="text-indigo-700 hover:text-indigo-900 font-semibold underline text-[11px]"
                  >
                    Resend code
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  ref={otpInputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="• • • • • •"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && handleVerifyOtp(e)}
                  className="font-mono text-center tracking-widest text-base font-semibold bg-white border-indigo-200 focus:border-indigo-600 focus:ring-indigo-200"
                />
                <Button
                  type="button"
                  onClick={handleVerifyOtp}
                  disabled={otpCode.length !== 6 || verifying}
                  size="sm"
                  className="shrink-0 px-4 py-2"
                >
                  {verifying ? 'Verifying…' : 'Verify'}
                </Button>
              </div>

              {otpError && (
                <p className="text-xs text-rose-600 font-medium flex items-center gap-1">
                  <Icon.AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {otpError}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
