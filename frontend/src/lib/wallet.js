// Wallet client — talks to /api/wallet/* + drives Razorpay Checkout.
//
// Razorpay Checkout JS is loaded from their CDN on-demand (the script tag
// is injected only when a deposit is initiated). That way our portal
// doesn't make network requests to Razorpay at all if the wallet feature
// is disabled or the operator never tries to top up.

import { api } from './api.js'

// One-time fetch of /api/wallet/config — caches the result. The values
// don't change at runtime (deployment-level config), so caching is safe
// for the session.
let _configCache = null
export async function getWalletConfig() {
  if (_configCache) return _configCache
  _configCache = await api('/wallet/config')
  return _configCache
}

export async function getWallet() {
  return api('/wallet')
}

// Create a Razorpay order on the backend (which talks to api.razorpay.com).
// Returns { razorpay_order_id, razorpay_key_id, amount_paise, currency }.
export async function createWalletOrder(amountPaise) {
  return api('/wallet/order', {
    method: 'POST',
    body: { amount_paise: amountPaise },
  })
}

// Send the three values Razorpay Checkout returns back to the backend
// for signature verification + wallet credit.
export async function verifyWalletPayment({ razorpay_order_id, razorpay_payment_id, razorpay_signature, amount_paise }) {
  return api('/wallet/verify-payment', {
    method: 'POST',
    body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount_paise },
  })
}

// Lazily inject the Razorpay Checkout script. Resolves when window.Razorpay
// is available; rejects on script load error (e.g. offline, blocked by an
// extension, or Razorpay's CDN is down).
let _scriptPromise = null
function loadRazorpayScript() {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve()
  if (_scriptPromise) return _scriptPromise
  _scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      _scriptPromise = null  // allow a retry on next call
      reject(new Error('failed to load Razorpay Checkout — offline?'))
    }
    document.head.appendChild(s)
  })
  return _scriptPromise
}

// Format paise as ₹ X.YZ. Always uses 2 decimals so column alignment looks
// right in the history table.
export function formatRupees(paise) {
  if (typeof paise !== 'number' || Number.isNaN(paise)) return '—'
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const fraction = (abs % 100).toString().padStart(2, '0')
  return `${sign}₹${rupees}.${fraction}`
}

// Drive Razorpay Checkout end-to-end:
//   1. createWalletOrder       — backend → Razorpay /v1/orders
//   2. window.Razorpay(...).open() — vendor's hosted modal
//   3. On vendor's success cb:   verifyWalletPayment — backend → HMAC verify → wallet credit
//
// Resolves with the final { balance_paise, transaction_id, replayed }.
// Rejects with an Error if (a) the user closed the modal, (b) the vendor
// returned a failure, (c) signature verification failed server-side.
export async function deposit({ amountPaise, displayUser }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('amountPaise must be a positive integer')
  }
  await loadRazorpayScript()
  const order = await createWalletOrder(amountPaise)

  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key:      order.razorpay_key_id,
      order_id: order.razorpay_order_id,
      amount:   order.amount_paise,
      currency: order.currency,
      name:     'NEET Verification Portal',
      description: `Wallet top-up of ${formatRupees(amountPaise)}`,
      // Operator's name pre-filled into Checkout so they don't have to
      // re-type it on every deposit. Email/phone left blank — Razorpay
      // doesn't require them in test mode.
      prefill: displayUser ? { name: displayUser } : {},
      theme: { color: '#4f46e5' }, // indigo-600, matches our portal accent
      handler: async (response) => {
        // Razorpay calls this on success with the three magic values.
        // verifyWalletPayment confirms the HMAC signature server-side
        // and credits the wallet.
        try {
          const result = await verifyWalletPayment({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            amount_paise:        amountPaise,
          })
          resolve(result)
        } catch (e) {
          reject(e)
        }
      },
      modal: {
        ondismiss: () => reject(new Error('payment cancelled')),
      },
    })
    rzp.on('payment.failed', (resp) => {
      const desc = resp?.error?.description || 'payment failed'
      reject(new Error(desc))
    })
    rzp.open()
  })
}

// Helper for the lookup flow's 402 handling. The backend includes
// {error, balance_paise, fee_paise} in the body when balance is too low.
export function parseWalletError(apiError) {
  // api.js throws an Error with the body's `error` field as .message,
  // but to know it's a wallet 402 we need access to the raw response.
  // The api() wrapper only surfaces the message string today, so
  // callers should also catch the HTTP 402 explicitly via the
  // Response object. See LowBalanceModal usage for the recommended
  // pattern: a custom fetch() wrapper that returns both ok + body.
  return apiError
}
