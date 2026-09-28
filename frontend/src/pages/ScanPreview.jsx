import { useState } from 'react'
import { FingerScene, IrisScene } from '../components/fv/ScanScene.jsx'
import PrintPlate, { demoCapture } from '../components/fv/PrintPlate.jsx'

// A bench for the two biometric bays, so each state can be looked at
// without walking a candidate through the whole check.
const STATES = ['idle', 'scanning', 'pass', 'fail']

export default function ScanPreview() {
  const [i, setI] = useState(0)
  const forced = new URLSearchParams(window.location.search).get('state')
  const status = forced || STATES[i]
  const seed = '10001'
  const shot = status === 'pass' || status === 'fail'

  return (
    <div className="min-h-screen bg-fv-page p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex gap-2">
          {STATES.map((s, k) => (
            <button key={s} type="button" onClick={() => setI(k)}
                    className={`rounded-[10px] border px-3 py-2 text-[14px] font-bold ${
                      status === s ? 'border-fv-accent bg-fv-accent text-white' : 'border-fv-line bg-white text-fv-ink'}`}>
              {s}
            </button>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-[14px] border border-fv-line bg-fv-page p-4">
            <h4 className="fv-display text-[17px] font-bold text-fv-ink">
              Fingerprint <span className="fv-hi ml-2 text-[13px] font-bold text-fv-faint">अंगुली</span>
            </h4>
            <div className="flex h-[260px] items-stretch gap-3 rounded-[12px] border border-fv-line bg-white p-2">
              <FingerScene status={status} className="h-full w-0 flex-[3]" />
              <PrintPlate src={shot ? demoCapture('finger', seed) : null} status={status} kind="finger" seed={seed}
                          className="h-full w-0 flex-[2]" />
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-[14px] border border-fv-line bg-fv-page p-4">
            <h4 className="fv-display text-[17px] font-bold text-fv-ink">
              Iris <span className="fv-hi ml-2 text-[13px] font-bold text-fv-faint">पुतली</span>
            </h4>
            <div className="flex h-[260px] items-stretch gap-3 rounded-[12px] border border-fv-line bg-white p-2">
              <IrisScene status={status} className="h-full w-0 flex-[3]" />
              <PrintPlate src={shot ? demoCapture('iris', seed) : null} status={status} kind="iris" seed={seed}
                          className="h-full w-0 flex-[2]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
