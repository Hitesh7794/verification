import { useState } from 'react'
import { Button } from './ui.jsx'
import { deposit, formatRupees } from '../lib/wallet.js'
import { useAuth } from '../lib/auth.jsx'

// Preset amounts in paise — most operators will pick from these. The
// freeform field below lets them enter any amount up to the deployment
// cap (config.max_deposit_paise).
const PRESETS = [
  { paise: 10000,  label: '₹100' },
  { paise: 50000,  label: '₹500' },
  { paise: 100000, label: '₹1,000' },
  { paise: 500000, label: '₹5,000' },
]

// DepositModal — picks an amount, opens Razorpay Checkout, waits for the
// vendor's hosted modal to complete, then either:
//   • success → onSuccess(newBalance) and self-close
//   • failure → show error inline, modal stays open for retry
//   • cancel  → modal stays open (operator can try a different amount)
//
// `currentBalance` is just for display ("you have ₹15 left"). The actual
// debit is on the backend.

export default function DepositModal({ config, currentBalance, onClose, onSuccess }) {
  const { user } = useAuth()
  const [selected, setSelected] = useState(50000) // default ₹500
  const [custom, setCustom] = useState('')        // freeform in rupees, e.g. "750"
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Effective amount in paise: freeform takes precedence over preset.
  const effectivePaise = custom.trim()
    ? Math.round(Number(custom) * 100)
    : selected
  const effectiveValid =
    Number.isFinite(effectivePaise) &&
    effectivePaise >= 100 &&                        // minimum ₹1
    effectivePaise <= config.max_deposit_paise

  async function pay() {
    setBusy(true)
    setErr('')
    try {
      const result = await deposit({
        amountPaise: effectivePaise,
        displayUser: user?.display_name || user?.username,
      })
      onSuccess(result.balance_paise)
    } catch (e) {
      // Vendor "payment cancelled" / "payment failed" / our backend's
      // "signature verification failed" all land here. Same UI.
      setErr(e.message || 'payment failed')
    } finally {
      setBusy(false)
    }
  }

  if (!config.razorpay_enabled) {
    return (
      <Backdrop onClose={onClose}>
        <Modal onClose={onClose} title="Deposits unavailable">
          <p className="text-sm text-slate-600">
            Razorpay isn't configured on this deployment. Ask an admin to
            credit your wallet from the admin dashboard.
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </Modal>
      </Backdrop>
    )
  }

  return (
    <Backdrop onClose={onClose}>
      <Modal onClose={onClose} title="Add money to wallet">
        <p className="text-sm text-slate-600 mb-3">
          Current balance: <span className="font-semibold text-slate-900">{formatRupees(currentBalance)}</span>
          {' · '}
          Each roll-number search costs {formatRupees(config.fee_per_lookup_paise)}.
        </p>

        <p className="text-xs text-slate-500 mb-2">Pick an amount:</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {PRESETS.map((p) => (
            <button
              key={p.paise}
              type="button"
              disabled={busy}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                selected === p.paise && !custom
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-slate-300 hover:border-slate-400 text-slate-700'
              }`}
              onClick={() => {
                setSelected(p.paise)
                setCustom('')
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-slate-500 mb-1">Or enter a custom amount (₹):</p>
        <input
          type="number"
          min="1"
          step="1"
          disabled={busy}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="e.g. 750"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm mb-2"
        />
        <p className="text-xs text-slate-500 mb-3">
          Maximum per top-up: {formatRupees(config.max_deposit_paise)}.
        </p>

        {err && (
          <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-2">
          <p className="text-sm text-slate-600">
            Paying: <span className="font-semibold text-slate-900">
              {effectiveValid ? formatRupees(effectivePaise) : '—'}
            </span>
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={pay} disabled={busy || !effectiveValid}>
              {busy ? 'Opening Razorpay…' : 'Pay with Razorpay'}
            </Button>
          </div>
        </div>

        <p className="mt-4 text-[11px] text-slate-400 leading-relaxed">
          Test mode: use card <span className="font-mono">4111 1111 1111 1111</span> with any
          future expiry and any 3-digit CVV. No real money is moved.
        </p>
      </Modal>
    </Backdrop>
  )
}

function Backdrop({ onClose, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50"
      onClick={onClose}
    >
      {children}
    </div>
  )
}

function Modal({ onClose, title, children }) {
  return (
    <div
      className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <button
          type="button"
          className="text-slate-400 hover:text-slate-600 text-xl leading-none"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}
