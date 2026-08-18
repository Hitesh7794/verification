// OTP Client for sending and verifying Email & SMS OTPs.

const BASE = '/api/otp'

async function call(endpoint, body) {
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  let data = null
  try {
    data = await res.json()
  } catch {
    // Non-JSON response fallback
  }

  if (!res.ok) {
    const errorMsg = data?.error || res.statusText || `Request failed (${res.status})`
    const err = new Error(errorMsg)
    err.status = res.status
    err.data = data
    throw err
  }

  return data
}

export async function sendEmailOTP(email, purpose = 'registration') {
  return call('/send-email', { email, purpose })
}

export async function verifyEmailOTP(email, code, purpose = 'registration') {
  return call('/verify-email', { email, code, purpose })
}

export async function sendSmsOTP(mobile, purpose = 'registration') {
  return call('/send-sms', { mobile, purpose })
}

export async function verifySmsOTP(mobile, code, purpose = 'registration') {
  return call('/verify-sms', { mobile, code, purpose })
}
