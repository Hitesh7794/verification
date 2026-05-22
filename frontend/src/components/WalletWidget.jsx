import { useCallback, useEffect, useState } from 'react'
import { Button } from './ui.jsx'
import { getWallet, getWalletConfig } from '../lib/wallet.js'
import WalletBalanceBadge from './WalletBalanceBadge.jsx'
import DepositModal from './DepositModal.jsx'

// WalletWidget — navbar composition: prominent balance badge + Deposit
// CTA + modal lifecycle. The badge itself is now its own component
// (WalletBalanceBadge) so its colour / icon / sizing can be reused
// elsewhere (e.g. a future wallet-history page) without duplication.
//
// `refreshKey` is a number the parent bumps to force a re-fetch (e.g.
// after a successful candidate-lookup charge). The reload key threads
// the same way regardless of which component triggers the refresh —
// the WalletWidget itself when the user deposits, or the Dashboard
// after a lookup succeeds.

export default function WalletWidget({ refreshKey = 0, onBalanceChange }) {
  const [balance, setBalance] = useState(null)   // null = loading; number = paise
  const [cfg, setCfg] = useState(null)
  const [err, setErr] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([getWallet(), getWalletConfig()])
      setBalance(w.balance_paise)
      setCfg(c)
      setErr('')
      onBalanceChange?.(w.balance_paise)
    } catch (e) {
      setErr(e.message || 'wallet unavailable')
    }
  }, [onBalanceChange])

  useEffect(() => {
    reload()
  }, [reload, refreshKey])

  // Treat 503 / network errors as "feature disabled" rather than a loud
  // error in the navbar — keeps the UI clean if a deployment has the
  // wallet feature off.
  if (err) return null
  if (balance === null) {
    return <span className="text-xs text-slate-500">Loading wallet…</span>
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <WalletBalanceBadge
          balancePaise={balance}
          feePaise={cfg?.fee_per_lookup_paise || 500}
          onClick={() => setModalOpen(true)}
        />
        <Button size="sm" onClick={() => setModalOpen(true)}>
          Deposit
        </Button>
      </div>
      {modalOpen && cfg && (
        <DepositModal
          config={cfg}
          currentBalance={balance}
          onClose={() => setModalOpen(false)}
          onSuccess={(newBalance) => {
            setBalance(newBalance)
            onBalanceChange?.(newBalance)
            setModalOpen(false)
          }}
        />
      )}
    </>
  )
}
