import DeviceScene from '../../components/fv/DeviceScene.jsx'
import { ArtScanner } from '../../components/fv/FvArt.jsx'
import { useState } from 'react'
import AdminShell from '../../components/fv/FvAdminShell.jsx'
import { PageHead } from '../../components/shell/AdminShell.jsx'
import { AestheticCard, Icon } from '../../components/ui/extras.jsx'
import { FadeIn, StaggerList, StaggerItem } from '../../components/ui/motion.jsx'

import mfs500Img from '../../assets/products/mantra-mfs500.jpg'
import mis100v2Img from '../../assets/products/mantra-mis100v2.jpg'
import startekFm220uImg from '../../assets/products/startek-fm220u.jpg'

// Verified hardware catalog for exam center administrators
const PRODUCTS = [
  {
    id: 'mantra-mfs500',
    name: 'Mantra MFS500 Biometric Fingerprint Scanner',
    category: 'fingerprint',
    categoryLabel: 'Fingerprint Scanner',
    tag: 'Fingerprint Scanner',
    image: mfs500Img,
    amazonUrl: 'https://www.amazon.in/MFS500-Biometric-Fingerprint-Scanner-Non-Aadhar/dp/B0GC7VMY6C',
    modelNumber: 'MFS500 (FAP10)',
    specs: [['dpi', '500 DPI'], ['shield', 'Anti-spoof'], ['cert', 'UIDAI L1'], ['bolt', 'Under 0.5 s'], ['usb', 'USB']],
    description: 'High-speed 500 DPI optical fingerprint reader designed for candidate biometric verification at examination centers.',
    highlights: [
      'STQC Certified & UIDAI Level-0 / Level-1 ready',
      '500 DPI optical sensor with scratch-resistant glass platen',
      'Built-in fake finger & active liveness detection',
      'Sub-second minutiae capture (< 500ms) with ISO 19794-2 standard output',
      'Plug-and-play USB connectivity for center operator laptops',
    ],
  },
  {
    id: 'startek-fm220u',
    name: 'ACPL Startek FM220U L1 Biometric Fingerprint Scanner',
    category: 'fingerprint',
    categoryLabel: 'Fingerprint Scanner',
    tag: 'Fingerprint Scanner',
    image: startekFm220uImg,
    amazonUrl: 'https://www.amazon.in/Access-FM220U-L1-biometric-Scanner/dp/B0CKX5S7RK',
    modelNumber: 'FM220U L1',
    specs: [['dpi', '500 DPI'], ['cert', 'UIDAI L1'], ['shield', 'Anti-spoof'], ['file', 'ISO template'], ['usb', 'USB power']],
    description: 'Compact single-finger optical scanner with L1-certified fake finger detection, ready for Aadhaar-grade candidate verification at examination centers.',
    highlights: [
      'STQC + UIDAI Level-1 (L1) certified for public Aadhaar authentication',
      '500 DPI optical sensor with anti-spoof / fake-finger detection',
      'ISO/IEC 19794-2 template output — compatible with the portal fingerprint match service',
      'Rugged scratch-resistant scanning window built for daily centre use',
      'Plug-and-play USB — no external power, works from a laptop USB port',
    ],
  },
  {
    id: 'mantra-mis100v2',
    name: 'Mantra MIS100V2 USB Single Iris Scanner',
    category: 'iris',
    categoryLabel: 'Iris Scanner',
    tag: 'Iris Scanner',
    image: mis100v2Img,
    amazonUrl: 'https://www.amazon.in/Mantra-MIS100V2-Scanner-Portable-Service/dp/B09RSHM8YQ/ref=sr_1_1?adgrpid=60270071438&dib=eyJ2IjoiMSJ9.QfB_M5_z86vJCzYS5hg6hKOo_9tzG86jg0APCgAgnxa3xvoqU81TSFZa3cVSUNDP1jB1ZzWEVwv_6mNyw0SiJJA5VVPDnFLf-cZUIxPpZP4OnHPrtoer6VGBc5rtoJEaliorvEgNZqCPlBwCdbYIWhAcTslR7DflE5AUUXQ3sIa5Vq3nh0owaglbhzeVj3jEe2ePMHhN_Q4CMAsIUw9Bqs75CCmLhj9ftlTE1jDYkY4.jkhtUUVutNwV2bK8ky9Rs9ex3MWlbOJQrYoKQ-DnQhA&dib_tag=se&gad_source=1&hvadid=590214941014&hvdev=c&hvexpln=0&hvlocphy=9303888&hvnetw=g&hvocijid=4556545584522511735--&hvqmt=b&hvrand=4556545584522511735&hvtargid=kwd-1333816882970&hydadcr=10367_2128952&keywords=mantra+mis100+v2+iris+scanner&mcid=fdc887212fc13b50a0dbac8d76aecc2f&qid=1787134079&sr=8-1',
    modelNumber: 'MIS100V2',
    specs: [['ir', 'Dual IR'], ['focus', 'Auto-focus'], ['cert', 'STQC'], ['sun', 'Any light'], ['usb', 'USB']],
    description: 'High-precision optical iris capture device for secure and accurate biometric candidate verification.',
    highlights: [
      'STQC Certified for UIDAI & National Entrance Examinations',
      'Dual infrared LED illumination for clear capture in any lighting condition',
      'Scratch-proof optical prism with high ambient light rejection',
      'Fast auto-focus & optical distance indicator for seamless capture',
      'Standard USB interface compatible with examination verification desks',
    ],
  },
]

export default function Products() {
  const [filter, setFilter] = useState('all')

  const filteredProducts = PRODUCTS.filter((item) => {
    if (filter === 'all') return true
    return item.category === filter
  })

  const counts = { all: PRODUCTS.length, fingerprint: PRODUCTS.filter((p) => p.category === 'fingerprint').length, iris: PRODUCTS.filter((p) => p.category === 'iris').length }
  return (
    <AdminShell>
      {/* The page's living background: the desk kit at work. */}
      <DeviceScene className="fixed bottom-[20px] right-[1%] z-0 h-[min(72vh,660px)] aspect-[480/300] opacity-[0.15]" />
      <div className="fv-bold relative z-[1]">
      <FadeIn>
        <PageHead eyebrow="Hardware" title="Certified devices" art={ArtScanner} subtitle="What each desk needs." />

        {/* Filters */}
        <div className="mb-5 flex items-center gap-2">
          {[['all', 'All', 'grid'], ['fingerprint', 'Fingerprint', 'finger'], ['iris', 'Iris', 'iris']].map(([key, label, ic]) => (
            <button key={key} type="button" onClick={() => setFilter(key)}
                    className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[14px] transition-colors ${
                      filter === key ? 'border-fv-accent bg-fv-accent text-white' : 'border-fv-line bg-fv-card text-fv-accent-deep hover:bg-fv-card-focus'}`}>
              <SpecIcon name={ic} className="h-4 w-4" />{label}
              <span className={`rounded-full px-1.5 text-[12px] ${filter === key ? 'bg-white/20' : 'bg-fv-card-focus'}`}>{counts[key]}</span>
            </button>
          ))}
        </div>

        {/* Devices */}
        <StaggerList className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 mb-12">
          {filteredProducts.map((product) => (
            <StaggerItem key={product.id}>
              <article className="group flex h-full flex-col overflow-hidden rounded-[12px] border border-fv-line bg-fv-card"
                       data-guide-title={product.modelNumber}
                       data-guide={product.category === 'iris' ? 'An iris scanner that works with the portal.' : 'A fingerprint scanner that works with the portal.'}>
                {/* the stage */}
                <div className="relative flex h-52 items-center justify-center bg-fv-card-focus">
                  <img src={product.image} alt={product.name} loading="lazy"
                       className="max-h-40 w-auto object-contain mix-blend-multiply transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-2" />
                  <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[12.5px] text-fv-accent-deep">
                    <SpecIcon name={product.category === 'iris' ? 'iris' : 'finger'} className="h-4 w-4" />{product.category === 'iris' ? 'Iris' : 'Fingerprint'}
                  </span>
                  <CertSeal className="absolute right-3 top-3 h-14 w-14" />
                  <span className="absolute bottom-3 right-3 rounded-full bg-white px-2.5 py-0.5 text-[12px] text-fv-muted">{product.modelNumber}</span>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <h3 className="fv-display text-[18px] leading-snug tracking-[-0.015em] text-fv-ink">{product.name}</h3>
                  {/* specs as badges */}
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {(product.specs || []).map(([ic, label]) => (
                      <li key={label} className="inline-flex items-center gap-1.5 rounded-[10px] bg-fv-page px-2.5 py-1.5 text-[13px] text-fv-ink">
                        <SpecIcon name={ic} className="h-4 w-4 text-fv-accent" />{label}
                      </li>
                    ))}
                  </ul>
                  <details className="mt-3 text-[13px] text-fv-muted">
                    <summary className="cursor-pointer text-fv-accent hover:text-fv-accent-deep">All specs</summary>
                    <ul className="mt-2 space-y-1.5">
                      {product.highlights.map((h, i) => (
                        <li key={i} className="flex items-start gap-2"><SpecIcon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fv-accent" />{h}</li>
                      ))}
                    </ul>
                  </details>
                  <div className="flex-1" />
                  <a href={product.amazonUrl} target="_blank" rel="noopener noreferrer"
                     className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-fv-accent px-4 py-3 text-[14px] text-white transition-colors hover:bg-fv-accent-deep">
                    <SpecIcon name="cart" className="h-4 w-4" />Buy on Amazon
                  </a>
                </div>
              </article>
            </StaggerItem>
          ))}
        </StaggerList>
      </FadeIn>
      </div>
    </AdminShell>
  )
}

// A round "certified" seal for the device stage.
function CertSeal({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={`${className} -rotate-12`} aria-label="Certified">
      <circle cx="32" cy="32" r="28" fill="#fff" />
      <circle cx="32" cy="32" r="25" fill="none" stroke="#5B3FA6" strokeWidth="3" />
      <circle cx="32" cy="32" r="19" fill="none" stroke="#5B3FA6" strokeWidth="1.2" strokeDasharray="3 3" />
      <path d="M22 32.5l7 7 13-15" fill="none" stroke="#5B3FA6" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpecIcon({ name, className = 'h-4 w-4' }) {
  const d = {
    dpi: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 8h2v2H8zM14 8h2v2h-2zM8 14h2v2H8zM14 14h2v2h-2z" /></>,
    shield: <><path d="M12 3l8 3v6c0 5-3.6 8-8 9-4.4-1-8-4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
    cert: <><circle cx="12" cy="10" r="6" /><path d="M9 15.5 8 21l4-2 4 2-1-5.5" /></>,
    bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
    usb: <><path d="M12 3v14" /><path d="M9 6l3-3 3 3" /><circle cx="12" cy="19" r="2" /><path d="M12 12l-4-2V8M12 14l4-2v-2" /></>,
    file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
    ir: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
    focus: <><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" /><circle cx="12" cy="12" r="3" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    check: <path d="M5 12.5l4.5 4.5L19 7" />,
    cart: <><path d="M3 4h2l2.4 11h10.2L20 7H6.2" /><circle cx="9" cy="19.5" r="1.5" /><circle cx="17" cy="19.5" r="1.5" /></>,
    grid: <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>,
    finger: <><path d="M8 18a4 5 0 0 1 8 0" /><path d="M6 15a6 7 0 0 1 12 0" /><path d="M4.5 12a7.5 8.5 0 0 1 15 0" /></>,
    iris: <><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.8" /></>,
  }[name]
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
}
