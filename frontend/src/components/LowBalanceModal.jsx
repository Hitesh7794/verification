import { Button } from './ui.jsx'
import { formatRupees } from '../lib/wallet.js'
import DepositModal from './DepositModal.jsx'
import { useState } from 'react'

// LowBalanceModal — shown when /api/candidates/{roll} returns HTTP 402.
// Tells the operator they're out of wallet credit and offers Deposit.
// On successful deposit, the parent retries the failed roll lookup
// automatically (via the onDeposited callback).

export default function LowBalanceModal({
  err,        // ApiError with .body = { error, balance_paise, fee_paise }
  config,     // wallet config (fee, cap, etc.)
  onClose,
  onDeposited, // (newBalance) => caller retries the original action
}) {
  const [depositOpen, setDepositOpen] = useState(false)
  const balance = err?.body?.balance_paise ?? 0
  const fee = err?.body?.fee_paise ?? config?.fee_per_lookup_paise ?? 500

  if (depositOpen) {
    return (
      <DepositModal
        config={config}
        currentBalance={balance}
        onClose={() => setDepositOpen(false)}
        onSuccess={(newBalance) => {
          setDepositOpen(false)
          onDeposited?.(newBalance)
        }}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-rose-700 mb-2">
          Wallet empty
        </h3>
        <p className="text-sm text-slate-700 mb-4">
          You need at least <span className="font-semibold">{formatRupees(fee)}</span>
          {' '}in your wallet to look up a candidate.
          Your current balance is <span className="font-semibold">{formatRupees(balance)}</span>.
        </p>
        <p className="text-xs text-slate-500 mb-4">
          Top up to continue. Test mode card{' '}
          <span className="font-mono">4111 1111 1111 1111</span>
          {' '}always succeeds.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => setDepositOpen(true)}>Add money</Button>
        </div>
      </div>
    </div>
  )
}
